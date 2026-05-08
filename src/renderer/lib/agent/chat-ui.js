/**
 * Chat UI
 *
 * Message-list + composer wired to the main-process Ollama sidecar
 * via the `window.agent` preload bridge. Streaming tokens are
 * appended to the in-flight assistant message as they arrive over
 * IPC, with the rendered HTML re-derived on each chunk via the
 * markdown helper.
 *
 * Conversation is in-memory only for now — Phase 2 of the local-AI
 * roadmap adds the SQLite-backed sessions store.
 */

import { renderMarkdown } from './markdown.js';
import { pushDebug } from '../debug.js';

const FALLBACK_MODEL = 'gemma4:e2b';

const state = {
  messages: [],
  activeStreamId: null,
  activeAssistantEl: null,
  selectedModel: null,
  models: [],
  daemonRunning: false,
  currentSessionId: null,
};

let messagesEl;
let composerEl;
let inputEl;
let sendBtn;
let stopBtn;
let modelSelect;
let clearBtn;
let statusBadge;

export function initChatUi() {
  messagesEl = document.getElementById('agent-messages');
  composerEl = document.getElementById('agent-composer');
  inputEl = document.getElementById('agent-input');
  sendBtn = document.getElementById('agent-send-btn');
  stopBtn = document.getElementById('agent-stop-btn');
  modelSelect = document.getElementById('agent-model-select');
  clearBtn = document.getElementById('agent-clear-btn');
  statusBadge = document.getElementById('agent-status-badge');

  if (!messagesEl || !composerEl || !inputEl || !sendBtn) {
    pushDebug('[ChatUi] Required elements not found');
    return;
  }

  if (!window.agent) {
    pushDebug('[ChatUi] window.agent bridge not available');
    setStatus('error', 'no bridge');
    return;
  }

  composerEl.addEventListener('submit', handleSubmit);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  });
  stopBtn.addEventListener('click', handleStop);
  clearBtn?.addEventListener('click', startNewSession);
  modelSelect?.addEventListener('change', () => {
    state.selectedModel = modelSelect.value;
  });

  window.agent.onChatChunk((data) => handleChunk(data));
  window.agent.onChatDone((data) => handleDone(data));

  // Refresh status whenever the AI sidebar opens — daemon may have
  // started/stopped while it was hidden.
  document.addEventListener('sidebar-opened', (event) => {
    if (event.detail?.id === 'ai-sidebar') refreshStatus();
  });

  // Re-fetch status whenever the Ollama lifecycle transitions (start
  // succeeded / process exited / etc.). The chat UI's status badge and
  // model dropdown both depend on whether the daemon is reachable, so
  // we want the same source of truth as the Nodes panel.
  window.ollama?.onStatusUpdate?.(() => refreshStatus());

  refreshStatus();
  renderMessages();
  loadCurrentSession();
  pushDebug('[ChatUi] Initialized');
}

export async function refreshStatus() {
  try {
    const status = await window.agent.getStatus();
    state.daemonRunning = !!status.running;
    state.models = status.models || [];

    if (status.running) {
      setStatus('running', `v${status.version}`);
    } else {
      setStatus('error', 'offline');
    }

    if (modelSelect) {
      modelSelect.innerHTML = '';
      const names = state.models.map((m) => m.name);
      const choices = names.length > 0 ? names : [FALLBACK_MODEL];
      for (const name of choices) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        modelSelect.appendChild(opt);
      }
      // Prefer the previously selected model if still installed; otherwise
      // use FALLBACK_MODEL if present, otherwise the first available.
      const preferred =
        (state.selectedModel && choices.includes(state.selectedModel)
          ? state.selectedModel
          : null) ||
        (choices.includes(FALLBACK_MODEL) ? FALLBACK_MODEL : choices[0]);
      modelSelect.value = preferred;
      state.selectedModel = preferred;
    }
  } catch (err) {
    pushDebug(`[ChatUi] Status refresh failed: ${err?.message || err}`);
    setStatus('error', 'offline');
  }
}

function setStatus(level, text) {
  if (!statusBadge) return;
  statusBadge.classList.remove('running', 'error');
  if (level === 'running' || level === 'error') {
    statusBadge.classList.add(level);
  }
  statusBadge.textContent = text;
}

