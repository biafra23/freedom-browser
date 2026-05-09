jest.mock('../tabs.js', () => ({ createTab: jest.fn() }));

const { createElement, createDocument } = require('../../../../test/helpers/fake-dom.js');

const originalDocument = global.document;

const loadRenderers = async () => {
  jest.resetModules();
  const document = createDocument({ body: createElement('body') });
  global.document = document;
  const mod = await import('./tool-card-renderers.js');
  return { mod };
};

const into = (frag) => {
  const host = createElement('div');
  host.appendChild(frag);
  return host;
};

describe('tool-card-renderers', () => {
  afterEach(() => {
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('truncateMiddle keeps short strings intact and clips with an ellipsis when long', async () => {
    const { mod } = await loadRenderers();
    expect(mod._internals.truncateMiddle('short', 50)).toBe('short');
    expect(mod._internals.truncateMiddle('a'.repeat(100), 11)).toBe(`${'a'.repeat(5)}…${'a'.repeat(5)}`);
    expect(mod._internals.truncateMiddle(undefined, 5)).toBe('');
  });

  describe('navigate', () => {
    test('pending shows the URL pill with verb "Navigating to"', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'navigate',
        status: 'pending',
        args: { url: 'https://example.com' },
      }));
      const pill = host.querySelector('.agent-tool-url-pill');
      expect(pill).toBeTruthy();
      expect(pill.href).toBe('https://example.com');
      expect(host.querySelector('.agent-tool-summary').textContent).toContain('Navigating to');
    });

    test('allowed renders past tense with the resolved final URL', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'navigate',
        status: 'allowed',
        args: { url: 'https://example.com' },
        result: { url: 'https://example.com/redirected' },
      }));
      const pill = host.querySelector('.agent-tool-url-pill');
      expect(pill.href).toBe('https://example.com/redirected');
      expect(host.querySelector('.agent-tool-summary').textContent).toContain('Navigated to');
    });

    test('error path surfaces the error message', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'navigate',
        status: 'error',
        args: { url: 'https://example.com' },
        result: { error: 'ERR_NAME_NOT_RESOLVED' },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toContain(
        'Navigation failed: ERR_NAME_NOT_RESOLVED'
      );
    });
  });

  describe('read_current_tab', () => {
    test('allowed renders the page title + a disclosure with body text', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'read_current_tab',
        status: 'allowed',
        args: {},
        result: { title: 'Wikipedia', url: 'https://w.org', text: 'Hello world' },
      }));
      expect(host.querySelector('.agent-tool-title').textContent).toBe('Wikipedia');
      const disclosure = host.querySelector('.agent-tool-disclosure');
      expect(disclosure).toBeTruthy();
      expect(host.querySelector('.agent-tool-mono').textContent).toBe('Hello world');
    });
  });

  describe('click', () => {
    test('shows the selector pill for a successful click', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'click',
        status: 'allowed',
        args: { selector: '#submit' },
        result: { clicked: true },
      }));
      expect(host.querySelector('.agent-tool-selector-pill').textContent).toBe('#submit');
      expect(host.querySelector('.agent-tool-summary').textContent).toContain('Clicked');
    });

    test('reports when no element matched (clicked === false)', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'click',
        status: 'allowed',
        args: { selector: '#nope' },
        result: { clicked: false },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toContain(
        'No element matched'
      );
    });
  });

  describe('fill', () => {
    test('renders a value disclosure when value is non-empty', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'fill',
        status: 'allowed',
        args: { selector: 'input[name=q]', value: 'hello' },
        result: { filled: true },
      }));
      expect(host.querySelector('.agent-tool-disclosure')).toBeTruthy();
      expect(host.querySelector('.agent-tool-mono').textContent).toBe('hello');
    });
  });

  describe('screenshot', () => {
    test('renders an inline thumbnail with caption', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'screenshot',
        status: 'allowed',
        args: {},
        result: { dataUrl: 'data:image/jpeg;base64,abc', url: 'https://x' },
      }));
      const img = host.querySelector('.agent-tool-screenshot-img');
      expect(img.src).toBe('data:image/jpeg;base64,abc');
      const caption = host.querySelector('.agent-tool-screenshot-caption');
      expect(caption).toBeTruthy();
      expect(caption.querySelector('.agent-tool-url-pill').href).toBe('https://x');
    });
  });

  describe('spawn_subagent', () => {
    test('allowed renders id + meta and always includes the children container slot', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        id: 'parent-1',
        name: 'spawn_subagent',
        status: 'allowed',
        args: { subagent_id: 'research_topic', prompt: 'investigate X' },
        result: { turnCount: 4, durationMs: 12300 },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toBe(
        'Subagent research_topic · 4 turns · 12.3s'
      );
      const nested = host.querySelector('.agent-tool-subagent-children');
      expect(nested).toBeTruthy();
      expect(nested.dataset.subagentParent).toBe('parent-1');
    });

    test('children container slot is also rendered for pending subagents', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        id: 'parent-1',
        name: 'spawn_subagent',
        status: 'pending',
        args: { subagent_id: 'research_topic', prompt: 'investigate X' },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toContain('running');
      expect(host.querySelector('.agent-tool-subagent-children')).toBeTruthy();
    });
  });

  describe('read_skill', () => {
    test('shows "Loaded skill /<name> (source)" + a recipe disclosure on success', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'read_skill',
        status: 'allowed',
        args: { name: 'tldr' },
        result: { name: 'tldr', source: 'builtin', body: 'do the thing' },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toContain('Loaded skill ');
      expect(host.querySelector('.agent-tool-title').textContent).toBe('/tldr');
      const disclosure = host.querySelector('.agent-tool-disclosure');
      expect(disclosure).toBeTruthy();
      expect(host.querySelector('.agent-tool-mono').textContent).toBe('do the thing');
    });

    test('reports a not_found error with the requested name', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'read_skill',
        status: 'allowed',
        args: { name: 'nope' },
        result: { name: 'nope', error: 'not_found' },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toContain(
        'Skill "nope" not found'
      );
    });

    test('pending state shows the skill name being loaded', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'read_skill',
        status: 'pending',
        args: { name: 'tldr' },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toContain('Loading skill tldr');
    });
  });

  describe('list_tabs', () => {
    test('summarises count + active tab title with a disclosure for the full list', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'list_tabs',
        status: 'allowed',
        args: {},
        result: {
          tabs: [
            { id: 1, url: 'https://x', title: 'X', isActive: true },
            { id: 2, url: 'https://y', title: 'Y', isActive: false },
          ],
        },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toContain('Listed 2 tabs');
      expect(host.querySelector('.agent-tool-title').textContent).toBe('X');
      const mono = host.querySelector('.agent-tool-mono');
      expect(mono.textContent).toContain('[1]* X — https://x');
      expect(mono.textContent).toContain('[2]  Y — https://y');
    });

    test('handles zero tabs without crashing', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'list_tabs',
        status: 'allowed',
        args: {},
        result: { tabs: [] },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toContain('Listed 0 tabs');
      expect(host.querySelector('.agent-tool-disclosure')).toBeNull();
    });
  });

  describe('open_tab', () => {
    test('shows the resolved URL pill from the new tab object', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'open_tab',
        status: 'allowed',
        args: { url: 'https://input' },
        result: { tab: { id: 9, url: 'https://resolved', title: '' } },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toContain('Opened new tab');
      const pill = host.querySelector('.agent-tool-url-pill');
      expect(pill.href).toBe('https://resolved');
    });
  });

  describe('close_tab', () => {
    test('reports closed when bridge confirms', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'close_tab',
        status: 'allowed',
        args: { id: 3 },
        result: { closed: true, id: 3 },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toBe('Closed tab 3');
    });

    test('reports unmatched id when bridge returns false', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'close_tab',
        status: 'allowed',
        args: { id: 99 },
        result: { closed: false, id: 99 },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toBe('No tab matched id 99');
    });
  });

  describe('wallet_sign_message', () => {
    const SIG = '0x' + 'ab'.repeat(65); // 132-hex sig
    const ADDR = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

    test('pending shows "Signing message with <addr>…" using the requested address', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'wallet_sign_message',
        status: 'pending',
        args: { message: 'Hi', reason: 'r', address: ADDR },
      }));
      const text = host.querySelector('.agent-tool-summary').textContent;
      expect(text).toContain('Signing message with 0xd8dA…6045');
    });

    test('pending without an address arg falls back to "active wallet"', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'wallet_sign_message',
        status: 'pending',
        args: { message: 'Hi', reason: 'r' },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toContain(
        'Signing message with active wallet'
      );
    });

    test('allowed renders "Signed with <addr>" + a disclosure containing the signature', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'wallet_sign_message',
        status: 'allowed',
        args: { message: 'Hi', reason: 'r' },
        result: { address: ADDR, signature: SIG },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toBe(
        'Signed with 0xd8dA…6045'
      );
      const disclosure = host.querySelector('.agent-tool-disclosure');
      expect(disclosure).toBeTruthy();
      expect(disclosure.querySelector('.agent-tool-disclosure-summary').textContent).toBe(
        'Signature'
      );
      expect(disclosure.querySelector('.agent-tool-mono').textContent).toBe(SIG);
    });

    test('error path surfaces the underlying error', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'wallet_sign_message',
        status: 'error',
        args: { message: 'Hi', reason: 'r' },
        result: { error: 'Vault unlock cancelled by user' },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toContain(
        'Signing failed: Vault unlock cancelled by user'
      );
    });
  });

  describe('wallet_sign_typed_data', () => {
    const TYPED_DATA = {
      domain: { name: 'USD Coin', chainId: 1 },
      types: { Permit: [] },
      primaryType: 'Permit',
      message: { value: '1' },
    };
    const ADDR = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
    const SIG = '0x' + 'cd'.repeat(65);

    test('pending shows "Signing <primaryType> for <domain> with <addr>…"', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'wallet_sign_typed_data',
        status: 'pending',
        args: { typedData: TYPED_DATA, reason: 'r', address: ADDR },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toBe(
        'Signing Permit for USD Coin with 0xd8dA…6045…'
      );
    });

    test('allowed renders "Signed Permit for USD Coin" + signature disclosure', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'wallet_sign_typed_data',
        status: 'allowed',
        args: { typedData: TYPED_DATA, reason: 'r' },
        result: {
          address: ADDR,
          signature: SIG,
          domain: TYPED_DATA.domain,
          primaryType: 'Permit',
        },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toBe(
        'Signed Permit for USD Coin with 0xd8dA…6045'
      );
      expect(host.querySelector('.agent-tool-mono').textContent).toBe(SIG);
    });

    test('error path surfaces the underlying error', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'wallet_sign_typed_data',
        status: 'error',
        args: { typedData: TYPED_DATA, reason: 'r' },
        result: { error: 'Vault unlock cancelled by user' },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toContain(
        'Signing failed: Vault unlock cancelled by user'
      );
    });
  });

  describe('switch_tab', () => {
    test('reports switched on success', async () => {
      const { mod } = await loadRenderers();
      const host = into(mod.renderToolBody({
        name: 'switch_tab',
        status: 'allowed',
        args: { id: 5 },
        result: { switched: true, id: 5 },
      }));
      expect(host.querySelector('.agent-tool-summary').textContent).toBe('Switched to tab 5');
    });
  });

  test('falls back to JSON args block for unknown tool names', async () => {
    const { mod } = await loadRenderers();
    const host = into(mod.renderToolBody({
      name: 'mystery_tool',
      status: 'allowed',
      args: { foo: 1 },
    }));
    const block = host.querySelector('.agent-tool-mono');
    expect(block.textContent).toContain('"foo": 1');
  });
});
