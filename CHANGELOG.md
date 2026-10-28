# Changelog

All notable changes to FlowPilot are documented here.

## [0.7.0-beta.3] - 2026-10-28

**Beta.** Finishes Simple Flow: FlowPilot can now prove a flow works,
long turns survive reverse proxies, errors are readable, and custom
intents become saved prompts. Install with
`npm install @manny-est/node-red-flowpilot@beta`; the stable line stays on
0.6.x.

### Added
- **Runtime proof with FlowPilot's own test nodes.** To check a flow,
  FlowPilot adds small debug nodes named "FlowPilot test" next to the
  flow's output, deploys, triggers the flow, reads what they receive, then
  removes them and deploys again so nothing is left running. **Test it** on
  the result card does the same on demand. The run line says "Run: proven"
  with the flow's actual output, or "Run: not provable here" and why.
  - Only FlowPilot's own test nodes count, matched by id. A node of yours
    with the same name can't fake a pass.
  - Deploying asks first only when it would also deploy changes you made
    yourself.
  - Test nodes left behind by a crash or a closed tab are removed when the
    editor loads, with a notice.
  - Restricted mode adds no test nodes and never deploys.
  - Known limit: while a proof runs, its test messages also show in your
    Debug sidebar.
- **Saved prompts.** Type `/` to see them next to the built-in commands;
  choosing one fills the prompt box without sending. Add, edit and delete
  them in Settings.
- **Speed hint.** On a local model, after 45 seconds the status line adds
  "Local models can take a minute or more per step", once per run.

### Changed
- **Custom intents are now saved prompts.** They're converted the first
  time this version loads, and FlowPilot tells you once where they went.
  Nothing you wrote is lost.
- **Settings is shorter.** Controls that no longer did anything are gone
  ("Hold at each loop checkpoint", "Show the built-in helper buttons"). The
  pause threshold ("Diff-gate pause above", default 5 changed nodes) is
  now a visible setting, and the routing override is under
  **Diagnostics**.

### Fixed
- **Long turns no longer fail at a reverse proxy** (for example a 504 after
  90 seconds). While a slow model works, FlowPilot keeps the connection
  open.
- **Errors are readable.** Proxy and error-page HTML never reaches the
  chat; a 504, 502, auth, timeout or network failure gets a plain
  sentence.
- Settings is usable at the 180 px minimum sidebar width.

## [0.7.0-beta.2] - 2026-10-27

**Beta.** Simple Flow: FlowPilot now does clear, targeted changes straight
away and saves the plan step for the requests that need one. This replaces
beta.1's Plan/Act bar, which beta testers found confusing and hard to fit
in a narrow sidebar. Install with
`npm install @manny-est/node-red-flowpilot@beta`; the stable line stays on
0.6.x.

### Changed
- **No more Plan/Act bar or mode row.** Type what you want and press Send.
  - A clear change to a node you selected or named (rename it, fix this
    function, make this inject fire every 5 seconds) just runs.
  - Open-ended or bigger requests ("build me a flow that…") show a
    **plan card** first: the summary, the steps, and the risky operations
    (deploy, deletes, nodes that reach outside Node-RED) listed up front.
    **Approve** runs it. Anything risky the plan didn't list still asks
    during the run.
  - If FlowPilot can't tell which node you mean, it asks **"Which one?"**
    and lists the candidates with their tab names.
- **Auto** (next to Send, on by default). Turn it off to get a plan card
  for every change. The **▾** menu next to Send picks **Plan first** or
  **Just do it** for your next message only; the button shows the choice
  until it's used.
- **One engine for every model with tool calling.** Modify, Generate,
  Document and Build all use the same step-by-step loop. Models without tool
  calling keep the previous review-and-apply flow.
- **Every model classifies your request first**, then reads your flows to
  answer questions. Answers now quote your actual nodes instead of
  guessing.
- **Messages typed while FlowPilot is working:** choose **Stop and do this
  instead** (the run stops at the next step) or **Do it after**.

### Added
- **Result card after every change.** It shows what changed on each node
  (function code as a line diff), every validation check, whether the
  change was run, and the tokens used. **Undo** reverses the whole run in
  one step.
- **Checks after every write.** FlowPilot checks that node types are
  installed, wires point at real nodes, required settings are filled in, and
  function code parses (it is never run). Problems go back to the model to
  fix, up to three tries.
- **"This turned out bigger than expected."** If a run starts changing
  nodes you didn't point it at, or more nodes than expected, it pauses so you
  can keep going or undo the run.
- **Restricted mode** (Settings). FlowPilot never deploys: every change gets
  a plan card, and you deploy yourself.
- **Example prompts** in an empty conversation.
- **The pop-out window** now has the same controls and cards as the
  sidebar.

### Fixed
- **Narrow sidebars.** FlowPilot is usable at Node-RED's minimum sidebar
  width (180 px) and looks right at the default 300 px, in the sidebar and
  the pop-out.
- Answering FlowPilot's "What would you like me to do?" question now
  carries on with that choice instead of showing a single letter.
- Deleting a node no longer counts as changing the node wired into it.

## [0.7.0-beta.1] - 2026-10-27

**Beta.** Plan/Act: FlowPilot now works out which action you want instead
of asking you to pick a mode first. Install with
`npm install @manny-est/node-red-flowpilot@beta`; the stable line stays on
0.6.x until this beta has had real use.

