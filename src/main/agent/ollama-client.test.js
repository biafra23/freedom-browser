const { getVersion, listModels, streamChat } = require('./ollama-client');

function ndjsonStream(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe('ollama-client', () => {
  describe('getVersion', () => {
    test('returns parsed version JSON on 200', async () => {
      const fetchImpl = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '0.23.2' }),
      });
      const result = await getVersion({ fetchImpl });
      expect(result).toEqual({ version: '0.23.2' });
      expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:11434/api/version');
    });

    test('throws on non-2xx', async () => {
      const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 503 });
      await expect(getVersion({ fetchImpl })).rejects.toThrow(/HTTP 503/);
    });

    test('respects baseUrl override', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ version: '0.0.0' }) });
      await getVersion({ fetchImpl, baseUrl: 'http://example.test:1234' });
      expect(fetchImpl).toHaveBeenCalledWith('http://example.test:1234/api/version');
    });
  });

  describe('listModels', () => {
    test('returns parsed models JSON on 200', async () => {
      const fetchImpl = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: 'gemma4:e2b' }] }),
      });
      const result = await listModels({ fetchImpl });
      expect(result.models).toHaveLength(1);
      expect(result.models[0].name).toBe('gemma4:e2b');
    });

    test('throws on error response', async () => {
      const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 500 });
      await expect(listModels({ fetchImpl })).rejects.toThrow(/HTTP 500/);
    });
  });

  describe('streamChat', () => {
    test('yields each NDJSON chunk in order', async () => {
      const body = ndjsonStream([
        '{"message":{"role":"assistant","content":"Hel"},"done":false}\n',
        '{"message":{"role":"assistant","content":"lo"},"done":false}\n',
        '{"message":{"role":"assistant","content":"!"},"done":true}\n',
      ]);
      const fetchImpl = jest.fn().mockResolvedValue({ ok: true, body });

      const chunks = [];
      for await (const chunk of streamChat(
        { model: 'gemma4:e2b', messages: [{ role: 'user', content: 'hi' }] },
        { fetchImpl }
      )) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks.map((c) => c.message.content).join('')).toBe('Hello!');
      expect(chunks[2].done).toBe(true);
    });

    test('handles a chunk split across reads', async () => {
      const body = ndjsonStream([
        '{"message":{"role":"assistant","conte',
        'nt":"Split"},"done":false}\n{"message":{"role":"assistant","content":""},"done":true}\n',
      ]);
      const fetchImpl = jest.fn().mockResolvedValue({ ok: true, body });

      const chunks = [];
      for await (const chunk of streamChat(
        { model: 'm', messages: [] },
        { fetchImpl }
      )) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0].message.content).toBe('Split');
    });

    test('skips malformed lines without aborting the stream', async () => {
      const body = ndjsonStream([
        'this-is-not-json\n',
        '{"message":{"role":"assistant","content":"ok"},"done":true}\n',
      ]);
      const fetchImpl = jest.fn().mockResolvedValue({ ok: true, body });

      const chunks = [];
      for await (const chunk of streamChat({ model: 'm', messages: [] }, { fetchImpl })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0].message.content).toBe('ok');
    });

    test('throws if the upstream returns non-2xx', async () => {
      const fetchImpl = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'model not found',
      });

      await expect(async () => {
        for await (const _chunk of streamChat({ model: 'missing', messages: [] }, { fetchImpl })) {
          // never yields
        }
      }).rejects.toThrow(/HTTP 404/);
    });

    test('passes signal to fetch for cancellation', async () => {
      const controller = new AbortController();
      const fetchImpl = jest.fn().mockImplementation((_url, opts) => {
        expect(opts.signal).toBe(controller.signal);
        return Promise.resolve({ ok: true, body: ndjsonStream(['{"done":true}\n']) });
      });

      const iter = streamChat(
        { model: 'm', messages: [] },
        { fetchImpl, signal: controller.signal }
      );
      // Drain so the fetchImpl assertion runs.
      // eslint-disable-next-line no-empty
      for await (const _chunk of iter) {
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
});
