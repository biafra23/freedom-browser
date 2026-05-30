describe('dapp-x402 renderer helpers', () => {
  test('normalizes cap-consumed origins the same way as permission banner keys', async () => {
    const mod = await import('./dapp-x402-utils.js');

    expect(mod.normalizeX402BannerOrigin('bzz://Paywall.eth/article')).toBe('paywall.eth');
    expect(mod.normalizeX402BannerOrigin('ipfs://QmRootCid/path')).toBe('ipfs://QmRootCid');
    expect(mod.normalizeX402BannerOrigin('https://api.example/paid')).toBe('https://api.example');
  });

  test('shows the chooser when a pinned selected option becomes unfundable', async () => {
    const mod = await import('./dapp-x402-utils.js');

    expect(mod.shouldShowChooserForSelection(1, true)).toBe(false);
    expect(mod.shouldShowChooserForSelection(1, false)).toBe(true);
    expect(mod.shouldShowChooserForSelection(2, true)).toBe(true);
  });

  test('detects selected balance or fundability changes for full card rerender', async () => {
    const mod = await import('./dapp-x402-utils.js');
    const before = [
      { balance: '10000', fundable: true },
      { balance: '50000', fundable: true },
    ];

    expect(mod.selectedAcceptChanged(before, [
      { balance: '10000', fundable: true },
      { balance: '0', fundable: false },
    ], 0)).toBe(false);

    expect(mod.selectedAcceptChanged(before, [
      { balance: '0', fundable: false },
      { balance: '50000', fundable: true },
    ], 0)).toBe(true);
  });
});

