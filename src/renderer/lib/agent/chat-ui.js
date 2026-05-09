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
import { initThinkingChip, getThinkingLevel } from './composer-thinking-chip.js';
import { initSlashPalette, isPaletteVisible, hidePalette } from './composer-slash-palette.js';
import { renderToolBody, SUBAGENT_CHILDREN_CLASS } from './tool-card-renderers.js';
import { pushDebug } from '../debug.js';
import { getActiveWebview } from '../tabs.js';

const FALLBACK_MODEL = 'gemma4:e2b';
// Mirror of `.agent-input { max-height }` in sidebar.css. The two must
// stay in lockstep — the JS clamp prevents the textarea from growing
// past what CSS will scroll.
const MAX_TEXTAREA_HEIGHT_PX = 200;

const state = {
  messages: [],
  activeStreamId: null,
  activeAssistantEl: null,
  // Cached ref to the active assistant's thinking-disclosure body so
  // per-chunk thinking updates don't have to querySelector through the
  // bubble's growing descendant tree.
  activeAssistantThinkingBodyEl: null,
  // Tool-call cards live inside the active assistant message's bubble.
  // toolCallEls maps callId → { wrapEl, headerEl, bodyEl } so the
  // tool-result + consent-response handlers can update the card in
  // place without re-rendering the whole message. Phase 3 brings this
  // back to life; Phase 2 leaves the wiring in place but no events fire.
  activeToolCallEls: new Map(),
  // Held while a session_before_compact has fired but no matching
  // session_compact has arrived. The end event mutates this element
  // in place so the conversation gets one permanent compaction
  // marker, not two stacked notices.
  activeCompactionEl: null,
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
  inputEl.addEventListener('input', () => {
    autoGrowInput();
    syncSendDisabled();
  });
  syncSendDisabled();
  initThinkingChip(document.getElementById('agent-composer-chips'));
  initSlashPalette({
    popover: document.getElementById('agent-composer-popover'),
    input: inputEl,
    onSelect: handleSlashCommandPick,
  });
  const slashBtn = document.getElementById('agent-slash-btn');
  slashBtn?.addEventListener('click', () => {
    if (state.activeStreamId) return;
    if (isPaletteVisible()) {
      hidePalette();
      // If the input is just the bare `/` we typed when opening, clear
      // it — saves the user a backspace. Otherwise leave whatever they
      // typed alone.
      if (inputEl.value === '/') {
        inputEl.value = '';
        syncSendDisabled();
        autoGrowInput();
      }
      return;
    }
    inputEl.value = '/';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.focus();
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
  window.agent.onThinkingChunk?.((data) => handleThinkingChunk(data));
  window.agent.onChatDone((data) => handleDone(data));
  window.agent.onToolCall((data) => handleToolCall(data));
  window.agent.onToolResult((data) => handleToolResult(data));
  window.agent.onConsentRequest((data) => handleConsentRequest(data));
  window.agent.onChatNotice?.((data) => handleNotice(data));

  document.addEventListener('sidebar-opened', (event) => {
    if (event.detail?.id === 'ai-sidebar') refreshStatus();
  });

  window.ollama?.onStatusUpdate?.(() => refreshStatus());

  refreshStatus();
  renderMessages();
  // Cold-start always opens a fresh chat — past conversations are
  // reachable via the history view. Auto-resuming the most recent
  // session was confusing: opening the sidebar showed yesterday's
  // chat instead of an empty composer.
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
  state.activeAssistantThinkingBodyEl = null;
  state.activeCompactionEl = null;
  renderMessages();
  return true;
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
  autoGrowInput();
  setComposerBusy(true);

  // The assistant bubble is created lazily by ensureActiveAssistant()
  // on the first chunk / thinking / tool event. Slash commands fire
  // none of those (they post `notice` IPCs only) so no empty bubble
  // appears for command-only turns.

  try {
    const result = await window.agent.startChat({
      sessionPath,
      model,
      prompt: text,
      thinkingLevel: getThinkingLevel(),
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

// Idempotent — first call (per turn) inserts an empty assistant message
// and its DOM bubble; subsequent calls are no-ops. Splitting bubble
// creation out of handleSubmit lets slash commands (which produce no
// chunks) finish without rendering an empty bubble.
function ensureActiveAssistant() {
  if (state.activeAssistantEl) return state.activeAssistantEl;
  const assistantMsg = { role: 'assistant', content: '' };
  state.messages.push(assistantMsg);
  state.activeAssistantEl = appendMessage(assistantMsg, { streaming: true });
  return state.activeAssistantEl;
}

function handleChunk(data) {
  if (!state.activeStreamId || data.streamId !== state.activeStreamId) return;
  if (!ensureActiveAssistant()) return;
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== 'assistant') return;
  last.content += data.content;
  scheduleAssistantRender();
}

function handleThinkingChunk(data) {
  if (!state.activeStreamId || data.streamId !== state.activeStreamId) return;
  if (!ensureActiveAssistant()) return;
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== 'assistant') return;
  last.thinking = (last.thinking || '') + data.content;
  ensureThinkingDisclosure(state.activeAssistantEl, last);
}

function ensureToolCallsArray(message) {
  if (!Array.isArray(message.toolCalls)) message.toolCalls = [];
  return message.toolCalls;
}

function handleToolCall(data) {
  if (!state.activeStreamId || data.streamId !== state.activeStreamId) return;
  if (!ensureActiveAssistant()) return;
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== 'assistant') return;
  const record = {
    id: data.callId,
    name: data.name,
    tier: data.tier,
    args: data.args,
    status: 'pending',
    result: null,
    subagentCallId: data.subagentCallId ?? null,
  };
  ensureToolCallsArray(last).push(record);
  appendToolCallCard(targetForToolCard(record), record);
}

// Inner subagent calls nest under the parent spawn_subagent card's
// children container (built by tool-card-renderers' renderSpawnSubagent
// — see SUBAGENT_CHILDREN_CLASS). Top-level cards attach directly to
// the assistant bubble.
function targetForToolCard(record) {
  if (record.subagentCallId) {
    const parentCard = state.activeToolCallEls.get(record.subagentCallId);
    const nested = parentCard?.bodyEl.querySelector(`.${SUBAGENT_CHILDREN_CLASS}`);
    if (nested) return nested;
  }
  return state.activeAssistantEl;
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

// No-arg commands auto-submit on pick — the user already chose; making
// them press Enter again is friction. Commands with args land in the
// input so the user can type them.
//
// We do NOT dispatch an `input` event after assigning to inputEl.value,
// because the palette listens for `input` and would re-show itself
// against the freshly-set `/cmd` value (the bug from Phase 6.4 follow-up
// smoke). Call the input-derived helpers directly instead.
function handleSlashCommandPick(cmd) {
  if (!cmd || !inputEl) return;
  inputEl.value = cmd.argsHint ? `/${cmd.name} ` : `/${cmd.name}`;
  syncSendDisabled();
  autoGrowInput();
  if (!cmd.argsHint && composerEl) {
    composerEl.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return;
  }
  inputEl.focus?.();
  if (typeof inputEl.setSelectionRange === 'function') {
    const pos = inputEl.value.length;
    inputEl.setSelectionRange(pos, pos);
  }
}

function handleNotice(data) {
  if (!data || !messagesEl) return;

  // Compaction is a two-event sequence: the start fires a sticky
  // indicator we keep a reference to, and the end re-uses that same
  // element so the conversation gets a single permanent marker
  // showing where context was summarised — not two stacked bubbles.
  if (data.kind === 'compaction-start') {
    state.activeCompactionEl = appendCompactionNotice(data.text || 'Compacting context…', true);
    return;
  }
  if (data.kind === 'compaction-end') {
    const text = data.text || 'Context compacted';
    if (state.activeCompactionEl) {
      state.activeCompactionEl.classList.remove('compacting');
      state.activeCompactionEl.textContent = text;
      state.activeCompactionEl = null;
    } else {
      // No matching start — render the end as a standalone marker.
      appendCompactionNotice(text, false);
    }
    scrollToBottom();
    return;
  }

  if (!data.text) return;
  const kind = data.kind === 'error' ? 'error' : 'info';
  const el = document.createElement('div');
  el.className = `agent-notice agent-notice-${kind}`;
  el.textContent = data.text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function appendCompactionNotice(text, compacting) {
  const el = document.createElement('div');
  el.className = `agent-notice agent-notice-compaction${compacting ? ' compacting' : ''}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
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
  // Errors and cancellations need a visible bubble even when no chunks
  // ever arrived (e.g. startChat rejected before the first delta) so
  // the user sees what happened. Slash-command turns finish without
  // chunks and without errors — those legitimately need no bubble.
  if (error || cancelled) ensureActiveAssistant();
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
      if (typeof fullContent === 'string' && fullContent && last?.role === 'assistant') {
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
  state.activeAssistantThinkingBodyEl = null;
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
  state.activeAssistantThinkingBodyEl = null;
  state.activeCompactionEl = null;
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
    syncSendDisabled();
  }
}

function syncSendDisabled() {
  if (!sendBtn || !inputEl) return;
  sendBtn.disabled = inputEl.value.trim().length === 0;
}

function autoGrowInput() {
  if (!inputEl) return;
  inputEl.style.height = 'auto';
  const next = Math.min(inputEl.scrollHeight || 0, MAX_TEXTAREA_HEIGHT_PX);
  if (next > 0) {
    inputEl.style.height = `${next}px`;
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
  // Thinking goes BEFORE content — it's collapsible, so it doesn't
  // dominate, and putting it above signals "this is reasoning that
  // came before the answer". Surfaces both during live streaming and
  // when restoring sessions where Pi persisted ThinkingContent blocks.
  if (msg.role === 'assistant' && msg.thinking) {
    wrap.appendChild(buildThinkingDisclosure(msg.thinking).details);
  }
  wrap.appendChild(content);

  // Restore historical tool-call cards when re-rendering. Subagent
  // nesting (the live path's targetForToolCard routing) is intentionally
  // not honoured here: Pi's JSONL doesn't persist subagentCallId, so a
  // restored conversation renders inner cards as siblings — known
  // cosmetic gap, not a correctness one.
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

function buildThinkingDisclosure(thinkingText) {
  const details = document.createElement('details');
  details.className = 'agent-message-thinking';
  const summary = document.createElement('summary');
  summary.className = 'agent-message-thinking-summary';
  summary.textContent = 'Thinking';
  const body = document.createElement('div');
  body.className = 'agent-message-thinking-body';
  body.textContent = thinkingText;
  details.appendChild(summary);
  details.appendChild(body);
  return { details, body };
}

// During streaming, we get thinking chunks before the assistant has
// finished its text response. Insert the disclosure on the first chunk
// and cache its body ref so subsequent chunks skip the querySelector
// walk through the bubble's descendant tree.
function ensureThinkingDisclosure(wrap, msg) {
  if (!state.activeAssistantThinkingBodyEl) {
    const { details, body } = buildThinkingDisclosure(msg.thinking);
    const content = wrap.querySelector('.agent-message-content');
    wrap.insertBefore(details, content);
    state.activeAssistantThinkingBodyEl = body;
  } else {
    state.activeAssistantThinkingBodyEl.textContent = msg.thinking;
  }
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
  card.bodyEl.appendChild(renderToolBody(call));
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

export const _internals = { state, hydrateFromSession, handleSlashCommandPick };
