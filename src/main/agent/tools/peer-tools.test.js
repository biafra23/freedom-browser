jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// Mock messaging-runtime: capture listeners, expose helpers to drive
// envelope deliveries from tests.
const mockState = {
  lobbyChannelId: 'lobby-id',
  listeners: new Set(),
  published: [],
};
function deliver(channelId, parsed) {
  for (const fn of mockState.listeners) fn({ channelId, message: { parsed } });
}
jest.mock('../../messaging/messaging-runtime', () => ({
  getLobbyChannelId: jest.fn(() => mockState.lobbyChannelId),
  publish: jest.fn(async (channelId, payload) => {
    mockState.published.push({ channelId, payload });
    return `msg-${mockState.published.length}`;
  }),
  addMessageListener: jest.fn((fn) => {
    mockState.listeners.add(fn);
    return () => mockState.listeners.delete(fn);
  }),
}));

const { Type } = require('typebox');
const { createPeerTools } = require('./peer-tools');
const messagingRuntime = require('../../messaging/messaging-runtime');

function getTools() {
  const [run, list] = createPeerTools({ Type });
  return { run, list };
}

beforeEach(() => {
  mockState.lobbyChannelId = 'lobby-id';
  mockState.listeners.clear();
  mockState.published.length = 0;
  messagingRuntime.publish.mockClear();
  messagingRuntime.addMessageListener.mockClear();
  messagingRuntime.getLobbyChannelId.mockClear();
  messagingRuntime.getLobbyChannelId.mockImplementation(() => mockState.lobbyChannelId);
});

// ---------------------------------------------------------------------------
// peer_run_inference
// ---------------------------------------------------------------------------

