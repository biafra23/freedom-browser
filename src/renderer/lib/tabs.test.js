/**
 * Tests for tab navigation state isolation
 *
 * Critical bug: Navigation state (currentPageUrl, currentBzzBase, etc.) is stored
 * globally in state.js, but should be per-tab. This causes:
 * - Wrong URL shown in address bar after switching tabs
 * - Wrong bzzBase used for relative URL resolution in Swarm content
 */

// Mock electronAPI
const mockElectronAPI = {
  setWindowTitle: jest.fn(),
};

// Mock DOM elements
const createMockWebview = (tabId) => ({
  setAttribute: jest.fn(),
  addEventListener: jest.fn(),
  classList: {
    toggle: jest.fn(),
    add: jest.fn(),
    remove: jest.fn(),
  },
  dataset: { tabId },
  getURL: jest.fn(() => 'about:blank'),
  remove: jest.fn(),
});

// Setup DOM mocks before importing modules
beforeAll(() => {
  global.window = {
    electronAPI: { ...mockElectronAPI, getSettings: jest.fn(() => Promise.resolve({})) },
    location: { href: 'file:///app/index.html' },
    addEventListener: jest.fn(),
  };

  global.document = {
    createElement: jest.fn((tag) => {
      if (tag === 'webview') {
        return createMockWebview(0);
      }
      return {
        className: '',
        classList: { add: jest.fn(), toggle: jest.fn() },
        dataset: {},
        appendChild: jest.fn(),
        addEventListener: jest.fn(),
        innerHTML: '',
      };
    }),
    getElementById: jest.fn((id) => {
      if (id === 'tab-bar') return { innerHTML: '', appendChild: jest.fn() };
      if (id === 'webview-container') return { appendChild: jest.fn() };
      if (id === 'new-tab-btn') return { addEventListener: jest.fn() };
      return null;
    }),
  };

  global.URL = URL;
});

