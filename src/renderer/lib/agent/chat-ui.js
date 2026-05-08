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
import { getActiveWebview } from '../tabs.js';

const FALLBACK_MODEL = 'gemma4:e2b';

const state = {
  messages: [],
  activeStreamId: null,
  activeAssistantEl: null,
  // Tool-call cards live inside the active assistant message's bubble.
  // toolCallEls maps callId → { wrapEl, headerEl, bodyEl } so the
  // tool-result + consent-response handlers can update the card in
  // place without re-rendering the whole message.
  activeToolCallEls: new Map(),
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
let modelSelector;
let modelBtn;
let modelBtnName;
let modelDropdown;
let modelList;
let clearBtn;
let statusBadge;

export function initChatUi() {
  messagesEl = document.getElementById('agent-messages');
  composerEl = document.getElementById('agent-composer');
  inputEl = document.getElementById('agent-input');
  sendBtn = document.getElementById('agent-send-btn');
  stopBtn = document.getElementById('agent-stop-btn');
  modelSelector = document.getElementById('agent-model-selector');
  modelBtn = document.getElementById('agent-model-btn');
  modelBtnName = document.getElementById('agent-model-btn-name');
  modelDropdown = document.getElementById('agent-model-dropdown');
  modelList = document.getElementById('agent-model-list');
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
  modelBtn?.addEventListener('click', toggleModelDropdown);
  // Close the model dropdown on any click outside the selector.
  document.addEventListener('click', (e) => {
    if (modelSelector && !modelSelector.contains(e.target)) {
      closeModelDropdown();
    }
  });

  window.agent.onChatChunk((data) => handleChunk(data));
  window.agent.onChatDone((data) => handleDone(data));
  window.agent.onToolCall?.((data) => handleToolCall(data));
  window.agent.onToolResult?.((data) => handleToolResult(data));
  window.agent.onConsentRequest?.((data) => handleConsentRequest(data));

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

    const names = state.models.map((m) => m.name);
    const choices = names.length > 0 ? names : [FALLBACK_MODEL];
    // Prefer the previously selected model if still installed; otherwise
    // use FALLBACK_MODEL if present, otherwise the first available.
    const preferred =
      (state.selectedModel && choices.includes(state.selectedModel)
        ? state.selectedModel
        : null) ||
      (choices.includes(FALLBACK_MODEL) ? FALLBACK_MODEL : choices[0]);
    state.selectedModel = preferred;
    renderModelDropdown(choices);
    if (modelBtnName) modelBtnName.textContent = preferred;
  } catch (err) {
    pushDebug(`[ChatUi] Status refresh failed: ${err?.message || err}`);
    setStatus('error', 'offline');
  }
}

function renderModelDropdown(choices) {
  if (!modelList) return;
  modelList.innerHTML = '';
  for (const name of choices) {
    const li = document.createElement('li');
    li.className = 'agent-model-item';
    if (name === state.selectedModel) li.classList.add('active');
    li.setAttribute('role', 'option');
    li.dataset.model = name;
    li.textContent = name;
    li.addEventListener('click', () => selectModel(name));
    modelList.appendChild(li);
  }
}

function selectModel(name) {
  state.selectedModel = name;
  if (modelBtnName) modelBtnName.textContent = name;
  // Update the active class without a full re-render.
  if (modelList) {
    for (const item of modelList.children) {
      item.classList.toggle('active', item.dataset.model === name);
    }
  }
  closeModelDropdown();
}

function toggleModelDropdown() {
  if (!modelSelector || !modelDropdown) return;
  if (modelSelector.classList.contains('open')) {
    closeModelDropdown();
  } else {
    modelSelector.classList.add('open');
    modelDropdown.classList.remove('hidden');
    modelBtn?.setAttribute('aria-expanded', 'true');
  }
}

