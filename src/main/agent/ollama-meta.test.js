const { getBaseUrl, getVersion, listModels } = require('./ollama-meta');

const originalEnv = process.env.OLLAMA_HOST;

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.OLLAMA_HOST;
  } else {
    process.env.OLLAMA_HOST = originalEnv;
  }
});

describe('getBaseUrl', () => {
  test('defaults to local Ollama', () => {
    delete process.env.OLLAMA_HOST;
    expect(getBaseUrl()).toBe('http://127.0.0.1:11434');
  });

  test('honours OLLAMA_HOST env var', () => {
    process.env.OLLAMA_HOST = 'http://other:1234';
    expect(getBaseUrl()).toBe('http://other:1234');
  });
});

describe('getVersion', () => {
  test('returns parsed JSON when fetch succeeds', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.23.2' }),
    });
    const result = await getVersion({ fetchImpl, baseUrl: 'http://x' });
    expect(result).toEqual({ version: '0.23.2' });
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/version');
  });

  test('throws when HTTP status is not ok', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(getVersion({ fetchImpl })).rejects.toThrow(/HTTP 500/);
  });

  test('propagates network errors', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(getVersion({ fetchImpl })).rejects.toThrow('ECONNREFUSED');
  });
});

describe('listModels', () => {
  test('returns model list from /api/tags', async () => {
    const payload = {
      models: [{ name: 'gemma3:4b', size: 4_000_000_000, modified_at: '2026-05-08T00:00:00Z' }],
    };
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => payload });
    const result = await listModels({ fetchImpl, baseUrl: 'http://x' });
    expect(result).toEqual(payload);
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/tags');
  });

  test('throws when HTTP status is not ok', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(listModels({ fetchImpl })).rejects.toThrow(/HTTP 503/);
  });
});
