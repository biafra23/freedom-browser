jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const channelMod = require('./channel');

// ---------------------------------------------------------------------------
// Mock SDK objects
// ---------------------------------------------------------------------------

function makeMockGroup({
  id = 'group-A',
  members = [],
  sendTextImpl,
  streamImpl,
} = {}) {
  let cachedMembers = members.slice();
  const sentMessages = [];
  const streams = [];

  const group = {
    id,
    sync: jest.fn(async () => {}),
    members: jest.fn(async () => cachedMembers.map((inboxId) => ({ inboxId }))),
    addMembers: jest.fn(async (ids) => {
      cachedMembers = [...new Set([...cachedMembers, ...ids])];
    }),
    removeMembers: jest.fn(async (ids) => {
      cachedMembers = cachedMembers.filter((m) => !ids.includes(m));
    }),
    sendText: sendTextImpl
      ? jest.fn(sendTextImpl)
      : jest.fn(async (text) => {
          const msgId = `msg-${sentMessages.length + 1}`;
          sentMessages.push({ id: msgId, text });
          return msgId;
        }),
    stream: streamImpl
      ? jest.fn(streamImpl)
      : jest.fn(async (options) => {
          const handle = {
            options,
            ended: false,
            emit(msg) {
              if (this.ended) return;
              return options.onValue?.(msg);
            },
            error(err) {
              return options.onError?.(err);
            },
            end: jest.fn(async () => {
              handle.ended = true;
            }),
          };
          streams.push(handle);
          return handle;
        }),
  };
  return { group, sentMessages, streams, getCachedMembers: () => [...cachedMembers] };
}

function makeMockClient({ inboxId = 'inbox-self', listGroupsResult = [], getConvoResult } = {}) {
  return {
    inboxId,
    conversations: {
      sync: jest.fn(async () => {}),
      createGroup: jest.fn(),
      getConversationById: jest.fn(async () => getConvoResult),
      listGroups: jest.fn(() => listGroupsResult),
    },
  };
}

