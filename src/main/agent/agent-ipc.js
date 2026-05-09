/**
 * Agent IPC (Pi-backed)
 *
 * Bridges the renderer to a Pi `AgentSession` per chat turn. Five concerns:
 *
 *   1. **Status** (`agent:status`) — point-in-time snapshot for the
 *      sidebar header: is Ollama reachable, what version, which models.
 *   2. **Streaming chat** (`agent:chat:start` → `agent:chat:chunk` /
 *      `agent:chat:done`) — long-running, multi-chunk request. The
 *      invoke handler returns a `streamId` immediately; chunks flow
 *      over `event.sender.send` until a terminal `agent:chat:done`.
 *   3. **Sessions** (`agent:session:list/get/get-recent/create/rename/delete`)
 *      — a thin shell over Pi's `SessionManager`. Sessions live as
 *      JSONL files under `userData/pi-agent/sessions/<encoded-cwd>/`.
 *   4. **Consent** (`agent:chat:consent-request` / `agent:chat:consent`)
 *      — Phase 3 wires real tool consent through here. Phase 2 has no
 *      tools yet; the consent handler returns "no pending consent".
 *   5. **Cancellation** (`agent:chat:cancel`) — abort the in-flight
 *      stream by id.
 *
 * One Pi `AgentSession` per `chat:start` (per chat turn). When agent_end
 * fires (or on cancel / error / sender-destroyed), the session is
 * disposed and the stream removed from `activeStreams`.
 *
 * Pi owns all message persistence — no SQLite. The Pi JSONL is the
 * source of truth for prior conversation; chat:start with an existing
 * sessionPath restores history automatically via Pi's session context.
 */

