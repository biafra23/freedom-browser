const path = require('path');
const fs = require('fs');
const os = require('os');

jest.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn(),
  },
  ipcMain: {
    handle: jest.fn(),
  },
}));

const mockGetEthereumWalletIdentityReferences = jest.fn();

jest.mock('./swarm/feed-store', () => ({
  getEthereumWalletIdentityReferences: (...args) => mockGetEthereumWalletIdentityReferences(...args),
}));

const { deleteDerivedWallet } = require('./identity-manager');

let tmpDir;
let previousIdentityDataDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-manager-test-'));
  previousIdentityDataDir = process.env.FREEDOM_IDENTITY_DATA;
  process.env.FREEDOM_IDENTITY_DATA = tmpDir;
  mockGetEthereumWalletIdentityReferences.mockReturnValue([]);
});

afterEach(() => {
  if (previousIdentityDataDir === undefined) {
    delete process.env.FREEDOM_IDENTITY_DATA;
  } else {
    process.env.FREEDOM_IDENTITY_DATA = previousIdentityDataDir;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeVaultMeta(meta) {
  fs.writeFileSync(path.join(tmpDir, 'vault-meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

function readVaultMeta() {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'vault-meta.json'), 'utf-8'));
}

describe('identity-manager wallet deletion', () => {
  test('blocks deleting wallets referenced by Swarm publisher identities', async () => {
    const references = [{
      origin: 'myapp.eth',
      identityId: 'ethereum-wallet:2',
      active: true,
      feedNames: ['blog'],
      feedCount: 1,
    }];
    mockGetEthereumWalletIdentityReferences.mockReturnValue(references);
    writeVaultMeta({
      activeWalletIndex: 2,
      derivedWallets: [
        { index: 0, name: 'Main Wallet', address: '0x0' },
        { index: 2, name: 'Trading Wallet', address: '0x2' },
      ],
    });

    await expect(deleteDerivedWallet(2))
      .rejects.toMatchObject({
        code: 'SWARM_PUBLISHER_IDENTITY_WALLET_IN_USE',
        references,
      });

    expect(mockGetEthereumWalletIdentityReferences).toHaveBeenCalledWith(2);
    expect(readVaultMeta().derivedWallets.map((wallet) => wallet.index)).toEqual([0, 2]);
    expect(readVaultMeta().activeWalletIndex).toBe(2);
  });

  test('deletes unreferenced derived wallet and resets active wallet', async () => {
    writeVaultMeta({
      activeWalletIndex: 2,
      derivedWallets: [
        { index: 0, name: 'Main Wallet', address: '0x0' },
        { index: 2, name: 'Trading Wallet', address: '0x2' },
      ],
    });

    await deleteDerivedWallet(2);

    expect(mockGetEthereumWalletIdentityReferences).toHaveBeenCalledWith(2);
    expect(readVaultMeta().derivedWallets.map((wallet) => wallet.index)).toEqual([0]);
    expect(readVaultMeta().activeWalletIndex).toBe(0);
  });
});
