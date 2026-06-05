# Brief: runtime postage batch management in `antd` (bee/Freedom upload parity)

## Objective

Make the `antd` HTTP API behave like a real bee light node for Freedom's publish
flow: the browser buys a postage batch, sees it as usable, and uploads against it
— all at runtime, no restart, no startup `--postage-batch`.

## Current state (verified against `main`)

- `UploadRuntime` holds **one** issuer: `crates/ant-p2p/src/behaviour.rs:61` →
  `{ issuer: Mutex<StampIssuer>, stamp_key:[u8;32], batch_owner:[u8;20] }`. The
  node loop is passed `Option<UploadRuntime>` (single).
- Stamping happens in the node loop at `behaviour.rs:~1487` (PushChunk) and
  `:~1561` (PushSoc): `ant_postage::sign_stamp_bytes(&upload.stamp_key, &mut issuer, &addr)`.
  No batch selection.
- `ControlCommand::PushChunk`/`PushSoc` (`crates/ant-control/src/command.rs:144,154`)
  carry **no** batch id. (`UploadStart` already has `batch_id: Option<String>` for
  antctl jobs — follow that precedent.)
- Gateway uploads (`crates/ant-gateway/src/retrieval.rs`:
  `upload_chunk/upload_soc/upload_bytes/upload_bzz`) send `PushChunk` with no batch
  id; error path keys on `"uploads not configured"`.
- `POST /stamps/{amount}/{depth}` → `chain::buy_stamp`
  (`crates/ant-gateway/src/chain.rs`) calls `ChainWriter::buy_batch` and returns
  `batchID` but **never registers an issuer** for it. `topup`/`dilute` similarly
  only touch chain.
- `GET /node` reports `beeMode:"light"` only when
  `handle.light_mode == upload.is_some()` (`crates/ant-gateway/src/status.rs:81`).
  Freedom's `checkSwarmPreFlight` refuses to publish on `ultra-light`.
- `GET /stamps` lists only the one configured batch with placeholders
  (`amount:"0"`, fixed TTL) via `ControlCommand::PostageStatus`
  (`crates/ant-gateway/src/stamps.rs`).
- `build_upload_runtime` (`crates/antd/src/main.rs`) builds the single issuer at
  startup from `--postage-batch/--postage-owner-key/--gnosis-rpc-url`, cross-checks
  owner == batch owner, opens `StampIssuer` at `<data-dir>/postage/<batch>.bin`.

**Good news (already present):**

- `StampIssuer` `.bin` persists `batch_depth/bucket_depth/immutable` in its header
  (`crates/ant-postage/src/lib.rs:24-31`); batch id is the filename. So
  restart-reload = rescan `<data-dir>/postage/*.bin` + `StampIssuer::open`. No
  sidecar needed.
- All on-chain primitives exist in `crates/ant-chain/src/tx.rs`: `create_batch`,
  `top_up`, `increase_depth`, `deploy_chequebook`, `erc20_transfer`, plus
  `BatchCreated.batchId` extraction.

## Design

The node wallet owns every batch it buys, so **one `stamp_key` (= node
`signing_secret`), many issuers**. Convert the single issuer to a registry.

1. **`UploadRuntime` → batch registry** (`ant-p2p/src/behaviour.rs`)

   ```rust
   pub struct UploadRuntime {
       pub issuers: std::sync::Mutex<HashMap<[u8;32], StampIssuer>>,
       pub stamp_key: [u8;32],     // node wallet key — owner of all node-bought batches
       pub batch_owner: [u8;20],
       pub postage_dir: PathBuf,   // to open new issuers at runtime
   }
   ```

   Stamping sites select `issuers.get(&batch_id)`; if absent →
   `ControlAck::Error{ "batch <id> not usable" }`. `PostageStatus` handler →
   return a list (one view per issuer).

2. **Thread `batch_id` through the push commands** (`ant-control/src/command.rs`)

   Add `batch_id: [u8;32]` to `PushChunk` and `PushSoc` (and the internal
   bytes/bzz chunk pushes). Bump the control protocol if it's versioned.

3. **Add a runtime-register command** (`ant-control` + node loop)

   `ControlCommand::RegisterBatch { batch_id:[u8;32], depth:u8, bucket_depth:u8, immutable:bool, ack }`.
   Handler: `StampIssuer::open_or_new(postage_dir/<id>.bin, batch_id, depth, bucket_depth, immutable)`
   → insert into the map → ack. (Idempotent: re-register = reopen existing `.bin`.)