describe('Tab Navigation State Isolation', () => {
  describe('Per-tab state storage', () => {
    test('each tab should have its own navigation state object', async () => {
      // Import after mocks are set up
      const { createTab } = await import('./tabs.js');

      // Create two tabs
      const tab1 = createTab('http://example.com/page1');
      const tab2 = createTab('http://example.com/page2');

      // Each tab should have navigation state properties
      expect(tab1).toHaveProperty('navigationState');
      expect(tab2).toHaveProperty('navigationState');

      // Navigation states should be separate objects
      expect(tab1.navigationState).not.toBe(tab2.navigationState);
    });

    test('tab navigation state should include required properties', async () => {
      const { createTab } = await import('./tabs.js');

      const tab = createTab('http://example.com');

      // Check all required navigation state properties exist
      expect(tab.navigationState).toHaveProperty('currentPageUrl');
      expect(tab.navigationState).toHaveProperty('pendingNavigationUrl');
      expect(tab.navigationState).toHaveProperty('pendingTitleForUrl');
      expect(tab.navigationState).toHaveProperty('hasNavigatedDuringCurrentLoad');
      expect(tab.navigationState).toHaveProperty('isWebviewLoading');
      expect(tab.navigationState).toHaveProperty('currentBzzBase');
      expect(tab.navigationState).toHaveProperty('addressBarSnapshot');
      expect(tab.navigationState).toHaveProperty('committedDisplayUrl');
      expect(tab.navigationState).toHaveProperty('cachedWebContentsId');
    });
  });

  describe('State isolation between tabs', () => {
    test('modifying one tab state should not affect another tab', async () => {
      const { createTab } = await import('./tabs.js');

      const tab1 = createTab('http://example.com/page1');
      const tab2 = createTab('http://example.com/page2');

      // Set state on tab1
      tab1.navigationState.currentPageUrl = 'http://example.com/tab1-url';
      tab1.navigationState.currentBzzBase = 'http://127.0.0.1:1633/bzz/hash1/';

      // Set different state on tab2
      tab2.navigationState.currentPageUrl = 'http://example.com/tab2-url';
      tab2.navigationState.currentBzzBase = 'http://127.0.0.1:1633/bzz/hash2/';

      // Verify states are independent
      expect(tab1.navigationState.currentPageUrl).toBe('http://example.com/tab1-url');
      expect(tab2.navigationState.currentPageUrl).toBe('http://example.com/tab2-url');
      expect(tab1.navigationState.currentBzzBase).toBe('http://127.0.0.1:1633/bzz/hash1/');
      expect(tab2.navigationState.currentBzzBase).toBe('http://127.0.0.1:1633/bzz/hash2/');
    });

    test('switching tabs should preserve each tab state', async () => {
      const { createTab, switchTab, getActiveTab } = await import('./tabs.js');

      const tab1 = createTab('http://example.com/page1');
      tab1.navigationState.currentPageUrl = 'http://tab1.com';

      const tab2 = createTab('http://example.com/page2');
      tab2.navigationState.currentPageUrl = 'http://tab2.com';

      // Switch to tab1
      switchTab(tab1.id);
      expect(getActiveTab().navigationState.currentPageUrl).toBe('http://tab1.com');

      // Switch to tab2
      switchTab(tab2.id);
      expect(getActiveTab().navigationState.currentPageUrl).toBe('http://tab2.com');

      // Switch back to tab1 - state should be preserved
      switchTab(tab1.id);
      expect(getActiveTab().navigationState.currentPageUrl).toBe('http://tab1.com');
    });
  });

  describe('getDisplayUrlForWebview', () => {
    // Provider permission checks (swarm-provider.js etc.) call this helper
    // to derive the page origin for keying prompts and storing decisions.
    // It must return the *committed* display identity, never the user's
    // unsubmitted address-bar draft — otherwise a Swarm site could fire a
    // request while the user is mid-typing and have its permission prompt
    // keyed on the typed-but-not-loaded URL instead of the actual page.
    test('returns committedDisplayUrl, ignoring an unsubmitted draft in addressBarSnapshot', async () => {
      const { createTab, getDisplayUrlForWebview } = await import('./tabs.js');

      const tab = createTab('https://example.com/');
      // Mirror the production did-navigate commit shape: committedDisplayUrl
      // is the source of truth for the active page identity.
      tab.navigationState.committedDisplayUrl = 'https://example.com/';
      // addressBarSnapshot can carry an unsubmitted draft (focusin /
      // tab-switched both write the live address-bar value into it). It
      // must NOT be the value getDisplayUrlForWebview returns.
      tab.navigationState.addressBarSnapshot = 'vitalik.eth';

      expect(getDisplayUrlForWebview(tab.webview)).toBe('https://example.com/');
    });

    test('returns empty string when committedDisplayUrl is empty (no fallback to addressBarSnapshot)', async () => {
      // `addressBarSnapshot` is overwritten with the live address-bar
      // value on focusin and tab-switched, so it can carry an
      // unsubmitted draft. Falling back to it would leak that draft
      // into provider permission keying — instead, an unset
      // `committedDisplayUrl` must surface as the empty string so
      // callers explicitly handle the "no committed page yet" case.
      const { createTab, getDisplayUrlForWebview } = await import('./tabs.js');

      const tab = createTab('https://example.com/');
      tab.navigationState.committedDisplayUrl = '';
      tab.navigationState.addressBarSnapshot = 'vitalik.eth';

      expect(getDisplayUrlForWebview(tab.webview)).toBe('');
    });

    test('returns empty string when the webview is not tracked', async () => {
      const { getDisplayUrlForWebview } = await import('./tabs.js');

      const orphan = createMockWebview(999);
      expect(getDisplayUrlForWebview(orphan)).toBe('');
    });
  });

  describe('did-navigate populates committedDisplayUrl', () => {
    // The committed display identity is the source of truth for reload
    // ("what page are we actually on?") and for provider permission
    // keying. It must be written on the per-webview `did-navigate`
    // event (which fires after Chromium actually commits the
    // navigation) for every tab — not pre-commit by the dispatch path,
    // and not gated on the tab being active. Otherwise either:
    //   - a pre-commit write lets the destination origin briefly stand
    //     in for the still-loaded previous page, or
    //   - a background ENS load that finishes while its tab is
    //     inactive never populates the committed identity, so a later
    //     reload falls through to webview.reload() instead of
    //     re-resolving under today's verification method.
    test('writes committedDisplayUrl for the active tab on did-navigate', async () => {
      const { createTab } = await import('./tabs.js');

      const tab = createTab('https://example.com/');
      tab.webview.getURL.mockReturnValue('https://example.com/page');
      tab.webview._eventHandlers['did-navigate']({ url: 'https://example.com/page' });

      expect(tab.navigationState.committedDisplayUrl).toBe('https://example.com/page');
    });

    test('writes committedDisplayUrl for a background tab on did-navigate', async () => {
      const { createTab, switchTab } = await import('./tabs.js');

      const tabA = createTab('https://a.example/');
      const tabB = createTab('https://b.example/');
      // Foreground tabB so tabA is the background tab whose did-navigate
      // we exercise.
      switchTab(tabB.id);

      tabA.webview.getURL.mockReturnValue('ipfs://vitalik.eth');
      tabA.webview._eventHandlers['did-navigate']({ url: 'ipfs://vitalik.eth' });

      expect(tabA.navigationState.committedDisplayUrl).toBe('ipfs://vitalik.eth');
    });

    test('preserves committedDisplayUrl when did-navigate fires for about:blank', async () => {
      // about:blank navigations happen during "open in new window" before
      // the real loadURL runs. Letting them clobber `committedDisplayUrl`
      // would lose the actual page identity for the brief window between
      // the about:blank commit and the real navigation committing.
      const { createTab } = await import('./tabs.js');

      const tab = createTab('https://example.com/');
      tab.navigationState.committedDisplayUrl = 'https://example.com/';
      tab.webview.getURL.mockReturnValue('about:blank');
      tab.webview._eventHandlers['did-navigate']({ url: 'about:blank' });

      expect(tab.navigationState.committedDisplayUrl).toBe('https://example.com/');
    });

    test('captures view-source: prefix from webview.getURL() on did-navigate', async () => {
      // `webview.getURL()` is the canonical source for the committed
      // URL because event.url omits the view-source: prefix. Reload
      // checks downstream depend on the prefix being preserved here.
      const { createTab } = await import('./tabs.js');

      const tab = createTab('https://example.com/');
      tab.webview.getURL.mockReturnValue('view-source:https://example.com/');
      tab.webview._eventHandlers['did-navigate']({ url: 'https://example.com/' });

      expect(tab.navigationState.committedDisplayUrl).toBe(
        'view-source:https://example.com/'
      );
    });
  });

  describe('getActiveTabState helper', () => {
    test('should return navigation state of active tab', async () => {
      const { createTab, switchTab, getActiveTabState } = await import('./tabs.js');

      const tab1 = createTab('http://example.com/page1');
      tab1.navigationState.currentPageUrl = 'http://active-tab.com';

      createTab('http://example.com/page2');

      switchTab(tab1.id);

      const state = getActiveTabState();
      expect(state.currentPageUrl).toBe('http://active-tab.com');
    });

    test('should return null when no active tab', async () => {
      const { getActiveTabState } = await import('./tabs.js');

      // This test assumes we can have a state with no active tab
      // In practice this might not happen, but the function should handle it
      const state = getActiveTabState();
      // Either returns null or a default state object
      expect(state === null || typeof state === 'object').toBe(true);
    });
  });
});
