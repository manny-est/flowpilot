# FlowPilot for Node-RED

Package: `node-red-contrib-flowpilot`

FlowPilot: AI assistance for Node-RED, designed for builders who want help
without giving up control.

FlowPilot is an AI-powered development assistant that lives in the Node-RED
editor sidebar. It talks to any OpenAI-compatible API (OpenAI, LocalAI,
Ollama, etc.) and helps you generate, modify, document, and discuss your
flows — without ever acting behind your back.

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

## Install in a local Node-RED user directory

From your Node-RED user directory:

```bash
cd ~/.node-red
npm install /path/to/node-red-contrib-flowpilot
node-red
```

For a Docker/container setup, place or install the package inside the
mounted Node-RED user directory. If your user directory is
`/data` (or `/workspaces/nodered`, etc.), this folder should exist:

```text
<node-red-userDir>/node_modules/node-red-contrib-flowpilot
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

Click **Save & test** to verify connectivity.

## Development status

FlowPilot is under active development. Every change is reviewable and
undoable, but as with any AI-assisted tool, review proposed changes before
applying them — especially on flows you care about.
