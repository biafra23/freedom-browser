jest.mock('../service-registry', () => ({
  getIpfsGatewayUrl: jest.fn(() => 'http://localhost:8080'),
}));

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Prefix required by Jest's mock-factory hoisting: the factory runs before
// regular `const` initialisation, so any captured variable must start with
// `mock` to survive the static analyser.
const mockResolveEnsContent = jest.fn();
jest.mock('../ens-resolver', () => ({
  resolveEnsContent: (...args) => mockResolveEnsContent(...args),
}));

const {
  buildGatewayUrl,
  sanitizeRequestHeaders,
  handleRequest,
} = require('./ipfs-protocol');

const CIDV0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const CIDV1_BASE32 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const CIDV1_BASE58 = 'zb2rhe5P4gXftAwvA4eXQ5HJwsER2owDyS9sKaQRRVQPn93bA';
const IPNS_KEY_BASE36 = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const IPNS_KEY_BASE58_ED25519 = '12D3KooWGuQafLgPqRRRkRSUNqZNQwL2gMZcQ27GiNpoVxz3vMWj';

describe('buildGatewayUrl(ipfs)', () => {
  beforeEach(() => {
    mockResolveEnsContent.mockReset();
  });

  test.each([
    ['CIDv0 (Qm…)', CIDV0],
    ['CIDv1 base32 (baf…)', CIDV1_BASE32],
    ['CIDv1 base58btc (z…)', CIDV1_BASE58],
  ])('converts ipfs://<%s>/path to the Kubo gateway URL', async (_label, cid) => {
    await expect(buildGatewayUrl('ipfs', `ipfs://${cid}/index.html`)).resolves.toEqual({
      ok: true,
      url: `http://localhost:8080/ipfs/${cid}/index.html`,
    });
    expect(mockResolveEnsContent).not.toHaveBeenCalled();
  });

  test('preserves query string and drops fragment (Chromium never sends it)', async () => {
    await expect(buildGatewayUrl('ipfs', `ipfs://${CIDV0}/page?v=1`)).resolves.toEqual({
      ok: true,
      url: `http://localhost:8080/ipfs/${CIDV0}/page?v=1`,
    });
  });

  test('returns null for non-CID non-ENS hosts', async () => {
    await expect(buildGatewayUrl('ipfs', 'ipfs://not-a-cid/file')).resolves.toBeNull();
    expect(mockResolveEnsContent).not.toHaveBeenCalled();
  });

  test('returns null for DNSLink-style hosts under ipfs:// (only ipns:// accepts those)', async () => {
    await expect(
      buildGatewayUrl('ipfs', 'ipfs://docs.ipfs.tech/install')
    ).resolves.toBeNull();
    expect(mockResolveEnsContent).not.toHaveBeenCalled();
  });

  describe('gateway-form rewrite', () => {
    // Sub-resource fetches that bypass the renderer's address-bar pipeline
    // can land here with the path-gateway shape `ipfs://<gateway-host>/ipfs/<cid>/...`
    // (typical source: protocol-relative URLs like
    // `<img src="//localhost:8080/ipfs/<cid>/img.png">` in Kubo's HTML
    // resolved against the page's `ipfs:` scheme). The handler must
    // recognise the embedded ref so the bytes load instead of 400-ing.

    test('rewrites ipfs://<gw>/ipfs/<cidv1>/<path> to use the embedded CID', async () => {
      await expect(
        buildGatewayUrl('ipfs', `ipfs://localhost/ipfs/${CIDV1_BASE32}/img.png`)
      ).resolves.toEqual({
        ok: true,
        url: `http://localhost:8080/ipfs/${CIDV1_BASE32}/img.png`,
      });
    });

    test('canonicalises an embedded CIDv0 to base32 for the upstream fetch', async () => {
      const expected = 'bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34';
      await expect(
        buildGatewayUrl('ipfs', `ipfs://localhost/ipfs/${CIDV0}/sub`)
      ).resolves.toEqual({
        ok: true,
        url: `http://localhost:8080/ipfs/${expected}/sub`,
      });
    });

    test('cross-namespace rewrite: ipfs://<gw>/ipns/<key>/path → IPNS branch', async () => {
      await expect(
        buildGatewayUrl('ipfs', `ipfs://localhost/ipns/docs.ipfs.tech/install`)
      ).resolves.toEqual({
        ok: true,
        url: 'http://localhost:8080/ipns/docs.ipfs.tech/install',
      });
    });

    test('canonicalises an embedded base58 IPNS peer ID to base36', async () => {
      const expected = 'k51qzi5uqu5dit2ibca2nikouuslvo21d3trnsklq7f1c3zdelrq38i7nahsgk';
      await expect(
        buildGatewayUrl('ipfs', `ipfs://localhost/ipns/${IPNS_KEY_BASE58_ED25519}/foo`)
      ).resolves.toEqual({
        ok: true,
        url: `http://localhost:8080/ipns/${expected}/foo`,
      });
    });

    test('preserves a CID host when path also begins with /ipfs/ (legitimate subdir)', async () => {
      await expect(
        buildGatewayUrl('ipfs', `ipfs://${CIDV1_BASE32}/ipfs/somefile`)
      ).resolves.toEqual({
        ok: true,
        url: `http://localhost:8080/ipfs/${CIDV1_BASE32}/ipfs/somefile`,
      });
    });

    test('still 400s when the gateway-form embeds garbage', async () => {
      await expect(
        buildGatewayUrl('ipfs', 'ipfs://localhost/ipfs/not-a-cid/file')
      ).resolves.toBeNull();
    });
  });

  describe('ENS hosts', () => {
    test('resolves .eth host via ENS resolver and proxies to the resolved CID', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'ok',
        protocol: 'ipfs',
        decoded: CIDV0,
        uri: `ipfs://${CIDV0}`,
        name: 'vitalik.eth',
      });

      await expect(
        buildGatewayUrl('ipfs', 'ipfs://vitalik.eth/page.html?v=1')
      ).resolves.toEqual({
        ok: true,
        url: `http://localhost:8080/ipfs/${CIDV0}/page.html?v=1`,
      });
      expect(mockResolveEnsContent).toHaveBeenCalledWith('vitalik.eth');
    });

    test('resolves .box host via ENS resolver', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'ok',
        protocol: 'ipfs',
        decoded: CIDV0,
        uri: `ipfs://${CIDV0}`,
      });

      await expect(buildGatewayUrl('ipfs', 'ipfs://myapp.box/')).resolves.toEqual({
        ok: true,
        url: `http://localhost:8080/ipfs/${CIDV0}/`,
      });
    });

    test('returns 404 when ENS contenthash is Swarm, not IPFS', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'ok',
        protocol: 'bzz',
        decoded: 'a'.repeat(64),
        uri: `bzz://${'a'.repeat(64)}`,
      });

      const result = await buildGatewayUrl('ipfs', 'ipfs://swarm.eth/');
      expect(result).toEqual({
        ok: false,
        status: 404,
        message: 'ENS name swarm.eth resolves to bzz, not IPFS',
      });
    });

    test('returns 404 when ENS contenthash is IPNS, not IPFS', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'ok',
        protocol: 'ipns',
        decoded: IPNS_KEY_BASE36,
        uri: `ipns://${IPNS_KEY_BASE36}`,
      });

      const result = await buildGatewayUrl('ipfs', 'ipfs://jalil.eth/');
      expect(result).toEqual({
        ok: false,
        status: 404,
        message: 'ENS name jalil.eth resolves to ipns, not IPFS',
      });
    });

    test('returns 404 when ENS name has no contenthash record', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'not_found',
        reason: 'NO_RESOLVER',
      });

      const result = await buildGatewayUrl('ipfs', 'ipfs://nothing.eth/');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(404);
      expect(result.message).toContain('nothing.eth');
      expect(result.message).toContain('NO_RESOLVER');
    });

    test('returns 415 when contenthash format is unsupported', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'unsupported',
        reason: 'UNSUPPORTED_CONTENTHASH_FORMAT',
        contentHash: '0xdeadbeef',
      });

      const result = await buildGatewayUrl('ipfs', 'ipfs://exotic.eth/');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(415);
    });

    test('returns 502 when providers disagree (conflict)', async () => {
      mockResolveEnsContent.mockResolvedValue({ type: 'conflict', groups: [] });

      const result = await buildGatewayUrl('ipfs', 'ipfs://contested.eth/');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(502);
      expect(result.message).toContain('disagree');
    });

    test('returns 502 when the resolver throws (RPC unreachable)', async () => {
      mockResolveEnsContent.mockRejectedValue(new Error('all RPC providers failed'));

      const result = await buildGatewayUrl('ipfs', 'ipfs://offline.eth/');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(502);
      expect(result.message).toContain('all RPC providers failed');
    });

    test('CID-shaped host short-circuits the ENS resolver', async () => {
      await buildGatewayUrl('ipfs', `ipfs://${CIDV0}/x`);
      expect(mockResolveEnsContent).not.toHaveBeenCalled();
    });

    test.each([['ipfs://.eth/'], ['ipfs://foo..eth/']])(
      'returns null for hosts with empty labels (%s)',
      async (url) => {
        await expect(buildGatewayUrl('ipfs', url)).resolves.toBeNull();
        expect(mockResolveEnsContent).not.toHaveBeenCalled();
      }
    );
  });
});

