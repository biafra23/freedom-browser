/**
 * Agent IPC
 *
 * Bridges the renderer to the local Ollama sidecar via AI SDK Core +
 * the OpenAI-compatible provider (Ollama exposes `/v1/chat/completions`).
 * Five concerns:
 *
 * 1. **Status** (`agent:status`) — point-in-time snapshot for the
 *    sidebar header: is the daemon reachable, what version, which
 *    models are installed.
 * 2. **Streaming chat** (`agent:chat:start` → `agent:chat:chunk` /
 *    `agent:chat:done`) — long-running, multi-chunk request. The
 *    invoke handler returns a `streamId` immediately; chunks flow
 *    over `event.sender.send` until a terminal `agent:chat:done`.
 * 3. **Tool calls** (`agent:chat:tool-call` / `:tool-result`) — AI
 *    SDK invokes our wrapped `execute` function for each tool the
 *    model emits; we forward the call, run it through the broker,
 *    and stream the result back so the renderer can render a card.
 * 4. **Consent** (`agent:chat:consent-request` →
 *    `agent:chat:consent`) — when the broker says `ask`, we emit a
 *    request, await the user's allow/allow-session/deny via the
 *    response channel, and resume the wrapped execute accordingly.
 * 5. **Cancellation** (`agent:chat:cancel`) — abort an in-flight
 *    stream by id, including any pending consent prompts.
 *
 * Streams are tracked per-sender. When a sender goes away (renderer
 * close, navigation) we abort + drop the stream so a closed window
 * can't leak an in-flight Ollama request or a stuck consent prompt.
 */

const { ipcMain, app } = require('electron');
const log = require('../logger');
const IPC = require('../../shared/ipc-channels');
const { newId } = require('../../shared/random-id');
const { getVersion, listModels } = require('./ollama-meta');
const { getOllamaApiUrl } = require('../service-registry');
const profilesStore = require('./agent-profiles');
const sessionsStore = require('./sessions-store');
const broker = require('./agent-permissions');
const registry = require('./tools/registry');
const { BROWSER_TOOLS } = require('./tools/browser-tools');

// streamId -> {
//   controller, senderId, sessionId, profile, activeWebContentsId,
//   toolCalls,            // accumulated for parts persistence on done
//   pendingConsent,       // Map<callId, resolve>
// }
const activeStreams = new Map();

let toolsRegistered = false;
function ensureToolsRegistered() {
  if (toolsRegistered) return;
  registry.registerAll(BROWSER_TOOLS);
  toolsRegistered = true;
}

// Lazy-load AI SDK Core so unit tests can mock it via jest.doMock without
// paying the import cost. Provider is rebuilt per chat against the
// service-registry's live URL so a port-conflict fallback (default 11434
// busy → 11435) doesn't leave us streaming to a stale baseURL.
let _streamText;
let _createOpenAICompatible;
let _tool;
let _stepCountIs;

function loadAiSdk() {
  if (!_streamText) {
    const ai = require('ai');
    _streamText = ai.streamText;
    _tool = ai.tool;
    _stepCountIs = ai.stepCountIs;
  }
  if (!_createOpenAICompatible) {
    _createOpenAICompatible = require('@ai-sdk/openai-compatible').createOpenAICompatible;
  }
  const provider = _createOpenAICompatible({
    name: 'ollama',
    baseURL: `${getOllamaApiUrl()}/v1`,
  });
  return { streamText: _streamText, tool: _tool, stepCountIs: _stepCountIs, provider };
}

function newStreamId() {
  return newId();
}

function dropStream(streamId) {
  const entry = activeStreams.get(streamId);
  if (entry?.pendingConsent) {
    // Reject any outstanding consent prompts so the wrapped execute
    // unwinds rather than waiting forever.
    for (const resolve of entry.pendingConsent.values()) {
      resolve('deny');
    }
    entry.pendingConsent.clear();
  }
  activeStreams.delete(streamId);
}

function dropStreamsForSender(senderId) {
  for (const [streamId, entry] of activeStreams) {
    if (entry.senderId === senderId) {
      try {
        entry.controller.abort();
      } catch {
        // Aborting an already-finished controller is a no-op.
      }
      dropStream(streamId);
    }
  }
}