// On startup, resume the most recent session so conversations survive
// quit/reopen. If none exists, defer creating one until the first user
// message — keeps an empty session out of the DB just for opening the
// sidebar.
async function loadCurrentSession() {
  try {
    const session = await window.agent.getRecentSession();
    if (!session) return;
    state.currentSessionId = session.id;
    state.messages = (session.messages || []).map((m) => ({
      role: m.role,
      content: m.content || '',
    }));
    renderMessages();
  } catch (err) {
    pushDebug(`[ChatUi] Could not load recent session: ${err?.message || err}`);
  }
}

async function ensureSession(modelId, initialTitle = null) {
  if (state.currentSessionId) return state.currentSessionId;
  const session = await window.agent.createSession({ modelId, title: initialTitle });
  state.currentSessionId = session.id;
  return session.id;
}

const TITLE_MAX_LEN = 40;

function autoTitleFromMessage(text) {
  const trimmed = (text || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  if (trimmed.length <= TITLE_MAX_LEN) return trimmed;
  return trimmed.slice(0, TITLE_MAX_LEN - 1) + '…';
}

async function persistMessage(role, content) {
  if (!state.currentSessionId) return;
  try {
    await window.agent.appendMessage({
      sessionId: state.currentSessionId,
      role,
      content,
    });
  } catch (err) {
    pushDebug(`[ChatUi] Could not persist ${role} message: ${err?.message || err}`);
  }
}

async function handleSubmit(e) {
  e.preventDefault();
  if (state.activeStreamId) return;
  const text = inputEl.value.trim();
  if (!text) return;

  const model = state.selectedModel || (modelSelect && modelSelect.value) || FALLBACK_MODEL;
  // Auto-title from the first user message of a fresh session. Existing
  // sessions keep their stored title (user-renamed or earlier auto-title).
  const initialTitle = state.messages.length === 0 ? autoTitleFromMessage(text) : null;
  await ensureSession(model, initialTitle);

  state.messages.push({ role: 'user', content: text });
  appendMessage({ role: 'user', content: text });
  inputEl.value = '';
  setComposerBusy(true);
  // Fire-and-forget — persist failure is logged via pushDebug but
  // does not block the chat stream from starting. In-memory messages
  // remain the source of truth for this run; cross-launch loss is
  // acceptable for v1, hardenable in Phase 3 with a status indicator.
  persistMessage('user', text);

  // Insert an empty assistant message that we'll stream into.
  const assistantMsg = { role: 'assistant', content: '' };
  state.messages.push(assistantMsg);
  state.activeAssistantEl = appendMessage(assistantMsg, { streaming: true });

  try {
    const result = await window.agent.startChat(model, state.messages.slice(0, -1));
    if (result.error) {
      finalizeAssistant({ error: result.error });
      return;
    }
    state.activeStreamId = result.streamId;
  } catch (err) {
    finalizeAssistant({ error: err?.message || String(err) });
  }
}

// Per-chunk re-rendering of the full assistant message is O(n²) in
// content length (marked + DOMPurify both re-parse the entire string),
// so we coalesce to one render per animation frame. Multiple tokens
// arriving inside the same frame collapse to a single parse + sanitise.
let renderScheduled = false;

function flushAssistantRender() {
  renderScheduled = false;
  if (!state.activeAssistantEl) return;
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== 'assistant') return;
  const contentEl = state.activeAssistantEl.querySelector('.agent-message-content');
  if (!contentEl) return;
  contentEl.innerHTML = renderMarkdown(last.content);
  scrollToBottom();
}

function scheduleAssistantRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(flushAssistantRender);
  } else {
    // Test fallback: run synchronously when rAF isn't available.
    flushAssistantRender();
  }
}

function handleChunk(data) {
  if (!state.activeStreamId || data.streamId !== state.activeStreamId) return;
  if (!state.activeAssistantEl) return;
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== 'assistant') return;
  last.content += data.content;
  scheduleAssistantRender();
}

function handleDone(data) {
  if (!state.activeStreamId || data.streamId !== state.activeStreamId) return;
  finalizeAssistant({
    fullContent: data.fullContent,
    cancelled: data.cancelled,
    error: data.error,
    stats: data.stats,
  });
}

