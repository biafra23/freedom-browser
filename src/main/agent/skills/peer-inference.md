---
name: peer-inference
description: Offload inference to a willing peer in the Freedom Lobby (distributed-inference demo)
builtin: true
version: 1
risk: medium
---

# Peer inference (distributed inference over XMTP)

Use these tools when the user explicitly asks to **route inference to the
network** instead of running locally — phrases like "ask the network",
"ask the lobby", "use a peer", "demo distributed inference".

This is **not** a routing layer for normal chat. The local model handles
everyday turns. Only reach for these tools when the user invokes them.

## What's happening under the hood

Every Freedom install joins the global Freedom Lobby (an XMTP MLS group).
A Freedom user can flip a setting that turns their install into an
inference *provider* — once on, their browser silently serves any
inference request that arrives in a shared channel by running the
requested model through their local Ollama and replying.

Two tools cover the consumer side:

- `peer_list_providers` — broadcasts a probe, collects every reply for a
  short window, returns the list of providers + their installed models.
- `peer_run_inference` — broadcasts a prompt, returns the **first**
  matching reply (no quorum, no validation).

## Recipes

### Just ask the network and show the answer

The user said "ask the network what 2+2 is":

1. `peer_run_inference({ prompt: "What is 2+2?", reason: "user asked for distributed inference demo" })`.
2. Show the user the response, with attribution: "via 0x6eC4…82A2 in 4.2s".

`model: "*"` (default) means "any installed model on any responding peer".
The reply tells you which model was actually used.

### Discover who's online before asking

The user said "who's online to run inference?":

1. `peer_list_providers({ reason: "user asked who is online" })`.
2. Summarise: "3 providers online: Alice (gemma4:e2b, qwen3:4b), Bob
   (gemma4:e2b), Carol (phi3)."

If the list is empty, say so plainly — most users have the toggle off.

### Ask a specific model

The user said "ask the network for a qwen3:4b answer":

1. (Optional) `peer_list_providers` first to confirm someone has it.
2. `peer_run_inference({ prompt, model: "qwen3:4b", reason: "user requested qwen3:4b" })`.
3. If no one replies before the timeout, the tool throws — fall back to
   the local model with a note ("no peer with qwen3:4b replied within
   30s, answering locally instead").

## Safety / honesty notes

- **First-response-wins.** A malicious or buggy peer can return garbage.
  Always surface the provider's address so the user can see who answered.
  Do not treat the response as authoritative.
- **Prompts are public.** The lobby is a global group — every member
  sees every envelope. Don't route private content through here.
- **Latency is unpredictable.** A peer's reply depends on their machine,
  their model, their network. Default 30s timeout; raise via `timeoutMs`
  if you have reason to wait longer.
- **No payment, no reputation.** This is a demo of the primitive, not a
  market. A peer who runs your inference does it for free, and you have
  no recourse if they don't.

## When NOT to use these tools

- For normal chat turns (use the local model — that's what it's for).
- For sensitive prompts (private data, secrets, identity material).
- As a fallback for "the local model didn't know" — try search via
  navigate first.
- Inside subagents — these tools are main-agent-only.
