// Right-click edit menu for chrome <input> elements (address bar, etc.).
import { showMenuBackdrop, hideMenuBackdrop } from './menu-backdrop.js';

let contextMenu = null;
let activeInput = null;

export const hideChromeInputContextMenu = () => {
  if (!contextMenu || contextMenu.classList.contains('hidden')) return;
  contextMenu.classList.add('hidden');
  activeInput = null;
  hideMenuBackdrop();
};

function updateActionStates(input) {
  if (!contextMenu || !input) return;
  const hasSelection = input.selectionStart !== input.selectionEnd;
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
  updateActionStates(input);
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

function runEditAction(action, input) {
  input.focus();
  switch (action) {
    case 'cut':
      document.execCommand('cut');
      break;
    case 'copy':
      document.execCommand('copy');
      break;
    case 'paste':
      document.execCommand('paste');
      break;
    case 'select-all':
      input.select();
      break;
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
    const action = event.target.closest?.('[data-action]')?.dataset?.action;
    if (!action || !activeInput) return;
    runEditAction(action, activeInput);
    hideChromeInputContextMenu();
  });
};
