jest.mock('electron', () => {
  const fromId = jest.fn();
  return {
    webContents: { fromId },
    _fromId: fromId,
  };
});

const { Type } = require('typebox');
const electron = require('electron');
const { createTabTools, _internals } = require('./tab-tools');
const { TIERS } = require('../tool-tiers');

function makeFakeWc({ result, throws } = {}) {
  return {
    isDestroyed: jest.fn().mockReturnValue(false),
    executeJavaScript: jest.fn(async () => {
      if (throws) throw throws;
      return result;
    }),
  };
}

describe('createTabTools', () => {
  beforeEach(() => {
    electron._fromId.mockReset();
  });

  test('returns no tools when hostWebContentsId is missing', () => {
    expect(createTabTools({ hostWebContentsId: null, Type })).toEqual([]);
    expect(createTabTools({ Type })).toEqual([]);
  });

  test('exposes the four tab tools with the right names + tiers', () => {
    const tools = createTabTools({ hostWebContentsId: 7, Type });
    expect(tools.map((t) => t.name)).toEqual(
      ['list_tabs', 'open_tab', 'close_tab', 'switch_tab']
    );
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.list_tabs.tier).toBe(TIERS.LOCAL_SENSITIVE);
    expect(byName.open_tab.tier).toBe(TIERS.BROWSER_MUTATION);
    expect(byName.close_tab.tier).toBe(TIERS.BROWSER_MUTATION);
    expect(byName.switch_tab.tier).toBe(TIERS.BROWSER_MUTATION);
  });
});

describe('list_tabs', () => {
  test('returns the bridge result wrapped in jsonResult', async () => {
    const wc = makeFakeWc({
      result: [{ id: 1, url: 'https://x', title: 'X', isActive: true }],
    });
    electron._fromId.mockReturnValue(wc);
    const [listTabs] = createTabTools({ hostWebContentsId: 7, Type });
    const result = await listTabs.execute('id');
    expect(result.details.tabs).toEqual([
      { id: 1, url: 'https://x', title: 'X', isActive: true },
    ]);
    expect(wc.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('window.__agentTabBridge__')
    );
  });

  test('returns an empty array when bridge returns a non-array', async () => {
    electron._fromId.mockReturnValue(makeFakeWc({ result: null }));
    const [listTabs] = createTabTools({ hostWebContentsId: 7, Type });
    const result = await listTabs.execute('id');
    expect(result.details.tabs).toEqual([]);
  });

  test('rejects when the host webContents has been destroyed', async () => {
    const wc = makeFakeWc({ result: [] });
    wc.isDestroyed.mockReturnValue(true);
    electron._fromId.mockReturnValue(wc);
    const [listTabs] = createTabTools({ hostWebContentsId: 7, Type });
    await expect(listTabs.execute('id')).rejects.toThrow(/not available/);
  });

  test('rejects when the bridge surfaces an __error', async () => {
    electron._fromId.mockReturnValue(
      makeFakeWc({ result: { __error: 'tab bridge unavailable' } })
    );
    const [listTabs] = createTabTools({ hostWebContentsId: 7, Type });
    await expect(listTabs.execute('id')).rejects.toThrow(/tab bridge: tab bridge unavailable/);
  });
});

describe('open_tab', () => {
  test('forwards the URL to openTab and returns the new tab object', async () => {
    const wc = makeFakeWc({ result: { id: 2, url: 'https://example.com', title: 'New Tab' } });
    electron._fromId.mockReturnValue(wc);
    const [, openTab] = createTabTools({ hostWebContentsId: 7, Type });
    const result = await openTab.execute('id', { url: 'https://example.com' });
    expect(result.details.tab).toEqual({ id: 2, url: 'https://example.com', title: 'New Tab' });
    const script = wc.executeJavaScript.mock.calls[0][0];
    expect(script).toContain('"https://example.com"');
    expect(script).toContain('openTab');
  });
});

describe('close_tab / switch_tab', () => {
  test('close_tab returns {closed:true,id} when bridge succeeds', async () => {
    electron._fromId.mockReturnValue(makeFakeWc({ result: true }));
    const [, , closeTab] = createTabTools({ hostWebContentsId: 7, Type });
    const result = await closeTab.execute('id', { id: 3 });
    expect(result.details).toEqual({ closed: true, id: 3 });
  });

  test('close_tab returns {closed:false,id} when bridge returns falsy (unknown id)', async () => {
    electron._fromId.mockReturnValue(makeFakeWc({ result: false }));
    const [, , closeTab] = createTabTools({ hostWebContentsId: 7, Type });
    const result = await closeTab.execute('id', { id: 99 });
    expect(result.details).toEqual({ closed: false, id: 99 });
  });

  test('switch_tab passes id to bridge and reports outcome', async () => {
    electron._fromId.mockReturnValue(makeFakeWc({ result: true }));
    const [, , , switchTab] = createTabTools({ hostWebContentsId: 7, Type });
    const result = await switchTab.execute('id', { id: 4 });
    expect(result.details).toEqual({ switched: true, id: 4 });
  });
});

describe('bridgeCall script', () => {
  test('JSON-stringifies args so model strings cannot inject JS', () => {
    const script = _internals.bridgeCall('openTab', ['"); alert(1); //']);
    // The dangerous string lands inside a JSON string literal (with the
    // inner `"` escaped as `\"`), so V8 parses it as a single string
    // arg rather than as broken JS plus an `alert(1)` call.
    expect(script).toContain('"\\"); alert(1); //"');
  });

  test('returns __error from a try/catch around the bridge call', () => {
    const script = _internals.bridgeCall('listTabs');
    expect(script).toContain('__error');
    expect(script).toContain('catch');
  });
});
