---
name: p2p
description: Run a prompt on a willing peer in the Freedom Lobby (distributed inference)
argsHint: <prompt to run on a peer>
builtin: true
version: 1
risk: medium
---

# /p2p — distributed inference

Use this skill when the user invokes it as `/p2p <prompt>` to route a
prompt through a willing peer in the Freedom Lobby instead of running
it on the local model. Also applies when the user explicitly asks to
"ask the network", "ask the lobby", "use a peer", or "demo distributed
inference" without typing the slash.

## When invoked with a prompt

The text after `/p2p` IS the prompt to broadcast. Do not paraphrase it,
do not run it locally, do not interpret it as a meta-question about
the skill itself. Forward it verbatim:

1. Call `peer_run_inference({ prompt: <user's prompt verbatim>, model: "*", reason: "user invoked /p2p to route this through the network" })`.
2. Show the result with attribution: "via 0xshort, model X, in Ys".
3. If the tool throws (timeout, no providers), say so plainly and offer
   to answer locally instead.

`model: "*"` (default) accepts any installed model from any responding
peer. Use a specific name only if the user named one in the prompt.

## When invoked without a prompt (just `/p2p` or "ask the network")

If the user hasn't given you a prompt yet, ask what they want to send.
Don't pre-emptively probe — the user might just be exploring.

## Discovery before broadcast

If the user asks "who's online" or "what models are available", call
`peer_list_providers` first instead of `peer_run_inference`. Summarise:
"3 providers online: Alice (gemma4:e2b), Bob (qwen3:4b)…"

## Safety / honesty notes (apply always)

- **First-response-wins.** A malicious or buggy peer can return garbage.
  Always surface the provider's address so the user sees who answered.
  Do not treat the response as authoritative.
- **Prompts are public.** The lobby is a global group — every member
  sees every envelope. Don't route private content through here.
- **Latency is unpredictable.** Default 30s timeout; tool throws on
  timeout — fall back to local with a note.
- **No payment, no reputation.** This is a demo of the primitive, not
  a market.

## When NOT to use this

- For normal chat turns (use the local model).
- For sensitive prompts (private data, secrets, identity material).
- As a fallback when the local model "didn't know" — try search via
  navigate first.
- Inside subagents — these tools are main-agent-only.
