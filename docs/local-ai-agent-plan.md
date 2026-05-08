# Local AI Agent — Integration Plan

Status: **Draft / pre-implementation.** This document captures the agreed-upon design for adding a local open-source AI assistant to Freedom. It is the source of truth for scope, architecture decisions, and phased delivery. Update it when scope or decisions change.

---

## Goals & scope

- A local-first AI assistant in Freedom, accessed from a new **left** sidebar ("Chat"), with persistent **Sessions**.
- The model runs **locally** (no external API calls in the default path), is downloaded once per device, and (later) is identified on-chain via an ENS name pointing at a Swarm hash.
- The assistant can call **tools** that go through the same main-process authority + per-origin permission pattern that `swarm-provider-ipc.js` and `dapp-permissions.js` already use:
  - **Phase 5:** control the active webview (navigate, read DOM/text, click, fill, screenshot).
  - **Phase 6:** wallet actions (send tx, sign) — reusing `wallet:send-transaction` etc.
  - **Phase 6:** Swarm uploads — reusing `swarm:provider-execute` + `publishData` / `publishFiles`.

### Out of scope

- Uploading model GGUFs to Swarm — performed outside Freedom. Freedom only **consumes** a Swarm hash + a small JSON catalog entry per model.
- Cloud / remote LLM providers in v1. Local-only by design; opt-in remote providers can ship as a separate, later work package.

---

## Architectural decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Local model runtime | **Ollama as managed sidecar** | Mirrors the existing Bee/IPFS/Radicle pattern (`ollama-bin/<platform>-<arch>/`, `ollama-data/`, `src/main/agent/ollama-manager.js` parallel to `bee-manager.js`). Cross-platform binary, OpenAI-compatible HTTP API on `127.0.0.1:11434`, GGUF models, native tool-calling. ~25 MB binary added to the package. |
| Browser automation | **Electron `webContents` APIs (no Puppeteer)** | Freedom *is* the Chromium host. `webContents.executeJavaScript`, `webContents.debugger.sendCommand` (CDP), `capturePage`, `sendInputEvent`, `loadURL` give us everything Puppeteer offers, with no extra process, no extra port, no extra binary. Driving the *active tab the user is looking at* is also more useful than driving a hidden browser. |
| Sidebar placement | **New left sidebar, separate from the existing right sidebar** | Right sidebar stays Wallet / Nodes / Settings. Left sidebar is the Agent (Chat + Sessions + sub-screens). Layout becomes `[left aside] [main content] [right aside]` inside `.app-body`. Default closed; toggle in the header (left of the address bar) and `Cmd/Ctrl+Shift+A`. |
| ENS Agent registration | **Skipped in v1** | Agents have a local name + UUID only. ENS becomes Phase 7. The data model leaves room (`agent.ensName: null`) so we don't refactor later. |
| Tool consent default | **Per-category per session** | First time the agent calls a `browser.read*` / `browser.write*` / `wallet.*` / `swarm.*` tool in a session, prompt; remember the choice for the rest of that session. Reset on session close. Per-agent policy lives in `agents.json` so power users can pre-approve. |
| Dependencies | **`undici` (latest stable) approved** | Used for streaming Ollama responses and the model GGUF download from `bzz://`. Nothing else added without explicit approval (per `AGENTS.md` rule 9). |
| Feature gate | **`enableLocalAgent: false`** in default settings, surfaced under Settings → Experimental | Mirrors `enableRadicleIntegration`. Whole feature ships dark by default and can be progressively enabled. |
| Module boundaries | **All new code under `src/main/agent/` and `src/renderer/lib/agent/`** | No top-level package boundary changes (per `docs/agent-playbooks/architecture-boundaries.md`). The agent is a *client* of existing wallet/swarm/identity modules through their IPC surfaces. |

---

## Module / file plan

All paths are new unless marked otherwise. Every `.js` module gets a neighbouring `.test.js` (per `AGENTS.md` rule 8).

### Main process — `src/main/agent/`

- `ollama-manager.js` — start/stop/status/checkBinary, port detection (default `127.0.0.1:11434`, fallback if busy), `service-registry.js` integration so the Nodes panel shows it. Mirrors `bee-manager.js` shape exactly.
- `model-store.js` — list installed models, install from `bzz://<hash>` via the existing protocol handler, hash-verify, persist `agent-models/index.json`. `delete(modelId)`. Progress events over IPC.
- `agent-registry.js` — `agents.json` in `identity-data/` (encrypted alongside vault when unlocked, plaintext for non-vault users). Fields:
  ```json
  {
    "id": "uuid",
    "name": "string",
    "modelId": "string",
    "systemPrompt": "string",
    "allowedTools": ["browser.read", "browser.write", "wallet", "swarm"],
    "ensName": null,
    "createdAt": "ISO-8601"
  }
  ```
