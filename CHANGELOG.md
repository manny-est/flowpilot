# Changelog

All notable changes to FlowPilot are documented here.

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
