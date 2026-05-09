/**
 * Composer Thinking-Level Chip
 *
 * Per-prompt control for Pi's `setThinkingLevel`. Renders a small
 * label+chevron chip into the composer's chips slot; click opens a
 * popover with the five Pi thinking levels. Selection is sticky
 * across reloads via localStorage. Pi clamps to model capabilities
 * internally, so the chip can offer all five regardless of which
 * model is active.
 */

const STORAGE_KEY = 'agent.thinkingLevel';
const DEFAULT_LEVEL = 'medium';

// Pi's `ThinkingLevel` (pi-ai/types). The off path is model-config,
// not per-call, so it's not exposed here.
export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

let chipWrap = null;
let chipBtn = null;
let chipValueEl = null;
let popoverEl = null;
let documentClickHandler = null;
let currentLevel = DEFAULT_LEVEL;

function readStored() {
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    return THINKING_LEVELS.includes(stored) ? stored : DEFAULT_LEVEL;
  } catch {
    return DEFAULT_LEVEL;
  }
}

function writeStored(level) {
  try {
    window.localStorage?.setItem(STORAGE_KEY, level);
  } catch {
    // localStorage may be unavailable (private mode, quota); accept the
    // session-only fallback.
  }
}

export function initThinkingChip(slotEl) {
  if (!slotEl) return;
  // Singleton — re-init would leak the prior document click handler and
  // orphan the existing chip in the slot.
  if (chipWrap) return;
  currentLevel = readStored();

  chipWrap = document.createElement('div');
  chipWrap.className = 'agent-chip';

  chipBtn = document.createElement('button');
  chipBtn.type = 'button';
  chipBtn.className = 'agent-chip-btn';
  chipBtn.setAttribute('aria-haspopup', 'listbox');
  chipBtn.setAttribute('aria-expanded', 'false');
  chipBtn.setAttribute('title', 'Thinking depth');

  const stem = document.createElement('span');
  stem.className = 'agent-chip-stem';
  stem.textContent = 'Thinking';

  chipValueEl = document.createElement('span');
  chipValueEl.className = 'agent-chip-value';
  chipValueEl.textContent = currentLevel;

  const chev = document.createElement('span');
  chev.className = 'agent-chip-chevron';
  chev.setAttribute('aria-hidden', 'true');
  chev.textContent = '▾';

  chipBtn.append(stem, chipValueEl, chev);

  popoverEl = document.createElement('div');
  popoverEl.className = 'agent-chip-popover hidden';
  popoverEl.setAttribute('role', 'listbox');
  popoverEl.setAttribute('aria-label', 'Thinking depth');

  for (const level of THINKING_LEVELS) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'agent-chip-option';
    option.setAttribute('role', 'option');
    option.dataset.level = level;
    option.textContent = level;
    if (level === currentLevel) {
      option.classList.add('active');
      option.setAttribute('aria-selected', 'true');
    }
    option.addEventListener('click', () => selectLevel(level));
    popoverEl.appendChild(option);
  }

  chipBtn.addEventListener('click', togglePopover);

  // Close on outside click. Stored so callers/tests can reason about
  // listener registration if needed.
  documentClickHandler = (e) => {
    if (!chipWrap || !popoverEl) return;
    if (popoverEl.classList.contains('hidden')) return;
    if (!chipWrap.contains(e.target)) closePopover();
  };
  document.addEventListener('click', documentClickHandler);

  chipWrap.append(chipBtn, popoverEl);
  slotEl.appendChild(chipWrap);
}

function togglePopover() {
  if (!popoverEl) return;
  if (popoverEl.classList.contains('hidden')) openPopover();
  else closePopover();
}

function openPopover() {
  popoverEl.classList.remove('hidden');
  chipBtn?.setAttribute('aria-expanded', 'true');
}

function closePopover() {
  popoverEl?.classList.add('hidden');
  chipBtn?.setAttribute('aria-expanded', 'false');
}

function selectLevel(level) {
  if (!THINKING_LEVELS.includes(level)) return;
  currentLevel = level;
  writeStored(level);
  if (chipValueEl) chipValueEl.textContent = level;
  if (popoverEl) {
    for (const child of popoverEl.children) {
      const matches = child.dataset.level === level;
      child.classList.toggle('active', matches);
      if (matches) child.setAttribute('aria-selected', 'true');
      else child.removeAttribute('aria-selected');
    }
  }
  closePopover();
}

export function getThinkingLevel() {
  return currentLevel;
}
