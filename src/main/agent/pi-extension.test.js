jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const log = require('../logger');
const { createFreedomExtension } = require('./pi-extension');

describe('createFreedomExtension', () => {
  beforeEach(() => {
    log.info.mockClear();
    log.warn.mockClear();
    log.error.mockClear();
  });

  function makeFakePiApi() {
    const handlers = new Map();
    return {
      handlers,
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    };
  }

  test('returns an async factory function', () => {
    const factory = createFreedomExtension();
    expect(typeof factory).toBe('function');
  });

  test('registers exactly the lifecycle hooks Phase 1 needs', async () => {
    const factory = createFreedomExtension();
    const pi = makeFakePiApi();
    await factory(pi);
    expect([...pi.handlers.keys()].sort()).toEqual(['session_shutdown', 'session_start']);
  });

  test('session_start handler logs a bind notice', async () => {
    const factory = createFreedomExtension();
    const pi = makeFakePiApi();
    await factory(pi);
    const handler = pi.handlers.get('session_start')[0];
    await handler({}, {});
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('bound to session'));
  });

  test('session_shutdown handler logs the reason', async () => {
    const factory = createFreedomExtension();
    const pi = makeFakePiApi();
    await factory(pi);
    const handler = pi.handlers.get('session_shutdown')[0];
    await handler({ reason: 'quit' });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('quit'));
  });
});
