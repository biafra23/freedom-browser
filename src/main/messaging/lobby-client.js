/**
 * Lobby Client
 *
 * Per-Freedom-install module that joins the global "Freedom Lobby" XMTP
 * group on first launch and resumes membership on subsequent launches.
 *
 * Flow on first launch:
 *   1. Check the on-disk cache (lobby.json) — if a groupId is recorded, do
 *      nothing; the messaging-runtime will pick the group up via its
 *      normal listChannels() path.
 *   2. If no cache, find or create a DM with the admin, send a
 *      `lobby:join-request` envelope containing our inbox + address.
 *   3. Stream incoming DM messages waiting for a `lobby:join-ack` from the
 *      admin. The ack carries the groupId.
 *   4. Persist the groupId to lobby.json. The messaging-runtime's normal
 *      subscribeAllExistingChannels() picks the group up next sync.
 *
 * The flow is fire-and-forget from the runtime's perspective — a network
 * blip or admin downtime just means the lobby doesn't appear in the
 * channels list for that session; the next launch retries.
 */

const fs = require('fs');
const path = require('path');
const log = require('electron-log');

const {
  LOBBY_ADMIN_ADDRESS,
  KIND_LOBBY_JOIN_REQUEST,
  KIND_LOBBY_JOIN_ACK,
  LOBBY_CACHE_FILE,
} = require('./lobby-config');

// Cap how long we wait for an ack before timing out. The admin should
// respond in well under a second once it sees the request, but allow a
// healthy buffer for slow networks / a momentarily-offline admin.
const ACK_TIMEOUT_MS = 30_000;

function cachePath(dataDir) {
  return path.join(dataDir, LOBBY_CACHE_FILE);
}

function readCache(dataDir) {
  try {
    const raw = fs.readFileSync(cachePath(dataDir), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCache(dataDir, payload) {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(cachePath(dataDir), JSON.stringify(payload, null, 2) + '\n');
  } catch (err) {
    log.warn('[LobbyClient] failed to write cache:', err);
  }
}

/**
 * Resolve the admin EVM address to its XMTP inbox ID. Returns null if the
 * admin has no XMTP inbox yet (admin daemon hasn't been started against
 * this env), so callers can defer rather than crash.
 *
 * IdentifierKind.Ethereum is a const enum (value 0). We pass the numeric
 * value directly so this works without importing the SDK eagerly.
 */
async function resolveAdminInboxId(client) {
  const identifier = { identifier: LOBBY_ADMIN_ADDRESS.toLowerCase(), identifierKind: 0 };
  try {
    if (typeof client.fetchInboxIdByIdentifier === 'function') {
      const id = await client.fetchInboxIdByIdentifier(identifier);
      return id || null;
    }
    return null;
  } catch (err) {
    log.warn('[LobbyClient] resolveAdminInboxId failed:', err);
    return null;
  }
}

async function findOrCreateAdminDm(client, adminInboxId) {
  // Reuse an existing DM with the admin if we have one; otherwise create.
  const dm = client.conversations.getDmByInboxId?.(adminInboxId);
  if (dm) return dm;
  return client.conversations.createDm(adminInboxId);
}

function safeJsonParse(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Check if a group with this ID is in the local SDK's view of the world.
 * Syncs first so groups we were admitted to in the background show up.
 * Returns false on any error so callers can fall back to a fresh join.
 */
async function isGroupVisibleLocally(client, groupId) {
  try {
    await client.conversations.sync();
    const convo = await client.conversations.getConversationById(groupId);
    // Groups expose addMembers; DMs don't. We only care about groups.
    return !!(convo && typeof convo.addMembers === 'function');
  } catch (err) {
    log.warn(`[LobbyClient] isGroupVisibleLocally(${groupId}) failed:`, err);
    return false;
  }
}

/**
 * Wait for a `lobby:join-ack` from the admin on `dm`. Resolves with the
 * group ID, rejects on timeout or stream error.
 */
async function awaitAck(dm, adminInboxId, requestId) {
  return new Promise((resolve, reject) => {
    let stream = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`lobby ack timed out after ${ACK_TIMEOUT_MS}ms`));
    }, ACK_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      try {
        stream?.end?.();
      } catch (err) {
        log.warn('[LobbyClient] stream end error:', err);
      }
    };

    dm.stream({
      onValue: (msg) => {
        if (!msg || typeof msg.content !== 'string') return;
        if (msg.senderInboxId !== adminInboxId) return;
        const parsed = safeJsonParse(msg.content);
        if (!parsed || parsed.kind !== KIND_LOBBY_JOIN_ACK) return;
        if (requestId && parsed.requestId && parsed.requestId !== requestId) return;
        if (!parsed.groupId) {
          cleanup();
          reject(new Error('lobby ack missing groupId'));
          return;
        }
        cleanup();
        resolve(parsed.groupId);
      },
      onError: (err) => {
        cleanup();
        reject(err);
      },
    })
      .then((s) => {
        stream = s;
      })
      .catch((err) => {
        cleanup();
        reject(err);
      });
  });
}