const { ipcMain, app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const log = require('../logger');
const IPC = require('../../shared/ipc-channels');
const { newId } = require('../../shared/random-id');
const { getVersion, listModels } = require('./ollama-meta');
const { getOllamaApiUrl } = require('../service-registry');
const {
  createFreedomPiSession,
  getFreedomAgentDir,
  _internals: piInternals,
} = require('./pi-runtime');
const broker = require('./pi-broker');
const { CONSENT_VALUES } = require('./pi-broker');

// streamId -> {
//   streamId, senderId, sender, sessionPath, activeWebContentsId,
//   session?, dispose?, unsubscribe?,
//   fullText, cancelled,
//   toolCalls,         // accumulated for AGENT_CHAT_DONE payload
//   pendingConsent,    // Map<callId, resolveFn>
// }
const activeStreams = new Map();

// Coalesce streaming text deltas before crossing the IPC boundary. Pi emits
// per-token text_delta events (300-500 per response on Gemma 4); the renderer
// already coalesces marked + DOMPurify renders to one per animation frame, so
// flushing main-side at ~16ms gives us at most one IPC + one render per frame.
const CHUNK_FLUSH_MS = 16;

function newStreamId() {
  return newId();
}

function getAgentDir() {
  return getFreedomAgentDir(app);
}

function getSessionsDir() {
  return path.join(getAgentDir(), 'sessions');
}

function ensureSessionsDir() {
  const dir = getSessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function loadPi() {
  return piInternals.loadPi();
}

function sendIfAlive(ctx, channel, payload) {
  if (ctx.sender && !ctx.sender.isDestroyed()) {
    ctx.sender.send(channel, payload);
  }
}

function dropStream(streamId) {
  const ctx = activeStreams.get(streamId);
  if (!ctx) return;
  // Reject any outstanding consent prompts so the agent unwinds rather
  // than waiting forever for a renderer that's gone.
  if (ctx.pendingConsent) {
    for (const resolve of ctx.pendingConsent.values()) resolve('deny');
    ctx.pendingConsent.clear();
  }
  try {
    ctx.unsubscribe?.();
  } catch (err) {
    log.warn(`[Agent] unsubscribe threw for ${streamId}:`, err.message);
  }
  try {
    ctx.dispose?.();
  } catch (err) {
    log.warn(`[Agent] dispose threw for ${streamId}:`, err.message);
  }
  activeStreams.delete(streamId);
}

function dropStreamsForSender(senderId) {
  for (const [streamId, ctx] of activeStreams) {
    if (ctx.senderId !== senderId) continue;
    ctx.cancelled = true;
    // Best-effort abort so session.prompt resolves sooner; pumpChat's `finally`
    // also calls dropStream but is a no-op once we've already cleared the map.
    ctx.session?.abort().catch((err) =>
      log.warn(`[Agent] session.abort during sender drop threw: ${err.message}`)
    );
    dropStream(streamId);
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
    return { running: false, error: err.message, models: [] };
  }
}

// --- Sessions IPC ----------------------------------------------------------

function infoToView(info) {
  return {
    id: info.path,
    title: info.name || firstLine(info.firstMessage) || '(Untitled)',
    created_at: info.created instanceof Date ? info.created.getTime() : null,
    updated_at: info.modified instanceof Date ? info.modified.getTime() : null,
    message_count: info.messageCount ?? 0,
  };
}

function firstLine(text) {
  if (!text) return '';
  const trimmed = String(text).trim();
  if (!trimmed) return '';
  const nl = trimmed.indexOf('\n');
  return nl === -1 ? trimmed : trimmed.slice(0, nl);
}

function parseIso(timestamp) {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? null : ms;
}

function entriesToTimestamps(entries, headerTimestamp) {
  if (!Array.isArray(entries) || entries.length === 0) {
    const headerMs = parseIso(headerTimestamp);
    return { created: headerMs, updated: headerMs };
  }
  return {
    created: parseIso(entries[0]?.timestamp),
    updated: parseIso(entries[entries.length - 1]?.timestamp),
  };
}

async function listSessions(limit = 50) {
  const pi = await loadPi();
  const cwd = getAgentDir();
  const sessionsDir = ensureSessionsDir();
  const infos = await pi.SessionManager.list(cwd, sessionsDir);
  return infos
    .sort((a, b) => (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0))
    .slice(0, limit)
    .map(infoToView);
}

async function getSession(sessionPath) {
  if (!sessionPath) return null;
  const pi = await loadPi();
  let sm;
  try {
    sm = pi.SessionManager.open(sessionPath);
  } catch (err) {
    log.warn(`[Agent] getSession open failed for ${sessionPath}: ${err.message}`);
    return null;
  }
  const entries = sm.getEntries();
  const messages = [];
  for (const entry of entries) {
    if (entry?.type === 'message' && entry.message) messages.push(entry.message);
  }
  const { created, updated } = entriesToTimestamps(entries, sm.getHeader()?.timestamp);
  return {
    id: sessionPath,
    title:
      sm.getSessionName() ||
      firstLine(extractFirstUserText(messages)) ||
      '(Untitled)',
    messages,
    created_at: created,
    updated_at: updated,
  };
}

function extractFirstUserText(messages) {
  for (const m of messages) {
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content.find((c) => c?.type === 'text')?.text;
      if (text) return text;
    }
  }
  return '';
}

async function getRecentSession() {
  const list = await listSessions(1);
  if (list.length === 0) return null;
  return getSession(list[0].id);
}

async function createSession({ title = null } = {}) {
  const pi = await loadPi();
  const cwd = getAgentDir();
  const sessionsDir = ensureSessionsDir();
  const sm = pi.SessionManager.create(cwd, sessionsDir);
  if (title) {
    sm.appendSessionInfo(title);
  }
  const sessionPath = sm.getSessionFile();
  if (!sessionPath) {
    throw new Error('SessionManager.create returned no session file path');
  }
  const tsMs = parseIso(sm.getHeader()?.timestamp) ?? Date.now();
  return {
    id: sessionPath,
    title: title ?? null,
    created_at: tsMs,
    updated_at: tsMs,
    message_count: 0,
  };
}

async function renameSession(sessionPath, title) {
  if (!sessionPath || !title) return false;
  const pi = await loadPi();
  let sm;
  try {
    sm = pi.SessionManager.open(sessionPath);
  } catch (err) {
    log.warn(`[Agent] renameSession open failed: ${err.message}`);
    return false;
  }
  sm.appendSessionInfo(String(title));
  return true;
}

function deleteSession(sessionPath) {
  if (!sessionPath) return false;
  try {
    fs.unlinkSync(sessionPath);
    // Drop the broker's session-grant cache for this chat — otherwise the
    // sessionGrants Map grows unbounded across app uptime as users delete
    // and recreate chats. Per-stream grants are scoped to sessionPath, so
    // a stale path can't accidentally re-authorize a brand-new chat.
    broker.clearSession(sessionPath);
    return true;
  } catch (err) {
    log.warn(`[Agent] deleteSession failed for ${sessionPath}: ${err.message}`);
    return false;
  }
}

// --- Chat IPC --------------------------------------------------------------

// Pi's `ThinkingLevel` (pi-ai/types). Mirrors composer-thinking-chip.js
// in the renderer — the renderer can't import CJS shared modules, so a
// shared file would still need a parallel ESM copy.
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

const coerceEnum = (value, allowed, fallback) =>
  allowed.includes(value) ? value : fallback;

async function startChatStream(event, payload = {}) {
  const { model, prompt, sessionPath, activeWebContentsId = null } = payload;
  if (!model || typeof model !== 'string') return { error: 'model is required' };
  if (!prompt || typeof prompt !== 'string') return { error: 'prompt is required' };
  if (!sessionPath || typeof sessionPath !== 'string') {
    return { error: 'sessionPath is required' };
  }

  // Drop unknown values silently rather than rejecting — the chip's enum
  // is the contract, anything else is a renderer bug we don't want to
  // surface as a chat failure.
  const thinkingLevel = coerceEnum(payload.thinkingLevel, THINKING_LEVELS, null);

  const streamId = newStreamId();
  const sender = event.sender;
  const ctx = {
    streamId,
    senderId: sender.id,
    sender,
    sessionPath,
    activeWebContentsId,
    fullText: '',
    cancelled: false,
    toolCalls: [],
    pendingConsent: new Map(),
  };
  activeStreams.set(streamId, ctx);

  // Fire-and-forget: pumpChat owns the lifecycle, including emitting the
  // terminal AGENT_CHAT_DONE and dropping the stream from the map.
  pumpChat({ model, prompt, thinkingLevel, ctx }).catch((err) => {
    log.error(`[Agent] pumpChat ${streamId} fatal:`, err);
    sendIfAlive(ctx, IPC.AGENT_CHAT_DONE, {
      streamId,
      fullContent: ctx.fullText,
      toolCalls: ctx.toolCalls,
      error: err?.message || String(err),
    });
    dropStream(streamId);
  });

  return { streamId };
}

function buildToolCallContext({ ctx, profile }) {
  return {
    profile,
    sessionId: ctx.sessionPath,
    webContentsId: ctx.activeWebContentsId,

    onToolCall: ({ callId, name, tier, args }) => {
      ctx.toolCalls.push({ id: callId, name, tier, args, status: 'pending', result: null });
      sendIfAlive(ctx, IPC.AGENT_CHAT_TOOL_CALL, {
        streamId: ctx.streamId,
        callId,
        name,
        tier,
        args,
      });
    },

    requestConsent: ({ callId, name, tier, args, description }) =>
      new Promise((resolve) => {
        ctx.pendingConsent.set(callId, resolve);
        sendIfAlive(ctx, IPC.AGENT_CHAT_CONSENT_REQUEST, {
          streamId: ctx.streamId,
          callId,
          name,
          tier,
          args,
          description,
        });
      }).finally(() => ctx.pendingConsent.delete(callId)),

    onToolResult: ({ callId, status, result }) => {
      const record = ctx.toolCalls.find((c) => c.id === callId);
      if (record) {
        record.status = status;
        record.result = result;
      }
      sendIfAlive(ctx, IPC.AGENT_CHAT_TOOL_RESULT, {
        streamId: ctx.streamId,
        callId,
        status,
        result,
      });
    },
  };
}

async function pumpChat({ model, prompt, thinkingLevel = null, ctx }) {
  const emitDone = (extra = {}) =>
    sendIfAlive(ctx, IPC.AGENT_CHAT_DONE, {
      streamId: ctx.streamId,
      fullContent: ctx.fullText,
      toolCalls: ctx.toolCalls,
      ...extra,
    });

  // The main agent runs with all tier-allowlist defaults — every tier
  // visible at the broker. Per-call consent still applies via TIER_POLICY.
  // Specialised subagents (Phase 5) will spawn with restricted profiles.
  const profile = broker.DEFAULT_PROFILE;
  const toolCallContext = buildToolCallContext({ ctx, profile });

  let session;
  let dispose;
  try {
    const created = await createFreedomPiSession({
      agentDir: getAgentDir(),
      modelId: model,
      sessionPath: ctx.sessionPath,
      toolCallContext,
    });
    session = created.session;
    dispose = created.dispose;
  } catch (err) {
    emitDone({ error: err?.message || String(err) });
    dropStream(ctx.streamId);
    return;
  }

  if (thinkingLevel) {
    try {
      session.setThinkingLevel(thinkingLevel);
    } catch (err) {
      // Pi clamps to model capabilities and only throws on truly
      // invalid input. Log and continue — falling back to Pi's default
      // is preferable to failing the whole turn.
      log.warn(`[Agent] setThinkingLevel(${thinkingLevel}) failed: ${err?.message || err}`);
    }
  }

  // Tool visibility is set inside pi-extension's session_start hook,
  // which runs during bindExtensions above. The hook uses the toolMeta
  // map it built when registering the tools (browser + spawn_subagent
  // for the main agent; just browser for subagents) so the active list
  // matches what's registered.

  ctx.session = session;
  ctx.dispose = dispose;

  // Two coalesced delta streams: `text` (visible assistant output) and
  // `thinking` (the model's reasoning, surfaced separately as a
  // collapsible disclosure in the renderer). Both share one 16ms timer
  // so we batch IPC traffic and let the renderer handle the matching
  // delivery rate cleanly.
  const buffers = {
    text: { content: '', channel: IPC.AGENT_CHAT_CHUNK },
    thinking: { content: '', channel: IPC.AGENT_CHAT_THINKING_CHUNK },
  };
  let flushTimer = null;
  const flushPending = () => {
    for (const buf of Object.values(buffers)) {
      if (!buf.content) continue;
      const content = buf.content;
      buf.content = '';
      sendIfAlive(ctx, buf.channel, { streamId: ctx.streamId, content });
    }
  };
  const scheduleFlush = () => {
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushPending();
      }, CHUNK_FLUSH_MS);
    }
  };
  const cancelFlushTimer = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  let agentEndEvent = null;

  ctx.unsubscribe = session.subscribe((evt) => {
    if (evt.type === 'message_update') {
      const sub = evt.assistantMessageEvent;
      if (sub?.type === 'text_delta' && sub.delta) {
        ctx.fullText += sub.delta;
        buffers.text.content += sub.delta;
        scheduleFlush();
      } else if (sub?.type === 'thinking_delta' && sub.delta) {
        buffers.thinking.content += sub.delta;
        scheduleFlush();
      }
    } else if (evt.type === 'agent_end') {
      agentEndEvent = evt;
    }
  });

  try {
    await session.prompt(prompt, { source: 'extension' });
    cancelFlushTimer();
    flushPending();
    emitDone(
      ctx.cancelled
        ? { cancelled: true }
        : { stats: extractStats(agentEndEvent) }
    );
  } catch (err) {
    cancelFlushTimer();
    flushPending();
    if (ctx.cancelled) {
      emitDone({ cancelled: true });
    } else {
      log.error(`[Agent] Chat stream ${ctx.streamId} failed:`, err.message);
      emitDone({ error: err.message });
    }
  } finally {
    cancelFlushTimer();
    dropStream(ctx.streamId);
  }
}