function closeModelDropdown() {
  if (!modelSelector || !modelDropdown) return;
  modelSelector.classList.remove('open');
  modelDropdown.classList.add('hidden');
  modelBtn?.setAttribute('aria-expanded', 'false');
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
    state.messages = (session.messages || []).map(rowToInMemoryMessage);
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

function rowToInMemoryMessage(row) {
  const msg = { role: row.role, content: row.content || '' };
  if (row.parts_json) {
    try {
      const parts = JSON.parse(row.parts_json);
      if (Array.isArray(parts.toolCalls)) msg.toolCalls = parts.toolCalls;
    } catch (err) {
      pushDebug(`[ChatUi] Could not parse parts_json: ${err?.message || err}`);
    }
  }
  return msg;
}

async function persistMessage(role, content, parts = null) {
  if (!state.currentSessionId) return;
  try {
    await window.agent.appendMessage({
      sessionId: state.currentSessionId,
      role,
      content,
      parts,
    });
  } catch (err) {
    pushDebug(`[ChatUi] Could not persist ${role} message: ${err?.message || err}`);
  }
}

function getActiveWebContentsId() {
  try {
    const wv = getActiveWebview?.();
    if (wv && typeof wv.getWebContentsId === 'function') {
      return wv.getWebContentsId();
    }
  } catch (err) {
    pushDebug(`[ChatUi] Could not resolve active webview: ${err?.message || err}`);
  }
  return null;
}

async function handleSubmit(e) {
  e.preventDefault();
  if (state.activeStreamId) return;
  const text = inputEl.value.trim();
  if (!text) return;

  const model = state.selectedModel || FALLBACK_MODEL;
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
    const result = await window.agent.startChat(model, state.messages.slice(0, -1), {
      sessionId: state.currentSessionId,
      activeWebContentsId: getActiveWebContentsId(),
    });
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

function ensureToolCallsArray(message) {
  if (!Array.isArray(message.toolCalls)) message.toolCalls = [];
  return message.toolCalls;
}

function handleToolCall(data) {
  if (!state.activeStreamId || data.streamId !== state.activeStreamId) return;
  if (!state.activeAssistantEl) return;
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== 'assistant') return;
  ensureToolCallsArray(last).push({
    id: data.callId,
    name: data.name,
    tier: data.tier,
    args: data.args,
    status: 'pending',
    result: null,
  });
  appendToolCallCard(state.activeAssistantEl, {
    callId: data.callId,
    name: data.name,
    tier: data.tier,
    args: data.args,
  });
}

function handleToolResult(data) {
  if (!state.activeStreamId || data.streamId !== state.activeStreamId) return;
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== 'assistant') return;
  const calls = ensureToolCallsArray(last);
  const record = calls.find((c) => c.id === data.callId);
  if (record) {
    record.status = data.status;
    record.result = data.result;
  }
  updateToolCallCard(data.callId, data.status, data.result);
}

