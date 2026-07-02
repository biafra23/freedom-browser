class FakeTextNode {
  constructor(text) {
    this.textContent = String(text);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.className = '';
    this.textContent = '';
    this.title = '';
  }

  replaceChildren(...children) {
    this.children = children;
    this.textContent = children.map((child) => child?.textContent || '').join('');
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }
}

const ADDRESS = '0x1111111111111111111111111111111111111111';

const installDocument = () => {
  global.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (text) => new FakeTextNode(text),
  };
};

const loadSendTestApi = async () => {
  jest.resetModules();
  jest.doMock('./wallet-state.js', () => ({
    walletState: {
      fullAddresses: { wallet: ADDRESS, swarm: '', ipfs: '', radicle: '' },
      identityView: null,
      registeredChains: {},
      registeredTokens: {},
      currentBalances: {},
    },
    registerScreenHider: jest.fn(),
  }));
  jest.doMock('./balance-display.js', () => ({
    refreshBalances: jest.fn(),
    getTokensWithBalance: jest.fn(() => []),
    getChainsWithBalance: jest.fn(() => []),
    sortTokens: jest.fn((tokens) => tokens),
  }));
  jest.doMock('../tabs.js', () => ({ createTab: jest.fn() }));

  const mod = await import('./send.js');
  return mod.__test__;
};

describe('send wallet review', () => {
  afterEach(() => {
    jest.dontMock('./wallet-state.js');
    jest.dontMock('./balance-display.js');
    jest.dontMock('../tabs.js');
    delete global.document;
    delete global.window;
  });

  test('maps unverified reverse lookup results to the warning render path', async () => {
    installDocument();
    global.window = {
      location: { href: 'file:///app/index.html' },
      internalPages: { routable: {} },
      electronAPI: {
        resolveEnsReverse: jest.fn().mockResolvedValue({
          success: false,
          reason: 'UNVERIFIED',
          claimedName: 'spoof.gwei',
        }),
      },
    };
    const { lookupPrimaryNameForAddress } = await loadSendTestApi();

    await expect(lookupPrimaryNameForAddress(ADDRESS)).resolves.toEqual({
      warning: 'unverified',
      claimedName: 'spoof.gwei',
    });
  });

  test('hides unverified reverse claimed names behind the warning glyph', async () => {
    installDocument();
    global.window = {
      location: { href: 'file:///app/index.html' },
      internalPages: { routable: {} },
      electronAPI: {},
    };
    const { renderRecipientReview } = await loadSendTestApi();
    const container = new FakeElement('div');

    renderRecipientReview(container, ADDRESS, {
      warning: 'unverified',
      claimedName: 'spoof.gwei',
    });

    expect(container.textContent).toContain(ADDRESS);
    expect(container.textContent).not.toContain('spoof.gwei');

    const warning = container.children.find((child) => child.className === 'send-review-warning');
    expect(warning).toBeTruthy();
    expect(warning.title).toContain('spoof.gwei');
    expect(warning.getAttribute('aria-label')).toContain('spoof.gwei');
  });
});
