/**
 * XMTP Client
 *
 * Owns the lifecycle of the @xmtp/node-sdk Client for one Freedom installation.
 * The wallet provided to start() is the installation's identity — under the
 * "1 account = 1 instance" model, each Freedom install registers its own XMTP
 * inbox tied to its own EVM address.
 *
 * Singleton-style: the main process holds a single Client per Freedom run.
 * Other modules (channel.js, the queue layer, IPC handlers) get the active
 * client via getClient().
 *
 * The @xmtp/node-sdk package is ESM-only; we keep require() compatibility by
 * importing it dynamically and caching the module. Tests can pass `sdkOverride`
 * to start() to inject a mock SDK without touching the import boundary.
 *
 * Persistent state:
 *  - Local SQLite DB at `${dataDir}/xmtp-${env}-${addrShort}.db3`. The DB is
 *    encrypted with a key deterministically derived from the wallet private
 *    key, so reopening the same wallet on the same machine restores the same
 *    XMTP installation rather than registering a fresh one each launch.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('electron-log');

// IdentifierKind.Ethereum is a TypeScript `const enum` (value 0 at runtime).
// We don't import the SDK eagerly, so spell the value out here.
const IDENTIFIER_KIND_ETHEREUM = 0;

const DB_KEY_DOMAIN = 'freedom-xmtp-db-v1';

// Module-scoped state. Mirrors the singleton pattern in swarm-service.js.
let cachedSdk = null;
let activeClient = null;
let activeInfo = null;

/**
 * Load and cache the ESM @xmtp/node-sdk module.
 * @param {object|null} override - Optional injected SDK (for tests).
 */
async function loadSdk(override) {
  if (override) return override;
  if (cachedSdk) return cachedSdk;
  cachedSdk = await import('@xmtp/node-sdk');
  return cachedSdk;
}

/**
 * Derive a 32-byte DB encryption key from the wallet private key.
 * Deterministic so we can reopen the same on-disk DB across runs without
 * exporting the wallet key itself to disk.
 * @param {string} privateKeyHex - 0x-prefixed hex private key
 * @returns {Uint8Array}
 */
function deriveDbEncryptionKey(privateKeyHex) {
  const pkBytes = Buffer.from(privateKeyHex.replace(/^0x/, ''), 'hex');
  const h = crypto.createHash('sha256');
  h.update(DB_KEY_DOMAIN);
  h.update(pkBytes);
  return new Uint8Array(h.digest());
}

/**
 * Build the SDK Signer for a wallet private key.
 * Uses ethers' Wallet purely as a message signer; no transactions are sent.
 * @param {string} privateKeyHex - 0x-prefixed hex private key
 * @param {string} address - 0x-prefixed checksummed address
 * @returns {object} XMTP Signer ({ type: 'EOA', getIdentifier, signMessage })
 */
function buildSigner(privateKeyHex, address) {
  const { Wallet } = require('ethers');
  const wallet = new Wallet(privateKeyHex);
  const lowerAddress = address.toLowerCase();
  return {
    type: 'EOA',
    getIdentifier: () => ({
      identifier: lowerAddress,
      identifierKind: IDENTIFIER_KIND_ETHEREUM,
    }),
    signMessage: async (message) => {
      const sigHex = await wallet.signMessage(message);
      return Uint8Array.from(Buffer.from(sigHex.slice(2), 'hex'));
    },
  };
}

/**
 * Build the on-disk DB path for this wallet/env. Includes a short
 * address suffix so multiple wallets on the same machine don't collide.
 * @param {string} dataDir
 * @param {string} env
 * @param {string} address
 * @returns {string}
 */
function buildDbPath(dataDir, env, address) {
  const short = address.replace(/^0x/, '').slice(0, 10).toLowerCase();
  return path.join(dataDir, `xmtp-${env}-${short}.db3`);
}

/**
 * Start the XMTP client for the given wallet.
 * If a client is already started for the same address+env, returns the
 * existing one. Starting for a different identity throws — call stop() first.
 *
 * @param {object} opts
 * @param {string} opts.privateKey - 0x-prefixed hex private key
 * @param {string} opts.address - 0x-prefixed EVM address
 * @param {string} opts.dataDir - Directory for the local XMTP DB
 * @param {string} [opts.env] - XMTP network env (default 'dev')
 * @param {object} [opts.sdkOverride] - Test seam: inject the SDK module
 * @returns {Promise<{ inboxId: string, installationId: string, address: string, env: string }>}
 */
async function start({ privateKey, address, dataDir, env = 'dev', sdkOverride = null }) {
  if (!privateKey || !address) {
    throw new Error('xmtp-client.start: privateKey and address are required');
  }
  if (!dataDir) {
    throw new Error('xmtp-client.start: dataDir is required');
  }

  if (activeClient) {
    if (activeInfo.address.toLowerCase() === address.toLowerCase() && activeInfo.env === env) {
      return activeInfo;
    }
    throw new Error(
      `xmtp-client: already started for ${activeInfo.address} on ${activeInfo.env}; ` +
        `call stop() before starting a different identity.`
    );
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const sdk = await loadSdk(sdkOverride);
  const signer = buildSigner(privateKey, address);
  const dbPath = buildDbPath(dataDir, env, address);
  const dbEncryptionKey = deriveDbEncryptionKey(privateKey);

  log.info(`[XmtpClient] starting (env=${env}, addr=${address}, db=${dbPath})`);
  const client = await sdk.Client.create(signer, {
    env,
    dbPath,
    dbEncryptionKey,
  });

  activeClient = client;
  activeInfo = {
    inboxId: client.inboxId,
    installationId: client.installationId,
    address,
    env,
    dbPath,
  };
  log.info(
    `[XmtpClient] ready (inboxId=${activeInfo.inboxId}, installationId=${activeInfo.installationId})`
  );
  return activeInfo;
}

/**
 * Stop and forget the active client. Idempotent.
 * The on-disk DB is preserved; deleting it is the caller's responsibility.
 */
function stop() {
  if (!activeClient) return;
  log.info(`[XmtpClient] stopping (addr=${activeInfo.address})`);
  activeClient = null;
  activeInfo = null;
}

/**
 * Get the active client.
 * @returns {object} The XMTP Client instance
 * @throws if no client is started
 */
function getClient() {
  if (!activeClient) {
    throw new Error('xmtp-client: not started — call start() first');
  }
  return activeClient;
}

/**
 * Get the active client's info, or null if not started.
 * @returns {{ inboxId: string, installationId: string, address: string, env: string, dbPath: string } | null}
 */
function getInfo() {
  return activeInfo;
}

/**
 * @returns {boolean} Whether a client is currently active.
 */
function isStarted() {
  return activeClient !== null;
}

module.exports = {
  start,
  stop,
  getClient,
  getInfo,
  isStarted,
  // Exposed for tests and for callers that need to construct identifiers in
  // the same shape XMTP expects (see channel.js).
  IDENTIFIER_KIND_ETHEREUM,
  buildDbPath,
  deriveDbEncryptionKey,
};