async function handleStatus() {
  try {
    const baseUrl = getOllamaApiUrl();
    const [version, tags] = await Promise.all([
      getVersion({ baseUrl }),
      listModels({ baseUrl }).catch(() => ({ models: [] })),
    ]);
    return {
      running: true,
      version: version.version,
      models: (tags.models || []).map((m) => ({
        name: m.name,
        size: m.size,
        modified_at: m.modified_at,
      })),
    };
  } catch (err) {
    return {
      running: false,
      error: err.message,
      models: [],
    };
  }
}

function resolveProfile(sessionId) {
  if (sessionId) {
    const session = sessionsStore.getSession(sessionId);
    if (session?.agent_id) {
      const p = profilesStore.getProfile(session.agent_id);
      if (p) return p;
    }
  }
  return profilesStore.getDefaultProfile();
}

function buildAiSdkTools(streamCtx) {
  const { tool } = loadAiSdk();
  const visible = broker.listToolsForProfile(streamCtx.profile);
  const out = {};
  for (const def of visible) {
    out[def.name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: makeWrappedExecute(def, streamCtx),
    });
  }
  return out;
}

function makeWrappedExecute(def, streamCtx) {
  return async (input) => {
    const callId = newId();
    const callRecord = {
      id: callId,
      name: def.name,
      tier: def.tier,
      args: input,
      status: 'pending',
      result: null,
    };
    streamCtx.toolCalls.push(callRecord);

    sendIfAlive(streamCtx, IPC.AGENT_CHAT_TOOL_CALL, {
      streamId: streamCtx.streamId,
      callId,
      name: def.name,
      tier: def.tier,
      args: input,
    });

    const decision = broker.evaluate({
      toolName: def.name,
      profile: streamCtx.profile,
      sessionId: streamCtx.sessionId,
    });

    let userChoice = null;
    if (decision.decision === 'block') {
      return finalizeCallAsError(streamCtx, callRecord, 'blocked', decision.reason);
    }
    if (decision.decision === 'allow') {
      userChoice = 'allow';
    } else if (decision.decision === 'ask') {
      sendIfAlive(streamCtx, IPC.AGENT_CHAT_CONSENT_REQUEST, {
        streamId: streamCtx.streamId,
        callId,
        name: def.name,
        tier: def.tier,
        args: input,
        description: def.description,
      });
      userChoice = await new Promise((resolve) => {
        streamCtx.pendingConsent.set(callId, resolve);
      });
      streamCtx.pendingConsent.delete(callId);
    }

    if (userChoice === 'deny') {
      return finalizeCallAsError(streamCtx, callRecord, 'denied', 'User denied this tool call');
    }
    if (userChoice === 'allow-session' && streamCtx.sessionId) {
      broker.grantForSession(streamCtx.sessionId, def.tier);
    }

    try {
      const result = await registry.runTool(def.name, input, {
        webContentsId: streamCtx.activeWebContentsId,
        sessionId: streamCtx.sessionId,
      });
      callRecord.status = 'allowed';
      callRecord.result = result;
      sendIfAlive(streamCtx, IPC.AGENT_CHAT_TOOL_RESULT, {
        streamId: streamCtx.streamId,
        callId,
        status: 'allowed',
        result,
      });
      return result;
    } catch (err) {
      return finalizeCallAsError(streamCtx, callRecord, 'error', err.message);
    }
  };
}

function finalizeCallAsError(streamCtx, callRecord, status, message) {
  callRecord.status = status;
  callRecord.result = { error: message };
  sendIfAlive(streamCtx, IPC.AGENT_CHAT_TOOL_RESULT, {
    streamId: streamCtx.streamId,
    callId: callRecord.id,
    status,
    result: callRecord.result,
  });
  // Returning the error as the tool result lets the model see what
  // happened and react gracefully (typically: explain to the user).
  return { error: message };
}

function sendIfAlive(streamCtx, channel, payload) {
  if (streamCtx.sender && !streamCtx.sender.isDestroyed()) {
    streamCtx.sender.send(channel, payload);
  }
}

