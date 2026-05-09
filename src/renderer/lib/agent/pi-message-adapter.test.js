const {
  adaptMessages,
  adaptEntries,
  adaptMessage,
  extractText,
  extractThinking,
} = require('./pi-message-adapter.js');

describe('extractText', () => {
  test('passes through plain strings', () => {
    expect(extractText('hello')).toBe('hello');
  });

  test('joins TextContent blocks', () => {
    expect(
      extractText([
        { type: 'text', text: 'Hello, ' },
        { type: 'text', text: 'world.' },
      ])
    ).toBe('Hello, world.');
  });

  test('skips non-text blocks', () => {
    expect(
      extractText([
        { type: 'text', text: 'before ' },
        { type: 'thinking', thinking: 'invisible' },
        { type: 'image', data: 'b64', mimeType: 'image/png' },
        { type: 'toolCall', id: 'x', name: 'navigate', arguments: {} },
        { type: 'text', text: 'after' },
      ])
    ).toBe('before after');
  });

  test('returns "" for empty / missing content', () => {
    expect(extractText(undefined)).toBe('');
    expect(extractText(null)).toBe('');
    expect(extractText([])).toBe('');
  });
});

describe('extractThinking', () => {
  test('joins ThinkingContent blocks via .thinking field', () => {
    expect(
      extractThinking([
        { type: 'thinking', thinking: 'first ' },
        { type: 'text', text: 'visible' },
        { type: 'thinking', thinking: 'and second' },
      ])
    ).toBe('first and second');
  });

  test('returns "" when no thinking blocks present', () => {
    expect(extractThinking([{ type: 'text', text: 'hi' }])).toBe('');
    expect(extractThinking('just a string')).toBe('');
    expect(extractThinking([])).toBe('');
    expect(extractThinking(null)).toBe('');
  });
});

describe('adaptMessage', () => {
  test('user message with string content', () => {
    expect(adaptMessage({ role: 'user', content: 'hi' })).toEqual({
      role: 'user',
      content: 'hi',
    });
  });

  test('user message with content blocks', () => {
    expect(
      adaptMessage({
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      })
    ).toEqual({ role: 'user', content: 'hello' });
  });

  test('assistant message with mixed blocks splits text vs thinking', () => {
    expect(
      adaptMessage({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning…' },
          { type: 'text', text: '2+2=' },
          { type: 'text', text: '4.' },
        ],
      })
    ).toEqual({ role: 'assistant', content: '2+2=4.', thinking: 'reasoning…' });
  });

  test('keeps thinking-only assistant messages so the disclosure renders', () => {
    const view = adaptMessage({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'reasoning…' }],
    });
    expect(view).toEqual({ role: 'assistant', content: '', thinking: 'reasoning…' });
  });

  test('returns null for assistant message with no text and no thinking', () => {
    expect(
      adaptMessage({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'x', name: 'navigate', arguments: {} }],
      })
    ).toBeNull();
  });

  test('assistant message with both text and thinking gets a thinking field', () => {
    const view = adaptMessage({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'let me think...' },
        { type: 'text', text: 'final answer' },
      ],
    });
    expect(view).toEqual({
      role: 'assistant',
      content: 'final answer',
      thinking: 'let me think...',
    });
  });

  test('skips toolResult, bashExecution, custom roles in Phase 2', () => {
    expect(adaptMessage({ role: 'toolResult', toolCallId: 'x', content: [] })).toBeNull();
    expect(adaptMessage({ role: 'bashExecution', command: 'ls' })).toBeNull();
    expect(adaptMessage({ role: 'custom', customType: 'x', content: 'y' })).toBeNull();
  });

  test('returns null for malformed input', () => {
    expect(adaptMessage(null)).toBeNull();
    expect(adaptMessage(undefined)).toBeNull();
    expect(adaptMessage({})).toBeNull();
    expect(adaptMessage('hello')).toBeNull();
  });
});

describe('adaptMessages', () => {
  test('maps a typical conversation', () => {
    const result = adaptMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: 'and?' },
    ]);
    expect(result).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'and?' },
    ]);
  });

  test('keeps thinking-only assistant messages; drops fully-empty ones', () => {
    const result = adaptMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning' }] },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'x', name: 'navigate', arguments: {} }],
      }, // no text and no thinking → dropped
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ]);
    expect(result).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', thinking: 'reasoning' },
      { role: 'assistant', content: 'a' },
    ]);
  });

  test('returns [] for non-array input', () => {
    expect(adaptMessages(null)).toEqual([]);
    expect(adaptMessages('hi')).toEqual([]);
    expect(adaptMessages(undefined)).toEqual([]);
  });
});

describe('adaptEntries', () => {
  test('walks message entries, ignoring non-message entries', () => {
    const result = adaptEntries([
      { type: 'session_info', id: 'a', name: 'My Chat' },
      {
        type: 'message',
        id: 'b',
        message: { role: 'user', content: 'hi' },
      },
      {
        type: 'thinking_level_change',
        id: 'c',
        thinkingLevel: 'medium',
      },
      {
        type: 'message',
        id: 'd',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi back' }] },
      },
      {
        type: 'message',
        id: 'e',
        message: { role: 'toolResult', toolCallId: 'x', content: [], isError: false },
      },
    ]);
    expect(result).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hi back' },
    ]);
  });

  test('returns [] for non-array input', () => {
    expect(adaptEntries(null)).toEqual([]);
    expect(adaptEntries(undefined)).toEqual([]);
  });
});
