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

## Native Addon

Install the pinned `freedom-ipfs` native addon:

```sh
npm run ipfs:download
```

By default this downloads and verifies the macOS arm64 / Electron 41 addon from
the `freedom-ipfs` `v0.4.0` GitHub release:

```text
https://github.com/solardev-xyz/freedom-ipfs/releases/tag/v0.4.0
```

The output is staged in both places the app needs:

- `native/freedom-ipfs-node/build/Release/freedom_ipfs_native.node`
- `native/freedom-ipfs-node/prebuilds/mac-arm64/freedom_ipfs_native.node`

`build/Release` is the local development load path. `prebuilds/<target>` is the
Electron Builder packaging input, so cross-target builds cannot accidentally
reuse a `.node` file built for the host machine.

To build from a local Rust checkout instead, use:

```sh
npm run ipfs:build
```

Or point at a specific checkout:

```sh
FREEDOM_IPFS_RUST_REPO=/path/to/freedom-ipfs npm run ipfs:build
```

The checkout override is passed to both Cargo and node-gyp, so the addon links
against the same Rust static library that was just built.

The packaged app includes the `.node` addon via Electron Builder
`extraResources` from `native/freedom-ipfs-node/prebuilds/${os}-${arch}/`.

## Runtime Notes

- Kubo is not downloaded, launched, configured, or packaged on this branch.
- Existing local `ipfs-bin/` directories can remain on disk for other branches;
  they are not part of this branch's runtime path.
- Native node data is stored under `ipfs-data/freedom-ipfs/` in development (or
  the `freedom-ipfs/` child of `FREEDOM_IPFS_DATA` when that override is set).
- Vault-derived IPFS PeerID metadata is prepared for future native support, but
  it is not reported as the active native node identity until `freedom-ipfs`
  can consume an injected identity.
- `window.ipfs.getStatus()` now reports `freedom-ipfs` diagnostics, including
  native gateway stats, instead of polling Kubo's HTTP API.
- The protocol handler keeps the existing URL canonicalization rules but routes
  the final gateway path directly into the native node.

## Verification

Useful checks:

```sh
npm run ipfs:download
npm test
```

For a live smoke from Node, run with network access enabled:

```sh
node -e 'const { FreedomIpfsNativeNode } = require("./src/main/ipfs/freedom-ipfs-native-node"); (async()=>{ const n = new FreedomIpfsNativeNode({ dataDir: "/private/tmp/freedom-ipfs-desktop-smoke-" + Date.now() }); if (!n.start()) throw new Error("start failed"); try { const r = await n.request({ method: "GET", path: "/ipns/ipfs.tech/", headers: new Headers() }); console.log(r.status, (await r.text()).slice(0, 80), n.nativeGatewayStatsJson()); } finally { await n.stop(); } })().catch(e=>{ console.error(e); process.exit(1); });'
```
