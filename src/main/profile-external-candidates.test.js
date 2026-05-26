const {
  DEFAULT_EXTERNAL_NODE_CANDIDATES,
  EXTERNAL_CANDIDATE_PROMPT_KEY,
  detectDefaultExternalCandidates,
  promptForDefaultExternalCandidates,
  shouldPromptForProtocol,
} = require('./profile-external-candidates');

function createProfile(nodes = {}) {
  return {
    id: 'default',
    displayName: 'Default',
    source: 'catalog',
    metadata: {
      nodes: {
        bee: { mode: 'managed' },
        ipfs: { mode: 'managed' },
        radicle: { mode: 'managed' },
        ...nodes,
      },
    },
  };
}

describe('profile external candidates', () => {
  test('detects compatible default-port nodes only for unprompted managed protocols', async () => {
    const profile = createProfile({
      ipfs: { mode: 'external', externalApi: 'http://127.0.0.1:5001' },
      radicle: {
        mode: 'managed',
        [EXTERNAL_CANDIDATE_PROMPT_KEY]: { choice: 'managed' },
      },
    });
    const probeEndpoint = jest.fn().mockResolvedValue(true);

    const candidates = await detectDefaultExternalCandidates(profile, {
      enabledProtocols: {
        bee: true,
        ipfs: true,
        radicle: true,
      },
      probeEndpoint,
    });

    expect(candidates.map((candidate) => candidate.protocol)).toEqual(['bee']);
    expect(probeEndpoint).toHaveBeenCalledWith(
      DEFAULT_EXTERNAL_NODE_CANDIDATES.bee.probes[0],
      expect.any(Object)
    );
  });

  test('skips disabled startup protocols during default-port detection', async () => {
    const profile = createProfile();
    const probeEndpoint = jest.fn().mockResolvedValue(true);

    const candidates = await detectDefaultExternalCandidates(profile, {
      enabledProtocols: {
        bee: false,
        ipfs: false,
        radicle: false,
      },
      probeEndpoint,
    });

    expect(candidates).toEqual([]);
    expect(probeEndpoint).not.toHaveBeenCalled();
  });

  test('persists external mode when the user chooses an existing default-port node', async () => {
    const profile = createProfile();
    const dialog = {
      showMessageBox: jest.fn().mockResolvedValue({ response: 0 }),
    };
    const updateNodeConfig = jest.fn();

    const decisions = await promptForDefaultExternalCandidates(profile, {
      dialog,
      enabledProtocols: {
        bee: true,
        ipfs: false,
        radicle: false,
      },
      logger: { info: jest.fn() },
      now: '2026-05-26T00:00:00.000Z',
      probeEndpoint: jest.fn().mockResolvedValue(true),
      updateNodeConfig,
    });

    expect(decisions).toEqual([
      {
        protocol: 'bee',
        choice: 'external',
        endpoints: ['http://127.0.0.1:1633'],
      },
    ]);
    expect(updateNodeConfig).toHaveBeenCalledWith('bee', {
      mode: 'external',
      externalApi: 'http://127.0.0.1:1633',
      [EXTERNAL_CANDIDATE_PROMPT_KEY]: {
        choice: 'external',
        checkedAt: '2026-05-26T00:00:00.000Z',
        endpoints: ['http://127.0.0.1:1633'],
      },
    });
  });

  test('persists managed choice without changing node mode', async () => {
    const profile = createProfile();
    const dialog = {
      showMessageBox: jest.fn().mockResolvedValue({ response: 1 }),
    };
    const updateNodeConfig = jest.fn();

    await promptForDefaultExternalCandidates(profile, {
      dialog,
      enabledProtocols: {
        bee: true,
        ipfs: false,
        radicle: false,
      },
      logger: { info: jest.fn() },
      now: '2026-05-26T00:00:00.000Z',
      probeEndpoint: jest.fn().mockResolvedValue(true),
      updateNodeConfig,
    });

    expect(updateNodeConfig).toHaveBeenCalledWith('bee', {
      [EXTERNAL_CANDIDATE_PROMPT_KEY]: {
        choice: 'managed',
        checkedAt: '2026-05-26T00:00:00.000Z',
        endpoints: ['http://127.0.0.1:1633'],
      },
    });
  });

  test('does not prompt outside catalog-managed profiles', () => {
    expect(shouldPromptForProtocol({ source: 'profile-dir' }, 'bee')).toBe(false);
    expect(shouldPromptForProtocol(createProfile({ bee: { mode: 'disabled' } }), 'bee')).toBe(
      false
    );
  });
});
