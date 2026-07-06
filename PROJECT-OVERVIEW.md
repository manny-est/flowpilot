# FlowPilot — Project Overview

FlowPilot is an AI-powered development assistant that lives in the Node-RED
editor sidebar. It talks to any OpenAI-compatible API (OpenAI, LocalAI,
Ollama, etc.) and helps you chat about, generate, modify, and document your
flows — always through Node-RED's own review and undo mechanisms, never
behind your back.

This document describes how FlowPilot was built and what it can do today.
For installation and provider setup, see [README.md](README.md).

## How it was built

FlowPilot grew through a sequence of phases, each adding one capability on
top of a stable foundation, with a working, reviewable build at every step:

- **Phase 1 — Foundation.** The sidebar plugin itself: an OpenAI-compatible
  provider connection, a settings UI for provider profiles, and a basic
  connectivity check.
- **Phase 2 — Context awareness.** FlowPilot reads the user's current node
  selection and its wiring, sanitizes it (stripping editor-internal fields
  and anything that looks like a credential), and sends that as context —
  only when the user has something selected, and only on request.
- **Phase 3 — Read-only copilot.** Chat, plus one-click "intent" buttons
  (Explain, Troubleshoot, Review, Suggest, and user-defined custom intents)
  that pre-fill the prompt box with a ready-to-edit instruction.
- **Phase 4 — Generate.** FlowPilot can produce a brand-new flow fragment
  from a plain-language description. The result is validated, laid out, and
  handed to Node-RED's own import mechanism — the user places it with one
  click and can undo it like any other paste.
- **Phase 5 — Modify.** FlowPilot can propose changes to the *selected*
  nodes — property edits, rewiring, additions, and removals — shown as a
  diff the user reviews and applies node-by-node, each as a native undo
  step.
- **Phase 6 — Conversation, memory, and streaming.** Multi-turn conversation
  history (capped and truncation-aware), per-conversation transcripts, a
  "Flight log" of past conversations, Recall (keyword search across past
  conversations), and SSE streaming for chat and generation responses.
- **Phase 6.5 — Polish.** Performance/audit metrics (timing, token usage),
  UI refinements, and groundwork for the agentic phase.
- **Phase 7 — Agentic tool-calling.** For providers that support
  tool/function calling, FlowPilot can autonomously call a small set of
  read-only tools (inspect a node, list flows, search the flow, check
  connections, read the Debug sidebar, get the current selection) to gather
  information *before* answering or proposing a change — an
  "explore-then-propose" loop, bounded by a step count and token ceiling,
  with a visible cost summary and a Stop button.
- **Phase 8 — Issue fixes and NR5 support.** Closed early user-reported
  issues (a stuck "streaming" indicator, missing wiring on some generated
  flows, an unconfigurable request timeout, an unexplained temperature
  setting), declared and verified Node-RED 5.x support, added "Preview
  JSON/debug" links so users can see exactly what a request will send, and
  an opt-out redaction toggle for local/private AI setups.
- **Phase 8.5 — Personality, an agentic build loop, a pop-out window, and
  group handling.** A captain-personality slider (separate from technical
  accuracy, which never changes), deterministic `/compact`/`/expand` label
  commands, and a `/build` command that closes FlowPilot's biggest
  remaining gap: a *visible, user-gated* build → deploy → attach debug
  output → review → fix loop, instead of generating a flow and never
  finding out if it works. A detached pop-out window mirrors the full
  cockpit in its own browser window for multi-monitor setups. FlowPilot can
  now also see and manage visual groups (create, extend, rename, ungroup),
  not just individual nodes.

Throughout, every phase preserved the same core guarantees: nothing is sent
without the user's selection or request, every proposed change is a
reviewable diff, and every applied change is a normal Node-RED undo step —
including every step of the `/build` loop and every group mutation.

## Current feature set

- **Chat** — a conversational copilot with selection context, conversation
  history, and optional live Debug-sidebar context attachment.
- **Query intents** — Explain, Troubleshoot, Review, Suggest, and
  user-defined custom buttons that pre-fill a ready-to-edit prompt.
- **Generate** — describe a flow in plain language and get a new set of
  nodes + wiring, reviewed and imported on your terms.
- **Modify** — select existing nodes, describe a change, and review a diff
  before applying (property changes, rewiring, additions, removals).
- **Document** — auto-generate a "Read Me" comment node summarizing a
  selection.
- **Recall & Flight log** — search and revisit past conversations; loading
  one rehydrates the chat and its memory.
- **Debug context attachment** — attach recent Node-RED Debug sidebar output
  to a request for troubleshooting.
- **Action chips** — when a chat reply describes a change the user could
  make, FlowPilot offers a one-click switch to Generate/Modify/Document with
  the request pre-filled.
- **Clarifying questions** — if an instruction is too vague to act on
  safely, FlowPilot asks ONE question (optionally with quick-reply options)
  instead of guessing.
- **Agentic exploration** — on providers with tool-calling support,
  FlowPilot can inspect the flow itself before answering or proposing a
  change.
- **Streaming replies** — SSE streaming for chat, generate, modify, and
  document.
- **Models dropdown** — fetch the provider's available models instead of
  typing a model name blind.
- **`/demo`** — a guided first request that walks through Generate end to
  end.
- **`/compact` / `/expand`** — instantly hide/restore the selected node(s)'
  labels, no AI round-trip.
- **`/build`** — a visible, user-gated build → deploy → attach debug output
  → review → fix loop for "make this actually work," bounded by a
  configurable iteration cap.
- **Group handling** — context includes a selected node's group membership;
  Generate/Build/Modify can create, extend, rename, and ungroup visual
  groups.
- **Personality slider** — adjustable captain-voice intensity (1-10) for
  conversational framing; technical content always stays plain.
- **Pop-out window** — the full cockpit (chat, action bar, status strip,
  slash commands) in a separate browser window.

## Architecture at a glance

- **`flowpilot.html`** — the editor-side plugin entry point: registers the
  sidebar panel and loads the shared client module below.
- **`lib/core/*.js`** — the shared client logic, split into focused fragments
  (redaction, history, markdown, selection-context, apply-review, modes, main,
  init) and assembled at request time by `lib/build-core-script.js` into one
  complete IIFE served at `/flowpilot/core.js`. Used by both the sidebar and
  the pop-out window so they stay in sync by construction. The pop-out's
  minimal page (`lib/popout/view.html`) loads this same assembled module and
  relays state to/from the main editor window over `postMessage`.
- **`flowpilot.js`** — the Node-RED runtime plugin: HTTP routes
  (`/flowpilot/*`), provider calls, response parsing/validation, and audit
  logging.
- **`lib/`** — system prompts (default/generation/document/modify/build/
  persona), the OpenAI-compatible provider adapter, and on-disk storage
  (settings, transcripts, audit log).
- **Storage** — FlowPilot keeps its own settings, audit log, and
  per-conversation transcripts under `<node-red-userDir>/flowpilot/`,
  separate from the plugin code itself.