4. **Wire buy → register** (`ant-gateway/src/chain.rs::buy_stamp`)

   After `w.buy_batch(amount, depth, immutable)` returns `batch_id`, send
   `RegisterBatch{ batch_id, depth, bucket_depth: <same constant the create_batch tx uses, bee = 16>, immutable }`
   over `handle.commands` **before** returning `201`. `bucket_depth` must equal
   what `create_batch` used or stamps won't validate. Do the same for
   `topup`/`dilute` (update the live issuer's depth/balance). `GatewayHandle`
   already carries `commands`.

5. **Per-batch stamping on upload** (`ant-gateway/src/retrieval.rs`)

   Parse the `Swarm-Postage-Batch-Id` header (case-insensitive, 32-byte hex) in
   `upload_chunk/upload_soc/upload_bytes/upload_bzz`, decode, and pass to the push
   commands (thread through the bytes/bzz chunkers, which fan out to many
   `PushChunk`s). Missing/invalid header → `400` (bee shape); unknown batch →
   `400` "batch not usable".

6. **Decouple `beeMode=light` from a startup batch** (`antd/src/main.rs` +
   `ant-gateway/src/status.rs`)

   - Always build `UploadRuntime` when the node can stamp (i.e. a
     `ChainWriter`/RPC is configured), with `stamp_key = signing_secret`,
     `batch_owner = node eth`, empty map, **and reload persisted issuers** by
     scanning `<data-dir>/postage/*.bin`.
   - Set `light_mode = (chain writer present)` — i.e. `blockchain-rpc-endpoint`
     configured — not `upload.is_some()`. Keep `chequebookEnabled`/`swapEnabled`
     tracking it.
   - Keep `--postage-batch` working as a pre-registered batch (back-compat for
     operators).

7. **`/stamps` accuracy** (`ant-gateway/src/stamps.rs`)

   List **all** registered batches (iterate the map). Fill `amount` (per-chunk
   balance) and `batchTTL` from chain when RPC is available; keep placeholders
   otherwise.

8. **Chequebook auto-bootstrap for sustained uploads** (`antd/src/main.rs`) —
   *bee-parity, heaviest, can be a second change*

   bee auto-deploys + funds a chequebook on first light start. On light-mode start
   with no chequebook configured and a funded wallet:
   `deploy_chequebook(factory, issuer = node EOA)` → `erc20_transfer` xBZZ to fund
   it → build `pushsync_swap_cfg` from it + `signing_secret`. Without this, uploads
   stall after a few hundred chunks/peer (see the existing warning in `main.rs`).
   Small uploads work without it; large ones don't.

## Edge cases / notes

- All batches are node-owned → single `stamp_key`. Reject header batch ids not in
  the registry (don't try foreign-owned batches).
- `bucket_depth` constant must be identical between `create_batch` (chain) and
  `RegisterBatch` (issuer) — bee uses 16; reuse whatever `ChainWriter::buy_batch`
  passes.
- Chain indexing lag: don't chain-read the batch back right after buy; construct
  the issuer from the known `(depth, bucket_depth=16, immutable)` buy params.
- Funding precondition (not code): node wallet needs xDAI (gas) + xBZZ
  (postage/chequebook). Freedom already has top-up flows for that wallet.

## Acceptance (how Freedom/bee-js exercises it)

1. Start antd with `blockchain-rpc-endpoint` set + funded wallet → `GET /node` →
   `beeMode:"light"`.
2. `POST /stamps/{amount}/{depth}` → `201 {batchID}`; within seconds `GET /stamps`
   lists it `usable:true`; `GET /stamps/{id}` returns it.
3. `POST /bzz` (or `/bytes`) with header `Swarm-Postage-Batch-Id: <batchID>` →
   `201 {reference}`; `GET /bzz/<reference>` returns the content.
4. Restart antd → `GET /stamps` still lists the batch (rescan persistence).
5. Upload a few MB → completes (chequebook/SWAP working — task 8).

Freedom's calls to target: pre-flight `GET /node` + `GET /stamps` + `GET /wallet`
+ `GET /chequebook/*`; buy via bee-js `createPostageBatch` →
`POST /stamps/{amount}/{depth}`; upload via bee-js `uploadData/uploadFile` →
`POST /bytes|/bzz` + `Swarm-Postage-Batch-Id`.
