const net = require('net');
const { parseSocksEndpoint } = require('../shared/socks-endpoint');

function probeSocks5Endpoint(endpoint, options = {}) {
  const parsed = parseSocksEndpoint(endpoint);
  if (!parsed) return Promise.resolve(false);

  const timeoutMs = options.timeoutMs ?? 1000;
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      // SOCKS5 greeting: version 5, one auth method, no-auth.
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    socket.on('data', (chunk) => {
      finish(chunk.length >= 2 && chunk[0] === 0x05 && chunk[1] !== 0xff);
    });
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
    socket.connect(parsed.port, parsed.host);
  });
}

module.exports = {
  probeSocks5Endpoint,
};
