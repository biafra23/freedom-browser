// Right-click edit menu for chrome <input> elements (address bar, etc.).
import { showMenuBackdrop, hideMenuBackdrop } from './menu-backdrop.js';

const electronAPI = window.electronAPI;

let contextMenu = null;
let activeInput = null;
let savedSelection = null;

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

function showChromeInputContextMenu(input, clientX, clientY) {
  if (!contextMenu || !input) return;

  activeInput = input;
  savedSelection = captureSelection(input);
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
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    await electronAPI?.copyText?.(text);
  }
}

async function readClipboard() {
  try {
    return await navigator.clipboard.readText();
  } catch {
    const result = await electronAPI?.readClipboardText?.();
    return result?.text ?? '';
  }
}

async function runEditAction(action, input) {
  const selection = savedSelection ?? captureSelection(input);
  applySelection(input, selection);

  switch (action) {
    case 'copy': {
      await writeClipboard(getSelectedText(input, selection));
      break;
    }
    case 'cut': {
      const text = getSelectedText(input, selection);
      await writeClipboard(text);
      input.value = input.value.slice(0, selection.start) + input.value.slice(selection.end);
      const caret = selection.start;
      input.setSelectionRange(caret, caret);
      break;
    }
    case 'paste': {
      const clipText = await readClipboard();
      input.value =
        input.value.slice(0, selection.start) + clipText + input.value.slice(selection.end);
      const caret = selection.start + clipText.length;
      input.setSelectionRange(caret, caret);
      break;
    }
    case 'select-all': {
      const end = input.value.length;
      input.setSelectionRange(0, end);
      break;
    }
    default:
      return;
  }

  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * @param {{ onOpening?: () => void, inputs?: (HTMLInputElement|null)[] }} [options]
 */
export const initChromeInputContextMenu = (options = {}) => {
  contextMenu = document.getElementById('chrome-input-context-menu');
  if (!contextMenu) return;

  // Keep focus and text selection on the input while the menu is used.
  contextMenu.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });

  const inputs =
    options.inputs?.filter(Boolean) ??
    [document.getElementById('address-input')].filter(Boolean);

  for (const input of inputs) {
    input.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      options.onOpening?.();
      showChromeInputContextMenu(input, event.clientX, event.clientY);
    });
  }

  contextMenu.addEventListener('click', (event) => {
    const item = event.target.closest?.('.context-menu-item');
    if (!item || item.disabled) return;

    const action = item.dataset.action;
    if (!action || !activeInput) return;

    void runEditAction(action, activeInput).finally(() => {
      hideChromeInputContextMenu();
    });
  });
};