describe('buildGatewayUrl(ipns)', () => {
  beforeEach(() => {
    mockResolveEnsContent.mockReset();
  });

  test.each([
    ['libp2p key base36', IPNS_KEY_BASE36],
    ['libp2p key base58 Ed25519 (12D3…)', IPNS_KEY_BASE58_ED25519],
    ['DNSLink hostname', 'docs.ipfs.tech'],
  ])('converts ipns://<%s>/path to the Kubo gateway URL', async (_label, host) => {
    await expect(buildGatewayUrl('ipns', `ipns://${host}/install`)).resolves.toEqual({
      ok: true,
      url: `http://localhost:8080/ipns/${host}/install`,
    });
    expect(mockResolveEnsContent).not.toHaveBeenCalled();
  });

  test('preserves query string', async () => {
    await expect(
      buildGatewayUrl('ipns', `ipns://${IPNS_KEY_BASE36}/page?v=1`)
    ).resolves.toEqual({
      ok: true,
      url: `http://localhost:8080/ipns/${IPNS_KEY_BASE36}/page?v=1`,
    });
  });

  describe('ENS hosts', () => {
    test('routes ENS hosts to the resolver, not the raw IPNS branch', async () => {
      // jalil.eth is a valid IPNS hostname per the regex AND an ENS host —
      // the order of checks must prefer ENS so the contenthash gets resolved
      // rather than handed to Kubo as a literal DNSLink lookup.
      mockResolveEnsContent.mockResolvedValue({
        type: 'ok',
        protocol: 'ipns',
        decoded: IPNS_KEY_BASE58_ED25519,
        uri: `ipns://${IPNS_KEY_BASE58_ED25519}`,
        name: 'jalil.eth',
      });

      await expect(buildGatewayUrl('ipns', 'ipns://jalil.eth/')).resolves.toEqual({
        ok: true,
        url: `http://localhost:8080/ipns/${IPNS_KEY_BASE58_ED25519}/`,
      });
      expect(mockResolveEnsContent).toHaveBeenCalledWith('jalil.eth');
    });

    test('returns 404 when ENS contenthash is IPFS, not IPNS', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'ok',
        protocol: 'ipfs',
        decoded: CIDV0,
        uri: `ipfs://${CIDV0}`,
      });

      const result = await buildGatewayUrl('ipns', 'ipns://vitalik.eth/');
      expect(result).toEqual({
        ok: false,
        status: 404,
        message: 'ENS name vitalik.eth resolves to ipfs, not IPNS',
      });
    });

    test('returns 404 when ENS contenthash is Swarm, not IPNS', async () => {
      mockResolveEnsContent.mockResolvedValue({
        type: 'ok',
        protocol: 'bzz',
        decoded: 'a'.repeat(64),
      });

      const result = await buildGatewayUrl('ipns', 'ipns://swarm.eth/');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(404);
      expect(result.message).toContain('not IPNS');
    });
  });
});