- `chat-service.js` — Ollama HTTP client via `undici`, streaming completion, tool-call orchestration loop (model returns `tool_calls` → dispatch → append result → re-enter the loop until no more tool calls or hit cap).
- `sessions-store.js` — `better-sqlite3` (already a dep). Tables:
  - `agent_sessions(id, agent_id, title, created_at, updated_at)`
  - `agent_messages(id, session_id, role, content, tool_calls_json, tool_results_json, created_at)`

  Mirrors `history.js` patterns.
- `agent-permissions.js` — per-session, per-category consent cache. Mirrors `dapp-permissions.js` shape but session-scoped and not persisted by default.
- `agent-ipc.js` — single registration entry point, called from `src/main/index.js` next to the others.
- `tools/registry.js` — JSON Schema definitions + tool dispatcher; the schemas are also the payload sent to Ollama as `tools: [...]`.
- `tools/browser-tools.js` — drives the **active** webview's `webContents` from main:
  - `navigate(url)`, `getCurrentUrl()`
  - `readVisibleText()`, `readDom({selector})`
  - `click({selector})`, `fill({selector, value})`
  - `screenshot()`, `waitForSelector({selector, timeoutMs})`

  Resolves "active webview" through the existing tab/window registry.
- `tools/wallet-tools.js` — thin wrappers that re-enter the existing wallet IPC, so every transaction still surfaces in `dapp-tx.js` for explicit approval. The agent **proposes**; the user **approves**.
- `tools/swarm-tools.js` — wraps `publish-service.js`. Same: routes through the existing publish-approval prompt.

### Shared

- `src/shared/ipc-channels.js` (existing file, edit) — append `AGENT_*` block (chat send/stream, session CRUD, model install/list, agent CRUD, tool consent, ollama lifecycle).
- `src/shared/agent-tools.json` (new) — declarative tool catalog (id, category, JSON Schema, description). Single source of truth for renderer (tool-call cards) and main (validation + Ollama tool definitions).

### Renderer — `src/renderer/lib/agent/`

- `agent-sidebar.js` — left-sidebar shell mirroring `src/renderer/lib/sidebar.js` (open/close, feature-flag gate, keyboard shortcut, `settings:updated` reactivity).
- `agent-state.js` — current session, current agent, streaming state.
- `chat-ui.js` — message list, composer, streaming token rendering, tool-call cards (collapsible "agent navigated to X", "agent clicked Y", with consent prompts inline).
- `sessions-ui.js` — list/rename/delete sessions, "New chat", session search.
- `wizard.js` — multi-step setup, modelled on `publish-setup.js` (step list, polling, action buttons).
- `tool-consent.js` — in-sidebar consent modal + per-category caching.

### Renderer markup / CSS

- Add `<aside id="agent-sidebar" class="agent-sidebar collapsed">` to the **left** of `<main class="content">` in `src/renderer/index.html`, plus a header toggle button.
- New `src/renderer/styles/agent-sidebar.css` (separate file — matches the `sidebar.css` convention for the right sidebar).
- Adjust `app-body` layout to flex-row with the new left aside.

### Preload

- Extend `src/main/preload.js` with `contextBridge.exposeInMainWorld('agent', { … })` covering chat / sessions / models / agents / tools / permissions / ollama channels.

### Settings

- Add `enableLocalAgent: false` in default settings; expose toggle under Settings → Experimental (mirrors `enableRadicleIntegration`).

### Scripts

- `scripts/fetch-ollama.js` — same shape as `scripts/fetch-bee.js` / `scripts/fetch-ipfs.js`. Pulls latest Ollama binary per `{mac-arm64, mac-x64, linux-x64, linux-arm64, win-x64}` into `ollama-bin/<platform>-<arch>/`.
- `package.json` scripts (new): `ollama:download`, `ollama:start`, `ollama:stop`, `ollama:status`, `ollama:reset`.

### Build / packaging

- `extraResources` entry in `package.json` for `ollama-bin/${os}-${arch}/` (mirroring `bee-bin` and `ipfs-bin`).
- `.gitignore` entries for `ollama-bin/`, `ollama-data/`, `agent-models/`.

### Test harness

- Extend `src/main/test-harness.js` to stub `ollama-manager` (no real binary spawn), stub model downloads (return fixture GGUF metadata), and stub chat completions (deterministic canned responses with optional tool calls). All Playwright agent specs hit this stub.

### Documentation

- New section in `README.md` between "Integrated IPFS Kubo Node" and "Integrated Radicle Node": **"Local AI Agent (Beta)"** with capability description, gating instructions, and security notes.
- New playbook `docs/agent-playbooks/agent-feature.md` covering: tool-call consent invariants, the "agent never bypasses existing approval surfaces" rule, model-download integrity rules.

