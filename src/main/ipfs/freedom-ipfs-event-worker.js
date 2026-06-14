const { parentPort, workerData } = require('worker_threads');
const { loadNativeBinding } = require('./freedom-ipfs-native-binding');

const native = loadNativeBinding();
const nodeHandle = workerData.nodeHandle;
const timeoutMs = Number(workerData.timeoutMs || 250);

let stopped = false;

parentPort.on('message', (message) => {
  if (message?.type === 'stop') {
    stopped = true;
  }
});

function postEvent(event) {
  parentPort.postMessage({
    type: 'event',
    event: {
      status: event.status,
      events: event.events,
      requestHandle: event.requestHandle.toString(),
    },
  });
}

function loop() {
  if (stopped) {
    parentPort.postMessage({ type: 'stopped' });
    return;
  }

  try {
    const event = native.gatewayWaitNextEvent(nodeHandle, timeoutMs);
    postEvent(event);
  } catch (err) {
    parentPort.postMessage({
      type: 'error',
      error: err?.message || String(err),
    });
    return;
  }

  setTimeout(loop, 0);
}

loop();
