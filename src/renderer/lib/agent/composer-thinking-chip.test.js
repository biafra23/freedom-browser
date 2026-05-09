const { createElement, createDocument } = require('../../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const loadChip = async ({ stored = null } = {}) => {
  jest.resetModules();

  const slotEl = createElement('div');
  const document = createDocument({ body: createElement('body') });
  document.body.appendChild(slotEl);

  const localStorageStore = stored ? { 'agent.thinkingLevel': stored } : {};
  global.window = {
    localStorage: {
      getItem: jest.fn((key) => localStorageStore[key] ?? null),
      setItem: jest.fn((key, value) => {
        localStorageStore[key] = value;
      }),
    },
  };
  global.document = document;

  const mod = await import('./composer-thinking-chip.js');
  return { mod, slotEl, document, localStorageStore };
};

describe('composer-thinking-chip', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('defaults to medium when localStorage is empty', async () => {
    const { mod, slotEl } = await loadChip();
    mod.initThinkingChip(slotEl);

    expect(mod.getThinkingLevel()).toBe('medium');
    const value = slotEl.querySelector('.agent-chip-value');
    expect(value.textContent).toBe('medium');
    const active = slotEl.querySelector('.agent-chip-option.active');
    expect(active.dataset.level).toBe('medium');
  });

  test('restores the previously stored level', async () => {
    const { mod, slotEl } = await loadChip({ stored: 'high' });
    mod.initThinkingChip(slotEl);

    expect(mod.getThinkingLevel()).toBe('high');
    expect(slotEl.querySelector('.agent-chip-value').textContent).toBe('high');
    expect(slotEl.querySelector('.agent-chip-option.active').dataset.level).toBe('high');
  });

  test('falls back to medium when stored value is invalid', async () => {
    const { mod, slotEl } = await loadChip({ stored: 'extreme' });
    mod.initThinkingChip(slotEl);
    expect(mod.getThinkingLevel()).toBe('medium');
  });

  test('renders all five thinking levels as options', async () => {
    const { mod, slotEl } = await loadChip();
    mod.initThinkingChip(slotEl);

    const options = slotEl.querySelectorAll('.agent-chip-option');
    const labels = Array.from(options).map((el) => el.dataset.level);
    expect(labels).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
  });

  test('clicking the chip toggles the popover hidden state and aria-expanded', async () => {
    const { mod, slotEl } = await loadChip();
    mod.initThinkingChip(slotEl);

    const btn = slotEl.querySelector('.agent-chip-btn');
    const popover = slotEl.querySelector('.agent-chip-popover');
    expect(popover.classList.contains('hidden')).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    btn.dispatch('click');
    expect(popover.classList.contains('hidden')).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    btn.dispatch('click');
    expect(popover.classList.contains('hidden')).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  test('selecting an option updates state, persists to localStorage, and closes the popover', async () => {
    const { mod, slotEl, localStorageStore } = await loadChip();
    mod.initThinkingChip(slotEl);

    slotEl.querySelector('.agent-chip-btn').dispatch('click');
    const highOption = slotEl.querySelector('[data-level="high"]');
    highOption.dispatch('click');

    expect(mod.getThinkingLevel()).toBe('high');
    expect(slotEl.querySelector('.agent-chip-value').textContent).toBe('high');
    expect(slotEl.querySelector('.agent-chip-option.active').dataset.level).toBe('high');
    expect(localStorageStore['agent.thinkingLevel']).toBe('high');
    expect(slotEl.querySelector('.agent-chip-popover').classList.contains('hidden')).toBe(true);
  });

  test('outside click closes an open popover', async () => {
    const { mod, slotEl, document } = await loadChip();
    mod.initThinkingChip(slotEl);

    slotEl.querySelector('.agent-chip-btn').dispatch('click');
    const popover = slotEl.querySelector('.agent-chip-popover');
    expect(popover.classList.contains('hidden')).toBe(false);

    document.handlers.click({ target: createElement('div') });
    expect(popover.classList.contains('hidden')).toBe(true);
  });

  test('initThinkingChip is a no-op when slot is missing', async () => {
    const { mod } = await loadChip();
    expect(() => mod.initThinkingChip(null)).not.toThrow();
    expect(mod.getThinkingLevel()).toBe('medium');
  });

  test('survives a missing localStorage gracefully', async () => {
    jest.resetModules();
    const slotEl = createElement('div');
    const document = createDocument({ body: createElement('body') });
    document.body.appendChild(slotEl);
    global.window = {};
    global.document = document;

    const mod = await import('./composer-thinking-chip.js');
    expect(() => mod.initThinkingChip(slotEl)).not.toThrow();
    expect(mod.getThinkingLevel()).toBe('medium');

    slotEl.querySelector('.agent-chip-btn').dispatch('click');
    slotEl.querySelector('[data-level="low"]').dispatch('click');
    expect(mod.getThinkingLevel()).toBe('low');
  });
});
