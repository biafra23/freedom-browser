/**
 * Agent IPC
 *
 * Bridges the renderer to the local Ollama sidecar via AI SDK Core +
 * the OpenAI-compatible provider (Ollama exposes `/v1/chat/completions`).
 * Three concerns:
 *
 * 1. **Status** (`agent:status`) — point-in-time snapshot for the
 *    sidebar header: is the daemon reachable, what version, which
 *    models are installed. Goes via Ollama's `/api/version` + `/api/tags`
 *    rather than the OpenAI-compatible endpoint, since those carry the
 *    metadata we display.
 * 2. **Streaming chat** (`agent:chat:start` → `agent:chat:chunk` /
 *    `agent:chat:done`) — long-running, multi-chunk request. The
 *    invoke handler returns a `streamId` immediately; chunks flow
 *    over `event.sender.send` until a terminal `agent:chat:done`
 *    arrives.
 * 3. **Cancellation** (`agent:chat:cancel`) — abort an in-flight
 *    stream by id.
 *
 * Streams are tracked per-sender. When a sender goes away (renderer
 * close, navigation) we abort + drop the stream so a closed window
 * can't leak an in-flight Ollama request.
 *
 * Tool-calling is deferred to a later phase; for now the model just
 * streams text.
 */

const { ipcMain, app } = require('electron');
const log = require('../logger');
const IPC = require('../../shared/ipc-channels');
const { newId } = require('../../shared/random-id');
const { getVersion, listModels } = require('./ollama-meta');
const { getOllamaApiUrl } = require('../service-registry');

// streamId -> { controller, senderId }
const activeStreams = new Map();

// Lazy-load AI SDK Core so unit tests can mock it via jest.doMock without
// paying the import cost. The provider is rebuilt per chat against the
// service-registry's live URL so a port-conflict fallback (default 11434
// busy → 11435) doesn't leave us streaming to a stale baseURL.
let _streamText;
let _createOpenAICompatible;

function loadAiSdk() {
  if (!_streamText) _streamText = require('ai').streamText;
  if (!_createOpenAICompatible) {
    _createOpenAICompatible = require('@ai-sdk/openai-compatible').createOpenAICompatible;
  }
  const provider = _createOpenAICompatible({
    name: 'ollama',
    baseURL: `${getOllamaApiUrl()}/v1`,
  });
  return { streamText: _streamText, provider };
}

function newStreamId() {
  return newId();
}

function dropStream(streamId) {
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
      activeStreams.delete(streamId);
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

async function startChatStream(event, { model, messages }) {
  if (!model || typeof model !== 'string') {
    return { error: 'model is required' };
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: 'messages must be a non-empty array' };
  }

  const streamId = newStreamId();
  const controller = new AbortController();
  const sender = event.sender;
  const senderId = sender.id;
  activeStreams.set(streamId, { controller, senderId });

  // Don't await — return the streamId immediately and pump chunks
  // asynchronously over `sender.send`.
  pumpChat({ streamId, sender, model, messages, signal: controller.signal }).finally(() => {
    dropStream(streamId);
  });

  return { streamId };
}

async function pumpChat({ streamId, sender, model, messages, signal }) {
  let fullContent = '';
  try {
    const { streamText, provider } = loadAiSdk();
    const result = streamText({
      model: provider(model),
      messages,
      abortSignal: signal,
    });

    for await (const delta of result.textStream) {
      if (delta) {
        fullContent += delta;
        if (!sender.isDestroyed()) {
          sender.send(IPC.AGENT_CHAT_CHUNK, { streamId, content: delta });
        }
      }
    }

    const [finishReason, usage] = await Promise.all([
      result.finishReason.catch(() => null),
      result.usage.catch(() => null),
    ]);

    if (!sender.isDestroyed()) {
      sender.send(IPC.AGENT_CHAT_DONE, {
        streamId,
        fullContent,
        stats: { finishReason, usage },
      });
    }
  } catch (err) {
    if (signal.aborted) {
      log.info(`[Agent] Chat stream ${streamId} cancelled`);
      if (!sender.isDestroyed()) {
        sender.send(IPC.AGENT_CHAT_DONE, { streamId, fullContent, cancelled: true });
      }
      return;
    }
    log.error(`[Agent] Chat stream ${streamId} failed:`, err.message);
    if (!sender.isDestroyed()) {
      sender.send(IPC.AGENT_CHAT_DONE, {
        streamId,
        fullContent,
        error: err.message,
      });
    }
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
  activeStreams.delete(streamId);
  return { cancelled: true };
}

function registerAgentIpc() {
  ipcMain.handle(IPC.AGENT_STATUS, () => handleStatus());
  ipcMain.handle(IPC.AGENT_CHAT_START, (event, payload) => startChatStream(event, payload));
  ipcMain.handle(IPC.AGENT_CHAT_CANCEL, (event, payload) => cancelChatStream(event, payload));

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
  },
};