async function startChatStream(
  event,
  { model, messages, sessionId = null, activeWebContentsId = null } = {}
) {
  if (!model || typeof model !== 'string') {
    return { error: 'model is required' };
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: 'messages must be a non-empty array' };
  }

  ensureToolsRegistered();

  const streamId = newStreamId();
  const controller = new AbortController();
  const sender = event.sender;
  const streamCtx = {
    streamId,
    controller,
    senderId: sender.id,
    sender,
    sessionId,
    activeWebContentsId,
    profile: resolveProfile(sessionId),
    toolCalls: [],
    pendingConsent: new Map(),
  };
  activeStreams.set(streamId, streamCtx);

  pumpChat({ model, messages, signal: controller.signal, streamCtx }).finally(() => {
    dropStream(streamId);
  });

  return { streamId };
}

async function pumpChat({ model, messages, signal, streamCtx }) {
  let fullContent = '';
  try {
    const { streamText, stepCountIs, provider } = loadAiSdk();
    const result = streamText({
      model: provider(model),
      messages,
      tools: buildAiSdkTools(streamCtx),
      stopWhen: stepCountIs(8),
      abortSignal: signal,
    });

    for await (const delta of result.textStream) {
      if (delta) {
        fullContent += delta;
        sendIfAlive(streamCtx, IPC.AGENT_CHAT_CHUNK, {
          streamId: streamCtx.streamId,
          content: delta,
        });
      }
    }

    const [finishReason, usage] = await Promise.all([
      result.finishReason.catch(() => null),
      result.usage.catch(() => null),
    ]);

    sendIfAlive(streamCtx, IPC.AGENT_CHAT_DONE, {
      streamId: streamCtx.streamId,
      fullContent,
      toolCalls: streamCtx.toolCalls,
      stats: { finishReason, usage },
    });
  } catch (err) {
    if (signal.aborted) {
      log.info(`[Agent] Chat stream ${streamCtx.streamId} cancelled`);
      sendIfAlive(streamCtx, IPC.AGENT_CHAT_DONE, {
        streamId: streamCtx.streamId,
        fullContent,
        toolCalls: streamCtx.toolCalls,
        cancelled: true,
      });
      return;
    }
    log.error(`[Agent] Chat stream ${streamCtx.streamId} failed:`, err.message);
    sendIfAlive(streamCtx, IPC.AGENT_CHAT_DONE, {
      streamId: streamCtx.streamId,
      fullContent,
      toolCalls: streamCtx.toolCalls,
      error: err.message,
    });
  }
}

function cancelChatStream(_event, { streamId }) {
  const entry = activeStreams.get(streamId);
  if (!entry) {
    return { cancelled: false };
  }
  try {
    entry.controller.abort();
  } catch {
    // Aborting an already-finished controller is a no-op.
  }
  dropStream(streamId);
  return { cancelled: true };
}

function handleConsentResponse(_event, { streamId, callId, decision }) {
  const entry = activeStreams.get(streamId);
  if (!entry || !entry.pendingConsent.has(callId)) {
    return { ok: false, reason: 'no pending consent for this callId' };
  }
  const accepted = ['allow', 'allow-session', 'deny'];
  const choice = accepted.includes(decision) ? decision : 'deny';
  const resolve = entry.pendingConsent.get(callId);
  resolve(choice);
  entry.pendingConsent.delete(callId);
  return { ok: true };
}

function registerAgentIpc() {
  ipcMain.handle(IPC.AGENT_STATUS, () => handleStatus());
  ipcMain.handle(IPC.AGENT_CHAT_START, (event, payload) => startChatStream(event, payload));
  ipcMain.handle(IPC.AGENT_CHAT_CANCEL, (event, payload) => cancelChatStream(event, payload));
  ipcMain.handle(IPC.AGENT_CHAT_CONSENT, (event, payload) => handleConsentResponse(event, payload));

  app.on('web-contents-created', (_event, contents) => {
    contents.on('destroyed', () => dropStreamsForSender(contents.id));
  });

  log.info('[Agent] IPC registered');
}

module.exports = {
  registerAgentIpc,
  _internals: {
    activeStreams,
    handleStatus,
    startChatStream,
    cancelChatStream,
    dropStreamsForSender,
    handleConsentResponse,
    resolveProfile,
  },
};
