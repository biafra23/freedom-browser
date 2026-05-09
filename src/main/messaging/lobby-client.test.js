jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');

const lobbyClient = require('./lobby-client');
const { LOBBY_ADMIN_ADDRESS, KIND_LOBBY_JOIN_ACK } = require('./lobby-config');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobby-client-test-'));
});

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock client builder. Lets each test assemble whatever surface it needs.
// ---------------------------------------------------------------------------
function makeGroupStub(id = 'lobby-group-xyz') {
  return {
    id,
    addMembers: jest.fn(async () => {}),
    members: jest.fn(async () => []),
  };
}

function makeClient({
  selfAddress = '0xMyAddress',
  inboxId = 'inbox-self',
  installationId = 'install-self',
  adminInboxId = 'inbox-admin',
  fetchInboxIdImpl,
  dm,
  // Cache-verification stubs. Defaults: sync() succeeds, getConversationById
  // returns a real group (so cached-membership-verification passes).
  syncImpl,
  getConversationByIdImpl,
  conversations,
} = {}) {
  const dmObj = dm || makeDm();
  const visibleGroups = new Map();
  visibleGroups.set('cached-group', makeGroupStub('cached-group'));
  visibleGroups.set('lobby-group-xyz', makeGroupStub('lobby-group-xyz'));

  return {
    inboxId,
    installationId,
    accountIdentifier: { identifier: selfAddress.toLowerCase(), identifierKind: 0 },
    fetchInboxIdByIdentifier:
      fetchInboxIdImpl !== undefined
        ? fetchInboxIdImpl
        : jest.fn(async () => adminInboxId),
    conversations: conversations || {
      sync: jest.fn(syncImpl || (async () => {})),
      getConversationById: jest.fn(
        getConversationByIdImpl || (async (id) => visibleGroups.get(id) || null)
      ),
      getDmByInboxId: jest.fn(() => dmObj),
      createDm: jest.fn(async () => dmObj),
    },
  };
}

function makeDm({ ackPayload, ackDelayMs = 5, simulateError } = {}) {
  let onValue;
  return {
    sendText: jest.fn(async () => {}),
    stream: jest.fn(async (handlers) => {
      onValue = handlers.onValue;
      // Default: emit an ack shortly after subscribe.
      setTimeout(() => {
        if (simulateError) {
          handlers.onError?.(new Error('stream blew up'));
          return;
        }
        const payload = ackPayload || {
          v: 1,
          kind: KIND_LOBBY_JOIN_ACK,
          groupId: 'lobby-group-xyz',
          sentAt: new Date().toISOString(),
        };
        onValue({
          content: JSON.stringify(payload),
          senderInboxId: 'inbox-admin',
        });
      }, ackDelayMs);
      return { end: jest.fn() };
    }),
  };
}

// ---------------------------------------------------------------------------

