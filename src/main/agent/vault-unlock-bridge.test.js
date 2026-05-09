jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockFromId = jest.fn();
jest.mock('electron', () => ({
  webContents: { fromId: (...args) => mockFromId(...args) },
}));

const IPC = require('../../shared/ipc-channels');
const bridge = require('./vault-unlock-bridge');

function fakeWc() {
  return {
    isDestroyed: jest.fn(() => false),
    send: jest.fn(),
  };
}

beforeEach(() => {
  bridge._internals.clearAll();
  mockFromId.mockReset();
});

describe('requestVaultUnlock', () => {
  test('sends AGENT_VAULT_UNLOCK_REQUEST and resolves on unlocked result', async () => {
    const wc = fakeWc();
    mockFromId.mockReturnValue(wc);
    const promise = bridge.requestVaultUnlock({
      reason: 'Sign a message',
      hostWebContentsId: 7,
    });

    expect(wc.send).toHaveBeenCalledWith(
      IPC.AGENT_VAULT_UNLOCK_REQUEST,
      expect.objectContaining({ reason: 'Sign a message', requestId: expect.any(String) })
    );

    const { requestId } = wc.send.mock.calls[0][1];
    bridge.handleResult({ requestId, status: 'unlocked' });
    await expect(promise).resolves.toBeUndefined();
    expect(bridge._internals.pendingRequests.size).toBe(0);
  });

  test('rejects with "cancelled by user" on cancelled result', async () => {
    const wc = fakeWc();
    mockFromId.mockReturnValue(wc);
    const promise = bridge.requestVaultUnlock({
      reason: 'x',
      hostWebContentsId: 7,
    });
    const { requestId } = wc.send.mock.calls[0][1];
    bridge.handleResult({ requestId, status: 'cancelled' });
    await expect(promise).rejects.toThrow(/cancelled by user/);
  });

  test('rejects up-front when host webContents is missing', async () => {
    mockFromId.mockReturnValue(null);
    await expect(
      bridge.requestVaultUnlock({ reason: 'x', hostWebContentsId: 99 })
    ).rejects.toThrow(/Host renderer unavailable/);
  });

  test('rejects up-front when host webContents has been destroyed', async () => {
    mockFromId.mockReturnValue({ isDestroyed: () => true, send: jest.fn() });
    await expect(
      bridge.requestVaultUnlock({ reason: 'x', hostWebContentsId: 7 })
    ).rejects.toThrow(/Host renderer unavailable/);
  });

  test('rejects up-front when hostWebContentsId is not a number', async () => {
    await expect(
      bridge.requestVaultUnlock({ reason: 'x', hostWebContentsId: null })
    ).rejects.toThrow(/host webContents id/);
  });

  test('rejects up-front when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      bridge.requestVaultUnlock({ reason: 'x', hostWebContentsId: 7, signal: ac.signal })
    ).rejects.toThrow(/aborted before start/);
  });

  test('parent abort during pending request rejects and removes from map', async () => {
    const wc = fakeWc();
    mockFromId.mockReturnValue(wc);
    const ac = new AbortController();
    const promise = bridge.requestVaultUnlock({
      reason: 'x',
      hostWebContentsId: 7,
      signal: ac.signal,
    });
    expect(bridge._internals.pendingRequests.size).toBe(1);
    ac.abort();
    await expect(promise).rejects.toThrow(/aborted by parent/);
    expect(bridge._internals.pendingRequests.size).toBe(0);
  });
});

describe('handleResult', () => {
  test('ignores results for unknown requestIds (no throw)', () => {
    expect(() =>
      bridge.handleResult({ requestId: 'never-existed', status: 'unlocked' })
    ).not.toThrow();
  });

  test('concurrent requests resolve independently by requestId', async () => {
    const wc = fakeWc();
    mockFromId.mockReturnValue(wc);
    const p1 = bridge.requestVaultUnlock({ reason: 'first', hostWebContentsId: 7 });
    const p2 = bridge.requestVaultUnlock({ reason: 'second', hostWebContentsId: 7 });
    expect(bridge._internals.pendingRequests.size).toBe(2);

    const id1 = wc.send.mock.calls[0][1].requestId;
    const id2 = wc.send.mock.calls[1][1].requestId;
    expect(id1).not.toBe(id2);

    bridge.handleResult({ requestId: id2, status: 'cancelled' });
    await expect(p2).rejects.toThrow(/cancelled by user/);
    expect(bridge._internals.pendingRequests.size).toBe(1);

    bridge.handleResult({ requestId: id1, status: 'unlocked' });
    await expect(p1).resolves.toBeUndefined();
    expect(bridge._internals.pendingRequests.size).toBe(0);
  });
});
