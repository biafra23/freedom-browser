jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockRunSubagent = jest.fn();
jest.mock('./subagents', () => {
  const actual = jest.requireActual('./subagents');
  return {
    ...actual,
    runSubagent: (...args) => mockRunSubagent(...args),
  };
});

const { Type } = require('typebox');
const { createSubagentTools, buildSubagentDescription } = require('./subagent-tools');
const { TIERS } = require('./tool-tiers');

const baseArgs = () => ({
  parentToolCallContext: {
    sessionId: '/tmp/parent.jsonl',
    webContentsId: 42,
    requestConsent: jest.fn(),
  },
  modelId: 'gemma4:e2b',
  agentDir: '/tmp/agentdir',
  Type,
});

beforeEach(() => {
  mockRunSubagent.mockReset();
});

describe('buildSubagentDescription', () => {
  test('lists every registered subagent in the description', () => {
    const desc = buildSubagentDescription();
    expect(desc).toMatch(/summarize_current_page/);
    expect(desc).toMatch(/research_topic/);
    expect(desc).toMatch(/extract_info/);
    expect(desc).toMatch(/Available subagents/i);
  });
});

describe('createSubagentTools', () => {
  test('returns [] without parentToolCallContext', () => {
    const tools = createSubagentTools({
      ...baseArgs(),
      parentToolCallContext: undefined,
    });
    expect(tools).toEqual([]);
  });

  test('returns [] without modelId', () => {
    const tools = createSubagentTools({ ...baseArgs(), modelId: undefined });
    expect(tools).toEqual([]);
  });

  test('returns [] without agentDir', () => {
    const tools = createSubagentTools({ ...baseArgs(), agentDir: undefined });
    expect(tools).toEqual([]);
  });

  test('builds spawn_subagent tool with LOCAL_SAFE tier and metadata', () => {
    const [tool] = createSubagentTools(baseArgs());
    expect(tool.name).toBe('spawn_subagent');
    expect(tool.tier).toBe(TIERS.LOCAL_SAFE);
    expect(typeof tool.label).toBe('string');
    expect(typeof tool.description).toBe('string');
    expect(typeof tool.promptSnippet).toBe('string');
    expect(Array.isArray(tool.promptGuidelines)).toBe(true);
    expect(tool.parameters).toBeDefined();
  });

  test('execute forwards to runSubagent with parent context closed-over', async () => {
    mockRunSubagent.mockResolvedValueOnce({
      text: 'subagent did the thing',
      turnCount: 4,
      durationMs: 1234,
    });
    const args = baseArgs();
    const [tool] = createSubagentTools(args);
    const result = await tool.execute('call-1', {
      subagent_id: 'summarize_current_page',
      prompt: 'summarise the page',
    });
    expect(mockRunSubagent).toHaveBeenCalledWith({
      subagentId: 'summarize_current_page',
      prompt: 'summarise the page',
      parentToolCallContext: args.parentToolCallContext,
      modelId: 'gemma4:e2b',
      agentDir: '/tmp/agentdir',
    });
    expect(result.content[0].text).toBe('subagent did the thing');
    expect(result.details).toEqual(
      expect.objectContaining({
        subagent_id: 'summarize_current_page',
        turnCount: 4,
        durationMs: 1234,
      })
    );
  });

  test('execute returns "(no response)" when subagent yields empty text', async () => {
    mockRunSubagent.mockResolvedValueOnce({ text: '', turnCount: 0, durationMs: 10 });
    const [tool] = createSubagentTools(baseArgs());
    const result = await tool.execute('call-1', {
      subagent_id: 'summarize_current_page',
      prompt: 'x',
    });
    expect(result.content[0].text).toBe('(no response)');
  });
});
