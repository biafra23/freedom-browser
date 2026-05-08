/**
 * Chat UI
 *
 * Message-list + composer wired to the main-process Pi runtime via the
 * `window.agent` preload bridge. Pi owns the conversation log: each
 * session is a JSONL file under `userData/pi-agent/sessions/`, and the
 * `id` we pass back and forth IS that file path.
 *
 * Per-prompt flow: renderer ensures a session exists (create on first
 * prompt of a new chat), calls `agent.startChat({ sessionPath, model,
 * prompt })`, then streams text deltas into the active assistant
 * bubble. Pi auto-restores prior history when the same sessionPath is
 * opened again, so we don't ship the message array over IPC.
 *
 * Tool calls are wired in Phase 3; Phase 2 is chat-only. The tool-call
 * card / consent handlers below are kept but no events trigger them yet.
 */

import { renderMarkdown } from './markdown.js';
import { adaptMessages } from './pi-message-adapter.js';
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
  // place without re-rendering the whole message. Phase 3 brings this
  // back to life; Phase 2 leaves the wiring in place but no events fire.
  activeToolCallEls: new Map(),
  selectedModel: null,
  models: [],
  daemonRunning: false,
  // The Pi JSONL path of the open session. null = "fresh chat, no JSONL
  // exists yet" — first user prompt creates one via createSession.
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
  document.addEventListener('click', (e) => {
    if (modelSelector && !modelSelector.contains(e.target)) {
      closeModelDropdown();
    }
  });

  window.agent.onChatChunk((data) => handleChunk(data));
  window.agent.onChatDone((data) => handleDone(data));
  window.agent.onToolCall((data) => handleToolCall(data));
  window.agent.onToolResult((data) => handleToolResult(data));
  window.agent.onConsentRequest((data) => handleConsentRequest(data));

  document.addEventListener('sidebar-opened', (event) => {
    if (event.detail?.id === 'ai-sidebar') refreshStatus();
  });

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

function hydrateFromSession(session) {
  if (!session) return false;
  state.currentSessionId = session.id;
  state.messages = adaptMessages(session.messages);
  state.activeToolCallEls.clear();
  renderMessages();
  return true;
}

// On startup, resume the most recent session so conversations survive
// quit/reopen. Pi's session list is read from JSONL files on disk; the
// renderer just renders what comes back.
async function loadCurrentSession() {
  try {
    hydrateFromSession(await window.agent.getRecentSession());
  } catch (err) {
    pushDebug(`[ChatUi] Could not load recent session: ${err?.message || err}`);
  }
}

const TITLE_MAX_LEN = 40;

function autoTitleFromMessage(text) {
  const trimmed = (text || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  if (trimmed.length <= TITLE_MAX_LEN) return trimmed;
  return trimmed.slice(0, TITLE_MAX_LEN - 1) + '…';
}

async function ensureSession(initialTitle = null) {
  if (state.currentSessionId) return state.currentSessionId;
  const session = await window.agent.createSession({ title: initialTitle });
  state.currentSessionId = session.id;
  return session.id;
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
  // Auto-title from the first user message of a fresh chat. Existing
  // sessions keep their stored name.
  const initialTitle =
    !state.currentSessionId && state.messages.length === 0
      ? autoTitleFromMessage(text)
      : null;
  const sessionPath = await ensureSession(initialTitle);

  state.messages.push({ role: 'user', content: text });
  appendMessage({ role: 'user', content: text });
  inputEl.value = '';
  setComposerBusy(true);

  // Insert an empty assistant message that we'll stream into.
  const assistantMsg = { role: 'assistant', content: '' };
  state.messages.push(assistantMsg);
  state.activeAssistantEl = appendMessage(assistantMsg, { streaming: true });

  try {
    const result = await window.agent.startChat({
      sessionPath,
      model,
      prompt: text,
      activeWebContentsId: getActiveWebContentsId(),
    });
    if (result?.error) {
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
// so we coalesce to one render per animation frame.
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
  const record = {
    id: data.callId,
    name: data.name,
    tier: data.tier,
    args: data.args,
    status: 'pending',
    result: null,
  };
  ensureToolCallsArray(last).push(record);
  appendToolCallCard(state.activeAssistantEl, record);
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
  updateToolCallCard(data.callId);
}

function handleConsentRequest(data) {
  if (!state.activeStreamId || data.streamId !== state.activeStreamId) return;
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
// JSONL via createSession. The old session remains on disk and shows up
// in the sessions list.
export function startNewSession() {
  if (state.activeStreamId) return false;
  state.currentSessionId = null;
  state.messages = [];
  state.activeToolCallEls.clear();
  renderMessages();
  return true;
}

// Load a saved session into the chat view. Used by the sessions UI.
export async function loadSessionById(id) {
  if (state.activeStreamId) return false;
  try {
    return hydrateFromSession(await window.agent.getSession(id));
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
      '<strong>Local AI Chat</strong><span>Ask the model anything. Conversations persist as Pi sessions on disk and survive restarts.</span>';
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

  // Restore historical tool-call cards when re-rendering. Phase 3 will
  // emit live cards via handleToolCall once tool wiring lands.
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

function appendToolCallCard(assistantWrap, record) {
  const card = renderToolCallShell(record);
  renderToolCallBody(card, record);
  assistantWrap.appendChild(card.wrapEl);
  state.activeToolCallEls.set(record.id, card);
  scrollToBottom();
}

function updateToolCallCard(callId) {
  const card = state.activeToolCallEls.get(callId);
  if (!card) return;
  const last = state.messages[state.messages.length - 1];
  const record = last?.toolCalls?.find((c) => c.id === callId);
  if (!record) return;
  renderToolCallBody(card, record);
  scrollToBottom();
}

const CONSENT_CHOICES = Object.freeze([
  { label: 'Allow once', value: 'allow' },
  { label: 'Allow for session', value: 'allow-session' },
  { label: 'Deny', value: 'deny', danger: true },
]);

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

  for (const choice of CONSENT_CHOICES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'agent-tool-card-consent-btn' + (choice.danger ? ' danger' : '');
    btn.dataset.action = choice.value;
    btn.textContent = choice.label;
    btn.addEventListener('click', () => {
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

export const _internals = { state, hydrateFromSession };
