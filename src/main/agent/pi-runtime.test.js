jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../service-registry', () => ({
  getOllamaApiUrl: jest.fn(() => 'http://127.0.0.1:11434'),
}));

jest.mock('./ollama-meta', () => ({
  listModels: jest.fn(),
}));

const path = require('node:path');
const { listModels } = require('./ollama-meta');

const runtime = require('./pi-runtime');
const { _internals } = runtime;

describe('buildOllamaProviderConfig', () => {
  test('produces an OpenAI-compatible config with Ollama compat flags', () => {
    const config = _internals.buildOllamaProviderConfig({
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: [{ name: 'gemma4:e2b' }, { name: 'llama3.1:8b' }],
    });
    expect(config).toEqual(
      expect.objectContaining({
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: 'ollama',
        api: 'openai-completions',
        compat: expect.objectContaining({
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        }),
      })
    );
    expect(config.models).toHaveLength(2);
    expect(config.models[0]).toEqual(
      expect.objectContaining({
        id: 'gemma4:e2b',
        name: 'gemma4:e2b',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })
    );
  });

  test('handles an empty model list without throwing', () => {
    const config = _internals.buildOllamaProviderConfig({
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: undefined,
    });
    expect(config.models).toEqual([]);
  });
});

describe('getFreedomAgentDir', () => {
  test('returns userData/pi-agent', () => {
    const fakeApp = { getPath: jest.fn(() => '/Users/test/Library/Application Support/Freedom') };
    const dir = runtime.getFreedomAgentDir(fakeApp);
    expect(fakeApp.getPath).toHaveBeenCalledWith('userData');
    expect(dir).toBe(
      path.join('/Users/test/Library/Application Support/Freedom', 'pi-agent')
    );
  });

  test('throws if no app instance is provided', () => {
    expect(() => runtime.getFreedomAgentDir()).toThrow(/app/);
    expect(() => runtime.getFreedomAgentDir({})).toThrow(/app/);
  });
});

