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
// Canonical CIDv1 base32 (`bafy...`) form of `CIDV0`; used to assert that
// the handler converts mixed-case CIDv0 hosts before forwarding to Kubo.
const CIDV0_AS_BASE32 = 'bafybeie5nqv6kd3qnfjupgvz34woh3oksc3iau6abmyajn7qvtf6d2ho34';
const CIDV1_BASE32 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const CIDV1_BASE58 = 'zb2rhe5P4gXftAwvA4eXQ5HJwsER2owDyS9sKaQRRVQPn93bA';
// Canonical CIDv1 base32 (`bafk…` raw) form of `CIDV1_BASE58`; used to
// assert that the handler converts mixed-case `z…` hosts before forwarding
// to Kubo (base58btc is case-sensitive and Chromium lowercases standard-
// scheme hosts, so re-encoding to lowercase-canonical base32 is the only
// way to round-trip cleanly).
const CIDV1_BASE58_AS_BASE32 = 'bafkreidon73zkcrwdb5iafqtijxildoonbwnpv7dyd6ef3qdgads2jc4su';
// CIDv1 base58btc with a multi-byte varint codec (dag-json = 0x0129,
// encoded as varint `0xa9 0x02`). Confirms the handler canonicalises
// codecs that don't fit in a single varint byte. Reference value
// generated with `multiformats`: CID.createV1(0x0129, sha256.digest('hello world')).
const CIDV1_BASE58_DAGJSON = 'z4EBG9jCb6wv7WCTz9NvmkQ5czYGEUZQgWFijgDTUqbD7aftapg';
const CIDV1_BASE58_DAGJSON_AS_BASE32 =
  'baguqeeraxfgspomtju7arjjokll5u7nl7lcij37dpjjyb3uqrd32zyxpzxuq';
const IPNS_KEY_BASE36 = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const IPNS_KEY_BASE58_ED25519 = '12D3KooWGuQafLgPqRRRkRSUNqZNQwL2gMZcQ27GiNpoVxz3vMWj';

