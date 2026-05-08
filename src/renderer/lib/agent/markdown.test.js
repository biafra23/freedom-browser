describe('agent/markdown', () => {
  let originalMarked;
  let originalDOMPurify;

  beforeEach(() => {
    jest.resetModules();
    originalMarked = global.marked;
    originalDOMPurify = global.DOMPurify;
  });

  afterEach(() => {
    global.marked = originalMarked;
    global.DOMPurify = originalDOMPurify;
  });

  test('returns empty string for empty input', async () => {
    global.marked = { setOptions: jest.fn(), parse: jest.fn() };
    global.DOMPurify = { sanitize: jest.fn() };
    const { renderMarkdown } = await import('./markdown.js');
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null)).toBe('');
    expect(renderMarkdown(undefined)).toBe('');
    expect(global.marked.parse).not.toHaveBeenCalled();
  });

  test('configures marked once with gfm + breaks options', async () => {
    const setOptions = jest.fn();
    global.marked = { setOptions, parse: jest.fn().mockReturnValue('<p>hi</p>') };
    global.DOMPurify = { sanitize: jest.fn((html) => html) };
    const { renderMarkdown } = await import('./markdown.js');

    renderMarkdown('hi');
    renderMarkdown('there');

    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(setOptions).toHaveBeenCalledWith({ gfm: true, breaks: true });
  });

  test('passes parsed HTML through DOMPurify with ADD_ATTR for target/rel', async () => {
    global.marked = {
      setOptions: jest.fn(),
      parse: jest.fn().mockReturnValue('<a href="https://x">x</a>'),
    };
    global.DOMPurify = {
      sanitize: jest.fn().mockReturnValue('<a href="https://x" target="_blank" rel="noopener">x</a>'),
    };
    const { renderMarkdown } = await import('./markdown.js');

    const out = renderMarkdown('[x](https://x)');
    expect(global.marked.parse).toHaveBeenCalledWith('[x](https://x)');
    expect(global.DOMPurify.sanitize).toHaveBeenCalledWith('<a href="https://x">x</a>', {
      ADD_ATTR: ['target', 'rel'],
    });
    expect(out).toContain('href="https://x"');
  });

  test('throws if window.marked is missing', async () => {
    delete global.marked;
    global.DOMPurify = { sanitize: jest.fn() };
    const { renderMarkdown } = await import('./markdown.js');
    expect(() => renderMarkdown('hi')).toThrow(/window.marked is not loaded/);
  });

  test('throws if window.DOMPurify is missing', async () => {
    global.marked = { setOptions: jest.fn(), parse: jest.fn().mockReturnValue('hi') };
    delete global.DOMPurify;
    const { renderMarkdown } = await import('./markdown.js');
    expect(() => renderMarkdown('hi')).toThrow(/window.DOMPurify is not loaded/);
  });
});
