describe('link-status', () => {
  const originalDocument = global.document;
  const originalWindow = global.window;

  const createElements = ({ visible = false } = {}) => {
    const urlEl = { textContent: '' };
    let isVisible = visible;
    const linkStatus = {
      hidden: true,
      classList: {
        contains: jest.fn((cls) => cls === 'visible' && isVisible),
        add: jest.fn((cls) => {
          if (cls === 'visible') isVisible = true;
        }),
        remove: jest.fn((cls) => {
          if (cls === 'visible') isVisible = false;
        }),
      },
    };
    return { linkStatus, urlEl };
  };

  const loadModule = async (linkStatus, urlEl) => {
    jest.resetModules();
    jest.useFakeTimers();
    global.document = {
      getElementById: jest.fn((id) => {
        if (id === 'link-status') return linkStatus;
        if (id === 'link-status-url') return urlEl;
        return null;
      }),
    };
    global.window = {
      matchMedia: jest.fn(() => ({ matches: false })),
      requestAnimationFrame: (cb) => cb(),
    };
    return import('./link-status.js');
  };

  afterEach(() => {
    jest.useRealTimers();
    global.document = originalDocument;
    global.window = originalWindow;
  });

  test('shows URL for active tab after delay and clears on empty target', async () => {
    const { linkStatus, urlEl } = createElements();
    const mod = await loadModule(linkStatus, urlEl);
    mod.initLinkStatus();

    mod.handleUpdateTargetUrl(1, 'https://example.com/path', 1);
    expect(urlEl.textContent).toBe('');
    expect(linkStatus.hidden).toBe(true);

    jest.advanceTimersByTime(200);
    expect(urlEl.textContent).toBe('https://example.com/path');
    expect(linkStatus.hidden).toBe(false);
    expect(linkStatus.classList.add).toHaveBeenCalledWith('visible');

    mod.handleUpdateTargetUrl(1, '', 1);
    jest.runAllTimers();
    expect(urlEl.textContent).toBe('');
    expect(linkStatus.hidden).toBe(true);
  });

  test('cancels pending show when hover ends before delay elapses', async () => {
    const { linkStatus, urlEl } = createElements();
    const mod = await loadModule(linkStatus, urlEl);
    mod.initLinkStatus();

    mod.handleUpdateTargetUrl(1, 'https://example.com/', 1);
    mod.handleUpdateTargetUrl(1, '', 1);
    jest.runAllTimers();
    expect(urlEl.textContent).toBe('');
    expect(linkStatus.hidden).toBe(true);
    expect(linkStatus.classList.add).not.toHaveBeenCalledWith('visible');
  });

  test('ignores update-target-url from inactive tabs', async () => {
    const { linkStatus, urlEl } = createElements();
    const mod = await loadModule(linkStatus, urlEl);
    mod.initLinkStatus();

    mod.handleUpdateTargetUrl(2, 'https://other.example/', 1);
    expect(urlEl.textContent).toBe('');
    expect(linkStatus.hidden).toBe(true);
  });

  test('updates text in place when already visible', async () => {
    const { linkStatus, urlEl } = createElements({ visible: true });
    const mod = await loadModule(linkStatus, urlEl);
    mod.initLinkStatus();

    mod.showLinkStatus('https://a.example/');
    linkStatus.classList.add.mockClear();
    mod.showLinkStatus('https://b.example/');
    expect(urlEl.textContent).toBe('https://b.example/');
    expect(linkStatus.classList.add).not.toHaveBeenCalled();
  });

  test('handles missing DOM elements safely', async () => {
    const mod = await loadModule(null, null);
    expect(() => {
      mod.initLinkStatus();
      mod.showLinkStatus('https://example.com/');
      mod.clearLinkStatus();
      mod.handleUpdateTargetUrl(1, 'https://example.com/', 1);
    }).not.toThrow();
  });
});
