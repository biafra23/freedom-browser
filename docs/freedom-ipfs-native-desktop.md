# Desktop freedom-ipfs Native Integration

This branch replaces the bundled Kubo process with the `freedom-ipfs` native
request/event API. Electron now serves `ipfs://` and `ipns://` resources through
an in-process Node native addon instead of forwarding every request to a
loopback HTTP gateway.

## Shape

```text
Electron protocol handler
  -> IpfsManager.serveNativeGatewayRequest()
  -> FreedomIpfsNativeNode
  -> freedom-ipfs C ABI
  -> GatewayCore
```

The Rust HTTP gateway still exists in the `freedom-ipfs` repo for CLI/debug and
third-party users. The desktop browser branch does not start it.

## Local Build

Build the Rust static library and Node addon:

```sh
npm run ipfs:native:build
```

This compiles:

- `../nodes/freedom-ipfs/target/release/libfreedom_ipfs_mobile.a`
- `native/freedom-ipfs-node/build/Release/freedom_ipfs_native.node`

The packaged app includes the `.node` addon via Electron Builder
`extraResources`.

## Runtime Notes

- Kubo is not downloaded, launched, configured, or packaged on this branch.
- Existing local `ipfs-bin/` directories can remain on disk for other branches;
  they are not part of this branch's runtime path.
- `window.ipfs.getStatus()` now reports `freedom-ipfs` diagnostics, including
  native gateway stats, instead of polling Kubo's HTTP API.
- The protocol handler keeps the existing URL canonicalization rules but routes
  the final gateway path directly into the native node.

## Verification

Useful checks:

```sh
npm run ipfs:native:build
npm test
```

For a live smoke from Node, run with network access enabled:

```sh
node -e 'const { FreedomIpfsNativeNode } = require("./src/main/ipfs/freedom-ipfs-native-node"); (async()=>{ const n = new FreedomIpfsNativeNode({ dataDir: "/private/tmp/freedom-ipfs-desktop-smoke-" + Date.now() }); if (!n.start()) throw new Error("start failed"); try { const r = await n.request({ method: "GET", path: "/ipns/ipfs.tech/", headers: new Headers() }); console.log(r.status, (await r.text()).slice(0, 80), n.nativeGatewayStatsJson()); } finally { await n.stop(); } })().catch(e=>{ console.error(e); process.exit(1); });'
```