---

## Phased delivery

Each phase is independently shippable behind the `enableLocalAgent` flag.

| Phase | Scope | Outcome |
|---|---|---|
| **0** | `enableLocalAgent` flag + empty `src/main/agent/` skeleton + `agent-ipc.js` registered + preload bridge | Feature flag flips on/off, no UX yet |
| **1** | `scripts/fetch-ollama.js`, `ollama-manager.js`, Nodes-panel entry for Ollama, debug page `freedom://agent-debug` for raw chat against a small model the user can pull manually (e.g. `qwen3:0.6b`) | "I can chat with a local model from inside Freedom" |
| **2** | `model-store.js` with `bzz://` install + hash verification, `chat-service.js` with streaming, basic chat in the debug page | "I can install a model from a Swarm hash and stream tokens" |
| **3** | Left sidebar shell, Chat UI, Sessions UI, persistent SQLite, `enableLocalAgent` setting in Experimental | "Chat + Sessions in the proper sidebar, gated behind a flag" |
| **4** | Wizard (model picker → background download with progress → agent config: name, system prompt, allowed tool categories → done) | "First-run flow that ends with a working agent in the sidebar" |
| **5** | `browser-tools.js` + tool-call loop in `chat-service.js` + per-category consent UI + tool-call cards in chat | "Agent can browse for me with my consent" |
| **6** | `wallet-tools.js` + `swarm-tools.js` (both routing through existing approval surfaces) | "Agent can transact and upload, never bypassing my approval" |
| **7 (later)** | ENS Agent registration: pick subname under a Freedom-owned root vs. write to user-owned `.eth`, `contenthash` = model bzz hash, text records for system prompt + version. Add `agent.ensName` to registry, importable agents over ENS. | "Agent has a portable on-chain identity and can be shared by ENS name" |

Phases 0–2 give a working dev loop. Phases 3–4 give something demoable. Phase 5 is where it starts being useful as an agent. Phases 6–7 are the long-tail integrations.

---

## Mapping to original work-package notes

| Original note | Where it lands |
|---|---|
| Upload model to Swarm (outside Freedom) | Out of scope — Freedom only consumes Swarm hashes + a JSON catalog |
| Sidebar: Chat, Sessions | Phase 3 (sidebar shell + Chat UI + Sessions UI) |
| Wizard for download: model choice, register Agent via ENS while waiting | Phase 4 (wizard + model download). ENS registration **deferred to Phase 7** per the v1 scoping decision. |
| Local model execution environment | Phases 0–2 (Ollama sidecar + model store + chat service) |
| Browser control by model: Puppeteer | Phase 5 — implemented via Electron `webContents` APIs, **not** Puppeteer (see decision above) |

---

## Security & invariants (non-negotiable)

1. **No bypass of existing approval surfaces.** Wallet transactions proposed by the agent still pop the existing `dapp-tx` modal. Swarm publishes still pop the existing publish-approval modal. The agent is a client of those flows, not a replacement.
2. **Tool calls are validated in main.** The renderer surfaces consent UI and renders tool-call cards; the main process re-validates every call against `agent-tools.json` JSON Schemas before dispatching. Mirrors the trust model in `swarm-provider-ipc.js`.
3. **No silent network egress.** v1 ships with the local Ollama runtime only. Any future remote-provider integration is a separate, opt-in setting.
4. **Model integrity.** Models installed from `bzz://<hash>` are verified by re-hashing before being marked installed. The Swarm reference is the integrity root.
5. **Vault-aware identity.** Agent identities (and later ENS records) derive from the existing vault when available. No agent state requires the vault to be unlocked, but ENS-bound or wallet-using actions do.

---

## Open follow-ups

- **Model catalog format.** A small JSON file (`{ name, swarm_hash, size_bytes, recommended_ram_gb, license }`) — needs a hosting decision (in-repo? on Swarm? both?). Decide before Phase 4.
- **Curated model list.** Which 3–5 models ship as "recommended" in the wizard. Likely a small (~1B) and a medium (~7B) to start.
- **Phase 7 ENS shape.** Subname under a Freedom-owned root vs. user-owned `.eth` vs. both. Revisit after Phases 0–6 land.
- **Alternate runtimes (deferred).** [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM) (`.litertlm` format, MTP for >2× decode on Gemma 4, native multimodal) is architecturally compelling but doesn't ship a daemon today — its CLI is one-shot. When/if Google ships an HTTP server (or it becomes worth wrapping the C++ SDK), refactor `chat-service.js` to talk to a runtime interface (`start/stop/status/listModels/installModel/chat`) so `ollama-runtime.js` and `litertlm-runtime.js` can coexist behind a single contract. Keep `chat-service.js` boundaries clean enough now that this is a refactor, not a rewrite.