describe('buildGatewayUrl(ipfs)', () => {
  beforeEach(() => {
    mockResolveEnsContent.mockReset();
  });

  test.each([
    // CIDv1 base32 is already lowercase-canonical and passes through.
    ['CIDv1 base32 (baf…)', CIDV1_BASE32, CIDV1_BASE32],
    // CIDv1 base58btc (`z…`) is case-sensitive — the handler converts it
    // to base32 so Chromium's host-lowercasing doesn't corrupt it on
    // subsequent sub-resource fetches that bypass the renderer.
    ['CIDv1 base58btc (z…) → base32', CIDV1_BASE58, CIDV1_BASE58_AS_BASE32],
    // Multi-byte-varint codec (dag-json) — verifies that the handler
    // doesn't false-reject CIDs with codec/multihash codes larger than
    // 0x7f (ie. anything not fitting in a single varint byte).
    [
      'CIDv1 base58btc dag-json (multi-byte varint) → base32',
      CIDV1_BASE58_DAGJSON,
      CIDV1_BASE58_DAGJSON_AS_BASE32,
    ],
  ])('converts ipfs://<%s>/path to the Kubo gateway URL', async (_label, host, expected) => {
    await expect(buildGatewayUrl('ipfs', `ipfs://${host}/index.html`)).resolves.toEqual({
      ok: true,
      url: `http://localhost:8080/ipfs/${expected}/index.html`,
    });
    expect(mockResolveEnsContent).not.toHaveBeenCalled();
  });

  test('rejects a lowercased CIDv1 base58btc (z…) host with a clear 400', async () => {
    // Same Chromium-normalisation story as the CIDv0 case below — base58btc
    // is case-sensitive, and once the host segment has been lowercased the
    // original bytes are unrecoverable. Surface a 400 with an actionable
    // message rather than forwarding garbage to Kubo.
    const result = await buildGatewayUrl(
      'ipfs',
      `ipfs://${CIDV1_BASE58.toLowerCase()}/page`
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.message).toMatch(/lowercased CIDv1 base58btc/);
    expect(result.message).toMatch(/CIDv1 base32/);
  });

  // Inputs that arrive *via the JS surface* (eg. unit tests, internal IPC)
  // can carry mixed-case CIDv0; in practice Chromium has already lowercased
  // the host before the handler runs (see the standard-scheme covered below).
  // Either way, the handler converts the recoverable form to CIDv1 base32
  // before forwarding to Kubo.
  test('canonicalises a properly-cased CIDv0 host to CIDv1 base32', async () => {
    await expect(buildGatewayUrl('ipfs', `ipfs://${CIDV0}/index.html`)).resolves.toEqual({
      ok: true,
      url: `http://localhost:8080/ipfs/${CIDV0_AS_BASE32}/index.html`,
    });
  });

  test('rejects a lowercased CIDv0 host with a clear 400 (the original case is unrecoverable)', async () => {
    // This is the request shape that actually arrives at the handler from
    // sub-resource fetches like `<img src="ipfs://Qm.../">` or
    // `fetch('ipfs://Qm.../')` — Chromium parses the URL with WHATWG rules
    // for standard schemes and lowercases the host segment before
    // protocol.handle is invoked. We can't recover the original CIDv0
    // bytes, so we 400 ourselves rather than forwarding a guaranteed-bad
    // reference to Kubo (whose 400 message is less actionable).
    const result = await buildGatewayUrl(
      'ipfs',
      `ipfs://${CIDV0.toLowerCase()}/page`
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.message).toMatch(/lowercased CIDv0/);
    expect(result.message).toMatch(/CIDv1 base32/);
  });

  test('preserves query string and drops fragment (Chromium never sends it)', async () => {
    await expect(buildGatewayUrl('ipfs', `ipfs://${CIDV0}/page?v=1`)).resolves.toEqual({
      ok: true,
      url: `http://localhost:8080/ipfs/${CIDV0_AS_BASE32}/page?v=1`,
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

    test.each([
      ['localhost', 'localhost'],
      ['127.0.0.1', '127.0.0.1'],
      ['dweb.link (public gateway)', 'dweb.link'],
      ['ipfs.io (public gateway)', 'ipfs.io'],
      ['cf-ipfs.com (public gateway)', 'cf-ipfs.com'],
    ])(
      'rewrites ipfs://<%s>/ipfs/<cidv1>/<path> to use the embedded CID',
      async (_label, gatewayHost) => {
        await expect(
          buildGatewayUrl('ipfs', `ipfs://${gatewayHost}/ipfs/${CIDV1_BASE32}/img.png`)
        ).resolves.toEqual({
          ok: true,
          url: `http://localhost:8080/ipfs/${CIDV1_BASE32}/img.png`,
        });
      }
    );

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
        buildGatewayUrl('ipfs', `ipfs://localhost/ipns/${IPNS_KEY_BASE36}/install`)
      ).resolves.toEqual({
        ok: true,
        url: `http://localhost:8080/ipns/${IPNS_KEY_BASE36}/install`,
      });
    });

    test('does NOT rewrite when outer host is a DNSLink target (not a known gateway)', async () => {
      // A DNSLink site that genuinely publishes a literal `/ipfs/coverage`
      // path is more plausible than a cross-namespace gateway-form URL
      // with `coverage` as the CID. The disambiguation is on the OUTER
      // host: only known public gateways / loopback hosts trigger the
      // rewrite. `docs.ipfs.tech` isn't in the gateway list so the path
      // passes through unchanged for Kubo to resolve as a DNSLink path.
      await expect(
        buildGatewayUrl('ipns', 'ipns://docs.ipfs.tech/ipfs/coverage')
      ).resolves.toEqual({
        ok: true,
        url: 'http://localhost:8080/ipns/docs.ipfs.tech/ipfs/coverage',
      });
    });

    test('rewrites ipfs://<gw>/ipns/<dnslink-name>/path → IPNS branch with DNSLink host', async () => {
      // P3 from the round-3 review: with the outer host being a known
      // public gateway, the `/ipns/<dnslink-name>` shape is unambiguously
      // the gateway-form for a DNSLink target, not a literal `/ipns/`
      // path on a content host.
      await expect(
        buildGatewayUrl('ipfs', 'ipfs://dweb.link/ipns/docs.ipfs.tech/install')
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

    test('canonicalises an embedded CIDv1 base58btc (z…) ref to base32', async () => {
      // The renderer-side pipeline strips this case before we see it for
      // top-level navigation, but sub-resource <img>/<fetch> can land
      // here with the `z…` form intact (case-preserved by the path
      // segment of the standard-scheme URL).
      await expect(
        buildGatewayUrl('ipfs', `ipfs://localhost/ipfs/${CIDV1_BASE58}/img.png`)
      ).resolves.toEqual({
        ok: true,
        url: `http://localhost:8080/ipfs/${CIDV1_BASE58_AS_BASE32}/img.png`,
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

    test('does NOT rewrite for unknown self-hosted gateways (conservative allowlist)', async () => {
      // Self-hosted private gateways aren't in the allowlist — the
      // alternative (rewriting any non-CID host) over-fires on DNSLink
      // sites. Authors of self-hosted gateways can publish canonical
      // `ipfs://<cid>/...` URLs directly.
      await expect(
        buildGatewayUrl('ipfs', `ipfs://my-gateway.example/ipfs/${CIDV1_BASE32}`)
      ).resolves.toBeNull();
    });

    test('still 400s when the gateway-form embeds garbage under /ipfs/', async () => {
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
    ['libp2p key base36', IPNS_KEY_BASE36, IPNS_KEY_BASE36],
    ['DNSLink hostname', 'docs.ipfs.tech', 'docs.ipfs.tech'],
  ])(
    'converts ipns://<%s>/path to the Kubo gateway URL',
    async (_label, host, expected) => {
      await expect(buildGatewayUrl('ipns', `ipns://${host}/install`)).resolves.toEqual({
        ok: true,
        url: `http://localhost:8080/ipns/${expected}/install`,
      });
      expect(mockResolveEnsContent).not.toHaveBeenCalled();
    }
  );

  test('canonicalises a properly-cased base58btc IPNS peer ID host to libp2p-key base36', async () => {
    const expected = 'k51qzi5uqu5dit2ibca2nikouuslvo21d3trnsklq7f1c3zdelrq38i7nahsgk';
    await expect(
      buildGatewayUrl('ipns', `ipns://${IPNS_KEY_BASE58_ED25519}/install`)
    ).resolves.toEqual({
      ok: true,
      url: `http://localhost:8080/ipns/${expected}/install`,
    });
  });

  test('rejects a lowercased base58btc IPNS host with a clear 400', async () => {
    // Same Chromium-normalisation story as the CIDv0 case under ipfs://.
    const result = await buildGatewayUrl(
      'ipns',
      `ipns://${IPNS_KEY_BASE58_ED25519.toLowerCase()}/install`
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.message).toMatch(/lowercased base58btc IPNS/);
    expect(result.message).toMatch(/libp2p-key base36/);
  });

  test('canonicalises a properly-cased CIDv1 base58btc (z…) IPNS host to base32', async () => {
    // IPNS keys can be published as CIDv1 base58btc with the libp2p-key
    // codec. Same Chromium-lowercasing problem as the IPFS z… case.
    await expect(
      buildGatewayUrl('ipns', `ipns://${CIDV1_BASE58}/install`)
    ).resolves.toEqual({
      ok: true,
      url: `http://localhost:8080/ipns/${CIDV1_BASE58_AS_BASE32}/install`,
    });
  });

  test('rejects a lowercased CIDv1 base58btc (z…) IPNS host with a clear 400', async () => {
    const result = await buildGatewayUrl(
      'ipns',
      `ipns://${CIDV1_BASE58.toLowerCase()}/install`
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.message).toMatch(/lowercased CIDv1 base58btc IPNS/);
    expect(result.message).toMatch(/libp2p-key base36/);
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

  test('proxies a 200 through untouched (raw CIDv1 base32)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('hello', { status: 200 }));
    const res = await handleRequest(
      'ipfs',
      makeRequest(`ipfs://${CIDV1_BASE32}/file.txt`),
      { fetchImpl }
    );
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe(`http://localhost:8080/ipfs/${CIDV1_BASE32}/file.txt`);
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
