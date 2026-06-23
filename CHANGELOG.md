# Changelog

All notable changes to FlowPilot are documented here.

## [Unreleased]

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