function makeMessage({
  id = 'm1',
  senderInboxId,
  content,
  sentAt = new Date('2026-01-01T00:00:00Z'),
}) {
  return { id, senderInboxId, content, sentAt };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// _safeParse
// ---------------------------------------------------------------------------

describe('_safeParse', () => {
  test('parses valid JSON', () => {
    const r = channelMod._safeParse('{"a":1}');
    expect(r.parsed).toEqual({ a: 1 });
    expect(r.parseError).toBeNull();
  });

  test('returns parseError for invalid JSON', () => {
    const r = channelMod._safeParse('not json');
    expect(r.parsed).toBeNull();
    expect(r.parseError).toBeInstanceOf(Error);
  });

  test('returns parseError for non-string content', () => {
    const r = channelMod._safeParse({ already: 'object' });
    expect(r.parsed).toBeNull();
    expect(r.parseError).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// createChannel / openChannelById / listChannels
// ---------------------------------------------------------------------------

describe('createChannel', () => {
  test('calls Conversations.createGroup with member inbox IDs', async () => {
    const { group } = makeMockGroup({ id: 'g-new', members: ['inbox-self', 'inbox-bob'] });
    const client = makeMockClient();
    client.conversations.createGroup.mockResolvedValue(group);

    const channel = await channelMod.createChannel(client, {
      memberInboxIds: ['inbox-bob'],
      name: 'queue-1',
    });

    expect(client.conversations.createGroup).toHaveBeenCalledWith(['inbox-bob'], {
      groupName: 'queue-1',
    });
    expect(channel.id).toBe('g-new');
  });

  test('passes no options when name is omitted', async () => {
    const { group } = makeMockGroup();
    const client = makeMockClient();
    client.conversations.createGroup.mockResolvedValue(group);

    await channelMod.createChannel(client, { memberInboxIds: ['inbox-bob'] });

    expect(client.conversations.createGroup).toHaveBeenCalledWith(['inbox-bob'], undefined);
  });

  test('throws when memberInboxIds is missing or invalid', async () => {
    const client = makeMockClient();
    await expect(channelMod.createChannel(client, {})).rejects.toThrow(/memberInboxIds/);
    await expect(
      channelMod.createChannel(client, { memberInboxIds: 'inbox-bob' })
    ).rejects.toThrow(/memberInboxIds/);
  });
});

describe('openChannelById', () => {
  test('syncs and returns a Channel for an existing group', async () => {
    const { group } = makeMockGroup({ id: 'g-exists' });
    const client = makeMockClient({ getConvoResult: group });

    const channel = await channelMod.openChannelById(client, 'g-exists');

    expect(client.conversations.sync).toHaveBeenCalled();
    expect(client.conversations.getConversationById).toHaveBeenCalledWith('g-exists');
    expect(channel.id).toBe('g-exists');
  });

  test('returns null when conversation is not found', async () => {
    const client = makeMockClient({ getConvoResult: undefined });
    const channel = await channelMod.openChannelById(client, 'g-missing');
    expect(channel).toBeNull();
  });

  test('returns null when conversation is a DM (no addMembers)', async () => {
    const dm = { id: 'dm-1', sendText: jest.fn() }; // no addMembers method
    const client = makeMockClient({ getConvoResult: dm });
    const channel = await channelMod.openChannelById(client, 'dm-1');
    expect(channel).toBeNull();
  });
});

describe('listChannels', () => {
  test('returns a Channel for each group', async () => {
    const { group: g1 } = makeMockGroup({ id: 'g-1' });
    const { group: g2 } = makeMockGroup({ id: 'g-2' });
    const client = makeMockClient({ listGroupsResult: [g1, g2] });

    const channels = await channelMod.listChannels(client);

    expect(client.conversations.sync).toHaveBeenCalled();
    expect(channels.map((c) => c.id)).toEqual(['g-1', 'g-2']);
  });
});

// ---------------------------------------------------------------------------
// Channel.publish
// ---------------------------------------------------------------------------

describe('Channel.publish', () => {
  test('JSON-stringifies the payload and calls group.sendText', async () => {
    const { group, sentMessages } = makeMockGroup();
    const client = makeMockClient();
    const channel = channelMod._makeChannel(client, group);

    const messageId = await channel.publish({ kind: 'task', taskId: 'T1' });

    expect(group.sendText).toHaveBeenCalledWith('{"kind":"task","taskId":"T1"}');
    expect(sentMessages[0]).toEqual({ id: 'msg-1', text: '{"kind":"task","taskId":"T1"}' });
    expect(messageId).toBe('msg-1');
  });

  test('returns the message ID from sendText', async () => {
    const { group } = makeMockGroup({ sendTextImpl: async () => 'returned-id' });
    const client = makeMockClient();
    const channel = channelMod._makeChannel(client, group);

    const id = await channel.publish({ a: 1 });
    expect(id).toBe('returned-id');
  });
});

// ---------------------------------------------------------------------------
// Channel.messages
// ---------------------------------------------------------------------------

describe('Channel.messages', () => {
  test('syncs first, then maps SDK messages to the normalized shape', async () => {
    const sdkMessages = [
      {
        id: 'm-old',
        senderInboxId: 'inbox-bob',
        content: '{"a":1}',
        sentAt: new Date('2026-01-01'),
      },
      {
        id: 'm-self',
        senderInboxId: 'inbox-self',
        content: '{"b":2}',
        sentAt: new Date('2026-01-02'),
      },
      {
        // non-string content (e.g. system update) — must be skipped
        id: 'm-system',
        senderInboxId: 'inbox-bob',
        content: { kind: 'GroupUpdated' },
        sentAt: new Date('2026-01-03'),
      },
      {
        // non-JSON text — included with parseError set
        id: 'm-text',
        senderInboxId: 'inbox-bob',
        content: 'plain hello',
        sentAt: new Date('2026-01-04'),
      },
    ];
    const group = {
      id: 'g',
      sync: jest.fn(async () => {}),
      members: jest.fn(async () => [{ inboxId: 'inbox-self' }, { inboxId: 'inbox-bob' }]),
      messages: jest.fn(async (_opts) => sdkMessages),
      addMembers: jest.fn(),
      removeMembers: jest.fn(),
      sendText: jest.fn(),
      stream: jest.fn(),
    };
    const client = makeMockClient({ inboxId: 'inbox-self' });
    const channel = channelMod._makeChannel(client, group);

    const messages = await channel.messages();

    expect(group.sync).toHaveBeenCalled();
    expect(group.messages).toHaveBeenCalledWith(undefined);
    expect(messages).toHaveLength(3); // system one filtered out
    expect(messages[0]).toMatchObject({ id: 'm-old', from: 'inbox-bob', parsed: { a: 1 }, isOwn: false });
    expect(messages[1]).toMatchObject({ id: 'm-self', from: 'inbox-self', parsed: { b: 2 }, isOwn: true });
    expect(messages[2]).toMatchObject({ id: 'm-text', parsed: null });
    expect(messages[2].parseError).toBeInstanceOf(Error);
  });

  test('forwards limit option', async () => {
    const group = {
      id: 'g',
      sync: jest.fn(async () => {}),
      members: jest.fn(async () => []),
      messages: jest.fn(async () => []),
    };
    const client = makeMockClient({ inboxId: 'inbox-self' });
    const channel = channelMod._makeChannel(client, group);

    await channel.messages({ limit: 50 });
    expect(group.messages).toHaveBeenCalledWith({ limit: 50 });
  });
});

// ---------------------------------------------------------------------------
// Channel.members / addMembers / removeMembers / refreshMembers
// ---------------------------------------------------------------------------

describe('Channel.members', () => {
  test('lazy-loads from group.members on first call and caches', async () => {
    const { group } = makeMockGroup({ members: ['inbox-self', 'inbox-bob'] });
    const client = makeMockClient();
    const channel = channelMod._makeChannel(client, group);

    expect(group.members).toHaveBeenCalledTimes(0);
    const m1 = await channel.members();
    const m2 = await channel.members();
    expect(m1).toEqual(['inbox-self', 'inbox-bob']);
    expect(m2).toEqual(['inbox-self', 'inbox-bob']);
    expect(group.members).toHaveBeenCalledTimes(1); // cached
  });

  test('refreshMembers syncs the group and forces reload', async () => {
    const { group } = makeMockGroup({ members: ['inbox-self', 'inbox-bob'] });
    const client = makeMockClient();
    const channel = channelMod._makeChannel(client, group);

    await channel.members();
    await channel.refreshMembers();
    expect(group.sync).toHaveBeenCalledTimes(1);
    expect(group.members).toHaveBeenCalledTimes(2);
  });
});

describe('Channel.addMembers / removeMembers', () => {
  test('addMembers calls group.addMembers and refreshes cache', async () => {
    const { group, getCachedMembers } = makeMockGroup({ members: ['inbox-self'] });
    const client = makeMockClient();
    const channel = channelMod._makeChannel(client, group);

    await channel.addMembers(['inbox-bob']);

    expect(group.addMembers).toHaveBeenCalledWith(['inbox-bob']);
    expect(getCachedMembers()).toEqual(['inbox-self', 'inbox-bob']);
    expect(await channel.members()).toEqual(['inbox-self', 'inbox-bob']);
  });

  test('removeMembers calls group.removeMembers and refreshes cache', async () => {
    const { group, getCachedMembers } = makeMockGroup({
      members: ['inbox-self', 'inbox-bob'],
    });
    const client = makeMockClient();
    const channel = channelMod._makeChannel(client, group);

    await channel.removeMembers(['inbox-bob']);

    expect(group.removeMembers).toHaveBeenCalledWith(['inbox-bob']);
    expect(getCachedMembers()).toEqual(['inbox-self']);
  });

  test('addMembers / removeMembers are no-ops on empty arrays', async () => {
    const { group } = makeMockGroup();
    const client = makeMockClient();
    const channel = channelMod._makeChannel(client, group);

    await channel.addMembers([]);
    await channel.removeMembers([]);
    expect(group.addMembers).not.toHaveBeenCalled();
    expect(group.removeMembers).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Channel.subscribe — the meaty bit
// ---------------------------------------------------------------------------

describe('Channel.subscribe', () => {
  test('forwards parsed JSON messages to handler', async () => {
    const { group, streams } = makeMockGroup({
      members: ['inbox-self', 'inbox-bob'],
    });
    const client = makeMockClient({ inboxId: 'inbox-self' });
    const channel = channelMod._makeChannel(client, group);

    const calls = [];
    await channel.subscribe(async (msg) => {
      calls.push(msg);
    });

    const handle = streams[0];
    handle.emit(
      makeMessage({
        id: 'm1',
        senderInboxId: 'inbox-bob',
        content: '{"kind":"task","taskId":"T1"}',
      })
    );
    // Allow microtasks to resolve
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      id: 'm1',
      from: 'inbox-bob',
      sentAt: expect.any(Date),
      content: '{"kind":"task","taskId":"T1"}',
      parsed: { kind: 'task', taskId: 'T1' },
      parseError: null,
    });
  });

  test('drops non-text system messages (e.g. GroupUpdated) instead of forwarding objects', async () => {
    // Repro for the chat-ui rendering "[object Object]" when the lobby
    // admin's add-member commit produced a GroupUpdated MLS message.
    const { group, streams } = makeMockGroup({
      members: ['inbox-self', 'inbox-admin'],
    });
    const client = makeMockClient({ inboxId: 'inbox-self' });
    const channel = channelMod._makeChannel(client, group);

    const calls = [];
    await channel.subscribe(async (msg) => calls.push(msg));

    streams[0].emit(
      makeMessage({
        senderInboxId: 'inbox-admin',
        content: { initiatedByInboxId: 'inbox-admin', addedInboxes: [{ inboxId: 'inbox-self' }] },
      })
    );
    await Promise.resolve();

    expect(calls).toHaveLength(0);
  });

  test('drops messages from the local installation by default', async () => {
    const { group, streams } = makeMockGroup({
      members: ['inbox-self', 'inbox-bob'],
    });
    const client = makeMockClient({ inboxId: 'inbox-self' });
    const channel = channelMod._makeChannel(client, group);

    const calls = [];
    await channel.subscribe(async (msg) => calls.push(msg));

    streams[0].emit(makeMessage({ senderInboxId: 'inbox-self', content: '{"a":1}' }));
    await Promise.resolve();

    expect(calls).toHaveLength(0);
  });

  test('includeOwn=true delivers own messages', async () => {
    const { group, streams } = makeMockGroup({
      members: ['inbox-self', 'inbox-bob'],
    });
    const client = makeMockClient({ inboxId: 'inbox-self' });
    const channel = channelMod._makeChannel(client, group);

    const calls = [];
    await channel.subscribe(async (msg) => calls.push(msg), { includeOwn: true });

    streams[0].emit(makeMessage({ senderInboxId: 'inbox-self', content: '{"a":1}' }));
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0].from).toBe('inbox-self');
  });

  test('drops messages from non-members when requireRoster=true', async () => {
    const { group, streams } = makeMockGroup({
      members: ['inbox-self', 'inbox-bob'],
    });
    const client = makeMockClient({ inboxId: 'inbox-self' });
    const channel = channelMod._makeChannel(client, group);

    const calls = [];
    await channel.subscribe(async (msg) => calls.push(msg));

    streams[0].emit(makeMessage({ senderInboxId: 'inbox-stranger', content: '{"a":1}' }));
    // First emit triggers a roster refresh (group.members called twice now)
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toHaveLength(0);
    // Initial prime + one re-check after seeing unknown sender
    expect(group.members).toHaveBeenCalledTimes(2);
  });

  test('refresh discovers a newly-added member on their first message', async () => {
    let memberList = ['inbox-self', 'inbox-bob'];
    const group = {
      id: 'g',
      sync: jest.fn(async () => {}),
      members: jest.fn(async () => memberList.map((inboxId) => ({ inboxId }))),
      addMembers: jest.fn(),
      removeMembers: jest.fn(),
      sendText: jest.fn(),
      stream: jest.fn(async (opts) => ({
        emit: (m) => opts.onValue?.(m),
        end: jest.fn(),
      })),
    };
    const client = makeMockClient({ inboxId: 'inbox-self' });
    const channel = channelMod._makeChannel(client, group);

    const calls = [];
    const stream = await channel.subscribe(async (m) => calls.push(m));

    // After subscribe the cached roster does not include carol.
    // Simulate carol being admitted upstream:
    memberList = ['inbox-self', 'inbox-bob', 'inbox-carol'];

    // Receive carol's first message — the channel should re-fetch members,
    // discover she is now a member, and deliver the message.
    await stream; // unsubscribe handle exists
    const incoming = group.stream.mock.results[0].value;
    const handle = await incoming;
    handle.emit(makeMessage({ senderInboxId: 'inbox-carol', content: '{"k":"v"}' }));
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toHaveLength(1);
    expect(calls[0].from).toBe('inbox-carol');
  });

  test('requireRoster=false delivers from any sender', async () => {
    const { group, streams } = makeMockGroup({ members: ['inbox-self'] });
    const client = makeMockClient({ inboxId: 'inbox-self' });
    const channel = channelMod._makeChannel(client, group);

    const calls = [];
    await channel.subscribe(async (m) => calls.push(m), { requireRoster: false });

    streams[0].emit(
      makeMessage({ senderInboxId: 'inbox-stranger', content: '{"a":1}' })
    );
    await Promise.resolve();

    expect(calls).toHaveLength(1);
  });

  test('passes parseError when JSON is invalid', async () => {
    const { group, streams } = makeMockGroup({
      members: ['inbox-self', 'inbox-bob'],
    });
    const client = makeMockClient({ inboxId: 'inbox-self' });
    const channel = channelMod._makeChannel(client, group);

    const calls = [];
    await channel.subscribe(async (m) => calls.push(m));
    streams[0].emit(makeMessage({ senderInboxId: 'inbox-bob', content: 'not json' }));
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0].parsed).toBeNull();
    expect(calls[0].parseError).toBeInstanceOf(Error);
    expect(calls[0].content).toBe('not json');
  });

  test('handler exceptions are logged but do not break the stream', async () => {
    const { group, streams } = makeMockGroup({
      members: ['inbox-self', 'inbox-bob'],
    });
    const client = makeMockClient({ inboxId: 'inbox-self' });
    const channel = channelMod._makeChannel(client, group);

    const errSpy = require('electron-log').error;
    let secondCalled = false;
    await channel.subscribe(async (m) => {
      if (m.id === 'm1') throw new Error('handler boom');
      if (m.id === 'm2') secondCalled = true;
    });

    streams[0].emit(makeMessage({ id: 'm1', senderInboxId: 'inbox-bob', content: '{}' }));
    await Promise.resolve();
    streams[0].emit(makeMessage({ id: 'm2', senderInboxId: 'inbox-bob', content: '{}' }));
    await Promise.resolve();

    expect(errSpy).toHaveBeenCalled();
    expect(secondCalled).toBe(true);
  });

  test('returns an unsubscribe function that ends the stream', async () => {
    const { group, streams } = makeMockGroup({
      members: ['inbox-self', 'inbox-bob'],
    });
    const client = makeMockClient({ inboxId: 'inbox-self' });
    const channel = channelMod._makeChannel(client, group);

    const unsubscribe = await channel.subscribe(() => {});
    await unsubscribe();

    expect(streams[0].end).toHaveBeenCalled();
    expect(streams[0].ended).toBe(true);
  });
});
