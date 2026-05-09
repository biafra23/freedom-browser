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
