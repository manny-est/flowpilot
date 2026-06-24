# Changelog

All notable changes to FlowPilot are documented here.

## [Unreleased]

### Added
- Personality slider in Settings → Behavior (1-10): 1 is a plain Node-RED engineer, 10 is a comically over-the-top airline captain who happens to be a Node-RED expert. Default (3) matches the original "subtle co-pilot" voice. Applies to Chat replies AND the natural-language "explanation" field of Generate/Document/Modify (e.g. announcing a flow it just built) — never to node names, ids, or any structural JSON. Explanations, troubleshooting, diffs, and errors always stay plain and accurate regardless of intensity. Generated fresh per request from the slider value via `lib/persona-prompt.js`, rather than being baked into the persisted system prompt.
- Copy button on every code block shown in chat (Preview JSON/debug, or any code the model pastes inline) — previously only the Generate/Document/Modify review panel's JSON tab had one.
- `/compact` and `/expand` slash commands — hide/restore labels on the selected node(s), instant and deterministic (no AI round-trip). Invokes Node-RED's own native `core:hide-selected-node-labels`/`core:show-selected-node-labels` actions directly, so group-member expansion, no-op skipping, and one-Ctrl+Z batching across the whole selection are handled by Node-RED itself, not reimplemented.

### Changed
- Removed the static "Personality:" paragraph from the default system prompt — superseded by the slider above. Existing users with that exact paragraph already saved in a customized system prompt get it surgically stripped on next load/save; any other customization they made is preserved.

### Fixed
- Setting the Personality slider to 10 still felt mild — the prompt's own closing line ("a little goes a long way even at high intensity") undercut the "go all out" instruction for max intensity. The restraint instruction now scales with intensity: low/mid stays subtle, 8-10 explicitly says to lean all the way in on every qualifying moment instead of holding back.
- The Personality slider's thumb didn't reach the true ends of the track — a generic `.fp-form input` rule applied an 8px padding + border to every input including the new range slider, insetting the native track from both edges. Range inputs now get zero padding/border.
- Markdown tables in chat replies rendered as raw, broken-looking `| a | b |` text — `renderMarkdown()` never had table support at all. Added GFM-style pipe table rendering.
- Fenced code blocks indented under a list item (e.g. "1. Try this:\n   ```bash\n   ...\n   ```", which models produce constantly) failed to render as code at all — the fence-detection regex required zero leading whitespace, so the whole block fell through as plain paragraph text with the literal ` ``` ` markers visible. Fence detection now tolerates leading whitespace.
- The Debug log list showed newest-first, so finding a just-arrived message in a long buffer meant scrolling up past everything else. Now oldest-first/newest-last, matching the chat panel's natural scroll-to-bottom behavior.

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
