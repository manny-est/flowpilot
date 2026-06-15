# FlowPilot — User Guide

This guide covers installing FlowPilot, the parts of its sidebar UI, setting
up an AI provider, and a walkthrough of every feature. For a high-level
overview of what FlowPilot is and how it was built, see
[PROJECT-OVERVIEW.md](PROJECT-OVERVIEW.md).

## Getting Started

▶ **[Watch a full walkthrough](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/full-intro-demo.mp4)** (MP4, ~30MB) — first launch, setting a provider, `/help`, and `/demo` end to end.

### Install from the Palette

In the Node-RED editor, open the menu (top-right) → **Manage palette** →
**Install**, and search for `@manny-est/node-red-flowpilot`. Click **Install**.

### Install via npm

From your Node-RED user directory:

```bash
cd ~/.node-red
npm install @manny-est/node-red-flowpilot
```

For a Docker/container setup, install into the mounted Node-RED user
directory (commonly `/data`), so the package ends up at:

```text
<node-red-userDir>/node_modules/@manny-est/node-red-flowpilot
```

### Restart Node-RED

Either way, **restart Node-RED** (or the container) after installing or
updating. FlowPilot's editor UI is cached server-side, so a browser refresh
alone is not enough.

### First launch

![The FlowPilot tab in the Node-RED editor's sidebar](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/Node-Red-Tool-Menu.png)

Open the FlowPilot sidebar tab (the paper-plane icon, usually grouped with
Info/Debug/etc. on the right edge of the editor) — or watch [a short clip of
finding it](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/finding-flowpilot.mp4).
On first launch, FlowPilot
walks you through the basics in the chat panel and ends by pointing you at
**Settings** to add a provider — see [Set a Provider](#set-a-provider) below.
This walkthrough only appears once; it disappears for good after you save
settings (which happens automatically the first time you run a **Pre-flight
check**).

![FlowPilot's first-run welcome and cockpit tour](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/first-run-welcome.png)

## UI Basics

![The FlowPilot sidebar's Chat panel](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/sidebar-chat-overview.png)

The FlowPilot sidebar has three panels, switched using the icons in the
header row (top-right of the sidebar):

| Icon | Tooltip | What it does |
| --- | --- | --- |
| 🖉 eraser | Clear chat | Clears the chat and resets conversation memory |
| 🔍 magnifying glass | Recall | Searches past conversations for text in the prompt box |
| 🐛 bug | Debug log | View recent Debug sidebar output and attach it as context |
| ✈ paper-plane | Chat | Switch to the Chat panel |
| 🕐 clock | Flight log | Switch to the Flight log (past conversations) panel |
| ⚙ gear | Settings | Switch to the Settings panel |

### The Chat panel

This is FlowPilot's main view:

- **Messages area** — your conversation with FlowPilot, including any review
  diffs, action chips, and clarifying questions.
- **Query buttons** (orange, left side, above the prompt box) — **Explain**,
  **Troubleshoot**, **Review**, **Suggest**, plus any custom buttons you add.
  Clicking one pre-fills the prompt box with a ready-to-edit instruction and
  switches the prompt to an amber "Query" look.
- **Execute buttons** (blue, right side, above the prompt box) — **Document**,
  **Generate**, **Modify**. Clicking one *arms* that mode (the prompt turns
  blue) — describe what you want and hit Send.
- **Prompt box** — type your question or instruction here. Press **Enter** to
  send, **Shift+Enter** for a new line. Drag the handle in the top-right
  corner of the box to resize it.
- **Status strip** (below the prompt) — shows how many nodes are selected,
  estimated context size, a credentials warning if relevant, any attached
  debug messages, and the active provider. **Clear** empties the prompt box;
  **Send** sends the request.

### The Settings panel

Configure AI providers, the system prompt, conversation memory, custom intent
buttons, and safety warnings. See [Set a Provider](#set-a-provider) and the
feature chapters below for details on each section.

### The Flight log panel

A list of past conversations. Click one to load it back into Chat — new
messages continue that conversation's memory. **Delete all** removes every
saved transcript permanently.

## Set a Provider

FlowPilot talks to any **OpenAI-compatible** API — OpenAI itself, LocalAI,
Ollama (with its OpenAI-compatible endpoint), LM Studio, etc.

1. Open **Settings** (gear icon).
2. Under **Providers**, click **+ Add** if you need a new provider slot
   (one is created for you by default).
3. Fill in:
   - **Provider Name** — any label, e.g. `LocalAI` or `OpenAI`.
   - **Base URL** — e.g. `http://localhost:8080` or `https://api.openai.com`.
     If Node-RED is running in Docker, `localhost` refers to the *Node-RED
     container*, not the Docker host — use the provider's container name, a
     Docker network alias, or a host IP (e.g. `http://172.17.0.1:8080`)
     instead.
   - **API Key** — leave blank unless your provider requires one.
   - **Model** — type a model name, or click **Refresh models** to fetch the
     provider's available models (via `GET /v1/models`) and pick from the
     list.
   - **Temperature** — a starting value of `0.2` works well for most uses.

![Provider settings: Base URL, API key, model, and temperature fields](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/sidebar-settings-providers.png)

4. Click **Pre-flight check**. This saves your settings and sends a small
   test request. A reply in the chat panel means you're connected.

![A successful Pre-flight check reply in Chat](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/preflight-success.png)

You can configure multiple providers and switch between them with the
**Active provider** dropdown — useful for comparing models, or keeping a
cheap/fast provider and a more capable one side by side. **Remove** deletes
the currently selected provider.

## Features

### Chat

Ask FlowPilot anything in plain language. If you have nodes selected on the
canvas, FlowPilot sees their configuration and wiring (sanitized — see
[Privacy and safety](#privacy-and-safety) below) and can reason about them.
Chat remembers recent exchanges (configurable under **Behavior → Remember
last N exchanges**) so you can have a back-and-forth conversation.

### Query intents: Explain, Troubleshoot, Review, Suggest

One-click buttons that pre-fill the prompt box with a ready-to-edit
instruction about your current selection:

- **Explain** — walks through what the selection does, step by step.
- **Troubleshoot** — looks for disabled nodes, dead-end wires, and likely
  misconfigurations.
- **Review** — a design/architecture critique with concrete suggestions.
- **Suggest** — suggests improvements or other Node-RED nodes that could help.

You can add your own custom intent buttons under **Settings → Behavior →
Custom intent buttons** — give it a label and the instruction text it should
send.

![Explain run on a selected node](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/query-explain-example.png)

### Generate

Describe a new flow in plain language (e.g. "fetch the weather every hour and
log it to a file") and click **Generate**, then **Send**. FlowPilot returns a
flow fragment, which you review before doing anything with it — nothing is
added to your canvas automatically. Approve it and FlowPilot hands the nodes
to Node-RED's own import, so placement and undo (Ctrl+Z) work exactly like a
normal paste.

Try `/demo` in the prompt box for a ready-made example: it types a Generate
request for a small "fetch a dad joke" flow into the box for you.

![A Generate request and the resulting reply](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/generate-example.png)

![Generate's review step, with the raw flow JSON](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/generate-review-json.png)

![Generate's review/diff before import](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/generate-review.png)

### Modify

Select the node(s) you want to change, arm **Modify**, and describe the
change (e.g. "add a 5 second delay before this", "change this function to
also log errors"). FlowPilot proposes property changes, rewiring, additions,
and removals as a diff. You review and apply each change — every applied
change is a single native Node-RED undo step (Ctrl+Z).

![Modify's proposed diff before applying](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/modify-diff.png)

![The same change applied to the flow](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/modify-diff-applied.png)

### Document

Select node(s), arm **Document**, and (optionally) add notes about what you
want highlighted, then **Send**. FlowPilot generates a "Read Me" comment node
summarizing the selection, which you review and place like any other change.

![A generated Read Me comment node, reviewed before placing](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/document-readme-node.png)

![The Read Me comment node placed on the canvas](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/document-readme-node-placed.png)

### Recall & Flight log

- **Recall** (magnifying glass icon) — type a search term in the prompt box
  and click Recall to search across your past conversations. Each result has
  a **Use this** button to load that conversation back into Chat.
- **Flight log** (clock icon) — browse and reload past conversations
  directly, or delete saved transcripts.

![The Flight log panel listing past conversations](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/flight-log.png)

### Debug context attachment

Click the **bug icon** to view recent messages from Node-RED's Debug sidebar.
Click **Attach** on any entry to include it as context for your next request
— useful for troubleshooting ("here's the error my flow just printed, what's
wrong?"). The status strip shows how many debug messages are attached; clear
them from there or by clicking **Clear chat**.

![The Debug log panel with recent entries](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/debug-log.png)

![A debug message attached, shown in the status strip](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/debug-log-attached.png)

### Action chips

When FlowPilot's reply describes a change you could make, it may offer an
action chip — a one-click button that switches to the suggested mode
(Generate/Modify/Document/Chat) with the request pre-filled. Nothing is sent
until you review and hit Send yourself.

![A reply with an action chip below it](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/action-chip.png)

![The full chat thread leading up to an action chip](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/action-chip-full.png)

### Clarifying questions

If your instruction is too vague to act on safely, FlowPilot asks **one**
clarifying question instead of guessing — often with quick-reply buttons (plus
an "Other" option for free text). Picking an answer sends it immediately.

![A clarifying question with quick-reply buttons](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/clarifying-question.png)

### Agentic exploration

If your provider supports tool/function calling, FlowPilot can autonomously
inspect your flow before answering or proposing a change — looking at a
node's config, listing flows, searching for nodes, checking connections, or
reading the Debug sidebar. This is read-only, bounded by a step count and
token budget, shown to you as it happens, and can be interrupted with the
**Stop** button.

![An agentic exploration run in progress](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/agentic-exploration.png)

### Streaming replies

Chat (and Generate/Modify/Document) responses can stream in as they're
generated rather than appearing all at once. Toggle this under **Settings →
Behavior → Stream chat replies**.

![Settings → Behavior, including streaming and custom intents](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/settings-behavior.png)

### Slash commands

Type these directly into the prompt box:

- `/help` — show the full command/feature briefing
- `/generate`, `/document`, `/modify` — arm that Execute mode
- `/query` (or `/chat`) — back to Query mode
- `/clear` — start a fresh conversation (clears chat and memory)
- `/history` — open the Flight log
- `/settings` — open Settings
- `/demo` — load a sample Generate request into the prompt box

![`/help`'s full command/feature briefing](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/slash-help.png)

![`/demo` pre-filling a Generate request](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/demo-command.png)

![The flow generated by `/demo`, reviewed and imported](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/slash-demo-complete.png)

### Privacy and safety

- FlowPilot only sends data when **you** trigger a request — nothing happens
  in the background.
- Selected nodes are sanitized before sending: editor-internal fields are
  stripped, and config-node credential fields are dropped entirely.
- A warning icon (⚠) appears in the status strip if your selection might
  still contain sensitive configuration or code — review before sending,
  especially with cloud providers. A local/private AI provider (LocalAI,
  Ollama, etc.) is recommended for sensitive flows.
- Every Generate/Modify/Document result is shown as a review or diff —
  nothing is applied until you click Apply/import, and every applied change
  is a normal Node-RED undo step.

![Settings → Context & Safety](https://github.com/manny-est/flowpilot/releases/download/v0.2.1/settings-context-safety.png)

## Examples

The `examples/` folder (visible via the editor's **Import → Examples →
FlowPilot** menu) includes:

- **Getting Started** — a tiny inject → function → debug flow to practice
  Explain/Modify on.
- **Dad Joke Demo** — a working version of the flow that `/demo` generates,
  so you can see the end result before trying Generate yourself.

## Bug Reports & Feature Requests

Found a bug, or have an idea for a feature? Please open an issue on GitHub:

**https://github.com/manny-est/flowpilot/issues**

When reporting a bug, it helps to include:

- Your Node-RED version and FlowPilot version (`package.json` → `version`).
- The AI provider/model you're using (not your API key).
- Steps to reproduce, and what you expected vs. what happened.
- Anything relevant from the browser console or Node-RED's log.
