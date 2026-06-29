const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;
const originalFetch = global.fetch;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const loadIpfsModule = async (options = {}) => {
  jest.resetModules();

  const state = {
    antMenuOpen: options.antMenuOpen ?? false,
    currentIpfsStatus: options.currentIpfsStatus || 'stopped',
    ipfsInfoInterval: null,
    ipfsVersionFetched: options.ipfsVersionFetched ?? false,
    ipfsVersionValue: options.ipfsVersionValue || '',
    ipfsDesiredRunning: options.ipfsDesiredRunning ?? null,
    registry: {
      ipfs: {
        api: 'http://ipfs.test',
        mode: options.mode || 'none',
        statusMessage: options.statusMessage ?? null,
        tempMessage: options.tempMessage ?? null,
      },
    },
  };
  const buildIpfsApiUrl = jest.fn((endpoint) => `http://ipfs.test${endpoint}`);
  const getDisplayMessage = jest.fn(() => {
    return state.registry.ipfs.tempMessage || state.registry.ipfs.statusMessage;
  });
  const debugMocks = {
    pushDebug: jest.fn(),
  };
  const ipfsToggleBtn = createElement('button');
  const ipfsToggleSwitch = createElement('div');
  const ipfsActiveRequestsCount = createElement('span');
  const ipfsDataRead = createElement('span');
  const ipfsVersionText = createElement('span');
  const ipfsInfoPanel = createElement('div', {
    classes: ['ipfs-info'],
  });
  const ipfsStatusRow = createElement('div');
  const ipfsStatusLabel = createElement('span');
  const ipfsStatusValue = createElement('span');
  const body = createElement('body');
  body.appendChild(ipfsInfoPanel);
  const document = createDocument({
    body,
    elementsById: {
      'ipfs-toggle-btn': ipfsToggleBtn,
      'ipfs-toggle-switch': ipfsToggleSwitch,
      'ipfs-active-requests-count': ipfsActiveRequestsCount,
      'ipfs-data-read': ipfsDataRead,
      'ipfs-version-text': ipfsVersionText,
      'ipfs-status-row': ipfsStatusRow,
      'ipfs-status-label': ipfsStatusLabel,
      'ipfs-status-value': ipfsStatusValue,
    },
  });
  let statusHandler = null;
  const ipfsApi =
    options.windowIpfs === false
      ? undefined
      : {
          checkBinary: jest.fn().mockResolvedValue({ available: options.binaryAvailable ?? true }),
          start: jest
            .fn()
            .mockResolvedValue(options.startResult || { status: 'running', error: null }),
          stop: jest
            .fn()
            .mockResolvedValue(options.stopResult || { status: 'stopped', error: null }),
          getStatus: jest
            .fn()
            .mockResolvedValue(options.statusResult || { status: 'stopped', error: null }),
          onStatusUpdate: jest.fn((handler) => {
            statusHandler = handler;
          }),
        };
  let intervalId = 1;
  const setIntervalMock = jest.spyOn(global, 'setInterval').mockImplementation(() => intervalId++);
  const clearIntervalMock = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});

  global.fetch =
    options.fetchImpl ||
    jest.fn(async (url) => {
      if (url.endsWith('/api/v0/swarm/peers')) {
        return {
          ok: true,
          json: async () => ({ Peers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
        };
      }
      if (url.endsWith('/api/v0/stats/bw')) {
        return {
          ok: true,
          json: async () => ({
            RateIn: 1536,
            RateOut: 1048576,
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({ AgentVersion: 'kubo/0.28.0-rc1/' }),
      };
    });
  global.window = {
    ipfs: ipfsApi,
  };
  global.document = document;

  jest.doMock('./state.js', () => ({
    state,
    buildIpfsApiUrl,
    getDisplayMessage,
  }));
  jest.doMock('./debug.js', () => debugMocks);

  const mod = await import('./ipfs-ui.js');

  return {
    mod,
    state,
    buildIpfsApiUrl,
    getDisplayMessage,
    debugMocks,
    setIntervalMock,
    clearIntervalMock,
    ipfsApi,
    getStatusHandler: () => statusHandler,
    elements: {
      ipfsToggleBtn,
      ipfsToggleSwitch,
      ipfsActiveRequestsCount,
      ipfsDataRead,
      ipfsVersionText,
      ipfsInfoPanel,
      ipfsStatusRow,
      ipfsStatusLabel,
      ipfsStatusValue,
    },
  };
};

describe('ipfs-ui', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('starts and stops IPFS info polling and populates stats', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'running',
      statusResult: {
        status: 'running',
        error: null,
        diagnostics: {
          nativeVersion: '0.4.1',
          nativeBuildInfo: JSON.stringify({
            name: 'freedom-ipfs',
            version: '0.4.1',
            release_tag: 'v0.4.1',
          }),
          nativeGatewayStats: JSON.stringify({
            active_native_handles: 3,
            bytes_read: 1536,
          }),
        },
      },
    });

    ctx.mod.initIpfsUi();
    ctx.mod.startIpfsInfoPolling();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ctx.buildIpfsApiUrl).not.toHaveBeenCalled();
    expect(ctx.elements.ipfsInfoPanel.classList.contains('visible')).toBe(true);
    expect(ctx.elements.ipfsActiveRequestsCount.textContent).toBe('3');
    expect(ctx.elements.ipfsDataRead.textContent).toBe('1.5 KB');
    expect(ctx.elements.ipfsVersionText.textContent).toBe('Freedom IPFS v0.4.1');
    expect(ctx.state.ipfsVersionFetched).toBe(true);
    expect(ctx.state.ipfsInfoInterval).toBe(2);
    expect(ctx.setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 1000);

    ctx.mod.stopIpfsInfoPolling();

    expect(ctx.clearIntervalMock).toHaveBeenCalledWith(2);
    expect(ctx.state.ipfsInfoInterval).toBeNull();
    expect(ctx.elements.ipfsInfoPanel.classList.contains('visible')).toBe(false);
    expect(ctx.elements.ipfsActiveRequestsCount.textContent).toBe('0');
    expect(ctx.elements.ipfsDataRead.textContent).toBe('');
    expect(ctx.elements.ipfsVersionText.textContent).toBe('Freedom IPFS v0.4.1');
  });

  test('updates IPFS status lines, toggle state, and running transitions', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'stopped',
      statusMessage: 'IPFS: Connected',
      windowIpfs: false,
    });

    ctx.mod.initIpfsUi();
    ctx.mod.updateIpfsStatusLine();

    expect(ctx.getDisplayMessage).toHaveBeenCalledWith('ipfs');
    expect(ctx.elements.ipfsStatusLabel.textContent).toBe('IPFS:');
    expect(ctx.elements.ipfsStatusValue.textContent).toBe('Connected');
    expect(ctx.elements.ipfsStatusRow.classList.contains('visible')).toBe(true);

    ctx.state.registry.ipfs.mode = 'reused';
    ctx.mod.updateIpfsToggleState();
    expect(ctx.elements.ipfsToggleBtn.classList.contains('external')).toBe(true);
    expect(ctx.elements.ipfsToggleBtn.getAttribute('title')).toBe(
      'Using existing node — cannot be controlled from Freedom'
    );

    ctx.state.registry.ipfs.mode = 'none';
    ctx.mod.updateIpfsToggleState();
    expect(ctx.elements.ipfsToggleBtn.classList.contains('external')).toBe(false);

    ctx.mod.updateIpfsUi('starting');
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);
    expect(ctx.state.currentIpfsStatus).toBe('starting');

    // While a stop is pending, a stale 'running' update must not flip the
    // switch back on before the node data settles.
    ctx.state.ipfsDesiredRunning = false;
    ctx.elements.ipfsToggleSwitch.classList.remove('running');
    ctx.mod.updateIpfsUi('running');
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(false);
    expect(ctx.state.ipfsDesiredRunning).toBe(false);

    ctx.mod.updateIpfsUi('error', 'offline');
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('IPFS Error: offline');

    ctx.mod.updateIpfsUi('stopped');
    expect(ctx.elements.ipfsStatusRow.classList.contains('visible')).toBe(false);
  });

  test('initializes IPFS controls, handles binary availability, and toggles start and stop', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'stopped',
      binaryAvailable: false,
      statusResult: { status: 'stopped', error: null },
    });

    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    expect(ctx.ipfsApi.checkBinary).toHaveBeenCalled();
    expect(ctx.elements.ipfsToggleBtn.classList.contains('disabled')).toBe(true);
    expect(ctx.elements.ipfsToggleBtn.getAttribute('disabled')).toBe('true');
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith(
      'IPFS binary not found - toggle disabled'
    );
    expect(ctx.ipfsApi.onStatusUpdate).toHaveBeenCalledWith(expect.any(Function));
    expect(ctx.ipfsApi.getStatus).toHaveBeenCalled();
    expect(ctx.setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 5000);

    ctx.elements.ipfsToggleBtn.dispatch('click');
    expect(ctx.ipfsApi.start).not.toHaveBeenCalled();

    ctx.ipfsApi.checkBinary.mockResolvedValueOnce({ available: true });
    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    ctx.elements.ipfsToggleBtn.dispatch('click');
    await flushMicrotasks();

    expect(ctx.ipfsApi.start).toHaveBeenCalled();
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('User toggled IPFS On');
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);
    expect(ctx.state.currentIpfsStatus).toBe('running');

    const statusHandler = ctx.getStatusHandler();
    statusHandler({
      status: 'error',
      error: 'offline',
    });
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('IPFS Status Update: error (offline)');

    ctx.state.currentIpfsStatus = 'running';
    ctx.elements.ipfsToggleBtn.dispatch('click');
    await flushMicrotasks();

    expect(ctx.ipfsApi.stop).toHaveBeenCalled();
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('User toggled IPFS Off');
  });

  test('keeps the switch on the latest intent through a rapid off/on toggle', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'running',
      statusResult: { status: 'running', error: null },
    });

    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    // Click off, then immediately back on before the backend has settled.
    ctx.elements.ipfsToggleBtn.dispatch('click');
    expect(ctx.state.ipfsDesiredRunning).toBe(false);
    ctx.elements.ipfsToggleBtn.dispatch('click');
    expect(ctx.state.ipfsDesiredRunning).toBe(true);
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);

    // The reversal must actually reach the backend: stop() fired on the first
    // click and start() on the second, in that order — not just settle the UI.
    expect(ctx.ipfsApi.stop).toHaveBeenCalledTimes(1);
    expect(ctx.ipfsApi.start).toHaveBeenCalledTimes(1);
    expect(ctx.ipfsApi.stop.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.ipfsApi.start.mock.invocationCallOrder[0]
    );

    // Transient backend states from the stop/start churn must not flip it off.
    ctx.mod.updateIpfsUi('stopping');
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);
    ctx.mod.updateIpfsUi('stopped');
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);
    ctx.mod.updateIpfsUi('starting');
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);

    // Once the backend confirms the requested state, the intent clears and the
    // switch follows live status again.
    ctx.mod.updateIpfsUi('running');
    expect(ctx.state.ipfsDesiredRunning).toBeNull();
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);
  });

  test('clears intent on a failed start but holds it through a failed stop', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'starting',
      statusResult: { status: 'starting', error: null },
    });

    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    // Failed start (intent was "on"): the attempt is over, so intent clears and
    // the switch falls back to the live status (off).
    ctx.state.ipfsDesiredRunning = true;
    ctx.mod.updateIpfsUi('error', 'offline');
    expect(ctx.state.ipfsDesiredRunning).toBeNull();
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(false);

    // Failed stop (intent was "off"): the node may still be running, so intent
    // is preserved and a later stale 'running' update can't flip it back on.
    ctx.state.ipfsDesiredRunning = false;
    ctx.mod.updateIpfsUi('error', 'stop failed');
    expect(ctx.state.ipfsDesiredRunning).toBe(false);
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(false);

    ctx.mod.updateIpfsUi('running');
    expect(ctx.state.ipfsDesiredRunning).toBe(false);
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(false);
  });

  test('polls stats during a pending "on" toggle while live status is still stopped', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'stopped',
      statusResult: {
        status: 'stopped',
        error: null,
        diagnostics: {
          nativeGatewayStats: JSON.stringify({ active_native_handles: 2, bytes_read: 2048 }),
        },
      },
    });

    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    // User just clicked on; the backend hasn't confirmed yet (live status is
    // still 'stopped'). Polling must run on the pending intent, not bail and
    // leave the panel blank.
    ctx.state.ipfsDesiredRunning = true;
    ctx.mod.startIpfsInfoPolling();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ctx.elements.ipfsInfoPanel.classList.contains('visible')).toBe(true);
    expect(ctx.state.ipfsInfoInterval).not.toBeNull();
    expect(ctx.elements.ipfsActiveRequestsCount.textContent).toBe('2');
    expect(ctx.elements.ipfsDataRead.textContent).toBe('2.0 KB');
  });

  test('falls back to a bare product label when version diagnostics are missing', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'running',
      statusResult: {
        status: 'running',
        error: null,
        diagnostics: { nativeVersion: '', nativeBuildInfo: '' },
      },
    });

    ctx.mod.initIpfsUi();
    ctx.mod.startIpfsInfoPolling();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ctx.elements.ipfsVersionText.textContent).toBe('Freedom IPFS');
    expect(ctx.state.ipfsVersionValue).toBe('Freedom IPFS');
  });

  test('reverts optimistic UI to real status when a toggle IPC rejects', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'stopped',
      statusResult: { status: 'stopped', error: null },
    });

    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    // start() throws at the IPC layer; a follow-up status query shows the node
    // never came up.
    ctx.ipfsApi.start.mockRejectedValueOnce(new Error('ipc boom'));
    ctx.ipfsApi.getStatus.mockResolvedValueOnce({ status: 'stopped', error: null });

    ctx.elements.ipfsToggleBtn.dispatch('click');
    // Optimistically on right after the click.
    expect(ctx.state.ipfsDesiredRunning).toBe(true);
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);

    await flushMicrotasks();
    await flushMicrotasks();

    // The rejection dropped the optimistic intent, re-queried status, and
    // settled the switch back off instead of polling a node that never started.
    expect(ctx.ipfsApi.getStatus).toHaveBeenCalled();
    expect(ctx.state.ipfsDesiredRunning).toBeNull();
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(false);
    expect(ctx.state.ipfsInfoInterval).toBeNull();
  });
});