describe('peer_run_inference', () => {
  test('publishes inference:request to the lobby and returns first matching response', async () => {
    const { run } = getTools();

    const promise = run.execute('id-1', {
      prompt: 'hello',
      reason: 'demo',
    });
    // Wait one microtask so the listener registers + publish() runs.
    await Promise.resolve();
    await Promise.resolve();

    expect(messagingRuntime.publish).toHaveBeenCalledTimes(1);
    const [chan, payload] = messagingRuntime.publish.mock.calls[0];
    expect(chan).toBe('lobby-id');
    expect(payload).toMatchObject({
      v: 1,
      kind: 'inference:request',
      model: '*',
      prompt: 'hello',
    });
    expect(payload.requestId).toMatch(/^req-/);

    deliver('lobby-id', {
      v: 1,
      kind: 'inference:response',
      requestId: payload.requestId,
      providerInboxId: 'inbox-bob',
      providerAddress: '0x' + 'b'.repeat(40),
      model: 'gemma4:e2b',
      content: 'world',
      latencyMs: 42,
      sentAt: '2026-05-10T00:00:00Z',
    });

    const result = await promise;
    expect(result.details).toMatchObject({
      channelId: 'lobby-id',
      content: 'world',
      model: 'gemma4:e2b',
      provider: { inboxId: 'inbox-bob', address: '0x' + 'b'.repeat(40) },
      latencyMs: 42,
    });
    expect(result.details.provider.shortAddress).toMatch(/^0x/);
    expect(result.details.requestId).toBe(payload.requestId);
  });

  test('ignores responses with mismatched requestId', async () => {
    const { run } = getTools();
    const promise = run.execute('id-1', { prompt: 'hi', reason: 'x', timeoutMs: 200 });
    await Promise.resolve();
    await Promise.resolve();
    const ourReqId = messagingRuntime.publish.mock.calls[0][1].requestId;

    deliver('lobby-id', {
      kind: 'inference:response',
      requestId: 'someone-else',
      providerInboxId: 'i',
      providerAddress: '0xX',
      model: 'm',
      content: 'wrong',
    });
    deliver('lobby-id', {
      kind: 'inference:response',
      requestId: ourReqId,
      providerInboxId: 'i2',
      providerAddress: '0x' + 'a'.repeat(40),
      model: 'm',
      content: 'right',
    });
    const result = await promise;
    expect(result.details.content).toBe('right');
  });

  test('ignores responses on other channels', async () => {
    const { run } = getTools();
    const promise = run.execute('id-1', { prompt: 'hi', reason: 'x', timeoutMs: 200 });
    await Promise.resolve();
    await Promise.resolve();
    const ourReqId = messagingRuntime.publish.mock.calls[0][1].requestId;

    deliver('other-channel', {
      kind: 'inference:response',
      requestId: ourReqId,
      providerInboxId: 'i',
      providerAddress: '0x' + 'a'.repeat(40),
      model: 'm',
      content: 'wrong',
    });
    deliver('lobby-id', {
      kind: 'inference:response',
      requestId: ourReqId,
      providerInboxId: 'i2',
      providerAddress: '0x' + 'b'.repeat(40),
      model: 'm',
      content: 'right',
    });
    const result = await promise;
    expect(result.details.content).toBe('right');
  });

  test('ignores non-response envelopes (probe-acks etc.)', async () => {
    const { run } = getTools();
    const promise = run.execute('id-1', { prompt: 'hi', reason: 'x', timeoutMs: 200 });
    await Promise.resolve();
    await Promise.resolve();
    const ourReqId = messagingRuntime.publish.mock.calls[0][1].requestId;

    deliver('lobby-id', {
      kind: 'inference:probe-ack',
      requestId: ourReqId,
      models: [],
    });
    deliver('lobby-id', {
      kind: 'inference:response',
      requestId: ourReqId,
      providerInboxId: 'i',
      providerAddress: '0x' + 'a'.repeat(40),
      model: 'm',
      content: 'ok',
    });
    const result = await promise;
    expect(result.details.content).toBe('ok');
  });

  test('times out when no reply arrives', async () => {
    const { run } = getTools();
    await expect(
      run.execute('id-1', { prompt: 'hi', reason: 'x', timeoutMs: 30 })
    ).rejects.toThrow(/No reply within 30ms/);
  });

  test('aborts when signal fires', async () => {
    const { run } = getTools();
    const ac = new AbortController();
    const promise = run.execute('id-1', { prompt: 'hi', reason: 'x', timeoutMs: 5000 }, ac.signal);
    await Promise.resolve();
    ac.abort();
    await expect(promise).rejects.toThrow(/Aborted by caller/);
  });

  test('throws when no lobby is known and no explicit channelId given', async () => {
    mockState.lobbyChannelId = null;
    const { run } = getTools();
    await expect(
      run.execute('id-1', { prompt: 'hi', reason: 'x' })
    ).rejects.toThrow(/No Freedom Lobby channel known/);
  });

  test('honours explicit channelId override', async () => {
    const { run } = getTools();
    const promise = run.execute('id-1', {
      prompt: 'hi',
      reason: 'x',
      channelId: 'custom-channel',
      timeoutMs: 200,
    });
    await Promise.resolve();
    await Promise.resolve();
    const [chan, payload] = messagingRuntime.publish.mock.calls[0];
    expect(chan).toBe('custom-channel');

    deliver('custom-channel', {
      kind: 'inference:response',
      requestId: payload.requestId,
      providerInboxId: 'i',
      providerAddress: '0x' + 'a'.repeat(40),
      model: 'm',
      content: 'hi back',
    });
    const result = await promise;
    expect(result.details.channelId).toBe('custom-channel');
  });

  test('forwards system + specific model to the envelope', async () => {
    const { run } = getTools();
    const promise = run.execute('id-1', {
      prompt: 'p',
      reason: 'r',
      model: 'qwen3:4b',
      system: 'be terse',
      timeoutMs: 100,
    });
    await Promise.resolve();
    await Promise.resolve();
    const payload = messagingRuntime.publish.mock.calls[0][1];
    expect(payload.model).toBe('qwen3:4b');
    expect(payload.system).toBe('be terse');
    promise.catch(() => {}); // swallow timeout
  });

  test('formatConsentDescription includes channel + model + truncated prompt', () => {
    const { run } = getTools();
    const desc = run.formatConsentDescription({
      prompt: 'a'.repeat(500),
      reason: 'demo',
    });
    expect(desc).toContain('Freedom Lobby');
    expect(desc).toContain('any model');
    expect(desc).toContain('demo');
    expect(desc).toContain('…'); // truncated
  });
});