function extractStats(agentEndEvent) {
  const messages = agentEndEvent?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  let assistant = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'assistant') {
      assistant = messages[i];
      break;
    }
  }
  if (!assistant?.usage) {
    return assistant?.stopReason ? { finishReason: assistant.stopReason } : null;
  }
  return {
    finishReason: assistant.stopReason || null,
    usage: {
      inputTokens: assistant.usage.input,
      outputTokens: assistant.usage.output,
      totalTokens: assistant.usage.totalTokens,
    },
  };
}

async function cancelChatStream(_event, { streamId } = {}) {
  const ctx = activeStreams.get(streamId);
  if (!ctx) return { cancelled: false };
  ctx.cancelled = true;
  if (ctx.session) {
    try {
      await ctx.session.abort();
    } catch (err) {
      log.warn(`[Agent] cancel: session.abort threw: ${err.message}`);
    }
  }
  return { cancelled: true };
}

function handleConsentResponse(_event, { streamId, callId, decision } = {}) {
  const ctx = activeStreams.get(streamId);
  if (!ctx || !ctx.pendingConsent.has(callId)) {
    return { ok: false, reason: 'no pending consent for this callId' };
  }
  const choice = coerceEnum(decision, CONSENT_VALUES, 'deny');
  const resolve = ctx.pendingConsent.get(callId);
  ctx.pendingConsent.delete(callId);
  resolve(choice);
  return { ok: true };
}

