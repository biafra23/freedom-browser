const http = require('http');
const https = require('https');
const { updateActiveProfileNodeConfig } = require('./profile-resolver');

const EXTERNAL_CANDIDATE_PROMPT_KEY = 'externalCandidatePrompt';

const DEFAULT_EXTERNAL_NODE_CANDIDATES = {
  bee: {
    label: 'Swarm Bee',
    endpoints: ['http://127.0.0.1:1633'],
    externalConfig: {
      mode: 'external',
      externalApi: 'http://127.0.0.1:1633',
    },
    probes: [
      {
        url: 'http://127.0.0.1:1633/health',
        method: 'GET',
        expectJson: true,
      },
    ],
  },
  ipfs: {
    label: 'IPFS',
    endpoints: ['http://127.0.0.1:5001', 'http://localhost:8080'],
    externalConfig: {
      mode: 'external',
      externalApi: 'http://127.0.0.1:5001',
      externalGateway: 'http://localhost:8080',
    },
    probes: [
      {
        url: 'http://127.0.0.1:5001/api/v0/id',
        method: 'POST',
        expectJson: true,
      },
      {
        url: 'http://localhost:8080/',
        method: 'GET',
        acceptAnyHttpResponse: true,
      },
    ],
  },
  radicle: {
    label: 'Radicle',
    endpoints: ['http://127.0.0.1:8780'],
    externalConfig: {
      mode: 'external',
      externalHttp: 'http://127.0.0.1:8780',
    },
    probes: [
      {
        url: 'http://127.0.0.1:8780/',
        method: 'GET',
      },
    ],
  },
};

function getHttpClient(url) {
  return url.startsWith('https:') ? https : http;
}

function probeEndpoint(probe, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1000;
  return new Promise((resolve) => {
    const parsed = new URL(probe.url);
    const requestOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: probe.method || 'GET',
      headers: probe.method === 'POST' ? { 'Content-Length': 0 } : undefined,
      timeout: timeoutMs,
    };

    const req = getHttpClient(probe.url).request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (probe.acceptAnyHttpResponse) {
          resolve(true);
          return;
        }

        if (res.statusCode !== 200) {
          resolve(false);
          return;
        }

        if (!probe.expectJson) {
          resolve(true);
          return;
        }

        try {
          JSON.parse(data);
          resolve(true);
        } catch {
          resolve(false);
        }
      });
      res.resume();
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function shouldPromptForProtocol(profile, protocol) {
  const config = profile?.metadata?.nodes?.[protocol];
  return config?.mode === 'managed' && !config?.[EXTERNAL_CANDIDATE_PROMPT_KEY]?.choice;
}

async function detectDefaultExternalCandidates(profile, options = {}) {
  const candidates = [];
  const probe = options.probeEndpoint || probeEndpoint;
  const definitions = options.candidates || DEFAULT_EXTERNAL_NODE_CANDIDATES;

  for (const [protocol, definition] of Object.entries(definitions)) {
    if (options.enabledProtocols && options.enabledProtocols[protocol] === false) continue;
    if (!shouldPromptForProtocol(profile, protocol)) continue;

    const results = await Promise.all(
      definition.probes.map((candidateProbe) => probe(candidateProbe, options))
    );
    if (results.every(Boolean)) {
      candidates.push({
        protocol,
        ...definition,
      });
    }
  }

  return candidates;
}

function buildPromptMarker(choice, candidate, now = new Date().toISOString()) {
  return {
    choice,
    checkedAt: now,
    endpoints: candidate.endpoints,
  };
}

async function promptForDefaultExternalCandidates(profile, options = {}) {
  if (!profile || profile.source !== 'catalog') return [];

  const logger = options.logger || console;
  const dialog = options.dialog || require('electron').dialog;
  const updateNodeConfig = options.updateNodeConfig || updateActiveProfileNodeConfig;
  const candidates = await detectDefaultExternalCandidates(profile, options);
  const decisions = [];

  for (const candidate of candidates) {
    const profileName = profile.displayName || profile.id;
    const endpointText = candidate.endpoints.join(' and ');
    const result = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Use External Node', 'Keep Managed Node'],
      defaultId: 1,
      cancelId: 1,
      title: `Use existing ${candidate.label} node?`,
      message: `Freedom found an existing ${candidate.label} node at ${endpointText}.`,
      detail:
        `Use it for the "${profileName}" profile, or keep this profile independent ` +
        'with a Freedom-managed node on profile-specific ports.',
    });

    const choice = result.response === 0 ? 'external' : 'managed';
    const marker = buildPromptMarker(choice, candidate, options.now);
    const updates = choice === 'external'
      ? { ...candidate.externalConfig, [EXTERNAL_CANDIDATE_PROMPT_KEY]: marker }
      : { [EXTERNAL_CANDIDATE_PROMPT_KEY]: marker };

    updateNodeConfig(candidate.protocol, updates);
    decisions.push({
      protocol: candidate.protocol,
      choice,
      endpoints: candidate.endpoints,
    });
    logger.info?.('[profile] Default-port external node decision:', {
      protocol: candidate.protocol,
      choice,
      endpoints: candidate.endpoints,
    });
  }

  return decisions;
}

module.exports = {
  DEFAULT_EXTERNAL_NODE_CANDIDATES,
  EXTERNAL_CANDIDATE_PROMPT_KEY,
  buildPromptMarker,
  detectDefaultExternalCandidates,
  probeEndpoint,
  promptForDefaultExternalCandidates,
  shouldPromptForProtocol,
};
