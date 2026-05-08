const mockFromId = jest.fn();

jest.mock('electron', () => ({
  webContents: {
    fromId: (...args) => mockFromId(...args),
  },
}));

const { BROWSER_TOOLS } = require('./browser-tools');
const { TIERS } = require('../tool-tiers');

function makeWc(overrides = {}) {
  return {
    isDestroyed: jest.fn(() => false),
    executeJavaScript: jest.fn(async () => ''),
    loadURL: jest.fn(async () => undefined),
    capturePage: jest.fn(async () => ({
      toJPEG: () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    })),
    getURL: jest.fn(() => 'https://example.com/'),
    getTitle: jest.fn(() => 'Example'),
    ...overrides,
  };
}

const ctx = { webContentsId: 7 };
const tools = Object.fromEntries(BROWSER_TOOLS.map((t) => [t.name, t]));

beforeEach(() => {
  mockFromId.mockReset();
});

describe('tool catalog', () => {
  test('exposes the five expected tools', () => {
    expect(BROWSER_TOOLS.map((t) => t.name).sort()).toEqual(
      ['click', 'fill', 'navigate', 'read_current_tab', 'screenshot'].sort()
    );
  });

  test('every tool has a description and a tier', () => {
    for (const t of BROWSER_TOOLS) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(10);
      expect(typeof t.tier).toBe('string');
    }
  });

  test('reads-and-screenshot are local_sensitive; mutations are browser_mutation', () => {
    expect(tools.read_current_tab.tier).toBe(TIERS.LOCAL_SENSITIVE);
    expect(tools.screenshot.tier).toBe(TIERS.LOCAL_SENSITIVE);
    expect(tools.navigate.tier).toBe(TIERS.BROWSER_MUTATION);
    expect(tools.click.tier).toBe(TIERS.BROWSER_MUTATION);
    expect(tools.fill.tier).toBe(TIERS.BROWSER_MUTATION);
  });
});

describe('webContents resolution', () => {
  test('throws when ctx.webContentsId is missing', async () => {
    await expect(tools.read_current_tab.execute({}, {})).rejects.toThrow(/webContentsId/);
  });

  test('throws when fromId returns nothing', async () => {
    mockFromId.mockReturnValue(null);
    await expect(tools.read_current_tab.execute({}, ctx)).rejects.toThrow(/not available/);
  });

  test('throws when the WebContents has been destroyed', async () => {
    mockFromId.mockReturnValue(makeWc({ isDestroyed: () => true }));
    await expect(tools.read_current_tab.execute({}, ctx)).rejects.toThrow(/not available/);
  });
});

describe('read_current_tab', () => {
  test('returns url + title + truncated text', async () => {
    const wc = makeWc({ executeJavaScript: jest.fn(async () => 'hello world') });
    mockFromId.mockReturnValue(wc);
    const result = await tools.read_current_tab.execute({}, ctx);
    expect(result).toEqual({
      url: 'https://example.com/',
      title: 'Example',
      text: 'hello world',
    });
    expect(wc.executeJavaScript).toHaveBeenCalledTimes(1);
  });

  test('caps text at 32k characters', async () => {
    const big = 'a'.repeat(40_000);
    mockFromId.mockReturnValue(makeWc({ executeJavaScript: jest.fn(async () => big) }));
    const result = await tools.read_current_tab.execute({}, ctx);
    expect(result.text).toHaveLength(32_000);
  });
});

describe('navigate', () => {
  test('accepts http/https/bzz/ipfs/ipns/rad/ens schemes', () => {
    for (const url of [
      'https://x.com',
      'http://x.com',
      'bzz://abc/',
      'ipfs://bafy/',
      'ipns://k51/',
      'rad://z3gqc/',
      'ens://vitalik.eth/',
    ]) {
      expect(() => tools.navigate.inputSchema.parse({ url })).not.toThrow();
    }
  });

  test('rejects unsupported schemes', () => {
    expect(() => tools.navigate.inputSchema.parse({ url: 'javascript:alert(1)' })).toThrow();
    expect(() => tools.navigate.inputSchema.parse({ url: 'file:///etc/passwd' })).toThrow();
    expect(() => tools.navigate.inputSchema.parse({ url: '/relative' })).toThrow();
  });

  test('calls loadURL and returns the live url', async () => {
    const wc = makeWc({ getURL: () => 'https://result.com/' });
    mockFromId.mockReturnValue(wc);
    const result = await tools.navigate.execute({ url: 'https://example.com' }, ctx);
    expect(wc.loadURL).toHaveBeenCalledWith('https://example.com');
    expect(result.url).toBe('https://result.com/');
  });
});

describe('click', () => {
  test('escapes the selector via JSON.stringify in the eval payload', async () => {
    const wc = makeWc({ executeJavaScript: jest.fn(async () => true) });
    mockFromId.mockReturnValue(wc);
    await tools.click.execute({ selector: 'button[name="x\\"\\\']"]' }, ctx);
    const code = wc.executeJavaScript.mock.calls[0][0];
    // The selector must appear inside a JSON-quoted string, no raw embed.
    expect(code).toContain(JSON.stringify('button[name="x\\"\\\']"]'));
  });

  test('returns clicked:true when the page reports an element', async () => {
    mockFromId.mockReturnValue(makeWc({ executeJavaScript: jest.fn(async () => true) }));
    const result = await tools.click.execute({ selector: '#go' }, ctx);
    expect(result).toEqual({ clicked: true });
  });

  test('returns clicked:false when the selector did not match', async () => {
    mockFromId.mockReturnValue(makeWc({ executeJavaScript: jest.fn(async () => false) }));
    const result = await tools.click.execute({ selector: '#missing' }, ctx);
    expect(result).toEqual({ clicked: false });
  });
});

describe('fill', () => {
  test('escapes both selector and value via JSON.stringify', async () => {
    const wc = makeWc({ executeJavaScript: jest.fn(async () => true) });
    mockFromId.mockReturnValue(wc);
    await tools.fill.execute({ selector: 'input', value: '"; alert(1); "' }, ctx);
    const code = wc.executeJavaScript.mock.calls[0][0];
    // The hostile string lands as a JSON-quoted literal inside the eval'd JS,
    // never as raw code. JSON.stringify produces "\"; alert(1); \"" — the
    // backslashes prove the closing quote of the value is escaped, so the
    // alert call stays inert string content.
    expect(code).toContain(JSON.stringify('"; alert(1); "'));
    expect(code).toContain('\\"; alert(1); \\"');
  });
});

describe('screenshot', () => {
  test('returns a JPEG data URL', async () => {
    mockFromId.mockReturnValue(makeWc());
    const result = await tools.screenshot.execute({}, ctx);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  });
});