### Added
- **Chat is now Plan.** Ask questions as before. When what you type
  becomes a specific change to your flows, FlowPilot answers with a
  **proposal card** instead of acting: what it will do, which nodes it
  targets, and a short plan. Edit the summary, add, remove or reorder plan
  items, then press **Act**, or **Discard** it. Nothing changes on your
  canvas until you press Act. Planning stays read-only.
- **Plan / Act bar and mode row.** Two main buttons, Plan and Act, plus a
  quieter row with Generate, Modify, Document and Build. The row lights up
  the mode FlowPilot picked for its proposal. Click a mode, or type
  `/generate`, `/modify`, `/document` or `/build`, to **pin** it: Act then
  runs your pinned mode instead. A pin lasts for one run.
- **Re-plan.** If a run stops before it's done (you skipped a step, it hit
  a limit, a change didn't verify, or it needs more information),
  FlowPilot offers a Re-plan card with the unfinished steps, ready to edit
  and run again. It never re-runs anything on its own.
- **Messages typed while FlowPilot is working are queued, not lost.** At
  the next step FlowPilot asks whether to use your message now (it adjusts
  the remaining steps) or after the run. Pressing Enter while busy no longer
  starts a second request.
- **Smarter, safer consent prompts.** FlowPilot decides when to ask by
  what a step does (create, change, rewire, delete, deploy, trigger) and
  which node type it touches. Steps on everyday nodes such as inject,
  function, change, switch and debug just run. Steps on nodes that reach
  outside Node-RED (HTTP, MQTT, exec, files, and any type it doesn't know)
  ask first. Deleting and deploying always ask. Once you approve a node, the
  same run doesn't ask about it again.
- **Settings shows how FlowPilot routes your requests and why**: the
  routing chosen for your provider, and whether that came from your manual
  override, from tool support, or from the model running locally or in the
  cloud. Local models and models without tool calling automatically use a
  classify-first routing that measured more reliable.
- **Experimental: Build on the agent engine** (Settings → Agentic build
  loop → Build engine → Converged, with the WRITE-tool loop on). Build places
  the nodes, asks before each deploy, fires the trigger itself, checks the
  real debug output, and fixes and retries in the same run. It finishes with
  "Done with proof" quoting what it observed, or an honest stop. Classic
  Build is still the default.
- **Settings → hide the built-in helper buttons** (Explain, Help, Review,
  Suggest). Your own custom buttons always show.
- **Build warns before deploying** when your editor has undeployed changes,
  because a deploy pushes all of them live.

### Changed
- The Generate, Modify and Document instructions no longer try to second-
  guess whether your request "belongs" in that mode. Choosing the action is
  Plan's job now, so a mode you pin is carried out as asked.
- Removing a node always asks for consent, even for a simple node type.

### Fixed
- Strict chat templates (such as Qwen's) rejected Plan routing and Act
  requests with "System message must be at the beginning." Every request
  now carries a single leading system message.
- A proposal made after FlowPilot had looked around the flow could show
  "Select nodes first" even though nodes were selected.
- After pressing Act, the next message you typed could still be routed into
  that mode instead of back to Plan.
- Grouping nodes reported "failed verification" even when the group was
  created correctly.
- Group creation from a reviewed Modify could leave an empty, orphaned
  group behind if Node-RED refused to create it. It now cleans up and
  reports the real error.

### Known limitations
- Local models with a small context window (around 8k tokens) can run out
  of room in Act runs that use the WRITE-tool loop, and in Build. Plan
  routing and classic Generate, Modify and Document still work. A larger
  context size for the model fixes this.
- In Node-RED 5, when FlowPilot shares the right-hand sidebar with the
  Debug panel, its message area can become very short. Drag the divider
  down, or collapse the Debug panel.

## [0.6.4] - 2026-10-24

### Fixed
- **FlowPilot didn't work when Node-RED's editor is served under a
  sub-path** (`httpAdminRoot` set to something other than `/`, e.g.
  `/manage`) — the sidebar showed errors because every FlowPilot request
  went to the server root instead of the editor's path. Settings, Test
  Provider, chat, and the pop-out window now all work under any
  `httpAdminRoot`, with or without `adminAuth`.
  ([#12](https://github.com/manny-est/flowpilot/issues/12))
- **Test Provider's "Not a valid provider endpoint" error now includes
  the Docker hint** when your provider URL uses `localhost` or
  `127.0.0.1`: inside a Dockerized Node-RED, `localhost` means the
  Node-RED container itself, not the machine running your provider.
  ([#10](https://github.com/manny-est/flowpilot/issues/10))
- **Local models with strict chat templates (such as Qwen's official
  template) rejected FlowPilot's requests** with "System message must be
  at the beginning." FlowPilot now sends all of its instructions as a
  single system message at the start of every request. The model
  receives the same information as before.
  ([#11](https://github.com/manny-est/flowpilot/issues/11))
- **The automatic capability check after switching models always
  failed** ("Pre-flight failed — continuing with cached capabilities").
  After you change a provider's model, FlowPilot now re-checks tool
  support on your next chat message as intended, without you having to
  press Test Provider.

## [0.6.3] - 2026-10-05

Promoted from the beta track after real-world confirmation: the
OpenRouter forum requester who originally reported the base-URL bug
confirmed `0.6.3-beta.2` works for their OpenRouter + ZDR setup, and no
other problems were reported during the beta window.

### Fixed
- **OpenRouter (and other OpenAI-compatible providers documented with a
  base URL that already includes `/v1`) couldn't connect at all —
  following the provider's own docs produced a doubled
  `.../v1/v1/chat/completions` 404.** Every affected provider (OpenAI,
  OpenRouter, Ollama, LM Studio, LocalAI, llama.cpp server, vLLM) now
  resolves correctly at request time. Your saved base URL itself is
  never rewritten, so an already-confirmed provider stays confirmed
  after upgrading.
- **A full endpoint that does NOT end in `/v1`** (a non-standard
  gateway path, e.g. Open WebUI's own `/api/chat/completions`) is now
  used exactly as typed instead of having `/v1` forced into it — lets
  this kind of gateway work through the Custom preset.
- **The "Advanced" section in Settings couldn't be expanded** — clicking
  it collapsed its own parent section (Providers) along with it.
  Advanced now opens independently.
- **Saving or testing one provider could be blocked by a problem with a
  completely different, unrelated provider.** Save/Test validation now
  only checks the provider you're actively working with. Related:
  unsaved edits to a provider are discarded when you switch to a
  different one without saving, instead of silently carrying forward.
- **Test Provider's connection-refused errors could show up blank.**
  Now shows a proper "Connection failed (CODE)." message, plus a hint
  when the host is literally `localhost`/`127.0.0.1` inside a
  Dockerized Node-RED, where that refers to the Node-RED container
  itself, not the host machine running your provider.

### Added
- **Provider presets.** A new "Provider" dropdown in Settings offers
  OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, LocalAI, llama.cpp
  server, vLLM, or Custom — picking one fills in the right base URL and
  shows or hides the API key field depending on whether that provider
  needs one. Base URL, context window, temperature, and OpenRouter's
  own extra options are tucked into a collapsed "Advanced" section so
  the everyday path stays simple. Every provider you already had
  configured keeps working exactly as before.
- **A live "FlowPilot will call: …" preview** under Base URL in
  Advanced, so it's never a guess which endpoint your configuration
  actually resolves to.
- **OpenRouter support**, including its own two extra options in
  Advanced: enforcing zero-data-retention (ZDR) per request, and
  optionally sending attribution headers identifying FlowPilot to
  OpenRouter (off by default).
- **`/bug`** — a quick command for reporting a bug, with a link to the
  GitHub issues page.
- **`/feedback`** — for feature requests and general feedback: the
  same issues page (put "feedback" in the title), or a direct DM on
  the [Node-RED forum](https://discourse.nodered.org/u?name=manny-est)
  for anything you'd rather send privately.

### Known limitations
- **Ollama's context window may be too small for FlowPilot's prompts.**
  Ollama's OpenAI-compatible API has no way to set context length per
  request. If a model using an Ollama provider seems to ignore your
  instructions, increase `OLLAMA_CONTEXT_LENGTH` on your Ollama server
  (or set `num_ctx` in a Modelfile) — Settings shows this same note
  whenever the Ollama preset is selected. A live-traffic measurement of
  this is planned as follow-up work; if it confirms an overflow, a
  stronger in-app hint (or an automatic mitigation) ships in a future
  release.
- LM Studio, llama.cpp server, and vLLM presets are confirmed against
  each provider's own current documentation but have not yet been
  tested against a live instance of each.

## [0.6.3-beta.2] - 2026-09-23

**Beta release** — same beta window as 0.6.3-beta.1, fixing issues
found during testing. Install/update with
`npm install @manny-est/node-red-flowpilot@beta`.

### Fixed
- **The "Advanced" section in Settings couldn't be expanded** — clicking
  it collapsed its own parent section (Providers) along with it, hiding
  both. Advanced now opens independently.
- **Saving or testing one provider could be blocked by a problem with a
  completely different, unrelated provider** — a single provider with
  incomplete or bad data (e.g. a cleared Base URL) could prevent saving
  or testing every other configured provider. Save/Test validation now
  only checks the provider you're actively working with. Related: unsaved
  edits to a provider are now discarded when you switch to a different
  one without saving, instead of silently carrying forward.

### Added
- **`/bug`** — a quick command for reporting a bug, with a link to the
  GitHub issues page.
- **`/feedback`** — revised for feature requests and general feedback:
  the same issues page (put "feedback" in the title), or a direct DM on
  the [Node-RED forum](https://discourse.nodered.org/u?name=manny-est)
  for anything you'd rather send privately.

## [0.6.3-beta.1] - 2026-09-23

**Beta release** — shipped on npm's `beta` dist-tag for the OpenRouter
forum requester (and anyone else who wants it early) to test ahead of
general availability. Install with
`npm install @manny-est/node-red-flowpilot@beta`. If you hit a problem,
please report it — a stable `0.6.3` follows once this beta is
confirmed working, or after roughly a week with no reported issues.

### Fixed
- **OpenRouter (and other OpenAI-compatible providers documented with a
  base URL that already includes `/v1`) couldn't connect at all —
  following the provider's own docs produced a doubled
  `.../v1/v1/chat/completions` 404.** FlowPilot was unconditionally
  appending `/v1/chat/completions` to whatever base URL was saved,
  after only trimming a trailing slash. Every OpenAI-compatible
  provider this affects (OpenAI, OpenRouter, Ollama, LM Studio,
  LocalAI, llama.cpp server, vLLM) documents its own base URL as
  already including `/v1` — now recovered and normalized correctly at
  request time, whether you paste the plain base URL or a full
  endpoint URL. Your saved base URL itself is never rewritten, so an
  already-confirmed provider stays confirmed after upgrading.

### Added
- **Provider presets.** A new "Provider" dropdown in Settings offers
  OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, LocalAI, llama.cpp
  server, vLLM, or Custom — picking one fills in the right base URL and
  shows or hides the API key field depending on whether that provider
  needs one. Base URL, context window, temperature, and OpenRouter's
  own extra options are now tucked into a collapsed "Advanced" section
  so the everyday path stays simple. Every provider you already had
  configured keeps working exactly as before — nothing about your
  existing setup changes on upgrade.
- **OpenRouter support**, including its own two extra options in
  Advanced: enforcing zero-data-retention (ZDR) per request, and
  optionally sending attribution headers identifying FlowPilot to
  OpenRouter (off by default).

## [0.6.2] - 2026-09-22

### Fixed
- **Newer Anthropic models (Sonnet 5, Fable 5.1) didn't work at all —
  every request failed with a 400 error.** ([#9](https://github.com/manny-est/flowpilot/issues/9))
  Models released after Claude Opus 4.6 reject any `temperature` value
  other than 1.0; FlowPilot's default of 0.2 meant every single chat,
  generate, modify, document, and provider-capability-probe request
  against a newer model failed outright with "temperature is deprecated
  for this model." Older models (confirmed: `claude-sonnet-4-5`) were
  unaffected. Fixed reactively — no model-name list to maintain: FlowPilot
  now detects that exact error live, retries once with `temperature`
  omitted, and remembers the model needs that treatment so it's a
  one-time cost. Live-verified against Sonnet 5, Fable 5.1, and an older
  model to confirm no regression there.
- **A multi-section plan could silently lose most of its steps from the
  todo checklist.** A model's own explanation can legitimately structure
  a larger plan as several numbered sections under short labels (e.g. a
  Dashboard 2.0 build broken into "Widgets to add:" / "Final steps:")
  rather than one unbroken numbered list. The checklist parser stopped
  reading at the first blank line, so only the first section's items
  ever made it onto the checklist — a 5-step plan could show as a
  1-item checklist, which read as "the numbering is wrong" but was
  actually silent data loss. Now keeps reading across section breaks and
  only stops at the real closing explanation paragraph.
- **No way to clear a pinned node selection without losing your place.**
  Once a mode (Generate/Modify/Document/Build) is armed with a
  selection, that selection intentionally stays attached across
  follow-up turns so you don't have to reselect every time — but there
  was no way to just drop it if you no longer wanted those nodes
  attached, short of fully re-arming the mode or clearing the whole
  chat. The status line now shows a small ✕ next to a pinned selection
  that clears just the pin, leaving the mode itself armed.

## [0.6.1] - 2026-09-02

### Fixed
- **Deterministic run summaries actually work now.** 0.6.0 shipped this
  feature — the per-item ✓/✗ outcome from a Modify or Generate run,
  built from what the WRITE tools actually reported instead of the
  model's own retelling — but a control-flow bug in the message-
  rendering path made it unreachable for every real run: the code path
  that shows the deterministic summary as primary (with the model's
  own explanation demoted underneath) never executed. Every response
  fell through to showing the model's own prose at full weight
  instead, exactly the narrative-accuracy gap this feature exists to
  close. Found and fixed during this release's own go-live testing,
  now live-verified against a real agentic write.
- **Installed-package awareness was silently non-functional — FlowPilot
  now actually receives your palette.** The feature that keeps
  Generate/Modify from proposing node types you don't have, and lets
  FlowPilot correctly answer "is X installed?", called a Node-RED API
  that doesn't exist on this version's plugin interface. The call was
  a silent no-op on every single request: FlowPilot never had real
  palette information to work with, so the model either said as much
  or, in some cases, guessed. This wasn't a timing bug or a stale
  cache — the underlying data source itself never worked. Now reads
  the live node registry directly and is correct immediately, from
  the very first request after a restart.

## [0.6.0] - 2026-09-01

Promoted from `0.6.0-beta.1` to the stable `latest` npm tag.

### Added
- **Agentic WRITE-tool loop for Modify and Generate** (behind the
  `enableAgentWrite` setting, default off): step-by-step tool calls
  against the live flow (`apply_step`, `remove_step`, `rename_node`,
  `group_nodes`), each write-gated by a per-step consent prompt (Proceed
  / Skip this step) before it touches the canvas. Multi-item requests are
  tracked and executed as separate, individually-verified steps rather
  than one all-or-nothing envelope; an injected mid-run failure (e.g. a
  referenced node no longer exists) fails only that item, with the rest
  completing normally. Generate joined the same agentic runtime Modify
  already used, closing the last place a mutation could land through the
  older, less-verified classic JSON path while write-tool mode is on.
- **`ask_user` clarifying-question tool**: an agent-strategy turn can pause
  mid-run to ask a single focused question (with optional quick-reply
  buttons) instead of guessing, and resumes exactly where it left off once
  answered.
- **Deterministic run summaries**: when a Modify or Generate run actually
  applied WRITE-tool steps, the per-item outcome you see (✓ applied and
  verified / ✗ failed, with why) now comes straight from what the tools
  actually reported — not from the model's own retelling. The model's own
  wrap-up explanation still shows, underneath, clearly secondary — useful
  context, never the thing you have to trust to know what really
  happened.
- **Contract-exclusivity enforcement**: a server-side safety net
  (`enforceAgentContract`) strips any classic-style mutation fields
  (`changes`/`newNodes`/`newWires`/`removeNodes`/`newGroups`/`flow`) that
  accidentally appear on an agent-strategy turn with no tool calls, before
  they ever reach the client — the two mutation paths (classic envelope vs.
  agentic WRITE tools) stay mutually exclusive per turn, for every mode
  that can run agentically.
- **Run identity and honest interruption**: agent-strategy runs now carry a
  stable run/operation id so a duplicate tool-call delivery (a retry, or the
  model repeating itself) is applied at most once; a run that's stopped or
  hits its step/token ceiling reports an honest "interrupted after N steps"
  instead of silently truncating. That step-by-step record is also now
  visible to the server (previously client-side only), the foundation for
  the deterministic run summaries above.

### Fixed
- **The FlowPilot sidebar's entire client script was loading twice on
  every single editor page load** — a packaging issue present since the
  plugin's first release, only now found and fixed. In practice this
  meant a page reload silently lost the current conversation (a second,
  redundant script execution would stomp the first one's restored state)
  and, more subtly, any other one-time setup code in the client ran
  twice per load. Reloading the Node-RED editor now correctly picks the
  conversation back up where you left off.
- Anthropic (Claude) responses now get the exact same deterministic
  run-summary and contract-exclusivity treatment as every other
  provider — verified directly against Claude Sonnet, not just the
  OpenAI-compatible path.

### Security
- **API keys are now write-only over HTTP** (previously exposed on
  `GET`/`POST /flowpilot/settings` — a fork-hygiene regression from the
  0.5.1 stable line, now ported forward and closed for good). Every
  provider's `apiKey` is masked to a sentinel or `""` in both responses;
  the real key never leaves the server. `settings.json` and per-conversation
  transcripts are now created with `0600` permissions.
- **Provider-confirmation gate (SSRF mitigation)**: no chat, generate,
  modify, document, build, agent-step, or model-list request reaches a
  configured provider's Base URL until that exact URL has passed a real
  FlowPilot connection check (Pre-flight check / Test Provider). The check
  itself is blind on failure — a non-provider target's response is never
  reflected back to the client — so pointing a provider at an unintended
  internal address yields nothing readable. Confirmation is tied to the
  exact URL and clears automatically if the Base URL or API key changes.
  See `dev-docs/decisions/ADR-007-Provider-Confirmation-Gate.md` for the
  full design.
- **Audit-trail completeness**: an agent-strategy request whose very first
  model turn is a tool call (rather than a later continuation) is now
  always recorded to the audit log — previously this specific case left no
  trace at all.

### Internal
- Phase 10: strategy propagation, contract-exclusivity enforcement, agent
  turn output caps, run identity/idempotency, and verification consolidation
  across the classic and agentic Modify paths. Full history in
  `dev-docs/current/Phase10-Build-Progress.md` and
  `dev-docs/current/Phase10-Gate-Closeout-Final.md`.

## [0.5.2] - 2026-08-04

This release continues the 0.5.x line. Phase 10's agentic Modify redesign
(WRITE-tool loop, per-call consent gates, `ask_user`) is developed
separately and is not included here — it ships under its own beta line
until it's ready to replace this one.

### Added
- **Anthropic provider support**: FlowPilot can now talk directly to the
  Anthropic API (Claude models) alongside any OpenAI-compatible endpoint.
  A new Provider Type dropdown in Settings switches between them; message
  format, tool-call translation, and streaming (SSE) are handled
  transparently by a dedicated adapter. Leave Base URL blank to use
  `api.anthropic.com`.
- **Reasoning model support**: FlowPilot detects reasoning models
  (Nemotron, DeepSeek, QwQ, and any model returning `reasoning_content` or
  `<think>` blocks) and shows a live collapsing "Thinking…" block during
  streaming, or a pre-collapsed one on the agent-loop path.
- **Auto-preflight on model change**: switching models and sending a
  message silently probes capabilities first — no more manual "Test
  Provider" click after every model swap.
- **`/refresh` command**: re-renders the message panel from the in-memory
  record store without losing conversation history — restores interactive
  Apply buttons and review panels that went stale after a long session.
- **Build loop — consent gates for side-effecting steps, checkpoint
  questions, context-aware start from a selection, and an explicit
  done/fail confirmation** instead of silently stopping.
- **Modify — todo/plan checklist rendering**: multi-item Modify requests
  now show a checklist that resolves as verification confirms each item
  landed, instead of a single opaque pass/fail.
- **Config node support**: config nodes (MQTT brokers, TLS configs, etc.)
  are now exposed in context and can be created/connected by Modify.
- **Server-side validator/repair layer**: malformed model output is
  caught and, where possible, automatically repaired before it reaches
  the canvas.

### Fixed
- Redaction round-trip poisoning, token-credential redaction gaps, and
  several redaction echo/false-positive fixes across Modify and the build
  loop's review step.
- Group data corruption from a stray `changes` patch touching a group's
  membership array directly; mixed-membership group create/extend
  corruption.
- Invalid port wiring (wiring to/from a port index that doesn't exist)
  now guarded instead of silently applied.
- New-node insertion collision avoidance tuned for faster, more reliable
  separation on dense flows.
- Several build-loop review false positives (metadata-field echoes,
  debug/function/mqtt node misclassification, stale in-progress status
  read as a real error).
- Partial id-validation no longer discards an entire valid Modify batch
  over one bad node id.

## [0.5.1] - 2026-07-24

### Added
- **`/refresh` command**: re-renders the entire message panel from an in-memory record store without clearing conversation history. Restores interactive Apply buttons and review panels that may have become stale after a long session or a pop-out sync. Type `/refresh` at any time.
- **Reasoning model support**: FlowPilot detects reasoning models (Nemotron, DeepSeek, QwQ, and any model returning `reasoning_content` or `<think>` blocks) at pre-flight and handles them correctly throughout. Streaming: a live collapsing "Thinking…" block shows reasoning tokens as they arrive, then auto-collapses when the real response begins. Non-streaming (agent loop): a pre-collapsed thinking block renders alongside the final response. Both the SGLang/Nemotron (`delta.reasoning_content`) and llama.cpp/LocalAI (`<think>…</think>` in `delta.content`) formats are supported. Token count shown on collapse.
- **Auto-preflight on model change**: changing the model field and sending a message now triggers a silent capability probe before the request goes out — no need to click "Test Provider" after every model switch. A notice appears in the chat thread confirming the probe result (model name, tool support, reasoning flag). Settings are saved automatically as part of the probe so the backend uses the new model. The provider status line also updates live as you type the model name.

### Fixed
- **Pre-flight `probedModel` not reaching frontend**: after a `/test` run, `probedModel` was saved to disk but never mirrored into the in-memory provider profile, so the auto-probe condition (`probedModel !== currentModel`) could never fire after a page reload. The `/test` response now includes `probedModel` in the `capability` object and `handleSendResult` mirrors it into `currentSettings.providers`.
- **Reasoning content scrolling**: the live thinking block now scrolls to bottom on each streaming delta so long reasoning chains stay visible as they arrive.

### Internal
- Phase 10 Workstream 0A: shadow record store added across `main.js`, `apply-review.js`, `modes.js`, `init.js` — addMessage/addModifyReview/addGeneratedReview/renderActionChip/renderClarifyingQuestion/renderLoopCheckpoint/renderLoopStepper all create typed records; rerenderRecord dispatches each kind on refresh.
- Phase 10 Workstream 0B: DOM elements now carry `data-fp-record-id` (record id) instead of inline JSON payloads in `data-fp-apply-*` attributes. Four separate pop-out bind functions consolidated into a single `bindReviewApplyButtons`; four separate parent postMessage handlers replaced by a unified `applyByRecordId` handler that dispatches on the record's subkind.

## [0.5.0] - 2026-07-06

### Added
- **Slash autocomplete**: type `/` in the compose box and a panel shows all available commands with descriptions. Arrow keys, Tab, and Enter navigate; Escape dismisses.
- **Mode-suggestion chips**: FlowPilot detects when you describe a Generate, Modify, or Build task while in a different mode and offers a one-click chip to switch — no need to type the slash command manually. A chip also surfaces after a Generate response if the flow looks like it needs a follow-up Build loop.
- **Build loop — hold-at-next-step pacing**: a new Settings → Behavior toggle pauses the loop at each waypoint for review instead of auto-advancing. Useful for carefully inspecting each iteration.
- **Build loop — checkpoint questions**: the loop can now ask a focused clarifying question at any waypoint (e.g. "the debug output shows X — did you mean to test Y?") with prefilled quick-reply options, the same mechanism Modify uses. The loop only continues once you answer.
- **Build loop — context-aware start**: `/build` now reads your current selection as the starting context (same as `/modify`), letting you target an existing sub-flow to extend or fix rather than always building from scratch.
- **Build loop — done confirmation**: a "Done" confirmation step with an explicit success/fail verdict now closes the loop instead of silently stopping.
- **Pop-out — debug log**: the debug log panel is now fully mirrored in the pop-out window, including the "Clear debug" button and the "Attach N to context" indicator.
- **Pop-out — Recall and flight log**: the Recall panel and flight-log history are now accessible from the pop-out; opening a past conversation or recalling a message works the same as in the main window.
- **Pop-out — prompt resize handle**: the compose box in the pop-out can now be resized vertically, matching the main window.

### Fixed
- **Partial id-validation** (`finalizeModifyResult`): a Modify response containing a mix of valid patches and one bad node id no longer rejects the whole response — valid patches are applied and the bad ones are silently dropped. Previously a single unrecognized id caused every change in the batch to be discarded.
- **Redaction round-trip poisoning** (issue #7): when a Modify request targets a field that FlowPilot redacted (e.g. an HTTP Authorization header), the model's response — echoing back the `[redacted: ...]` placeholder — previously produced a silent empty diff. Now the diff step recognises placeholder values, skips those fields, and if ALL proposed changes were redacted-field-only, shows an explicit warning explaining the limitation and instructing the user to edit that field directly in the node editor.
- **Token credential redaction**: `Authorization: Token <value>` headers (used by Django REST Framework and similar APIs) were not caught by the existing bearer-token pattern and could be sent to the model in plain text. The `Token <credential>` form is now recognised as a separate pattern.
- **Recursive sentinel check**: `isSanitizeSentinel` now walks into nested arrays and objects, so a placeholder buried inside a list property (e.g. `rules[0].v`) is correctly detected and skipped instead of producing a spurious empty diff.
- **Group data corruption**: a plain `changes` patch could reach the `nodes` membership array of a group container (since context exposes it as a plain field), overwriting the live group membership with a stringified copy. The `nodes` array is now in `DIFF_SKIP` so Modify patches never touch it directly.
- **Group create/extend on mixed-membership selections**: creating or extending a group when the selection contained nodes from more than one existing group (or some grouped and some ungrouped) could silently fail or corrupt membership. The membership reconciliation step now handles the mixed case correctly.
- **Invalid port wiring**: FlowPilot now guards against wiring to or from a port index that doesn't exist on a node (e.g. connecting output 3 of a node that only has 2 outputs) — the bad wire is skipped with a warning instead of being applied and then causing a Node-RED canvas error.
- **Pop-out — settings auth failure**: opening Settings from the pop-out could fail with a 404 or 401 in certain auth configurations because the settings request was issued from the pop-out's nested route rather than through the main window. All settings reads and writes are now relayed through the parent window.
- **Pop-out — recall and flight-log relay**: recall and flight-log API calls are now relayed through the parent window so they resolve correctly from the pop-out.

### Internal
- Phase 9 refactor complete: `flowpilot-core.js` is now assembled at runtime from focused fragments under `lib/core/` (redaction, history, markdown, selection-context, apply-review, modes, main, init). The assembled script is functionally identical to the old single file; the split is purely for maintainability.

## [0.4.1] - 2026-06-29

### Fixed
- **Critical**: the editor hung at "Loading plugins" on any Node-RED instance with `adminAuth` enabled, due to a 401 on `/flowpilot/core.js`. 0.4.0's pop-out refactor moved FlowPilot's frontend into a separately-served script, but the route serving it (along with `core.css` and the pop-out's `view.html`) was gated behind `RED.auth.needsPermission(...)` — a check that requires an `Authorization` header, which a plain `<script src>`/`<link>`/`window.open` request can never carry. These three static client-asset routes are no longer gated (they contain no secrets); every data/action route is unaffected and still requires authentication exactly as before.
- **Critical**, found while verifying the fix above: every settings/chat/generate/document/modify/build request (anything going through the shared `ajaxJson` helper) also failed with "Unauthorized" on `adminAuth` instances, for the same root cause — these requests use an absolute URL (needed for the pop-out to resolve correctly), and Node-RED's editor only auto-attaches the admin auth token to relative URLs. The SSE-streaming `fetch()` calls already worked around this (`fetchHeaders()`); `ajaxJson` now attaches the same bearer token itself.

## [0.4.0] - 2026-06-27

### Added
- Personality slider in Settings → Behavior (1-10): 1 is a plain Node-RED engineer, 10 is a comically over-the-top airline captain who happens to be a Node-RED expert. Default (3) matches the original "subtle co-pilot" voice. Applies to Chat replies AND the natural-language "explanation" field of Generate/Document/Modify (e.g. announcing a flow it just built) — never to node names, ids, or any structural JSON. Explanations, troubleshooting, diffs, and errors always stay plain and accurate regardless of intensity. Generated fresh per request from the slider value via `lib/persona-prompt.js`, rather than being baked into the persisted system prompt.
- Copy button on every code block shown in chat (Preview JSON/debug, or any code the model pastes inline) — previously only the Generate/Document/Modify review panel's JSON tab had one.
- `/compact` and `/expand` slash commands — hide/restore labels on the selected node(s), instant and deterministic (no AI round-trip). Invokes Node-RED's own native `core:hide-selected-node-labels`/`core:show-selected-node-labels` actions directly, so group-member expansion, no-op skipping, and one-Ctrl+Z batching across the whole selection are handled by Node-RED itself, not reimplemented.
- `/build` — describe a goal in plain language and FlowPilot plans it, proposes a first flow, then walks an interactive build → deploy → attach debug output → review → fix loop with you, bounded by a configurable iteration cap (Settings → Behavior, default 5). Every proposal and fix still goes through the same diff-review-then-Apply flow as Modify — nothing auto-applies, and the AI never deploys for you.
- A detached pop-out window (new header icon) mirrors the full cockpit — chat, action bar, status strip, slash commands, mode switching — in its own browser window, useful on multi-monitor setups. Sending, Clear Chat, and Apply for Generate/Document/Modify/Build review panels all work from the pop-out; it closes automatically if the main editor window does.
- Group awareness: FlowPilot now sees which group a selected node belongs to, and Generate/Build/Modify can create, extend, rename, and ungroup visual groups (a real bordered container, not just a label) — not just individual nodes.
- `/disable` and `/enable` slash commands — disable/re-enable the selected node(s) (skipped on Deploy without removing them), instant and deterministic (no AI round-trip), same mechanism as `/compact`/`/expand`.

### Changed
- Removed the static "Personality:" paragraph from the default system prompt — superseded by the slider above. Existing users with that exact paragraph already saved in a customized system prompt get it surgically stripped on next load/save; any other customization they made is preserved.

### Fixed
- Setting the Personality slider to 10 still felt mild — the prompt's own closing line ("a little goes a long way even at high intensity") undercut the "go all out" instruction for max intensity. The restraint instruction now scales with intensity: low/mid stays subtle, 8-10 explicitly says to lean all the way in on every qualifying moment instead of holding back.
- The Personality slider's thumb didn't reach the true ends of the track — a generic `.fp-form input` rule applied an 8px padding + border to every input including the new range slider, insetting the native track from both edges. Range inputs now get zero padding/border.
- Markdown tables in chat replies rendered as raw, broken-looking `| a | b |` text — `renderMarkdown()` never had table support at all. Added GFM-style pipe table rendering.
- Fenced code blocks indented under a list item (e.g. "1. Try this:\n   ```bash\n   ...\n   ```", which models produce constantly) failed to render as code at all — the fence-detection regex required zero leading whitespace, so the whole block fell through as plain paragraph text with the literal ` ``` ` markers visible. Fence detection now tolerates leading whitespace.
- The Debug log list showed newest-first, so finding a just-arrived message in a long buffer meant scrolling up past everything else. Now oldest-first/newest-last, matching the chat panel's natural scroll-to-bottom behavior.
- A stopped, errored, or empty-response turn could leave a dangling, unanswered entry in conversation history (pushed before the request, never rolled back on failure), corrupting the shape of every later request in that conversation.
- The model's JSON envelope could fail to parse, or get confused with an unrelated JSON-looking snippet embedded in its own prose (e.g. inline code like `{{payload}}`, or an illustrative logging example), when something brace-shaped appeared before the real envelope. Candidates are now matched with string-aware brace matching and must look like a recognized envelope shape before being accepted.
- The `/build` loop could judge a step "done" against only the first of several debug messages fired by one trigger (e.g. after a flow got accidentally forked), missing the full picture. It now waits briefly for all messages from one trigger before reviewing them together, and explicitly checks off each goal requirement instead of trusting a "looks plausible" read.
- The pop-out window's Settings request 404'd, because every internal URL was relative — correct from the main editor's route, but one level too deep from the pop-out's own nested route.
- Selecting a GROUP itself (its border/background, not a member node) showed "1 node selected" instead of expanding to its actual members, and the group's internal wiring wasn't included as context either.
- "Ungroup" could report success while changing nothing (the model was targeting a non-real `group` property instead of actual membership); separately, a model correctly using the documented group-creation field could have its result silently dropped before ever reaching the apply step. Both fixed.
- Fully ungrouping (reconciling a group down to zero members) emptied the group's membership but left a small, empty group container behind on the canvas instead of removing it — now matches what Node-RED's own "Ungroup Selection" does.
- Modify's node-insertion step could, on a partial failure (e.g. 2 of 3 new nodes succeed, the 3rd doesn't), leave the successful ones on the canvas with no undo entry and no message acknowledging anything had landed — now always covers whatever succeeded with one undo step, and reports a partial result honestly instead of staying silent about it.

## [0.3.0] - 2026-06-23

### Added
- `/feedback` slash command — links to the repo and issue tracker, with a note on what makes a good bug report.
- Temperature setting now has an explanatory hint (closes #3).
- Request timeout is now configurable in Settings → Behavior, instead of a hardcoded 180000ms (closes #2).
- "Preview JSON" / "Preview debug" links — show the exact node JSON or debug payload a request will send, for diagnosing "did the AI actually get this" confusion.
- Inline feedback on the Save settings button ("Settings saved." / "No changes to save." / validation errors).
- Declared Node-RED 5.x as tested/supported (previously only the `>=4.0.0` floor was documented).
- Redaction opt-out toggle in Settings → Context & Safety (redaction is on by default; disabling it requires checking a box and typing "disable redaction" to confirm). Intended for local/private AI setups. Node-RED's own credentials field is still always dropped either way. The secrets-warning badge in the status strip turns red with a stronger tooltip while redaction is off.

### Changed
- The "Provider settings... stored locally..." banner now only shows inside the Providers section, not across the whole Settings panel.

### Fixed
- Debug messages attached as context were truncated to 500 characters at capture time — before being attached — which could cut a value mid-JSON and make it look like the AI ignored the attached data. Raised to 20,000 characters for what's actually sent (the debug-log list preview stays short).
- The streaming "Cruising…" indicator never visibly appeared during streaming Chat/Generate/Document/Modify — it was converted into an empty bubble in the same tick it was created, before the request even went out (closes #4).
- Generate would sometimes produce nodes with no `"wires"` connecting them, landing disconnected on the canvas. Added a worked example to the generation prompt (smaller/local models follow concrete examples more reliably than prose rules) and a visible warning in the review panel when a generated flow has zero connections.
- When redaction was off, FlowPilot's chat replies implied it could "re-enable redaction" itself if asked — it has no such ability (no tool/function gives it write access to settings). Clarified the context note so it correctly tells the user to use the Settings panel instead of offering to do it for them.

## [0.2.2] - 2026-06-15

### Fixed
- Raw `fetch()` calls (chat/generate/document/modify streaming) were missing the `Authorization` header that jQuery's `$.ajax` gets automatically from the Node-RED editor, causing 401s on instances with `adminAuth` enabled.
- Dark themes: the prompt box and settings inputs used a non-existent CSS variable (`--red-ui-form-input-text-color`) and always fell back to a hardcoded dark color, making text unreadable against a dark background.

## [0.2.1] - 2026-06-15

Initial public release — published to npm and listed on the Node-RED Flow Library.