const originalWindow = global.window;
const originalDocument = global.document;
const originalHtmlInputElement = global.HTMLInputElement;

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class FakeClassList {
  constructor(el) {
    this.el = el;
    this.classes = new Set();
  }

  sync() {
    this.el._className = Array.from(this.classes).join(' ');
  }

  add(...names) {
    for (const name of names) this.classes.add(name);
    this.sync();
  }

  remove(...names) {
    for (const name of names) this.classes.delete(name);
    this.sync();
  }

  contains(name) {
    return this.classes.has(name);
  }

  toggle(name, force) {
    const shouldAdd = force === undefined ? !this.classes.has(name) : !!force;
    if (shouldAdd) this.classes.add(name);
    else this.classes.delete(name);
    this.sync();
    return shouldAdd;
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.dataset = {};
    this.classList = new FakeClassList(this);
    this._className = '';
    this._innerHTML = '';
    this._textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.title = '';
    this.name = '';
    this.type = '';
    this.focus = jest.fn();
  }

  set className(value) {
    this._className = String(value || '');
    this.classList.classes = new Set(this._className.split(/\s+/).filter(Boolean));
  }

  get className() {
    return this._className;
  }

  set textContent(value) {
    this._textContent = value == null ? '' : String(value);
    this._innerHTML = htmlEscape(this._textContent);
  }

  get textContent() {
    return this._textContent;
  }

  set innerHTML(value) {
    this._innerHTML = value == null ? '' : String(value);
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  addEventListener(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }

  async fire(event, detail = {}) {
    for (const handler of this.listeners.get(event) || []) {
      await handler({ type: event, target: this, ...detail });
    }
  }

  querySelector(selector) {
    return findDescendant(this, selector);
  }
}

class FakeInputElement extends FakeElement {
  constructor() {
    super('input');
  }
}

function matchesSelector(el, selector) {
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  return el.tagName.toLowerCase() === selector.toLowerCase();
}

function findDescendant(root, selector) {
  for (const child of root.children) {
    if (matchesSelector(child, selector)) return child;
    const found = findDescendant(child, selector);
    if (found) return found;
  }
  return null;
}

function createDocument(ids) {
  const elements = {};
  const documentListeners = new Map();

  for (const id of ids) {
    elements[id] = new FakeElement();
  }

  return {
    elements,
    createElement: jest.fn((tagName) =>
      tagName === 'input' ? new FakeInputElement() : new FakeElement(tagName)
    ),
    getElementById: jest.fn((id) => elements[id] || null),
    addEventListener: jest.fn((event, handler) => {
      if (!documentListeners.has(event)) documentListeners.set(event, []);
      documentListeners.get(event).push(handler);
    }),
  };
}

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

const dappX402ElementIds = [
  'sidebar-x402-approval',
  'x402-approval-back',
  'x402-approval-site',
  'x402-approval-amount',
  'x402-approval-to',
  'x402-approval-network',
  'x402-approval-url',
  'x402-approval-details',
  'x402-approval-chooser',
  'x402-approval-chooser-options',
  'x402-approval-insufficient',
  'x402-approval-insufficient-list',
  'x402-approval-insufficient-footer',
  'x402-approval-insufficient-refresh',
  'x402-approval-warning',
  'x402-approval-warning-text',
  'x402-approval-unlock',
  'x402-approval-touchid-btn',
  'x402-approval-password-link',
  'x402-approval-password-section',
  'x402-approval-password-input',
  'x402-approval-password-submit',
  'x402-approval-unlock-error',
  'x402-approval-error',
  'x402-approval-grant-row',
  'x402-approval-grant-toggle',
  'x402-approval-grant-cap-input',
  'x402-approval-grant-cap-symbol',
  'x402-approval-grant-window-select',
  'x402-approval-reject',
  'x402-approval-approve',
  'x402-connection-banner',
  'x402-connection-manage',
  'x402-connection-site',
  'x402-connection-remaining',
  'x402-connection-disconnect',
  'address-input',
];

function createAccept(overrides = {}) {
  return {
    accept: {
      amount: '2500000',
      asset: '0xUSDC',
      network: 'base',
      payTo: '0x1111111111111111111111111111111111111111',
    },
    tuple: { amount: '2500000', chainId: 8453 },
    balanceKey: '8453:0xUSDC',
    asset: { symbol: 'USDC', decimals: 6 },
    balance: '5000000',
    fundable: true,
    ...overrides,
  };
}

async function loadDappX402(options = {}) {
  jest.resetModules();

  const document = createDocument(dappX402ElementIds);
  const identityView = new FakeElement();
  const approvalNeededHandlers = [];
  const approvalResultHandlers = [];
  const balancesUpdatedHandlers = [];
  const hideAllSubscreens = jest.fn();
  const openSidebarPanel = jest.fn();
  const updatePermissionSubscreen = jest.fn();
  const refreshBalances = jest.fn().mockResolvedValue(undefined);

  document.elements['sidebar-x402-approval'].classList.add('hidden');
  document.elements['x402-approval-chooser'].classList.add('hidden');
  document.elements['x402-approval-insufficient'].classList.add('hidden');
  document.elements['x402-approval-warning'].classList.add('hidden');
  document.elements['x402-approval-unlock'].classList.add('hidden');
  document.elements['x402-approval-error'].classList.add('hidden');
  document.elements['x402-approval-grant-row'].classList.add('hidden');
  document.elements['x402-connection-banner'].classList.add('hidden');

  const details = options.details || {
    success: true,
    detectionId: 'det-1',
    url: 'https://pay.example/article',
    accepts: [createAccept()],
    initialSelectionIndex: 0,
  };

  const electronAPI = {
    onX402ApprovalNeeded: jest.fn((handler) => approvalNeededHandlers.push(handler)),
    onX402ApprovalResult: jest.fn((handler) => approvalResultHandlers.push(handler)),
    onX402UnlockNeeded: jest.fn(),
    onX402CapConsumed: jest.fn(),
    onX402BalancesUpdated: jest.fn((handler) => balancesUpdatedHandlers.push(handler)),
    x402GetDetails: jest.fn().mockResolvedValue(details),
    x402Approve: jest.fn().mockResolvedValue(options.approveResult || { success: true }),
    x402Cancel: jest.fn().mockResolvedValue({ success: true }),
    x402Reject: jest.fn().mockResolvedValue({ success: true }),
    x402RefreshBalances: jest.fn().mockResolvedValue({ success: true }),
    x402GetAllPermissions: jest.fn().mockResolvedValue({ success: true, permissions: [] }),
    x402RevokeAllForOrigin: jest.fn().mockResolvedValue({ success: true }),
  };

  global.window = {
    electronAPI,
    identity: {
      getStatus: jest.fn().mockResolvedValue(options.identityStatus || { isUnlocked: true }),
      getVaultMeta: jest.fn().mockResolvedValue({ userKnowsPassword: true }),
      unlock: jest.fn().mockResolvedValue({ success: true }),
    },
    quickUnlock: {
      canUseTouchId: jest.fn().mockResolvedValue(false),
      isEnabled: jest.fn().mockResolvedValue(false),
      unlock: jest.fn().mockResolvedValue({ success: true, password: 'pw' }),
    },
    tokens: {
      getToken: jest.fn().mockResolvedValue({ success: true, token: { symbol: 'USDC', decimals: 6 } }),
    },
    addEventListener: jest.fn(),
  };
  global.document = document;
  global.HTMLInputElement = FakeInputElement;

  jest.doMock('./wallet-state.js', () => ({
    walletState: {
      identityView,
      registeredChains: { 8453: { name: 'Base' } },
    },
    registerScreenHider: jest.fn(),
    hideAllSubscreens,
  }));
  jest.doMock('../sidebar.js', () => ({
    open: openSidebarPanel,
    isVisible: jest.fn(() => true),
  }));
  jest.doMock('./permission-manage.js', () => ({
    showX402Permissions: updatePermissionSubscreen,
  }));
  jest.doMock('./balance-display.js', () => ({ refreshBalances }));
  jest.doMock('./vault-unlock.js', () => ({
    showVaultUnlock: jest.fn().mockResolvedValue(undefined),
  }));

  const mod = await import('./dapp-x402.js');
  mod.initDappX402();

  return {
    mod,
    document,
    elements: document.elements,
    electronAPI,
    approvalNeededHandlers,
    approvalResultHandlers,
    balancesUpdatedHandlers,
    identityView,
    hideAllSubscreens,
    openSidebarPanel,
  };
}

describe('dapp-x402 approval card lifecycle', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.HTMLInputElement = originalHtmlInputElement;
    jest.restoreAllMocks();
  });

  test('renders an approval card from the approval-needed event and submits the selected grant', async () => {
    const ctx = await loadDappX402();

    await ctx.approvalNeededHandlers[0]({
      webContentsId: 7,
      detectionId: 'event-det',
      url: 'https://pay.example/article',
      resourceType: 'mainFrame',
    });
    await flushMicrotasks();

    expect(ctx.electronAPI.x402GetDetails).toHaveBeenCalledWith({
      webContentsId: 7,
      detectionId: 'event-det',
    });
    expect(ctx.hideAllSubscreens).toHaveBeenCalled();
    expect(ctx.openSidebarPanel).toHaveBeenCalled();
    expect(ctx.elements['sidebar-x402-approval'].classList.contains('hidden')).toBe(false);
    expect(ctx.identityView.classList.contains('hidden')).toBe(true);
    expect(ctx.elements['x402-approval-site'].textContent).toBe('https://pay.example');
    expect(ctx.elements['x402-approval-url'].textContent).toBe('https://pay.example/article');
    expect(ctx.elements['x402-approval-amount'].textContent).toBe('2.5 USDC');
    expect(ctx.elements['x402-approval-network'].textContent).toBe('base');
    expect(ctx.elements['x402-approval-approve'].disabled).toBe(false);

    ctx.elements['x402-approval-grant-toggle'].checked = true;
    ctx.elements['x402-approval-grant-cap-input'].value = '10';
    ctx.elements['x402-approval-grant-window-select'].value = String(30 * 24 * 60 * 60);

    await ctx.elements['x402-approval-approve'].fire('click');

    expect(ctx.electronAPI.x402Approve).toHaveBeenCalledWith({
      webContentsId: 7,
      detectionId: 'det-1',
      selectedAcceptIndex: 0,
      grant: {
        capAmount: '10000000',
        windowSeconds: 30 * 24 * 60 * 60,
      },
    });
    expect(ctx.elements['sidebar-x402-approval'].classList.contains('hidden')).toBe(true);
    expect(ctx.identityView.classList.contains('hidden')).toBe(false);
    expect(ctx.elements['x402-approval-approve'].textContent).toBe('Pay');
  });

  test('keeps subresource approvals open while signing and restores the card on async failure', async () => {
    const ctx = await loadDappX402({
      approveResult: { success: true, pending: true },
    });

    await ctx.approvalNeededHandlers[0]({
      webContentsId: 7,
      detectionId: 'event-det',
      url: 'https://pay.example/article',
      resourceType: 'image',
    });

    await ctx.elements['x402-approval-approve'].fire('click');

    expect(ctx.elements['sidebar-x402-approval'].classList.contains('hidden')).toBe(false);
    expect(ctx.elements['x402-approval-approve'].textContent).toMatch(/^Signing/);
    expect(ctx.electronAPI.x402Approve).toHaveBeenCalledWith({
      webContentsId: 7,
      detectionId: 'det-1',
      grant: undefined,
      selectedAcceptIndex: 0,
    });

    ctx.approvalResultHandlers[0]({
      detectionId: 'det-1',
      success: false,
      error: 'Payment settlement failed.',
    });

    expect(ctx.elements['sidebar-x402-approval'].classList.contains('hidden')).toBe(false);
    expect(ctx.elements['x402-approval-approve'].textContent).toBe('Pay');
    expect(ctx.elements['x402-approval-approve'].disabled).toBe(false);
    expect(ctx.elements['x402-approval-reject'].disabled).toBe(false);
    expect(ctx.elements['x402-approval-error'].textContent).toBe('Payment settlement failed.');
    expect(ctx.elements['x402-approval-error'].classList.contains('hidden')).toBe(false);
  });
});
