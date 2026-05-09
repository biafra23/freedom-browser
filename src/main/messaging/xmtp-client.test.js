jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const xmtpClient = require('./xmtp-client');

// A reference test wallet — same key used across cases.
// 32 bytes of 0xab is a valid (if hilarious) secp256k1 private key.
const TEST_PRIVATE_KEY = '0x' + 'ab'.repeat(32);
const TEST_ADDRESS = '0xAa11bB22cC33dD44eE55fF66aa77bb88cc99dd00';

function makeMockSdk({ inboxId = 'inbox-A', installationId = 'install-A' } = {}) {
  const created = [];
  const Client = {
    create: jest.fn(async (signer, options) => {
      const callArgs = { signer, options };
      created.push(callArgs);
      return {
        inboxId,
        installationId,
        // Echo a couple of inputs back so tests can assert on them.
        _signer: signer,
        _options: options,
      };
    }),
  };
  return { sdk: { Client }, created };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xmtp-client-test-'));
}

beforeEach(() => {
  // Reset module state between tests since xmtp-client is singleton-ish.
  xmtpClient.stop();
});

describe('deriveDbEncryptionKey', () => {
  test('produces a 32-byte Uint8Array', () => {
    const key = xmtpClient.deriveDbEncryptionKey(TEST_PRIVATE_KEY);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  test('is deterministic for the same private key', () => {
    const a = xmtpClient.deriveDbEncryptionKey(TEST_PRIVATE_KEY);
    const b = xmtpClient.deriveDbEncryptionKey(TEST_PRIVATE_KEY);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test('differs for different private keys', () => {
    const a = xmtpClient.deriveDbEncryptionKey(TEST_PRIVATE_KEY);
    const b = xmtpClient.deriveDbEncryptionKey('0x' + 'cd'.repeat(32));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test('does not equal the raw private key', () => {
    const key = xmtpClient.deriveDbEncryptionKey(TEST_PRIVATE_KEY);
    const raw = Buffer.from(TEST_PRIVATE_KEY.slice(2), 'hex');
    expect(Buffer.from(key).equals(raw)).toBe(false);
  });
});

describe('buildDbPath', () => {
  test('includes env and address shorthand', () => {
    const p = xmtpClient.buildDbPath('/tmp/freedom', 'dev', TEST_ADDRESS);
    expect(p).toBe(path.join('/tmp/freedom', 'xmtp-dev-aa11bb22cc.db3'));
  });

  test('different envs produce different paths', () => {
    const a = xmtpClient.buildDbPath('/tmp/freedom', 'dev', TEST_ADDRESS);
    const b = xmtpClient.buildDbPath('/tmp/freedom', 'production', TEST_ADDRESS);
    expect(a).not.toBe(b);
  });
});

describe('start / stop / getClient / getInfo / isStarted', () => {
  test('rejects missing arguments', async () => {
    await expect(xmtpClient.start({})).rejects.toThrow(/privateKey and address/);
    await expect(
      xmtpClient.start({ privateKey: TEST_PRIVATE_KEY, address: TEST_ADDRESS })
    ).rejects.toThrow(/dataDir/);
  });

  test('start() creates a client and registers info', async () => {
    const dir = tmpDir();
    const { sdk, created } = makeMockSdk();

    expect(xmtpClient.isStarted()).toBe(false);
    expect(xmtpClient.getInfo()).toBeNull();

    const info = await xmtpClient.start({
      privateKey: TEST_PRIVATE_KEY,
      address: TEST_ADDRESS,
      dataDir: dir,
      sdkOverride: sdk,
    });

    expect(info.address).toBe(TEST_ADDRESS);
    expect(info.env).toBe('dev');
    expect(info.inboxId).toBe('inbox-A');
    expect(info.installationId).toBe('install-A');
    expect(info.dbPath).toBe(path.join(dir, 'xmtp-dev-aa11bb22cc.db3'));

    expect(xmtpClient.isStarted()).toBe(true);
    expect(xmtpClient.getInfo()).toEqual(info);

    expect(sdk.Client.create).toHaveBeenCalledTimes(1);
    expect(created[0].options.env).toBe('dev');
    expect(created[0].options.dbPath).toBe(info.dbPath);
    expect(created[0].options.dbEncryptionKey).toBeInstanceOf(Uint8Array);
    expect(created[0].options.dbEncryptionKey.length).toBe(32);
    expect(created[0].signer.type).toBe('EOA');
  });

  test('signer.getIdentifier returns lowercased Ethereum identifier', async () => {
    const { sdk, created } = makeMockSdk();
    await xmtpClient.start({
      privateKey: TEST_PRIVATE_KEY,
      address: TEST_ADDRESS,
      dataDir: tmpDir(),
      sdkOverride: sdk,
    });
    const id = created[0].signer.getIdentifier();
    expect(id).toEqual({
      identifier: TEST_ADDRESS.toLowerCase(),
      identifierKind: xmtpClient.IDENTIFIER_KIND_ETHEREUM,
    });
  });

  test('signer.signMessage produces a 65-byte secp256k1 sig as Uint8Array', async () => {
    const { sdk, created } = makeMockSdk();
    await xmtpClient.start({
      privateKey: TEST_PRIVATE_KEY,
      address: TEST_ADDRESS,
      dataDir: tmpDir(),
      sdkOverride: sdk,
    });
    const sig = await created[0].signer.signMessage('hello world');
    expect(sig).toBeInstanceOf(Uint8Array);
    // ECDSA: r(32) + s(32) + v(1) = 65 bytes
    expect(sig.length).toBe(65);
  });

  test('start() is idempotent for the same identity+env', async () => {
    const dir = tmpDir();
    const { sdk } = makeMockSdk();
    const first = await xmtpClient.start({
      privateKey: TEST_PRIVATE_KEY,
      address: TEST_ADDRESS,
      dataDir: dir,
      sdkOverride: sdk,
    });
    const second = await xmtpClient.start({
      privateKey: TEST_PRIVATE_KEY,
      address: TEST_ADDRESS,
      dataDir: dir,
      sdkOverride: sdk,
    });
    expect(second).toEqual(first);
    expect(sdk.Client.create).toHaveBeenCalledTimes(1);
  });

  test('start() throws when an existing client uses a different address', async () => {
    const dir = tmpDir();
    const { sdk } = makeMockSdk();
    await xmtpClient.start({
      privateKey: TEST_PRIVATE_KEY,
      address: TEST_ADDRESS,
      dataDir: dir,
      sdkOverride: sdk,
    });
    const otherKey = '0x' + 'cd'.repeat(32);
    const otherAddress = '0x' + 'cd'.repeat(20);
    await expect(
      xmtpClient.start({
        privateKey: otherKey,
        address: otherAddress,
        dataDir: dir,
        sdkOverride: sdk,
      })
    ).rejects.toThrow(/already started/);
  });

  test('start() throws when env differs for the same wallet', async () => {
    const dir = tmpDir();
    const { sdk } = makeMockSdk();
    await xmtpClient.start({
      privateKey: TEST_PRIVATE_KEY,
      address: TEST_ADDRESS,
      dataDir: dir,
      sdkOverride: sdk,
    });
    await expect(
      xmtpClient.start({
        privateKey: TEST_PRIVATE_KEY,
        address: TEST_ADDRESS,
        dataDir: dir,
        env: 'production',
        sdkOverride: sdk,
      })
    ).rejects.toThrow(/already started/);
  });

  test('stop() resets the active client and is idempotent', async () => {
    const { sdk } = makeMockSdk();
    await xmtpClient.start({
      privateKey: TEST_PRIVATE_KEY,
      address: TEST_ADDRESS,
      dataDir: tmpDir(),
      sdkOverride: sdk,
    });
    expect(xmtpClient.isStarted()).toBe(true);
    xmtpClient.stop();
    expect(xmtpClient.isStarted()).toBe(false);
    expect(xmtpClient.getInfo()).toBeNull();
    xmtpClient.stop();
    expect(xmtpClient.isStarted()).toBe(false);
  });

  test('start() creates dataDir if it does not exist', async () => {
    const dir = path.join(os.tmpdir(), `xmtp-fresh-${crypto.randomBytes(4).toString('hex')}`);
    expect(fs.existsSync(dir)).toBe(false);
    const { sdk } = makeMockSdk();
    await xmtpClient.start({
      privateKey: TEST_PRIVATE_KEY,
      address: TEST_ADDRESS,
      dataDir: dir,
      sdkOverride: sdk,
    });
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('getClient() throws if not started', () => {
    expect(() => xmtpClient.getClient()).toThrow(/not started/);
  });
});
