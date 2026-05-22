// Right-click edit menu for chrome <input> elements (address bar, etc.).
import { showMenuBackdrop, hideMenuBackdrop } from './menu-backdrop.js';

const electronAPI = window.electronAPI;

let contextMenu = null;
let activeInput = null;
let savedSelection = null;
// Serializes async edit actions so a slow Paste cannot overlap a
// follow-up Cut/Copy/Paste against a stale selection range.
let actionInFlight = false;

export const hideChromeInputContextMenu = () => {
  if (!contextMenu || contextMenu.classList.contains('hidden')) return;
  contextMenu.classList.add('hidden');
  activeInput = null;
  savedSelection = null;
  hideMenuBackdrop();
};

function captureSelection(input) {
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? 0;
  return { start, end };
}

function getSelectedText(input, selection) {
  const { start, end } = selection;
  return input.value.slice(start, end);
}

function applySelection(input, selection) {
  input.focus();
  input.setSelectionRange(selection.start, selection.end);
}

function updateActionStates(input, selection) {
  if (!contextMenu || !input) return;
  const hasSelection = selection.start !== selection.end;
  const hasText = input.value.length > 0;
  const cut = contextMenu.querySelector('[data-action="cut"]');
  const copy = contextMenu.querySelector('[data-action="copy"]');
  const selectAll = contextMenu.querySelector('[data-action="select-all"]');
  if (cut) cut.disabled = !hasSelection;
  if (copy) copy.disabled = !hasSelection;
  if (selectAll) selectAll.disabled = !hasText;
}

function showChromeInputContextMenu(input, clientX, clientY, selection) {
  if (!contextMenu || !input) return;

  activeInput = input;
  savedSelection = selection ?? captureSelection(input);
  updateActionStates(input, savedSelection);
  showMenuBackdrop();

  contextMenu.style.left = `${clientX}px`;
  contextMenu.style.top = `${clientY}px`;
  contextMenu.classList.remove('hidden');

  const rect = contextMenu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    contextMenu.style.left = `${window.innerWidth - rect.width - 8}px`;
  }
  if (rect.bottom > window.innerHeight) {
    contextMenu.style.top = `${window.innerHeight - rect.height - 8}px`;
  }
}

async function writeClipboard(text) {
  if (!text) return { success: false };

  try {
    const result = await electronAPI?.copyText?.(text);
    if (result?.success) {
      return { success: true };
    }
  } catch {
    // Fall through to navigator clipboard.
  }

  try {
    await navigator.clipboard.writeText(text);
    return { success: true };
  } catch {
    return { success: false };
  }
}

function selectAllInInput(input) {
  const end = input.value.length;
  input.focus();
  input.select();
  if (input.selectionStart !== 0 || input.selectionEnd !== end) {
    input.setSelectionRange(0, end);
  }
}

async function readClipboard() {
  const result = await electronAPI?.readClipboardText?.();
  if (result?.success) {
    return result.text ?? '';
  }

  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}

async function runEditAction(action, input, selection) {
  applySelection(input, selection);
  let mutated = false;

  switch (action) {
    case 'copy': {
      await writeClipboard(getSelectedText(input, selection));
      break;
    }
    case 'cut': {
      const text = getSelectedText(input, selection);
      const { success } = await writeClipboard(text);
      if (!success) {
        // Restore the selection so the user can retry without data loss.
        applySelection(input, selection);
        break;
      }
      input.value = input.value.slice(0, selection.start) + input.value.slice(selection.end);
      const caret = selection.start;
      input.setSelectionRange(caret, caret);
      mutated = true;
      break;
    }
    case 'paste': {
      const clipText = await readClipboard();
      input.value =
        input.value.slice(0, selection.start) + clipText + input.value.slice(selection.end);
      const caret = selection.start + clipText.length;
      input.setSelectionRange(caret, caret);
      mutated = true;
      break;
    }
    case 'select-all': {
      selectAllInInput(input);
      break;
    }
    default:
      return;
  }

  if (mutated) {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/**
 * @param {{ onOpening?: () => void, inputs?: (HTMLInputElement|null)[] }} [options]
 */
export const initChromeInputContextMenu = (options = {}) => {
  contextMenu = document.getElementById('chrome-input-context-menu');
  if (!contextMenu) return;

  const inputs =
    options.inputs?.filter(Boolean) ??
    [document.getElementById('address-input')].filter(Boolean);

  for (const input of inputs) {
    // The pre-contextmenu selection snapshot is tied to a single mouse
    // gesture. It must be cleared aggressively so a stale range never
    // leaks into an unrelated keyboard / Ctrl-click context menu later.
    let pointerSelection = null;
    const clearPointerSelection = () => {
      pointerSelection = null;
    };

    input.addEventListener('mousedown', (event) => {
      if (event.button !== 2) {
        clearPointerSelection();
        return;
      }
      pointerSelection = {
        ...captureSelection(input),
        capturedAt: event.timeStamp,
      };
    });

    input.addEventListener('blur', clearPointerSelection);

    input.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      options.onOpening?.();

      const liveSelection = captureSelection(input);
      const snapshot = pointerSelection;
      clearPointerSelection();

      // Only trust the mousedown snapshot when it belongs to this same
      // gesture. Browsers fire contextmenu within a few ms of the
      // matching mouseup, so a much older snapshot (the user right-
      // mousedown on the input but released outside, then later opened
      // the menu via keyboard or Ctrl-click) must not be reused.
      const FRESH_GESTURE_WINDOW_MS = 500;
      const isSameGesture =
        snapshot && event.timeStamp - snapshot.capturedAt < FRESH_GESTURE_WINDOW_MS;
      const snapshotHasRange =
        isSameGesture && snapshot.start !== snapshot.end;
      const selection = snapshotHasRange
        ? { start: snapshot.start, end: snapshot.end }
        : liveSelection;

      showChromeInputContextMenu(input, event.clientX, event.clientY, selection);
    });
  }

  contextMenu.addEventListener('click', (event) => {
    const item = event.target.closest?.('.context-menu-item');
    if (!item || item.disabled) return;
    if (actionInFlight) return;

    const action = item.dataset.action;
    const input = activeInput;
    if (!action || !input) return;

    const selection = savedSelection ?? captureSelection(input);
    hideChromeInputContextMenu();

    actionInFlight = true;
    void runEditAction(action, input, selection)
      .then(() => {
        if (action === 'select-all') {
          selectAllInInput(input);
        }
      })
      .finally(() => {
        actionInFlight = false;
      });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideChromeInputContextMenu();
    }
  });
  window.addEventListener('blur', hideChromeInputContextMenu);
};