describe('sanitizeRequestHeaders', () => {
  test('strips hop-by-hop and origin headers, leaves Range and Accept intact', () => {
    const input = new Headers({
      'User-Agent': 'test',
      Accept: 'text/html',
      Range: 'bytes=0-1023',
      Origin: 'ipfs://some-origin',
      Referer: 'ipfs://some-origin/page',
      Host: 'whatever',
      Connection: 'keep-alive',
      Cookie: 'session=secret',
      Authorization: 'Bearer token',
    });
    const out = sanitizeRequestHeaders(input);
    expect(out.get('User-Agent')).toBe('test');
    expect(out.get('Accept')).toBe('text/html');
    expect(out.get('Range')).toBe('bytes=0-1023');
    expect(out.has('Origin')).toBe(false);
    expect(out.has('Referer')).toBe(false);
    expect(out.has('Host')).toBe(false);
    expect(out.has('Connection')).toBe(false);
    expect(out.has('Cookie')).toBe(false);
    expect(out.has('Authorization')).toBe(false);
  });
});

describe('handleRequest', () => {
  beforeEach(() => {
    mockResolveEnsContent.mockReset();
  });

  const makeRequest = (url, { method = 'GET', headers = {} } = {}) => ({
    url,
    method,
    headers: new Headers(headers),
    body: null,
    signal: new AbortController().signal,
  });

  test('returns 400 for invalid ipfs refs without calling fetch', async () => {
    const fetchImpl = jest.fn();
    const res = await handleRequest('ipfs', makeRequest('ipfs://not-a-cid/'), { fetchImpl });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toBe('invalid ipfs reference');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('returns 400 for invalid ipns refs without calling fetch', async () => {
    const fetchImpl = jest.fn();
    const res = await handleRequest('ipns', makeRequest('ipns://!bad-host!/'), { fetchImpl });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toBe('invalid ipns reference');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('proxies a 200 through untouched (raw CID)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('hello', { status: 200 }));
    const res = await handleRequest('ipfs', makeRequest(`ipfs://${CIDV0}/file.txt`), {
      fetchImpl,
    });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe(`http://localhost:8080/ipfs/${CIDV0}/file.txt`);
    expect(init.method).toBe('GET');
    // The Kubo subdomain redirect must be followed inside this handler;
    // surfacing it to Chromium would re-introduce the gateway-origin bug.
    expect(init.redirect).toBe('follow');
  });

  test('resolves ENS-host ipfs URLs and proxies to the gateway', async () => {
    mockResolveEnsContent.mockResolvedValue({
      type: 'ok',
      protocol: 'ipfs',
      decoded: CIDV0,
      uri: `ipfs://${CIDV0}`,
    });
    const fetchImpl = jest.fn().mockResolvedValue(new Response('hi', { status: 200 }));

    const res = await handleRequest('ipfs', makeRequest('ipfs://vitalik.eth/index.html'), {
      fetchImpl,
    });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `http://localhost:8080/ipfs/${CIDV0}/index.html`
    );
  });

  test('resolves ENS-host ipns URLs and proxies to the gateway', async () => {
    mockResolveEnsContent.mockResolvedValue({
      type: 'ok',
      protocol: 'ipns',
      decoded: IPNS_KEY_BASE58_ED25519,
      uri: `ipns://${IPNS_KEY_BASE58_ED25519}`,
    });
    const fetchImpl = jest.fn().mockResolvedValue(new Response('hi', { status: 200 }));

    const res = await handleRequest('ipns', makeRequest('ipns://jalil.eth/'), { fetchImpl });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `http://localhost:8080/ipns/${IPNS_KEY_BASE58_ED25519}/`
    );
  });

  test('returns 404 with explanatory body when ipfs:// ENS host has Swarm contenthash', async () => {
    mockResolveEnsContent.mockResolvedValue({
      type: 'ok',
      protocol: 'bzz',
      decoded: 'a'.repeat(64),
    });
    const fetchImpl = jest.fn();

    const res = await handleRequest('ipfs', makeRequest('ipfs://swarm.eth/'), { fetchImpl });
    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.code).toBe(404);
    expect(body.message).toMatch(/resolves to bzz/);
  });

  test('returns 502 when the ENS resolver throws (no fetch issued)', async () => {
    mockResolveEnsContent.mockRejectedValue(new Error('rpc down'));
    const fetchImpl = jest.fn();

    const res = await handleRequest('ipfs', makeRequest('ipfs://offline.eth/x'), { fetchImpl });
    expect(res.status).toBe(502);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('passes 4xx and 5xx through to the page (no retry)', async () => {
    // Unlike the bzz handler, we don't retry transient 5xx — Kubo doesn't
    // have Bee's cold-content reliability characteristic, so 5xx surfaces
    // immediately and SPAs can fall back without a multi-second hang.
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 503 }));
    const res = await handleRequest('ipfs', makeRequest(`ipfs://${CIDV0}/x`), { fetchImpl });
    expect(res.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('passes 404 through to the page', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 404 }));
    const res = await handleRequest('ipfs', makeRequest(`ipfs://${CIDV0}/missing`), {
      fetchImpl,
    });
    expect(res.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('returns 503 when Kubo is unreachable (ECONNREFUSED)', async () => {
    const err = new Error('connect failed');
    err.code = 'ECONNREFUSED';
    const fetchImpl = jest.fn().mockRejectedValue(err);

    const res = await handleRequest('ipfs', makeRequest(`ipfs://${CIDV0}/x`), { fetchImpl });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.message).toBe('kubo gateway unreachable');
  });

  test('returns 502 for other fetch errors', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('something else'));

    const res = await handleRequest('ipfs', makeRequest(`ipfs://${CIDV0}/x`), { fetchImpl });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.message).toBe('kubo gateway error');
  });

  test('forwards POST body and uses duplex: half', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const body = 'payload';
    const req = {
      url: `ipfs://${CIDV0}/api`,
      method: 'POST',
      headers: new Headers({ 'Content-Type': 'text/plain' }),
      body,
      signal: new AbortController().signal,
    };

    const res = await handleRequest('ipfs', req, { fetchImpl });
    expect(res.status).toBe(200);
    const init = fetchImpl.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('payload');
    expect(init.duplex).toBe('half');
  });
});