// ---------------------------------------------------------------------------
// peer_list_providers
// ---------------------------------------------------------------------------

describe('peer_list_providers', () => {
  test('publishes inference:probe and collects every probe-ack until timeout', async () => {
    const { list } = getTools();
    const promise = list.execute('id-1', { reason: 'who is here', timeoutMs: 80 });
    await Promise.resolve();
    await Promise.resolve();
    const probePayload = messagingRuntime.publish.mock.calls[0][1];
    expect(probePayload).toMatchObject({ kind: 'inference:probe', v: 1 });
    expect(probePayload.requestId).toMatch(/^req-/);

    deliver('lobby-id', {
      kind: 'inference:probe-ack',
      requestId: probePayload.requestId,
      providerInboxId: 'inbox-bob',
      providerAddress: '0x' + 'b'.repeat(40),
      models: [{ name: 'gemma4:e2b' }],
    });
    deliver('lobby-id', {
      kind: 'inference:probe-ack',
      requestId: probePayload.requestId,
      providerInboxId: 'inbox-carol',
      providerAddress: '0x' + 'c'.repeat(40),
      models: [{ name: 'qwen3:4b' }, { name: 'phi3' }],
    });

    const result = await promise;
    expect(result.details.providerCount).toBe(2);
    expect(result.details.providers.map((p) => p.inboxId)).toEqual(['inbox-bob', 'inbox-carol']);
    expect(result.details.providers[1].models.map((m) => m.name)).toEqual(['qwen3:4b', 'phi3']);
  });

  test('returns empty providers list on no replies (no throw)', async () => {
    const { list } = getTools();
    const result = await list.execute('id-1', { reason: 'silent', timeoutMs: 30 });
    expect(result.details.providerCount).toBe(0);
    expect(result.details.providers).toEqual([]);
  });

  test('filters acks by requestId and channelId', async () => {
    const { list } = getTools();
    const promise = list.execute('id-1', { reason: 'r', timeoutMs: 60 });
    await Promise.resolve();
    await Promise.resolve();
    const probePayload = messagingRuntime.publish.mock.calls[0][1];

    deliver('other-channel', {
      kind: 'inference:probe-ack',
      requestId: probePayload.requestId,
      providerInboxId: 'i-wrong-channel',
      providerAddress: '0x' + 'a'.repeat(40),
      models: [],
    });
    deliver('lobby-id', {
      kind: 'inference:probe-ack',
      requestId: 'wrong-req',
      providerInboxId: 'i-wrong-req',
      providerAddress: '0x' + 'a'.repeat(40),
      models: [],
    });
    deliver('lobby-id', {
      kind: 'inference:probe-ack',
      requestId: probePayload.requestId,
      providerInboxId: 'i-good',
      providerAddress: '0x' + 'b'.repeat(40),
      models: [{ name: 'gemma4:e2b' }],
    });

    const result = await promise;
    expect(result.details.providers.map((p) => p.inboxId)).toEqual(['i-good']);
  });

  test('aborts via signal', async () => {
    const { list } = getTools();
    const ac = new AbortController();
    const promise = list.execute('id-1', { reason: 'r', timeoutMs: 5000 }, ac.signal);
    await Promise.resolve();
    ac.abort();
    await expect(promise).rejects.toThrow(/Aborted by caller/);
  });

  test('throws when no lobby is known and no explicit channelId', async () => {
    mockState.lobbyChannelId = null;
    const { list } = getTools();
    await expect(list.execute('id-1', { reason: 'r' })).rejects.toThrow(
      /No Freedom Lobby channel known/
    );
  });
});