function handleConsentRequest(data) {
  if (!state.activeStreamId || data.streamId !== state.activeStreamId) return;
  // Replace the existing card's body with consent buttons. The
  // tool-call event has already created the card via handleToolCall.
  updateToolCallCardForConsent(data.callId, data);
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
  // error / partial-on-cancel content + any tool calls) so on next
  // launch the user sees the same conversation state they left.
  if (last?.role === 'assistant' && (last.content || last.toolCalls?.length)) {
    const parts = last.toolCalls?.length ? { toolCalls: last.toolCalls } : null;
    persistMessage('assistant', last.content, parts);
  }

  state.activeStreamId = null;
  state.activeAssistantEl = null;
  state.activeToolCallEls.clear();
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
    state.messages = (session.messages || []).map(rowToInMemoryMessage);
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

  // Restore historical tool-call cards when re-rendering a saved
  // assistant message. Live cards are added by handleToolCall as
  // events arrive — those go through appendToolCallCard instead.
  if (msg.role === 'assistant' && Array.isArray(msg.toolCalls) && !opts.streaming) {
    for (const call of msg.toolCalls) {
      const card = renderToolCallShell(call);
      renderToolCallBody(card, call);
      wrap.appendChild(card.wrapEl);
    }
  }

  messagesEl.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function renderToolCallShell(call) {
  const wrapEl = document.createElement('div');
  wrapEl.className = 'agent-tool-card';
  wrapEl.dataset.callId = call.id;
  wrapEl.dataset.tier = call.tier || '';

  const headerEl = document.createElement('div');
  headerEl.className = 'agent-tool-card-header';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'agent-tool-card-name';
  nameSpan.textContent = call.name;
  const statusSpan = document.createElement('span');
  statusSpan.className = 'agent-tool-card-status';
  headerEl.appendChild(nameSpan);
  headerEl.appendChild(statusSpan);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'agent-tool-card-body';

  wrapEl.appendChild(headerEl);
  wrapEl.appendChild(bodyEl);

  return { wrapEl, headerEl, statusEl: statusSpan, bodyEl };
}

function renderToolCallBody(card, call) {
  card.bodyEl.textContent = '';
  card.statusEl.textContent = call.status || 'pending';
  card.wrapEl.classList.remove('pending', 'allowed', 'denied', 'blocked', 'error', 'consent');
  card.wrapEl.classList.add(call.status || 'pending');

  // Compact args summary so the user can verify the model isn't doing
  // something weird (e.g., navigating to a surprise URL).
  if (call.args && Object.keys(call.args).length > 0) {
    const argsEl = document.createElement('pre');
    argsEl.className = 'agent-tool-card-args';
    argsEl.textContent = JSON.stringify(call.args, null, 2);
    card.bodyEl.appendChild(argsEl);
  }

  if (call.result?.error) {
    const errEl = document.createElement('div');
    errEl.className = 'agent-tool-card-error';
    errEl.textContent = call.result.error;
    card.bodyEl.appendChild(errEl);
  }
}

function appendToolCallCard(assistantWrap, call) {
  // Normalise the streamed event shape (uses `callId`) to the in-memory
  // record shape (uses `id`) so renderToolCallShell / renderToolCallBody
  // can be shared with the session-restore path.
  const normalised = { id: call.callId, ...call };
  const card = renderToolCallShell(normalised);
  renderToolCallBody(card, { ...normalised, status: 'pending' });
  assistantWrap.appendChild(card.wrapEl);
  state.activeToolCallEls.set(call.callId, card);
  scrollToBottom();
}

function updateToolCallCard(callId, status, result) {
  const card = state.activeToolCallEls.get(callId);
  if (!card) return;
  // Re-derive the call from state.messages so the body has args + name.
  const last = state.messages[state.messages.length - 1];
  const record = last?.toolCalls?.find((c) => c.id === callId);
  if (record) {
    renderToolCallBody(card, record);
  } else {
    card.statusEl.textContent = status;
    card.wrapEl.classList.add(status);
    if (result?.error) {
      const errEl = document.createElement('div');
      errEl.className = 'agent-tool-card-error';
      errEl.textContent = result.error;
      card.bodyEl.appendChild(errEl);
    }
  }
  scrollToBottom();
}

function updateToolCallCardForConsent(callId, data) {
  const card = state.activeToolCallEls.get(callId);
  if (!card) return;
  card.wrapEl.classList.add('consent');
  card.statusEl.textContent = 'awaiting consent';

  const prompt = document.createElement('div');
  prompt.className = 'agent-tool-card-consent';
  const desc = document.createElement('p');
  desc.className = 'agent-tool-card-consent-text';
  desc.textContent = `The agent wants to ${data.description || data.name}.`;
  prompt.appendChild(desc);

  const actions = document.createElement('div');
  actions.className = 'agent-tool-card-consent-actions';

  for (const choice of [
    { label: 'Allow once', value: 'allow' },
    { label: 'Allow for session', value: 'allow-session' },
    { label: 'Deny', value: 'deny', danger: true },
  ]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'agent-tool-card-consent-btn' + (choice.danger ? ' danger' : '');
    btn.textContent = choice.label;
    btn.addEventListener('click', () => {
      // Disable all buttons immediately so the user can't double-click;
      // tool result event will replace the consent block when it arrives.
      for (const b of actions.querySelectorAll('button')) b.disabled = true;
      respondConsent(data.callId, choice.value);
    });
    actions.appendChild(btn);
  }
  prompt.appendChild(actions);
  card.bodyEl.appendChild(prompt);
  scrollToBottom();
}

async function respondConsent(callId, decision) {
  if (!state.activeStreamId) return;
  try {
    await window.agent.respondConsent(state.activeStreamId, callId, decision);
  } catch (err) {
    pushDebug(`[ChatUi] respondConsent failed: ${err?.message || err}`);
  }
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
