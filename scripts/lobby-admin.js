#!/usr/bin/env node
/**
 * Freedom Lobby Admin Daemon
 *
 * Runs the always-online XMTP installation that bootstraps new Freedom
 * clients into the global "Freedom Lobby" MLS group.
 *
 * Responsibilities:
 *   - Hold the admin private key (loaded from `lobby-admin-keys/lobby-admin.key.json`).
 *   - On first run, create the lobby MLS group with `permissions: Default`
 *     so any member can subsequently admit others. Persist the resulting
 *     groupId to `lobby-admin-keys/lobby-admin.state.json`.
 *   - Stream every incoming DM, parse JSON envelopes, and for each
 *     `lobby:join-request`:
 *       * add the requester's inbox ID to the lobby group (idempotent)
 *       * reply on the same DM with `lobby:join-ack { groupId }`
 *
 * Run:
 *   node scripts/lobby-admin.js           # uses XMTP env=dev
 *   FREEDOM_XMTP_ENV=production node scripts/lobby-admin.js
 *
 * Notes:
 *   - One admin process per env (dev / production). The state file is
 *     env-segmented so you can run both side-by-side from the same checkout.
 *   - SIGINT/SIGTERM are handled cleanly: the stream is closed and the
 *     process exits.
 *   - Logs go to stdout. There's no external observability — wrap in
 *     systemd / pm2 / launchd if you want auto-restart.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Two valid layouts for `lobby-config.js`:
//   - inside the Freedom repo: src/main/messaging/lobby-config.js
//   - in a flat standalone deploy: lobby-config.js next to this script
function loadLobbyConfig() {
  try {
    return require('../src/main/messaging/lobby-config');
  } catch {
    return require('./lobby-config');
  }
}
const {
  KIND_LOBBY_JOIN_REQUEST,
  KIND_LOBBY_JOIN_ACK,
  LOBBY_ADMIN_ADDRESS,
  LOBBY_DEFAULT_NAME,
} = loadLobbyConfig();

const ETHEREUM_IDENTIFIER_KIND = 0;
const ENV = process.env.FREEDOM_XMTP_ENV || 'dev';

// BASE_DIR is the folder that holds `lobby-admin-keys/` and the on-disk
// XMTP DB. In dev (running from the repo) it defaults to the repo root;
// in a standalone server deploy point LOBBY_ADMIN_BASE_DIR at the deploy
// directory (e.g. /home/ubuntu/freedom-messaging-admin).
const BASE_DIR =
  process.env.LOBBY_ADMIN_BASE_DIR ||
  (fs.existsSync(path.join(__dirname, 'lobby-admin-keys'))
    ? __dirname
    : path.join(__dirname, '..'));

const KEY_PATH = path.join(BASE_DIR, 'lobby-admin-keys', 'lobby-admin.key.json');
const STATE_PATH = path.join(BASE_DIR, 'lobby-admin-keys', `lobby-admin.state.${ENV}.json`);
const DB_PATH = path.join(BASE_DIR, 'lobby-admin-keys', `xmtp-${ENV}.db3`);
const DB_KEY_PATH = path.join(BASE_DIR, 'lobby-admin-keys', `xmtp-${ENV}.dbkey`);

function ts() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(`[${ts()}] [lobby-admin]`, ...args);
}

function warn(...args) {
  console.warn(`[${ts()}] [lobby-admin] WARN`, ...args);
}

function err(...args) {
  console.error(`[${ts()}] [lobby-admin] ERROR`, ...args);
}

function loadAdminKey() {
  if (!fs.existsSync(KEY_PATH)) {
    throw new Error(
      `Admin key file not found at ${KEY_PATH}.\n` +
        `Generate one with:\n` +
        `  node -e "const {Wallet}=require('ethers');const fs=require('fs');const w=Wallet.createRandom();fs.writeFileSync('${KEY_PATH}', JSON.stringify({address:w.address,privateKey:w.privateKey,mnemonic:w.mnemonic.phrase},null,2));console.log(w.address);"`
    );
  }
  const raw = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  if (raw.address.toLowerCase() !== LOBBY_ADMIN_ADDRESS.toLowerCase()) {
    throw new Error(
      `Admin key address ${raw.address} does not match LOBBY_ADMIN_ADDRESS ${LOBBY_ADMIN_ADDRESS} ` +
        `in src/main/messaging/lobby-config.js. Update lobby-config to match the key file, then redeploy.`
    );
  }
  return raw;
}

function loadOrCreateDbEncryptionKey() {
  if (fs.existsSync(DB_KEY_PATH)) {
    return new Uint8Array(fs.readFileSync(DB_KEY_PATH));
  }
  const k = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(DB_KEY_PATH), { recursive: true });
  fs.writeFileSync(DB_KEY_PATH, k, { mode: 0o600 });
  log(`generated fresh DB encryption key at ${DB_KEY_PATH}`);
  return new Uint8Array(k);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function makeSigner(wallet) {
  return {
    type: 'EOA',
    getIdentifier: () => ({
      identifier: wallet.address.toLowerCase(),
      identifierKind: ETHEREUM_IDENTIFIER_KIND,
    }),
    signMessage: async (message) => {
      const sigHex = await wallet.signMessage(message);
      return Uint8Array.from(Buffer.from(sigHex.slice(2), 'hex'));
    },
  };
}

function safeParse(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function ensureLobbyGroup(client, sdk) {
  const state = readState();
  if (state?.groupId) {
    try {
      await client.conversations.sync();
      const existing = await client.conversations.getConversationById(state.groupId);
      if (existing && typeof existing.addMembers === 'function') {
        log(`reusing existing lobby group ${state.groupId}`);
        return existing;
      }
      warn(`state file references missing group ${state.groupId} — recreating`);
    } catch (e) {
      warn(`failed to reopen cached lobby group: ${e?.message || e}`);
    }
  }

  log('creating fresh lobby MLS group (permissions=Default, anyone can admit)');
  // GroupPermissionsOptions.Default = 0 (see node-bindings index.d.ts).
  // `Default` policy means any member can add/remove members and update
  // metadata — exactly what we want for an open lobby that heals as it grows.
  const group = await client.conversations.createGroup([], {
    groupName: LOBBY_DEFAULT_NAME,
    groupDescription: 'The global meeting room for all Freedom Browser instances.',
    permissions: sdk.GroupPermissionsOptions?.Default ?? 0,
  });
  writeState({
    groupId: group.id,
    env: ENV,
    createdAt: new Date().toISOString(),
    adminAddress: LOBBY_ADMIN_ADDRESS,
  });
  log(`created lobby group ${group.id}`);
  return group;
}

async function isAlreadyMember(group, inboxId) {
  try {
    await group.sync();
    const members = await group.members();
    for (const m of members) {
      const id = typeof m === 'string' ? m : m.inboxId || m.id;
      if (id === inboxId) return true;
    }
  } catch (e) {
    warn(`isAlreadyMember check failed: ${e?.message || e}`);
  }
  return false;
}

async function admitToLobby(group, inboxId) {
  if (await isAlreadyMember(group, inboxId)) {
    log(`  already a member: ${inboxId}`);
    return { admitted: false };
  }
  await group.addMembers([inboxId]);
  log(`  admitted: ${inboxId}`);
  return { admitted: true };
}

async function ackJoin(client, dmInboxId, groupId, requestId) {
  const dm =
    client.conversations.getDmByInboxId?.(dmInboxId) ||
    (await client.conversations.createDm(dmInboxId));
  const ack = {
    v: 1,
    kind: KIND_LOBBY_JOIN_ACK,
    requestId: requestId || null,
    groupId,
    sentAt: new Date().toISOString(),
  };
  await dm.sendText(JSON.stringify(ack));
  log(`  ack sent → ${dmInboxId} (group=${groupId})`);
}

async function handleEnvelope(client, group, msg) {
  // We're streaming ALL DM messages; ignore our own and anything that
  // isn't a JSON envelope shaped like a join request.
  if (!msg || typeof msg.content !== 'string') return;
  if (msg.senderInboxId === client.inboxId) return;
  const env = safeParse(msg.content);
  if (!env || env.kind !== KIND_LOBBY_JOIN_REQUEST) return;

  log(`join request from ${msg.senderInboxId} (req=${env.requestId || '?'})`);
  try {
    await admitToLobby(group, msg.senderInboxId);
    await ackJoin(client, msg.senderInboxId, group.id, env.requestId);
  } catch (e) {
    err(`failed to handle join from ${msg.senderInboxId}:`, e?.message || e);
  }
}

async function main() {
  const { Client, GroupPermissionsOptions } = await import('@xmtp/node-sdk');
  const { Wallet } = await import('ethers');
  // Pass the SDK module to ensureLobbyGroup so it can reach the const enum
  // value at runtime regardless of how Rollup compiled it.
  const sdk = { GroupPermissionsOptions };

  log(`env=${ENV}`);
  log(`db=${DB_PATH}`);
  log(`state=${STATE_PATH}`);

  const adminKey = loadAdminKey();
  const wallet = new Wallet(adminKey.privateKey);
  log(`admin address: ${wallet.address}`);

  const dbEncryptionKey = loadOrCreateDbEncryptionKey();

  const client = await Client.create(makeSigner(wallet), {
    env: ENV,
    dbPath: DB_PATH,
    dbEncryptionKey,
  });
  log(`client ready inboxId=${client.inboxId} installationId=${client.installationId}`);

  const group = await ensureLobbyGroup(client, sdk);

  log('streaming DM messages…');
  const stream = await client.conversations.streamAllDmMessages({
    onValue: (msg) => {
      handleEnvelope(client, group, msg).catch((e) => err('handleEnvelope threw:', e));
    },
    onError: (e) => err('stream error:', e),
  });

  const shutdown = (sig) => {
    log(`received ${sig}, shutting down`);
    try {
      stream?.end?.();
    } catch (e) {
      warn('stream.end failed:', e?.message || e);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log(`READY — ${LOBBY_DEFAULT_NAME} group ${group.id} on env=${ENV}`);
  log(`(will admit any inbox that DMs me ${KIND_LOBBY_JOIN_REQUEST})`);
}

main().catch((e) => {
  err('fatal:', e);
  process.exit(1);
});