describe('ensureLobbyMembership', () => {
  test('returns cached membership when env+inboxId match and group is visible locally', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'lobby.json'),
      JSON.stringify({ groupId: 'cached-group', env: 'dev', inboxId: 'inbox-self' })
    );
    const client = makeClient();

    const result = await lobbyClient.ensureLobbyMembership(client, tmpDir, 'dev');

    expect(result).toEqual({ groupId: 'cached-group', fromCache: true });
    expect(client.fetchInboxIdByIdentifier).not.toHaveBeenCalled();
    expect(client.conversations.sync).toHaveBeenCalled();
  });

  test('still trusts a legacy cache that was written without inboxId', async () => {
    // Pre-fix caches don't have inboxId — be permissive so an upgrade
    // doesn't force everyone through a re-join.
    fs.writeFileSync(
      path.join(tmpDir, 'lobby.json'),
      JSON.stringify({ groupId: 'cached-group', env: 'dev' })
    );
    const client = makeClient();

    const result = await lobbyClient.ensureLobbyMembership(client, tmpDir, 'dev');

    expect(result).toEqual({ groupId: 'cached-group', fromCache: true });
  });

  test('cached entry from a different env is ignored (re-runs handshake)', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'lobby.json'),
      JSON.stringify({
        groupId: 'old-group',
        env: 'production',
        inboxId: 'inbox-self',
      })
    );
    const client = makeClient();

    const result = await lobbyClient.ensureLobbyMembership(client, tmpDir, 'dev');

    expect(result).toEqual({ groupId: 'lobby-group-xyz', fromCache: false });
    expect(client.fetchInboxIdByIdentifier).toHaveBeenCalled();
  });

  test('cache from a different wallet (inboxId mismatch) is ignored — re-runs handshake', async () => {
    // Repro for the "second instance does not see the group" bug: a stale
    // lobby.json from another wallet must not short-circuit the join.
    fs.writeFileSync(
      path.join(tmpDir, 'lobby.json'),
      JSON.stringify({
        groupId: 'wallet-1-group',
        env: 'dev',
        inboxId: 'inbox-WALLET-1',
      })
    );
    const client = makeClient({ inboxId: 'inbox-WALLET-2' });

    const result = await lobbyClient.ensureLobbyMembership(client, tmpDir, 'dev');

    expect(result).toEqual({ groupId: 'lobby-group-xyz', fromCache: false });
    expect(client.fetchInboxIdByIdentifier).toHaveBeenCalled();
    const rewritten = JSON.parse(fs.readFileSync(path.join(tmpDir, 'lobby.json'), 'utf8'));
    expect(rewritten.inboxId).toBe('inbox-WALLET-2');
    expect(rewritten.groupId).toBe('lobby-group-xyz');
  });

  test('cache pointing to a group not in local SDK is invalidated — re-runs handshake', async () => {
    // The XMTP DB was wiped (or the cache predates a sync drift) — the
    // group ID in the cache no longer resolves locally. Force a re-join
    // rather than silently leaving the lobby invisible.
    fs.writeFileSync(
      path.join(tmpDir, 'lobby.json'),
      JSON.stringify({
        groupId: 'ghost-group',
        env: 'dev',
        inboxId: 'inbox-self',
      })
    );
    const client = makeClient({
      // Default visible groups don't include 'ghost-group', so verification fails.
    });

    const result = await lobbyClient.ensureLobbyMembership(client, tmpDir, 'dev');

    expect(result).toEqual({ groupId: 'lobby-group-xyz', fromCache: false });
    expect(client.fetchInboxIdByIdentifier).toHaveBeenCalled();
  });

  test('skips the join flow if THIS install is the admin', async () => {
    const client = makeClient({ selfAddress: LOBBY_ADMIN_ADDRESS });

    const result = await lobbyClient.ensureLobbyMembership(client, tmpDir, 'dev');

    expect(result).toBeNull();
    expect(client.fetchInboxIdByIdentifier).not.toHaveBeenCalled();
  });

  test('returns null when the admin has no XMTP inbox yet', async () => {
    const client = makeClient({ fetchInboxIdImpl: jest.fn(async () => null) });

    const result = await lobbyClient.ensureLobbyMembership(client, tmpDir, 'dev');

    expect(result).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'lobby.json'))).toBe(false);
  });

  test('happy path: DM admin, await ack, persist cache', async () => {
    const dm = makeDm();
    const client = makeClient({ dm });

    const result = await lobbyClient.ensureLobbyMembership(client, tmpDir, 'dev');

    expect(result).toEqual({ groupId: 'lobby-group-xyz', fromCache: false });
    expect(dm.sendText).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(dm.sendText.mock.calls[0][0]);
    expect(sentBody).toMatchObject({
      v: 1,
      kind: 'lobby:join-request',
      address: '0xmyaddress',
      inboxId: 'inbox-self',
      installationId: 'install-self',
    });
    expect(typeof sentBody.requestId).toBe('string');

    const cached = JSON.parse(fs.readFileSync(path.join(tmpDir, 'lobby.json'), 'utf8'));
    expect(cached).toMatchObject({
      groupId: 'lobby-group-xyz',
      env: 'dev',
      inboxId: 'inbox-self',
      address: '0xmyaddress',
    });
  });

  test('returns null and skips cache when ack is missing groupId', async () => {
    const dm = makeDm({
      ackPayload: { v: 1, kind: KIND_LOBBY_JOIN_ACK, sentAt: new Date().toISOString() },
    });
    const client = makeClient({ dm });

    const result = await lobbyClient.ensureLobbyMembership(client, tmpDir, 'dev');

    expect(result).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'lobby.json'))).toBe(false);
  });

  test('returns null on stream error', async () => {
    const dm = makeDm({ simulateError: true });
    const client = makeClient({ dm });

    const result = await lobbyClient.ensureLobbyMembership(client, tmpDir, 'dev');

    expect(result).toBeNull();
  });

  test('listener starts before the request is sent (no race on fast ack)', async () => {
    // Build an explicit dm where stream() must be called before sendText().
    const events = [];
    let onValue;
    const dm = {
      sendText: jest.fn(async () => {
        events.push('sendText');
        // Fire the ack immediately after sendText; if stream() ran first
        // we'll catch it, otherwise we'll deadlock.
        setImmediate(() => {
          onValue({
            content: JSON.stringify({
              v: 1,
              kind: KIND_LOBBY_JOIN_ACK,
              groupId: 'fast-group',
            }),
            senderInboxId: 'inbox-admin',
          });
        });
      }),
      stream: jest.fn(async (handlers) => {
        events.push('stream');
        onValue = handlers.onValue;
        return { end: jest.fn() };
      }),
    };
    const client = makeClient({ dm });

    const result = await lobbyClient.ensureLobbyMembership(client, tmpDir, 'dev');

    expect(events[0]).toBe('stream');
    expect(events[1]).toBe('sendText');
    expect(result).toEqual({ groupId: 'fast-group', fromCache: false });
  });
});
