/**
 * Chat UI
 *
 * Minimal message-list + composer wired to the main-process Ollama
 * sidecar via the `window.agent` preload bridge. Streaming tokens are
 * appended to the in-flight assistant message as they arrive over IPC.
 *
 * Conversation is in-memory only for now — Phase 3 of the plan adds the
 * SQLite-backed sessions store.
 */

const FALLBACK_MODEL = 'gemma4:e2b';

const state = {
  messages: [],
  activeStreamId: null,
  activeAssistantEl: null,
  selectedModel: null,
  models: [],
  daemonRunning: false,
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
    console.warn('[ChatUi] Required elements not found');
    return;
  }

  if (!window.agent) {
    console.warn('[ChatUi] window.agent bridge not available');
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
  clearBtn?.addEventListener('click', handleClear);
  modelSelect?.addEventListener('change', () => {
    state.selectedModel = modelSelect.value;
  });

  window.agent.onChatChunk((data) => handleChunk(data));
  window.agent.onChatDone((data) => handleDone(data));

  refreshStatus();
  renderMessages();
  console.log('[ChatUi] Initialized');
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
      // Prefer the previously selected model if it's still available; otherwise
      // pick gemma4:e2b if present, otherwise the first installed model.
      const preferred =
        (state.selectedModel && choices.includes(state.selectedModel)
          ? state.selectedModel
          : null) ||
        (choices.includes(FALLBACK_MODEL) ? FALLBACK_MODEL : choices[0]);
      modelSelect.value = preferred;
      state.selectedModel = preferred;
    }
  } catch (err) {
    console.error('[ChatUi] Status refresh failed:', err);
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

async function handleSubmit(e) {
  e.preventDefault();
  if (state.activeStreamId) {
    return;
  }
  const text = inputEl.value.trim();
  if (!text) return;

  const model = state.selectedModel || (modelSelect && modelSelect.value) || FALLBACK_MODEL;

  state.messages.push({ role: 'user', content: text });
  appendMessage({ role: 'user', content: text });
  inputEl.value = '';
  setComposerBusy(true);

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

function handleChunk(data) {
  if (!state.activeStreamId || data.streamId !== state.activeStreamId) return;
  if (!state.activeAssistantEl) return;
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== 'assistant') return;
  last.content += data.content;
  const contentEl = state.activeAssistantEl.querySelector('.agent-message-content');
  if (contentEl) {
    contentEl.textContent = last.content;
    scrollToBottom();
  }
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
        contentEl.textContent =
          (last?.content ? `${last.content}\n\n` : '') + `Error: ${error}`;
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
        if (contentEl) contentEl.textContent = fullContent;
      }
      if (stats?.eval_count != null) {
        const tokens = stats.eval_count;
        const seconds = (stats.total_duration || 0) / 1e9;
        const rate = seconds > 0 ? (tokens / seconds).toFixed(1) : '?';
        appendMeta(el, `${tokens} tok · ${seconds.toFixed(1)}s · ${rate} tok/s`);
      }
    }
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
    console.warn('[ChatUi] Cancel failed:', err);
  }
}

function handleClear() {
  if (state.activeStreamId) return;
  state.messages = [];
  renderMessages();
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
  // Remove the empty state if it's the only child.
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
  content.textContent = msg.content || '';

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