let agentIpcRegistered = false;

function registerAgentIpc() {
  if (agentIpcRegistered) return;
  agentIpcRegistered = true;

  ipcMain.handle(IPC.AGENT_STATUS, () => handleStatus());

  // Chat
  ipcMain.handle(IPC.AGENT_CHAT_START, (event, payload) => startChatStream(event, payload));
  ipcMain.handle(IPC.AGENT_CHAT_CANCEL, (event, payload) => cancelChatStream(event, payload));
  ipcMain.handle(IPC.AGENT_CHAT_CONSENT, (event, payload) => handleConsentResponse(event, payload));

  // Sessions (Pi-backed)
  ipcMain.handle(IPC.AGENT_SESSION_LIST, (_e, payload = {}) => listSessions(payload.limit ?? 50));
  ipcMain.handle(IPC.AGENT_SESSION_GET, (_e, payload = {}) => getSession(payload.id));
  ipcMain.handle(IPC.AGENT_SESSION_GET_RECENT, () => getRecentSession());
  ipcMain.handle(IPC.AGENT_SESSION_CREATE, (_e, payload = {}) => createSession(payload));
  ipcMain.handle(IPC.AGENT_SESSION_RENAME, async (_e, payload = {}) => ({
    ok: await renameSession(payload.id, payload.title),
  }));
  ipcMain.handle(IPC.AGENT_SESSION_DELETE, (_e, payload = {}) => ({
    ok: deleteSession(payload.id),
  }));

  app.on('web-contents-created', (_event, contents) => {
    contents.on('destroyed', () => dropStreamsForSender(contents.id));
  });

  log.info('[Agent] IPC registered (Pi-backed)');
}

module.exports = {
  registerAgentIpc,
  _internals: {
    activeStreams,
    handleStatus,
    startChatStream,
    cancelChatStream,
    handleConsentResponse,
    dropStreamsForSender,
    listSessions,
    getSession,
    getRecentSession,
    createSession,
    renameSession,
    deleteSession,
  },
};
