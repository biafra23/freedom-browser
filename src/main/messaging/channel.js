/**
 * Messaging Channel
 *
 * Thin wrapper around an XMTP MLS Group, treated as a "channel" of trusted
 * peers. A channel has N members, each member being one Freedom installation's
 * XMTP inbox (under "1 account = 1 instance"). The wrapper exposes a small
 * publish/subscribe surface that hides MLS / SDK details from callers above
 * (the queue layer, IPC handlers).
 *
 * Wire format on the channel: every message is a JSON-stringified payload
 * sent as XMTP text. Higher layers (e.g. agent-queue) define the envelope
 * shape (`{ v, kind, taskId, ... }`); this module is content-agnostic apart
 * from JSON parsing.
 *
 * Membership model: the SDK guarantees `senderInboxId` cryptographically
 * (MLS authentication), so trust = "is `senderInboxId` in the current group
 * roster?". By default subscribe() drops messages from non-members and from
 * the local installation's own inbox; both are toggleable.
 */

const log = require('electron-log');

const DEFAULT_OPTS = {
  includeOwn: false,
  requireRoster: true,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function safeParse(content) {
  if (typeof content !== 'string') {
    return { parsed: null, parseError: new Error('non-string content') };
  }
  try {
    return { parsed: JSON.parse(content), parseError: null };
  } catch (err) {
    return { parsed: null, parseError: err };
  }
}

async function loadMemberInboxIds(group) {
  const members = await group.members();
  return new Set(members.map((m) => m.inboxId));
}

// ---------------------------------------------------------------------------
// Channel — wraps a single Group instance
// ---------------------------------------------------------------------------

function makeChannel(client, group) {
  const channelId = group.id;
  let memberSet = new Set(); // inbox IDs
  let lastRefreshAt = 0;

  async function ensureMembers({ force = false } = {}) {
    if (force || memberSet.size === 0) {
      memberSet = await loadMemberInboxIds(group);
      lastRefreshAt = Date.now();
    }
    return memberSet;
  }

  return {
    get id() {
      return channelId;
    },

    /**
     * Cached set of current member inbox IDs. Loads on first call.
     * @returns {Promise<string[]>}
     */
    async members() {
      const set = await ensureMembers();
      return [...set];
    },

    /**
     * Force a fresh members fetch from the local SDK state. Note: MLS
     * commits arriving over the network are picked up by .sync() on the
     * group; pair this with sync() if you need to reflect remote changes.
     * @returns {Promise<string[]>}
     */
    async refreshMembers() {
      await group.sync();
      const set = await ensureMembers({ force: true });
      return [...set];
    },

    /**
     * Add inbox IDs as members. Triggers an MLS commit + rekey.
     * @param {string[]} inboxIds
     */
    async addMembers(inboxIds) {
      if (!inboxIds.length) return;
      await group.addMembers(inboxIds);
      await ensureMembers({ force: true });
      log.info(`[Channel ${channelId}] added ${inboxIds.length} member(s)`);
    },

    /**
     * Remove inbox IDs from the channel.
     * @param {string[]} inboxIds
     */
    async removeMembers(inboxIds) {
      if (!inboxIds.length) return;
      await group.removeMembers(inboxIds);
      await ensureMembers({ force: true });
      log.info(`[Channel ${channelId}] removed ${inboxIds.length} member(s)`);
    },

    /**
     * Publish a JSON-serializable payload to the channel.
     * @param {*} payload - Anything JSON.stringify can handle
     * @returns {Promise<string>} The XMTP message ID
     */
    async publish(payload) {
      const text = JSON.stringify(payload);
      const messageId = await group.sendText(text);
      return messageId;
    },

    /**
     * Read recent messages from the channel. Syncs from the network first
     * so missed messages from the offline window show up.
     *
     * Returned shape mirrors what subscribe()'s handler receives, plus
     * `isOwn` so the caller can render alignment / colour without needing
     * the local inbox ID.
     *
     * @param {{ limit?: number }} [opts]
     * @returns {Promise<Array<{
     *   id: string,
     *   from: string,
     *   sentAt: Date,
     *   content: string,
     *   parsed: any|null,
     *   parseError: Error|null,
     *   isOwn: boolean,
     * }>>}
     */
    async messages({ limit } = {}) {
      await group.sync();
      const ownInboxId = client.inboxId;
      const sdkMessages = await group.messages(limit ? { limit } : undefined);
      const out = [];
      for (const msg of sdkMessages) {
        if (typeof msg.content !== 'string') continue;
        const { parsed, parseError } = safeParse(msg.content);
        out.push({
          id: msg.id,
          from: msg.senderInboxId,
          sentAt: msg.sentAt,
          content: msg.content,
          parsed,
          parseError,
          isOwn: msg.senderInboxId === ownInboxId,
        });
      }
      return out;
    },

    /**
     * Subscribe to incoming messages. Returns an `unsubscribe()` function.
     *
     * Handler receives:
     *   {
     *     id: string,
     *     from: string,         // sender inbox ID
     *     sentAt: Date,
     *     content: string,      // raw text payload
     *     parsed: any|null,     // JSON.parse(content), or null on parse error
     *     parseError: Error|null,
     *   }
     *
     * Default behaviour:
     *   - Drops messages from the local installation (override with
     *     opts.includeOwn).
     *   - Drops messages whose senderInboxId is not in the current member
     *     roster (override with opts.requireRoster=false).
     *   - On an unknown sender, refreshes the roster once and re-checks
     *     before dropping; this covers the "newly added member's first
     *     message races our local roster cache" case.
     *
     * @param {(message: object) => void|Promise<void>} handler
     * @param {{ includeOwn?: boolean, requireRoster?: boolean }} [options]
     * @returns {Promise<() => Promise<void>>} unsubscribe function
     */
    async subscribe(handler, options = {}) {
      const opts = { ...DEFAULT_OPTS, ...options };
      const ownInboxId = client.inboxId;

      // Prime members so requireRoster doesn't need to wait on first message.
      await ensureMembers({ force: true });

      const stream = await group.stream({
        onValue: async (msg) => {
          try {
            if (!opts.includeOwn && msg.senderInboxId === ownInboxId) {
              return;
            }
            // System events (GroupUpdated, MembershipChange, etc.) arrive
            // here with a non-string `content` payload (an object). They're
            // not user messages — drop them so callers don't have to know
            // about every XMTP content type. Mirrors messages()' filter.
            if (typeof msg.content !== 'string') {
              log.info(
                `[Channel ${channelId}] skipping non-text system message (kind=${msg.kind ?? '?'})`
              );
              return;
            }
            if (opts.requireRoster) {
              if (!memberSet.has(msg.senderInboxId)) {
                // Refresh roster once before deciding to drop — covers the
                // case where a newly-admitted peer's first message lands
                // before our cached roster is updated.
                await ensureMembers({ force: true });
                if (!memberSet.has(msg.senderInboxId)) {
                  log.warn(
                    `[Channel ${channelId}] dropping message from non-member ${msg.senderInboxId}`
                  );
                  return;
                }
              }
            }
            const { parsed, parseError } = safeParse(msg.content);
            await handler({
              id: msg.id,
              from: msg.senderInboxId,
              sentAt: msg.sentAt,
              content: msg.content,
              parsed,
              parseError,
            });
          } catch (err) {
            log.error(`[Channel ${channelId}] handler threw:`, err);
          }
        },
        onError: (err) => {
          log.warn(`[Channel ${channelId}] stream error:`, err);
        },
      });

      log.info(`[Channel ${channelId}] subscribed (own=${ownInboxId})`);

      return async () => {
        try {
          await stream.end();
        } catch (err) {
          log.warn(`[Channel ${channelId}] stream end error:`, err);
        }
      };
    },

    /**
     * Internal accessors — useful for tests and advanced callers that need
     * the underlying group object directly.
     */
    _group: group,
    _lastRefreshAt: () => lastRefreshAt,
  };
}

// ---------------------------------------------------------------------------
// Entry points — create / open / list channels
// ---------------------------------------------------------------------------

/**
 * Create a new channel containing the given member inbox IDs.
 * The local client is implicitly a member (XMTP adds the creator).
 *
 * @param {object} client - Active XMTP Client
 * @param {object} opts
 * @param {string[]} opts.memberInboxIds - Inbox IDs of other members
 * @param {string} [opts.name] - Optional human-readable name
 * @returns {Promise<object>} Channel
 */
async function createChannel(client, { memberInboxIds, name } = {}) {
  if (!Array.isArray(memberInboxIds)) {
    throw new Error('createChannel: memberInboxIds[] is required');
  }
  const groupOpts = name ? { groupName: name } : undefined;
  const group = await client.conversations.createGroup(memberInboxIds, groupOpts);
  log.info(
    `[messaging.channel] created channel ${group.id} with ${memberInboxIds.length} other member(s)`
  );
  return makeChannel(client, group);
}

/**
 * Create a channel by EVM addresses instead of inbox IDs. Convenience wrapper
 * around `createGroupWithIdentifiers` that lets callers paste 0x addresses
 * without first resolving them to inbox IDs.
 *
 * Throws when any address has no XMTP inbox — pre-check via
 * `client.canMessage(...)` if that case needs friendlier handling.
 *
 * @param {object} client
 * @param {object} opts
 * @param {string[]} opts.memberAddresses - 0x EVM addresses
 * @param {string} [opts.name]
 * @returns {Promise<object>} Channel
 */
async function createChannelByAddresses(client, { memberAddresses, name } = {}) {
  if (!Array.isArray(memberAddresses) || memberAddresses.length === 0) {
    throw new Error('createChannelByAddresses: memberAddresses[] required');
  }
  const identifiers = memberAddresses.map((addr) => ({
    identifier: String(addr).toLowerCase(),
    identifierKind: 'Ethereum',
  }));
  const groupOpts = name ? { groupName: name } : undefined;
  const group = await client.conversations.createGroupWithIdentifiers(identifiers, groupOpts);
  log.info(
    `[messaging.channel] created channel ${group.id} with ${memberAddresses.length} other member(s)`
  );
  return makeChannel(client, group);
}

/**
 * Open a channel by group ID. Syncs from the network first so we discover
 * groups we were added to since last run.
 *
 * @param {object} client - Active XMTP Client
 * @param {string} groupId - The group ID to look up
 * @returns {Promise<object|null>} Channel, or null if not found / not a group
 */
async function openChannelById(client, groupId) {
  await client.conversations.sync();
  const convo = await client.conversations.getConversationById(groupId);
  if (!convo || typeof convo.addMembers !== 'function') {
    // DMs don't expose add/removeMembers — they're a different shape and
    // not what "channel" semantics are about. Return null in either case.
    return null;
  }
  return makeChannel(client, convo);
}

/**
 * List all channels (groups) the local client is a member of.
 * Syncs first so newly-admitted groups show up.
 *
 * @param {object} client
 * @returns {Promise<object[]>} Channels
 */
async function listChannels(client) {
  await client.conversations.sync();
  const groups = client.conversations.listGroups();
  return groups.map((g) => makeChannel(client, g));
}

module.exports = {
  createChannel,
  createChannelByAddresses,
  openChannelById,
  listChannels,
  // Exposed for tests; not intended for direct use by callers.
  _makeChannel: makeChannel,
  _safeParse: safeParse,
};