describe('createFreedomPiSession', () => {
  let piMock;
  let registryMock;
  let sessionMock;
  let sessionManagerInstance;

  beforeEach(() => {
    listModels.mockReset();
    registryMock = {
      registerProvider: jest.fn(),
      find: jest.fn(() => ({ provider: 'ollama', id: 'gemma4:e2b' })),
    };
    sessionMock = {
      bindExtensions: jest.fn(async () => undefined),
      dispose: jest.fn(),
      getActiveToolNames: jest.fn(() => []),
    };
    sessionManagerInstance = { kind: 'inMemory' };

    piMock = {
      AuthStorage: { create: jest.fn(() => ({ kind: 'auth' })) },
      ModelRegistry: { create: jest.fn(() => registryMock) },
      SettingsManager: { create: jest.fn(() => ({ kind: 'settings' })) },
      SessionManager: {
        inMemory: jest.fn(() => sessionManagerInstance),
        open: jest.fn(() => ({ kind: 'opened' })),
      },
      DefaultResourceLoader: jest.fn(function MockLoader(opts) {
        this.opts = opts;
        this.reload = jest.fn(async () => undefined);
      }),
      createAgentSession: jest.fn(async () => ({ session: sessionMock })),
    };
    _internals.setPiModule(piMock);
  });

  afterEach(() => {
    _internals.setPiModule(null);
  });

  test('throws when agentDir is missing', async () => {
    await expect(runtime.createFreedomPiSession({})).rejects.toThrow(/agentDir/);
  });

  test('throws if Ollama reports no installed models', async () => {
    listModels.mockResolvedValue({ models: [] });
    await expect(
      runtime.createFreedomPiSession({ agentDir: '/tmp/x' })
    ).rejects.toThrow(/No Ollama models installed/);
  });

  test('throws if requested model is not in registry', async () => {
    listModels.mockResolvedValue({ models: [{ name: 'gemma4:e2b' }] });
    registryMock.find.mockReturnValueOnce(undefined);
    await expect(
      runtime.createFreedomPiSession({ agentDir: '/tmp/x', modelId: 'nope:1' })
    ).rejects.toThrow(/not found in registry/);
  });

  test('disables Pi built-in tools and disk autodiscovery', async () => {
    listModels.mockResolvedValue({ models: [{ name: 'gemma4:e2b' }] });
    await runtime.createFreedomPiSession({ agentDir: '/tmp/x' });

    const loaderInstance = piMock.DefaultResourceLoader.mock.instances[0];
    expect(loaderInstance.opts).toEqual(
      expect.objectContaining({
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      })
    );
    expect(loaderInstance.opts.extensionFactories).toHaveLength(1);
    expect(typeof loaderInstance.opts.extensionFactories[0]).toBe('function');

    expect(piMock.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ noTools: 'builtin' })
    );
  });

  test('threads toolCallContext into the extension factory', async () => {
    listModels.mockResolvedValue({ models: [{ name: 'gemma4:e2b' }] });
    const toolCallContext = {
      profile: { allowed_tool_tiers: ['local_safe'] },
      sessionId: 's1',
      webContentsId: 42,
      onToolCall: jest.fn(),
      requestConsent: jest.fn(),
      onToolResult: jest.fn(),
    };
    await runtime.createFreedomPiSession({ agentDir: '/tmp/x', toolCallContext });

    // Run the factory against a fake Pi API and verify it tries to register
    // browser tools — proves the toolCallContext made it through, since the
    // extension's tool-registration code only runs when the context is set.
    const loaderInstance = piMock.DefaultResourceLoader.mock.instances[0];
    const factory = loaderInstance.opts.extensionFactories[0];
    const fakePi = {
      handlers: new Map(),
      tools: [],
      commands: new Map(),
      on(event, handler) {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
      },
      registerTool(def) {
        this.tools.push(def);
      },
      registerCommand(name, options) {
        this.commands.set(name, options);
      },
      setSessionName() {},
    };
    await factory(fakePi);
    expect(fakePi.tools.map((t) => t.name).sort()).toEqual(
      ['click', 'fill', 'navigate', 'read_current_tab', 'screenshot', 'spawn_subagent'].sort()
    );
  });

  test('isSubagent: true skips spawn_subagent so depth stays 1', async () => {
    listModels.mockResolvedValue({ models: [{ name: 'gemma4:e2b' }] });
    const toolCallContext = {
      profile: { allowed_tool_tiers: ['local_sensitive'] },
      sessionId: 's1',
      webContentsId: 42,
      onToolCall: jest.fn(),
      requestConsent: jest.fn(),
      onToolResult: jest.fn(),
    };
    await runtime.createFreedomPiSession({
      agentDir: '/tmp/x',
      toolCallContext,
      isSubagent: true,
    });
    const loaderInstance = piMock.DefaultResourceLoader.mock.instances[0];
    const factory = loaderInstance.opts.extensionFactories[0];
    const fakePi = {
      handlers: new Map(),
      tools: [],
      on(e, h) {
        const list = this.handlers.get(e) ?? [];
        list.push(h);
        this.handlers.set(e, list);
      },
      registerTool(d) {
        this.tools.push(d);
      },
    };
    await factory(fakePi);
    expect(fakePi.tools.map((t) => t.name)).not.toContain('spawn_subagent');
  });

  test('pre-registers the Ollama provider on the modelRegistry', async () => {
    listModels.mockResolvedValue({ models: [{ name: 'gemma4:e2b' }] });
    await runtime.createFreedomPiSession({ agentDir: '/tmp/x' });
    expect(registryMock.registerProvider).toHaveBeenCalledWith(
      'ollama',
      expect.objectContaining({
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:11434/v1',
      })
    );
  });

  test('uses inMemory SessionManager when no sessionPath is provided', async () => {
    listModels.mockResolvedValue({ models: [{ name: 'gemma4:e2b' }] });
    await runtime.createFreedomPiSession({ agentDir: '/tmp/x' });
    expect(piMock.SessionManager.inMemory).toHaveBeenCalledWith('/tmp/x');
    expect(piMock.SessionManager.open).not.toHaveBeenCalled();
  });

  test('uses SessionManager.open when sessionPath is provided', async () => {
    listModels.mockResolvedValue({ models: [{ name: 'gemma4:e2b' }] });
    await runtime.createFreedomPiSession({
      agentDir: '/tmp/x',
      sessionPath: '/tmp/sess.jsonl',
    });
    expect(piMock.SessionManager.open).toHaveBeenCalledWith('/tmp/sess.jsonl');
    expect(piMock.SessionManager.inMemory).not.toHaveBeenCalled();
  });

  test('binds the provided uiContext to the session', async () => {
    listModels.mockResolvedValue({ models: [{ name: 'gemma4:e2b' }] });
    const customUi = { kind: 'custom-ui' };
    await runtime.createFreedomPiSession({ agentDir: '/tmp/x', uiContext: customUi });
    expect(sessionMock.bindExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ uiContext: customUi })
    );
  });

  test('dispose calls session.dispose without re-throwing', async () => {
    listModels.mockResolvedValue({ models: [{ name: 'gemma4:e2b' }] });
    sessionMock.dispose.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const { dispose } = await runtime.createFreedomPiSession({ agentDir: '/tmp/x' });
    expect(() => dispose()).not.toThrow();
    expect(sessionMock.dispose).toHaveBeenCalled();
  });

  test('falls back to first reported Ollama model when modelId is omitted', async () => {
    listModels.mockResolvedValue({
      models: [{ name: 'llama3.1:8b' }, { name: 'gemma4:e2b' }],
    });
    const result = await runtime.createFreedomPiSession({ agentDir: '/tmp/x' });
    expect(result.modelId).toBe('llama3.1:8b');
    expect(registryMock.find).toHaveBeenCalledWith('ollama', 'llama3.1:8b');
  });
});
