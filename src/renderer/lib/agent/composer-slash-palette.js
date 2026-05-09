/**
 * Slash Command Palette
 *
 * Detects `/<prefix>` at the start of the composer input and renders
 * matching commands into the composer popover slot. Keyboard nav with
 * arrows + Enter/Tab to insert, Esc to close, click to insert. Uses
 * capture-phase keydown so it intercepts keys before the composer's
 * submit handler — selecting a command via Enter inserts it rather
 * than submitting whatever's in the input.
 *
 * Inserts `/<name> ` (with trailing space when args expected) and
 * leaves submission to the user. Pi handles `/<name>` as an extension
 * command in `session.prompt(...)` — we just type the right string.
 *
 * The command list is a curated subset of Pi's builtin slash commands
 * that make sense in a browser chat context. TUI-only ones (login,
 * logout, hotkeys, quit, scoped-models, reload) and ones already
 * covered by dedicated UI (model dropdown, + New chat) are omitted.
 * Skills support will extend this dynamically via `pi.getCommands()`.
 */

// Built-in commands are extension-registered slash commands handled by
// pi-extension. Their name == what gets typed into the input.
const BUILTIN_COMMANDS = [
  {
    name: 'compact',
    description: 'Manually compact the session context',
    argsHint: null,
  },
  {
    name: 'clone',
    description: 'Duplicate this chat at the current position',
    argsHint: null,
  },
  {
    name: 'copy',
    description: 'Copy the last assistant message to clipboard',
    argsHint: null,
  },
  {
    name: 'export',
    description: 'Export this session (default HTML; pass a path for .html/.jsonl)',
    argsHint: '[path]',
  },
  {
    name: 'session',
    description: 'Show session info and stats',
    argsHint: null,
  },
  {
    name: 'name',
    description: 'Set this session display name',
    argsHint: '<new name>',
  },
];

// Each entry in `commands` is `{ name, description, argsHint, insertName? }`.
// The display label uses `name` (clean for the user); insertion uses
// `insertName` if present, falling back to `name`. Skills set
// insertName=`skill:foo` so Pi's `_expandSkillCommand` picks them up.
let commands = [...BUILTIN_COMMANDS];

const SLASH_QUERY_RE = /^\/(\w*)$/;

let popoverEl = null;
let inputEl = null;
let onSelectCb = null;
let optionEls = [];
let visible = false;
let selectedIdx = -1;

export const _internals = { BUILTIN_COMMANDS };

export function initSlashPalette({ popover, input, onSelect } = {}) {
  if (!popover || !input) return;
  // Singleton — re-init would double-bind the input and orphan the
  // prior option DOM.
  if (popoverEl) return;
  popoverEl = popover;
  inputEl = input;
  onSelectCb = typeof onSelect === 'function' ? onSelect : null;

  inputEl.addEventListener('input', refresh);
  // Capture phase so we intercept Enter / arrows before the composer's
  // bubble-phase submit / cursor-movement handlers.
  inputEl.addEventListener('keydown', handleKeydown, true);
}

function refresh() {
  const filter = parseSlashQuery(inputEl.value);
  if (filter == null) {
    hide();
    return;
  }
  const matches = commands.filter((c) => c.name.startsWith(filter));
  if (matches.length === 0) {
    hide();
    return;
  }
  render(matches);
  show();
}

/**
 * Replace the dynamic-source slot of the command list (skills, future
 * user-defined entries). Built-ins always come first; extras are
 * appended after, deduped against built-in names.
 */
export function setSlashExtras(extras = []) {
  const builtinNames = new Set(BUILTIN_COMMANDS.map((c) => c.name));
  const safe = extras
    .filter((c) => c && typeof c.name === 'string' && !builtinNames.has(c.name))
    .map((c) => ({
      name: c.name,
      description: c.description || '',
      argsHint: c.argsHint || null,
      insertName: c.insertName || c.name,
    }));
  commands = [...BUILTIN_COMMANDS, ...safe];
  // If the palette is currently open, refresh against the new list.
  if (visible) refresh();
}

function parseSlashQuery(value) {
  const m = SLASH_QUERY_RE.exec(value);
  return m ? m[1] : null;
}

function render(matches) {
  popoverEl.innerHTML = '';
  optionEls = [];
  selectedIdx = matches.length > 0 ? 0 : -1;

  for (let i = 0; i < matches.length; i += 1) {
    const cmd = matches[i];
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'agent-slash-option';
    opt.setAttribute('role', 'option');
    opt.dataset.cmd = cmd.name;

    const head = document.createElement('span');
    head.className = 'agent-slash-option-head';

    const nameEl = document.createElement('span');
    nameEl.className = 'agent-slash-option-name';
    nameEl.textContent = `/${cmd.name}`;
    head.appendChild(nameEl);

    if (cmd.argsHint) {
      const argsEl = document.createElement('span');
      argsEl.className = 'agent-slash-option-args';
      argsEl.textContent = cmd.argsHint;
      head.appendChild(argsEl);
    }

    const descEl = document.createElement('span');
    descEl.className = 'agent-slash-option-desc';
    descEl.textContent = cmd.description;

    opt.append(head, descEl);
    opt.addEventListener('click', () => selectAndClose(cmd));
    opt.addEventListener('mouseenter', () => setSelected(i));
    popoverEl.appendChild(opt);
    optionEls.push(opt);
  }
  paintSelected();
}

function setSelected(idx) {
  selectedIdx = idx;
  paintSelected();
}

function paintSelected() {
  for (let i = 0; i < optionEls.length; i += 1) {
    optionEls[i].classList.toggle('selected', i === selectedIdx);
  }
}

function show() {
  if (visible) return;
  popoverEl.classList.remove('hidden');
  visible = true;
}

function hide() {
  if (!visible) return;
  popoverEl.classList.add('hidden');
  popoverEl.innerHTML = '';
  optionEls = [];
  selectedIdx = -1;
  visible = false;
}

export function isPaletteVisible() {
  return visible;
}

export function hidePalette() {
  hide();
}

function selectAndClose(cmd) {
  if (!cmd) return;
  hide();
  onSelectCb?.(cmd);
}

function handleKeydown(e) {
  if (!visible || optionEls.length === 0) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopImmediatePropagation();
    setSelected((selectedIdx + 1) % optionEls.length);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopImmediatePropagation();
    setSelected((selectedIdx - 1 + optionEls.length) % optionEls.length);
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    if (selectedIdx < 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const cmdName = optionEls[selectedIdx].dataset.cmd;
    const cmd = commands.find((c) => c.name === cmdName);
    selectAndClose(cmd);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    hide();
  }
}
