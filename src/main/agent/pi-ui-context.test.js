jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const log = require('../logger');
const { createPiUIContext } = require('./pi-ui-context');

describe('createPiUIContext (Phase 1 stub)', () => {
  beforeEach(() => {
    log.info.mockClear();
    log.warn.mockClear();
    log.error.mockClear();
  });

  test('confirm() warns and resolves false', async () => {
    const ui = createPiUIContext();
    await expect(ui.confirm('Title', 'Message')).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('not yet wired'),
      expect.any(Array)
    );
  });

  test('select() warns and resolves undefined', async () => {
    const ui = createPiUIContext();
    await expect(ui.select('Pick', ['a', 'b'])).resolves.toBeUndefined();
  });

  test('input() warns and resolves undefined', async () => {
    const ui = createPiUIContext();
    await expect(ui.input('Title')).resolves.toBeUndefined();
  });

  test('notify() logs and returns no value', () => {
    const ui = createPiUIContext();
    expect(ui.notify('hello', 'info')).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('notify()'),
      expect.any(Array)
    );
  });

  test('TUI affordances are no-ops (no throw)', () => {
    const ui = createPiUIContext();
    expect(() => ui.setWidget('x', ['line'])).not.toThrow();
    expect(() => ui.setFooter(undefined)).not.toThrow();
    expect(() => ui.setHeader(undefined)).not.toThrow();
    expect(() => ui.pasteToEditor('x')).not.toThrow();
  });

  test('theme accessors return safe defaults', () => {
    const ui = createPiUIContext();
    expect(ui.theme).toEqual(expect.objectContaining({ name: 'freedom-noop' }));
    expect(ui.getAllThemes()).toEqual([]);
    expect(ui.getTheme('anything')).toBeUndefined();
    expect(ui.setTheme('anything')).toEqual(
      expect.objectContaining({ success: false })
    );
  });

  test('custom() throws so we notice if Pi calls it', () => {
    const ui = createPiUIContext();
    expect(() => ui.custom(() => null)).toThrow(/not implemented/);
  });

  test('onTerminalInput returns an unsubscribe function', () => {
    const ui = createPiUIContext();
    const unsubscribe = ui.onTerminalInput(() => undefined);
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });
});
