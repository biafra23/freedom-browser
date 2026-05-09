const { createElement, createDocument } = require('../../../../test/helpers/fake-dom.js');

const originalDocument = global.document;
const originalEvent = global.Event;

class FakeEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = !!opts.bubbles;
  }
}

const loadPalette = async () => {
  jest.resetModules();
  const popoverEl = createElement('div', { classes: ['hidden'] });
  const inputEl = createElement('textarea');
  inputEl.value = '';
  inputEl.focus = jest.fn();
  inputEl.setSelectionRange = jest.fn();
  const document = createDocument({ body: createElement('body') });
  document.body.appendChild(popoverEl);
  document.body.appendChild(inputEl);
  global.document = document;
  global.Event = FakeEvent;

  const onSelect = jest.fn();
  const mod = await import('./composer-slash-palette.js');
  mod.initSlashPalette({ popover: popoverEl, input: inputEl, onSelect });
  return { mod, popoverEl, inputEl, onSelect };
};

const typeAndDispatch = (inputEl, value) => {
  inputEl.value = value;
  inputEl.dispatch('input');
};

const keydown = (inputEl, key, extra = {}) => {
  inputEl.dispatch('keydown', {
    key,
    preventDefault: jest.fn(),
    stopImmediatePropagation: jest.fn(),
    ...extra,
  });
};

describe('composer-slash-palette', () => {
  afterEach(() => {
    global.document = originalDocument;
    global.Event = originalEvent;
    jest.restoreAllMocks();
  });

  test('palette stays hidden when input does not start with /', async () => {
    const { popoverEl, inputEl } = await loadPalette();
    typeAndDispatch(inputEl, 'hello');
    expect(popoverEl.classList.contains('hidden')).toBe(true);
    expect(popoverEl.children).toHaveLength(0);
  });

  test('typing a single / opens the palette with all curated commands', async () => {
    const { mod, popoverEl, inputEl } = await loadPalette();
    typeAndDispatch(inputEl, '/');
    expect(popoverEl.classList.contains('hidden')).toBe(false);
    expect(popoverEl.children).toHaveLength(mod._internals.COMMANDS.length);
  });

  test('typing /co filters to compact + copy (clone is excluded — does not start with co)', async () => {
    const { popoverEl, inputEl } = await loadPalette();
    typeAndDispatch(inputEl, '/co');
    const names = Array.from(popoverEl.children).map((el) => el.dataset.cmd);
    expect(names).toEqual(['compact', 'copy']);
    expect(popoverEl.children[0].classList.contains('selected')).toBe(true);
  });

  test('typing a slash query that matches nothing hides the palette', async () => {
    const { popoverEl, inputEl } = await loadPalette();
    typeAndDispatch(inputEl, '/');
    expect(popoverEl.classList.contains('hidden')).toBe(false);
    typeAndDispatch(inputEl, '/zzz');
    expect(popoverEl.classList.contains('hidden')).toBe(true);
    expect(popoverEl.children).toHaveLength(0);
  });

  test('palette hides as soon as input no longer matches the slash regex', async () => {
    const { popoverEl, inputEl } = await loadPalette();
    typeAndDispatch(inputEl, '/com');
    expect(popoverEl.classList.contains('hidden')).toBe(false);
    // Adding a space breaks the slash query — palette should hide.
    typeAndDispatch(inputEl, '/com ');
    expect(popoverEl.classList.contains('hidden')).toBe(true);
  });

  test('clicking an option calls onSelect with the chosen command and hides the palette', async () => {
    const { popoverEl, inputEl, onSelect } = await loadPalette();
    typeAndDispatch(inputEl, '/');

    const exportOpt = popoverEl.querySelector('[data-cmd="export"]');
    exportOpt.dispatch('click');

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'export', argsHint: '[path]' }));
    expect(popoverEl.classList.contains('hidden')).toBe(true);
  });

  test('clicking a no-arg command also calls onSelect (the host owns insert vs auto-submit)', async () => {
    const { popoverEl, inputEl, onSelect } = await loadPalette();
    typeAndDispatch(inputEl, '/');

    popoverEl.querySelector('[data-cmd="compact"]').dispatch('click');

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'compact', argsHint: null }));
  });

  test('arrow-down advances the selection and arrow-up wraps backwards', async () => {
    const { popoverEl, inputEl } = await loadPalette();
    typeAndDispatch(inputEl, '/c'); // matches: compact, clone, copy

    expect(popoverEl.children[0].dataset.cmd).toBe('compact');
    expect(popoverEl.children[0].classList.contains('selected')).toBe(true);

    keydown(inputEl, 'ArrowDown');
    expect(popoverEl.children[1].classList.contains('selected')).toBe(true);

    keydown(inputEl, 'ArrowDown');
    expect(popoverEl.children[2].classList.contains('selected')).toBe(true);

    // wraps to first
    keydown(inputEl, 'ArrowDown');
    expect(popoverEl.children[0].classList.contains('selected')).toBe(true);

    // wraps to last
    keydown(inputEl, 'ArrowUp');
    expect(popoverEl.children[2].classList.contains('selected')).toBe(true);
  });

  test('Enter on a highlighted option calls onSelect and stops propagation', async () => {
    const { popoverEl, inputEl, onSelect } = await loadPalette();
    typeAndDispatch(inputEl, '/c');
    keydown(inputEl, 'ArrowDown'); // select clone

    const evt = {
      key: 'Enter',
      preventDefault: jest.fn(),
      stopImmediatePropagation: jest.fn(),
    };
    inputEl.dispatch('keydown', evt);

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'clone' }));
    expect(evt.preventDefault).toHaveBeenCalled();
    expect(evt.stopImmediatePropagation).toHaveBeenCalled();
    expect(popoverEl.classList.contains('hidden')).toBe(true);
  });

  test('Tab also calls onSelect for the highlighted option', async () => {
    const { popoverEl, inputEl, onSelect } = await loadPalette();
    typeAndDispatch(inputEl, '/co');

    keydown(inputEl, 'Tab');

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'compact' }));
    expect(popoverEl.classList.contains('hidden')).toBe(true);
  });

  test('Escape closes the palette without inserting', async () => {
    const { popoverEl, inputEl } = await loadPalette();
    typeAndDispatch(inputEl, '/');
    expect(popoverEl.classList.contains('hidden')).toBe(false);

    keydown(inputEl, 'Escape');
    expect(popoverEl.classList.contains('hidden')).toBe(true);
    expect(inputEl.value).toBe('/');
  });

  test('keys are inert when palette is hidden', async () => {
    const { inputEl } = await loadPalette();
    const evt = {
      key: 'Enter',
      preventDefault: jest.fn(),
      stopImmediatePropagation: jest.fn(),
    };
    inputEl.dispatch('keydown', evt);
    expect(evt.preventDefault).not.toHaveBeenCalled();
    expect(evt.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  test('initSlashPalette is a no-op when popover or input is missing', async () => {
    const { mod } = await loadPalette();
    expect(() => mod.initSlashPalette({})).not.toThrow();
    expect(() => mod.initSlashPalette({ popover: null, input: null })).not.toThrow();
  });
});