/**
 * Ensure this Freedom install is a member of the global lobby. Idempotent:
 * if a cached groupId exists, returns immediately; otherwise runs the
 * join handshake and persists the result.
 *
 * @param {object} client - Active XMTP Client
 * @param {string} dataDir - messaging-data directory (where lobby.json lives)
 * @param {string} env - XMTP env, persisted alongside the groupId so a
 *   later env switch (dev → production) re-runs the join.
 * @returns {Promise<{groupId: string, fromCache: boolean} | null>}
 */
async function ensureLobbyMembership(client, dataDir, env) {
  // Don't try to join our own lobby if THIS install IS the admin — the
  // admin daemon owns the lobby group directly.
  if (
    client?.accountIdentifier?.identifier?.toLowerCase?.() === LOBBY_ADMIN_ADDRESS.toLowerCase()
  ) {
    log.info('[LobbyClient] this install is the admin, skipping join flow');
    return null;
  }

  const cached = readCache(dataDir);
  // Trust the cache only if (a) it was written for this same XMTP env,
  // (b) it was written by THIS wallet's inbox, and (c) the group is
  // actually present in the local SDK state. (a)+(b) catch the
  // wallet-switch / dir-copy cases; (c) catches "DB was wiped but cache
  // wasn't" and any other sync drift. If any check fails, fall through
  // to the join handshake — the admin will re-admit + re-ack and we'll
  // overwrite the bad cache.
  if (
    cached?.groupId &&
    cached?.env === env &&
    (!cached.inboxId || cached.inboxId === client.inboxId)
  ) {
    const present = await isGroupVisibleLocally(client, cached.groupId);
    if (present) {
      log.info(`[LobbyClient] cached lobby membership verified (group=${cached.groupId})`);
      return { groupId: cached.groupId, fromCache: true };
    }
    log.warn(
      `[LobbyClient] cache references group ${cached.groupId} but it isn't in the local SDK state — re-running join handshake`
    );
  } else if (cached?.groupId) {
    log.warn(
      `[LobbyClient] ignoring cache (env=${cached.env} inboxId=${cached.inboxId}) — does not match current identity (env=${env} inboxId=${client.inboxId})`
    );
  }

  const adminInboxId = await resolveAdminInboxId(client);
  if (!adminInboxId) {
    log.warn(
      `[LobbyClient] admin ${LOBBY_ADMIN_ADDRESS} has no XMTP inbox on env=${env} — skipping lobby join (admin daemon may be offline)`
    );
    return null;
  }

  log.info(`[LobbyClient] requesting lobby membership via DM to admin ${adminInboxId}`);
  const dm = await findOrCreateAdminDm(client, adminInboxId);

  // Start the ack-listener BEFORE sending the request so we don't miss a
  // fast reply.
  const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ackPromise = awaitAck(dm, adminInboxId, requestId);

  await dm.sendText(
    JSON.stringify({
      v: 1,
      kind: KIND_LOBBY_JOIN_REQUEST,
      requestId,
      address: client.accountIdentifier?.identifier || null,
      inboxId: client.inboxId,
      installationId: client.installationId,
      sentAt: new Date().toISOString(),
    })
  );

  let groupId;
  try {
    groupId = await ackPromise;
  } catch (err) {
    log.warn('[LobbyClient] join handshake failed:', err);
    return null;
  }

  writeCache(dataDir, {
    groupId,
    env,
    inboxId: client.inboxId,
    address: client.accountIdentifier?.identifier || null,
    joinedAt: new Date().toISOString(),
  });
  log.info(`[LobbyClient] joined lobby (group=${groupId})`);
  return { groupId, fromCache: false };
}

/**
 * Read the on-disk lobby cache for callers that need the current group
 * ID (e.g. messaging-runtime.getLobbyChannelId so peer-tools can default
 * to broadcasting in the lobby). Returns the parsed JSON or null if no
 * cache exists or it's unreadable. Callers must validate env / inboxId
 * against their current identity before trusting the groupId.
 *
 * @param {string} dataDir
 * @returns {{ groupId, env, inboxId, address, joinedAt } | null}
 */
function readLobbyCache(dataDir) {
  return readCache(dataDir);
}

module.exports = {
  ensureLobbyMembership,
  readLobbyCache,
  // Test seams.
  _internals: {
    cachePath,
    readCache,
    writeCache,
    safeJsonParse,
    isGroupVisibleLocally,
    resolveAdminInboxId,
    findOrCreateAdminDm,
    awaitAck,
  },
};
