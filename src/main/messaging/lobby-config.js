/**
 * Lobby config — shared constants for the global Freedom lobby.
 *
 * Architecture: a single XMTP installation (the "lobby admin") creates an
 * MLS group with `permissions: Default` and admits new members on demand.
 * Every Freedom client knows the admin's address (constant below); on first
 * messaging start they DM the admin asking to join, the admin auto-admits
 * them, and the lobby group ID is cached locally for subsequent runs.
 *
 * Once admitted, a member can also admit others (Default permissions), so
 * the lobby is gossip-resilient: the admin is only a single point of
 * failure for *first-time onboarding*, not for ongoing operation.
 *
 * The admin's PRIVATE key lives in `lobby-admin-keys/lobby-admin.key.json`
 * (gitignored). Only one machine should hold it. See `scripts/lobby-admin.js`
 * for the daemon that runs the admin side.
 */

// EVM address of the lobby admin's XMTP installation. Address-only; we
// resolve it to an inbox ID at runtime so a future admin key rotation
// just requires updating this constant + redeploying.
const LOBBY_ADMIN_ADDRESS = '0x6eC4Fa6E1a9EDCd2cFf1943Ec621C327c9b782A2';

// Envelope `kind` values exchanged on the admin's DM channel.
const KIND_LOBBY_JOIN_REQUEST = 'lobby:join-request';
const KIND_LOBBY_JOIN_ACK = 'lobby:join-ack';

// Local cache filename inside the messaging data dir. Stores
// `{ groupId, joinedAt, env }` so we don't re-DM the admin on every launch.
const LOBBY_CACHE_FILE = 'lobby.json';

// Display name for the lobby in the channels list.
const LOBBY_DEFAULT_NAME = 'Freedom Lobby';

// MLS group ID of the Freedom Lobby on the dev XMTP env, hardcoded so
// `messaging-runtime.getLobbyChannelId()` has a working fallback when the
// per-install lobby.json cache is missing or stale (e.g. an install that
// was hand-admitted by the admin daemon's `addMembers` rather than via
// the join handshake never wrote the cache). Captured by reading
// `(await window.messaging.listChannels()).data.find(c => c.name === 'Freedom Lobby').id`
// against the live admin daemon. If the admin ever recreates the lobby
// the value changes — update here.
const LOBBY_DEFAULT_GROUP_ID = '50093f0317ef4032d84861eac39b5887';

module.exports = {
  LOBBY_ADMIN_ADDRESS,
  KIND_LOBBY_JOIN_REQUEST,
  KIND_LOBBY_JOIN_ACK,
  LOBBY_CACHE_FILE,
  LOBBY_DEFAULT_NAME,
  LOBBY_DEFAULT_GROUP_ID,
};