function finalizeAssistant({ fullContent, cancelled, error, stats } = {}) {
  const el = state.activeAssistantEl;
  const last = state.messages[state.messages.length - 1];

  if (el) {
    el.classList.remove('streaming');
    if (error) {
      el.classList.add('error');
      const contentEl = el.querySelector('.agent-message-content');
      if (contentEl) {
        const prefix = last?.content ? `${last.content}\n\n` : '';
        contentEl.textContent = `${prefix}Error: ${error}`;
      }
      if (last) last.content = `Error: ${error}`;
    } else if (cancelled) {
      const contentEl = el.querySelector('.agent-message-content');
      if (contentEl && !last?.content) {
        contentEl.textContent = '(cancelled)';
      }
      appendMeta(el, 'cancelled');
    } else {
      if (typeof fullContent === 'string' && fullContent && last) {
        last.content = fullContent;
        const contentEl = el.querySelector('.agent-message-content');
        if (contentEl) contentEl.innerHTML = renderMarkdown(fullContent);
      }
      const usage = stats?.usage;
      if (usage?.totalTokens != null || usage?.outputTokens != null) {
        const out = usage.outputTokens ?? usage.totalTokens;
        appendMeta(el, `${out} tok`);
      }
    }
  }

  // Fire-and-forget persist of the final assistant message (including
  // error / partial-on-cancel content) so on next launch the user sees
  // the same conversation state they left.
  if (last?.role === 'assistant' && last.content) {
    persistMessage('assistant', last.content);
  }

  state.activeStreamId = null;
  state.activeAssistantEl = null;
  setComposerBusy(false);
  inputEl?.focus();
}

async function handleStop() {
  if (!state.activeStreamId) return;
  try {
    await window.agent.cancelChat(state.activeStreamId);
  } catch (err) {
    pushDebug(`[ChatUi] Cancel failed: ${err?.message || err}`);
  }
}

// Forget the current session id — the next user message creates a fresh
// one. The old session remains in the DB and shows up in the sessions
// list. Used by both the "+ New" button and the sessions UI's
// new-chat affordance.
export function startNewSession() {
  if (state.activeStreamId) return false;
  state.currentSessionId = null;
  state.messages = [];
  renderMessages();
  return true;
}

// Load a saved session into the chat view. Used by the sessions UI when
// the user picks a row. Refuses while a stream is active.
export async function loadSessionById(id) {
  if (state.activeStreamId) return false;
  try {
    const session = await window.agent.getSession(id);
    if (!session) return false;
    state.currentSessionId = session.id;
    state.messages = (session.messages || []).map((m) => ({
      role: m.role,
      content: m.content || '',
    }));
    renderMessages();
    return true;
  } catch (err) {
    pushDebug(`[ChatUi] loadSessionById failed: ${err?.message || err}`);
    return false;
  }
}

export function getCurrentSessionId() {
  return state.currentSessionId;
}


function setComposerBusy(busy) {
  if (busy) {
    sendBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    inputEl.disabled = true;
  } else {
    sendBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    inputEl.disabled = false;
  }
}

function renderMessages() {
  if (!messagesEl) return;
  messagesEl.innerHTML = '';
  if (state.messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'agent-empty-state';
    empty.innerHTML =
      '<strong>Local AI Chat</strong><span>Ask the model anything. Conversations are kept in memory only — clearing or closing the sidebar discards them.</span>';
    messagesEl.appendChild(empty);
    return;
  }
  for (const msg of state.messages) {
    appendMessage(msg);
  }
  scrollToBottom();
}

function appendMessage(msg, opts = {}) {
  if (!messagesEl) return null;
  const existingEmpty = messagesEl.querySelector('.agent-empty-state');
  if (existingEmpty) existingEmpty.remove();

  const wrap = document.createElement('div');
  wrap.className = `agent-message ${msg.role}`;
  if (opts.streaming) wrap.classList.add('streaming');

  const role = document.createElement('div');
  role.className = 'agent-message-role';
  role.textContent = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Model' : msg.role;

  const content = document.createElement('div');
  content.className = 'agent-message-content';
  if (msg.role === 'assistant' && msg.content) {
    content.innerHTML = renderMarkdown(msg.content);
  } else {
    content.textContent = msg.content || '';
  }

  wrap.appendChild(role);
  wrap.appendChild(content);
  messagesEl.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function appendMeta(el, text) {
  const meta = document.createElement('div');
  meta.className = 'agent-message-meta';
  meta.textContent = text;
  el.appendChild(meta);
}

function scrollToBottom() {
  if (!messagesEl) return;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Exported for tests.
export const _internals = { state };
