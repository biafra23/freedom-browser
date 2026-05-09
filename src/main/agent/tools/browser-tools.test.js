const mockFromId = jest.fn();

jest.mock('electron', () => ({
  webContents: {
    fromId: (...args) => mockFromId(...args),
  },
}));

const { Type } = require('typebox');
const { createBrowserTools } = require('./browser-tools');
const { TIERS } = require('../tool-tiers');

function makeWc(overrides = {}) {
  return {
    isDestroyed: jest.fn(() => false),
    executeJavaScript: jest.fn(async () => ''),
    loadURL: jest.fn(async () => undefined),
    capturePage: jest.fn(async () => ({
      toJPEG: () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    })),
    getURL: jest.fn(() => 'https://example.com/'),
    getTitle: jest.fn(() => 'Example'),
    ...overrides,
  };
}

function makeTools(webContentsId = 7) {
  const arr = createBrowserTools({ webContentsId, Type, TIERS });
  return Object.fromEntries(arr.map((t) => [t.name, t]));
}

beforeEach(() => {
  mockFromId.mockReset();
});

describe('tool catalog', () => {
  test('exposes the five expected tools', () => {
    const tools = makeTools();
    expect(Object.keys(tools).sort()).toEqual(
      ['click', 'fill', 'navigate', 'read_current_tab', 'screenshot'].sort()
    );
  });

  test('every tool has label, description, parameters, tier', () => {
    const tools = makeTools();
    for (const t of Object.values(tools)) {
      expect(typeof t.label).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(10);
      expect(typeof t.tier).toBe('string');
      expect(typeof t.parameters).toBe('object');
    }
  });

  test('reads-and-screenshot are local_sensitive; mutations are browser_mutation', () => {
    const tools = makeTools();
    expect(tools.read_current_tab.tier).toBe(TIERS.LOCAL_SENSITIVE);
    expect(tools.screenshot.tier).toBe(TIERS.LOCAL_SENSITIVE);
    expect(tools.navigate.tier).toBe(TIERS.BROWSER_MUTATION);
    expect(tools.click.tier).toBe(TIERS.BROWSER_MUTATION);
    expect(tools.fill.tier).toBe(TIERS.BROWSER_MUTATION);
  });
});

describe('webContents resolution', () => {
  test('throws when webContentsId is not bound', async () => {
    const tools = createBrowserTools({ webContentsId: null, Type, TIERS });
    const read = tools.find((t) => t.name === 'read_current_tab');
    await expect(read.execute('call-1', {})).rejects.toThrow(/webContentsId/);
  });

  test('throws when fromId returns nothing', async () => {
    mockFromId.mockReturnValue(null);
    await expect(makeTools().read_current_tab.execute('call-1', {})).rejects.toThrow(
      /not available/
    );
  });

  test('throws when the WebContents has been destroyed', async () => {
    mockFromId.mockReturnValue(makeWc({ isDestroyed: () => true }));
    await expect(makeTools().read_current_tab.execute('call-1', {})).rejects.toThrow(
      /not available/
    );
  });
});

describe('read_current_tab', () => {
  test('returns Pi-shaped result with a single text content block', async () => {
    const wc = makeWc({ executeJavaScript: jest.fn(async () => 'hello world') });
    mockFromId.mockReturnValue(wc);
    const result = await makeTools().read_current_tab.execute('call-1', {});
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.details).toEqual({
      url: 'https://example.com/',
      title: 'Example',
      text: 'hello world',
    });
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(1);
  });

  test('caps text at 32k characters', async () => {
    const big = 'a'.repeat(40_000);
    mockFromId.mockReturnValue(makeWc({ executeJavaScript: jest.fn(async () => big) }));
    const result = await makeTools().read_current_tab.execute('call-1', {});
    expect(result.details.text).toHaveLength(32_000);
  });
});

describe('navigate', () => {
  test('rejects unsupported schemes inside execute', async () => {
    mockFromId.mockReturnValue(makeWc());
    await expect(
      makeTools().navigate.execute('call-1', { url: 'javascript:alert(1)' })
    ).rejects.toThrow(/supported scheme/);
    await expect(
      makeTools().navigate.execute('call-1', { url: 'file:///etc/passwd' })
    ).rejects.toThrow(/supported scheme/);
  });

  test('calls loadURL and returns the live url in details', async () => {
    const wc = makeWc({ getURL: () => 'https://result.com/' });
    mockFromId.mockReturnValue(wc);
    const result = await makeTools().navigate.execute('call-1', {
      url: 'https://example.com',
    });
    expect(wc.loadURL).toHaveBeenCalledWith('https://example.com');
    expect(result.details.url).toBe('https://result.com/');
  });
});

describe('click', () => {
  test('escapes the selector via JSON.stringify in the eval payload', async () => {
    const wc = makeWc({ executeJavaScript: jest.fn(async () => true) });
    mockFromId.mockReturnValue(wc);
    await makeTools().click.execute('call-1', { selector: 'button[name="x\\"\\\']"]' });
    const code = wc.executeJavaScript.mock.calls[0][0];
    expect(code).toContain(JSON.stringify('button[name="x\\"\\\']"]'));
  });

  test('returns clicked:true when the page reports an element', async () => {
    mockFromId.mockReturnValue(makeWc({ executeJavaScript: jest.fn(async () => true) }));
    const result = await makeTools().click.execute('call-1', { selector: '#go' });
    expect(result.details).toEqual({ clicked: true });
  });

  test('returns clicked:false when the selector did not match', async () => {
    mockFromId.mockReturnValue(makeWc({ executeJavaScript: jest.fn(async () => false) }));
    const result = await makeTools().click.execute('call-1', { selector: '#missing' });
    expect(result.details).toEqual({ clicked: false });
  });
});

describe('fill', () => {
  test('escapes both selector and value via JSON.stringify', async () => {
    const wc = makeWc({ executeJavaScript: jest.fn(async () => true) });
    mockFromId.mockReturnValue(wc);
    await makeTools().fill.execute('call-1', {
      selector: 'input',
      value: '"; alert(1); "',
    });
    const code = wc.executeJavaScript.mock.calls[0][0];
    expect(code).toContain(JSON.stringify('"; alert(1); "'));
    expect(code).toContain('\\"; alert(1); \\"');
  });
});

describe('screenshot', () => {
  test('returns an image content block plus a text caption', async () => {
    mockFromId.mockReturnValue(makeWc());
    const result = await makeTools().screenshot.execute('call-1', {});
    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe('image');
    expect(result.content[0].mimeType).toBe('image/jpeg');
    expect(typeof result.content[0].data).toBe('string');
    expect(result.content[1].type).toBe('text');
    expect(result.details.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(result.details.url).toBe('https://example.com/');
  });
});
