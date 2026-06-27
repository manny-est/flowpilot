# FlowPilot for Node-RED

Package: `@manny-est/node-red-flowpilot`

FlowPilot: AI assistance for Node-RED, designed for builders who want help
without giving up control.

FlowPilot is an AI-powered development assistant that lives in the Node-RED
editor sidebar. It talks to any OpenAI-compatible API (OpenAI, LocalAI,
Ollama, etc.) and helps you generate, modify, document, and discuss your
flows — without ever acting behind your back.

![FlowPilot sidebar](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/sidebar-chat-overview.png)

▶ [Watch a full walkthrough](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/full-intro-demo.mp4) (MP4, ~30MB) — first launch, setting a provider, `/help`, and `/demo`.

See [PROJECT-OVERVIEW.md](PROJECT-OVERVIEW.md) for how FlowPilot was built
and a full rundown of its features, or [USER-GUIDE.md](USER-GUIDE.md) for
installation, the sidebar UI, and a chapter on every feature.

## Design principles

- **Reuse Node-RED** — built on native capabilities (undo, import, deploy,
  selection, events) instead of parallel systems.
- **User-initiated only** — FlowPilot never changes your flow without an
  explicit request.
- **Complete visibility** — every proposed change is shown as a diff/review
  before anything is applied.
- **Undo first** — every change goes through Node-RED's native undo
  (Ctrl+Z), including multi-part changes (insertions + rewires + new nodes)
  as a single step.
- **Open architecture** — provider-agnostic, OpenAI-compatible REST. No
  lock-in to one AI platform.
- **Simple and lightweight** — favors simple, maintainable solutions over
  speculative complexity.

## Privacy & data

FlowPilot sends data to an AI provider only when **you** trigger a request —
nothing happens in the background. When you do, it sends the context you've
given it: your selected nodes and their wiring, any debug messages you've
attached, and your conversation history.

Before anything is sent, that context is sanitized: editor-internal fields are
stripped, and values that look like secrets (credentials, tokens, API keys,
auth headers) are redacted. Node-RED's separate credential store is never
included. A warning (⚠) appears in the status strip when a selection might
still contain sensitive configuration or code, so you can review before
sending.

Because your flow contents leave your Node-RED instance when you send a
request, a **local or private AI provider (LocalAI, Ollama, etc.) is
recommended for sensitive or proprietary flows**. You choose the provider, and
nothing is sent anywhere you didn't configure.

See the [User Guide](USER-GUIDE.md#privacy-and-safety) for the full details.

## Features

- **Chat** — a read-only copilot that can see your selected nodes and their
  connections, with multi-turn conversation memory.
- **Generate** — describe a flow in plain language and get a new set of
  nodes + wiring, reviewed and imported on your terms.
- **Modify** — select existing nodes, describe a change, and review a diff
  before applying (property changes, rewiring, additions, removals).
- **Document** — auto-generate a "Read Me" comment node summarizing a
  selection.
- **Review / Suggest / custom intents** — ask FlowPilot to critique or
  suggest improvements to a selection.
- **Conversational memory** — FlowPilot remembers recent exchanges
  (configurable depth) and carries that context into Generate/Modify/
  Document, with a clear notice when older messages are truncated.
- **Clarifying questions** — if an instruction is too vague to act on
  safely, FlowPilot asks ONE question instead of guessing.
- **Streaming replies** — optional SSE streaming for chat responses.
- **`/build`** — describe a goal and FlowPilot plans it, proposes a first
  flow, then walks an interactive build → deploy → debug → review → fix loop
  with you, bounded by a configurable iteration cap. Every step still goes
  through the same diff-review-then-apply flow as Modify.
- **Group handling** — FlowPilot sees which group a selected node belongs to,
  and Generate/Build/Modify can create, extend, rename, and ungroup visual
  groups, not just individual nodes.
- **Pop-out window** — the full chat/action-bar/status-strip cockpit in a
  separate browser window, handy for multi-monitor setups.
- **Personality slider** — an adjustable captain-voice intensity (1-10) for
  conversational framing; technical content (explanations, diffs, errors)
  always stays plain regardless of setting.
- **`/compact` / `/expand` / `/disable` / `/enable`** — instant, deterministic
  slash commands for label visibility and enabling/disabling the selected
  node(s); no AI round-trip.

## Requirements

Node-RED 4.x and 5.x, tested. Node.js 16+.

## Install in a local Node-RED user directory

From your Node-RED user directory:

```bash
cd ~/.node-red
npm install /path/to/node-red-flowpilot
node-red
```

For a Docker/container setup, place or install the package inside the
mounted Node-RED user directory. If your user directory is
`/data` (or `/workspaces/nodered`, etc.), this folder should exist:

```text
<node-red-userDir>/node_modules/@manny-est/node-red-flowpilot
```

Restart the Node-RED container/process after installing or updating —
plugin HTML is cached server-side, so a browser refresh alone is not enough.

FlowPilot stores its own settings and logs separately from the plugin code,
under `<node-red-userDir>/flowpilot/`:

- `settings.json` — provider configs (including API keys), custom intents,
  conversation/streaming preferences
- `audit.log` — a log of every generate/modify/document action
- `chats/` — lightweight per-session chat logs
- `backups/` — pre-change backups

## Provider setup (example: LocalAI)

Open the FlowPilot sidebar, click the settings (gear) icon, and add a
provider:

- Provider name: `LocalAI` (or any label)
- Base URL: `http://localhost:8080`
- API key: blank unless your instance requires one
- Model: your model name
- Temperature: `0.2`

If Node-RED is running in Docker, `localhost` refers to the Node-RED
container, not the Docker host. Use the provider's container name, Docker
network alias, or host IP instead, e.g.:

```text
http://localai:8080
http://172.17.0.1:8080
```

Click **Pre-flight check** to save and verify connectivity.

## Examples

The `examples/` folder includes a couple of small starter flows, available
from the editor's **Import → Examples → FlowPilot** menu — see
[USER-GUIDE.md](USER-GUIDE.md#examples) for what they're for.

## Development status

FlowPilot is under active development. Every change is reviewable and
undoable, but as with any AI-assisted tool, review proposed changes before
applying them — especially on flows you care about.

## Feedback

Found a bug or have a feature request? Please open an issue:
https://github.com/manny-est/flowpilot/issues
