# FlowPilot settings audit (SF-10)

This audit covers the persisted defaults in `lib/storage.js`, the Settings
markup in `lib/core/init.js`, and the form round-trip in
`lib/core/main.js`. Pure configuration retired by ADR-015 is removed during
settings load/save. User-authored `customIntents` are the exception: they are
copied to `savedPrompts`, retained until that copy is successfully saved, and
then removed.

## Application settings

| Key | Default | Where read | Verdict | Action |
| --- | --- | --- | --- | --- |
| `providers` | one LocalAI profile | `lib/storage.js:createStorage/getSettings/saveSettings`; `flowpilot.js:activeProvider` | used | Kept; provider secrets are reconciled and masked at the HTTP boundary. |
| `activeProviderId` | `default` | `lib/storage.js:getActiveProvider`; `lib/core/main.js:activeProvider/collectSettings` | used | Kept. |
| `maxContextChars` | `12000` | `flowpilot.js:truncateContext` | used | Kept as a server-side context cap. |
| `defaultContextMode` | `selected` | no runtime read found | dead | No UI control; ignored on load and omitted on the next save as an obsolete configuration key. |
| `allowConfigContext` | `false` | `lib/core/selection-context.js:collectSelectionContext` | used | Kept as a capability/context policy. |
| `debugLogging` | `false` | `lib/core/main.js:onDebugMessage/updateSelectionStatus`; `flowpilot.js:maybeLogDebugEvent` | used | Kept. |
| `streamingEnabled` | `true` | `flowpilot.js:runChatStream`; `lib/core/main.js:fillSettings/collectSettings` | used | Kept and exposed under Conversation memory. |
| `firstRunAcknowledged` | `false` | `lib/core/main.js:maybeShowFirstRun`; `lib/storage.js:saveSettings` | used | Kept; successful settings save acknowledges first run. |
| `contextWarnTokens` | `4000` | `lib/core/main.js:updateSelectionStatus` | used | Kept and exposed under Context & Safety. |
| `contextHighTokens` | `8000` | `lib/core/main.js:updateSelectionStatus` | used | Kept and exposed under Context & Safety. |
| `historyMaxExchanges` | `10` | `lib/core/history.js:buildHistoryPayload` | used | Kept and exposed under Conversation memory. |
| `requestTimeoutMs` | `180000` | `lib/storage.js:getActiveProvider`; provider `chat/chatStream/listModels/probeTools` calls | used | Kept; Settings edits seconds and stores milliseconds. |
| `checkForUpdates` | `true` by UI fallback | `flowpilot.js:update-check route`; `lib/core/main.js:fillSettings` | used | Kept as the update-check opt-out. |
| `auto` | `true` | `lib/core/main.js:collectSettings`; `lib/core/intake.js` / `modes.js` dispatch policy | used | Kept next to Send. |
| `restricted` | `false` | `lib/core/main.js:collectSettings`; `lib/core/modes.js` deploy/trigger gates | used | Kept in Settings. |
| `agentTurnMaxTokens` | `4096` | `flowpilot.js:agentMaxTokens` and agent request construction | used | Kept and exposed in Behavior. |
| `agentLoopTokenCeiling` | `50000` | `lib/core/modes.js:runAgentLoop` | used | Kept and exposed in Behavior. |
| `agentLoopMaxIterations` | `5` | `lib/core/main.js:buildMaxIterations/startBuildLoop` | used | Kept and exposed in Build loop settings. |
| `enableStepQueue` | `true` | `lib/core/modes.js:runGenerate` | used | Kept for the existing Generate verification path. |
| `diffGateThreshold` | `5` | `lib/core/diff-gate.js:getDiffGateThreshold`; `lib/core/main.js:collectSettings` | used | Added as a visible Settings control; invalid values fall back to 5. |
| `suppressContextWarnings` | `false` | `lib/core/main.js:updateSelectionStatus` | used | Kept in Context & Safety. |
| `redactionEnabled` | `true` | `lib/core/redaction.js`; `lib/core/main.js:updateSelectionStatus/collectSettings` | used | Kept with its type-to-confirm opt-out. |
| `personaIntensity` | `2` | `flowpilot.js:buildSystemPrompt`; `lib/core/main.js:fillSettings/collectSettings` | used | Kept under Personality. |
| `systemPrompt` | current built-in prompt | `flowpilot.js:buildSystemPrompt`; `lib/core/main.js:fillSettings/collectSettings` | used | Kept; stale shipped snapshots are repaired by storage. |
| `savedPrompts` | `[]` | `lib/core/init.js:bindSlashAutocomplete`; `lib/core/main.js:renderEmptyState/renderSavedPromptList` | used | New `{name,text}` store for slash-menu templates. |
| `savedPromptsMigrationNoticeShown` | `false` | `lib/core/main.js:migrateCustomIntentsOnLoad` | used | Set after the one-time migration notice is shown. |
| `customIntents` | legacy `[]` | `lib/storage.js:migrate`; `lib/core/main.js:migrateCustomIntentsOnLoad` | merged into `savedPrompts` | Converted to unique slash names, retained through the migration POST, then removed only after a successful write. |
| `enableAgentWrite` | legacy `false` | no runtime read in current engine | dead | Removed from defaults/UI/runtime; silently dropped on load/save. |
| `buildEngine` | legacy `classic` | no runtime read; engine selection is capability-driven | dead | Removed from defaults/UI/runtime; silently dropped on load/save. |
| `loopHoldStep` | legacy `false` | no runtime read after SF-10 | dead | Removed from defaults/UI/runtime; loop review advances normally. |
| `showHelperButtons` | legacy `true` | no runtime read after SF-10 | dead | Removed from Settings; built-in helper buttons are always available. |

`defaultContextMode` is retained in old files without error, but is not copied
to the normalized saved settings. Unknown extension keys are otherwise left
alone so older 0.6.x and 0.7.0-beta.1/2 profiles remain loadable.

## Provider profile fields

| Key | Default | Where read | Verdict | Action |
| --- | --- | --- | --- | --- |
| `id` | `default` | `lib/storage.js:getActiveProvider`; provider reconciliation | used | Kept as the stable profile identity. |
| `providerName` | `LocalAI` | Settings UI; audit labels; provider adapters | used | Kept. |
| `type` | `openai-compatible` | `flowpilot.js:getProvider`; provider adapters | used | Kept. |
| `presetId` | `localai` | `lib/provider-presets.js`; `lib/core/main.js:fillProviderFields` | used | Kept; pre-preset profiles are migrated to `custom` or `anthropic`. |
| `baseUrl` | `http://localhost:8080` | provider adapters, confirmation gate, Settings | used | Kept. |
| `apiKey` | empty | provider adapters and storage secret reconciliation | used | Kept server-side; masked in client responses. |
| `model` | empty | provider request bodies and Settings | used | Kept. |
| `temperature` | `0.2` | provider request bodies and Settings | used | Kept. |
| `numCtx` | `0` | `lib/core/main.js:updateSelectionStatus` | used | Kept as the optional context-window advisory. |
| `routingTier` | `A` | `flowpilot.js:normalizedRoutingTier`; `lib/core/main.js:routingTierChoice` | hidden diagnostic | Kept only behind the Providers → Diagnostics disclosure. |
| `routingTierMode` | `auto` | `flowpilot.js:normalizedRoutingTier`; storage migration; Diagnostics | hidden diagnostic | Kept; auto/manual is not a normal user choice. |
| `supportsTools` | absent until probe | provider probe result and routing display | used diagnostic | Kept as server-computed capability state; not directly editable. |
| `confirmedBaseUrl` / `confirmedAt` | absent | storage confirmation gate and test/probe routes | used diagnostic | Kept server-side only; never trusted from the client. |
| `zdrEnabled` / `attributionEnabled` | `false` | OpenRouter adapter and provider Advanced fields | used | Kept for OpenRouter-specific request behavior. |

## Migration and prompt behavior

On GET, a legacy profile receives a normalized `savedPrompts` copy while its
`customIntents` remain present. The client sends the copy in the next Settings
POST. `saveSettings` removes `customIntents` only as part of that successful
write; a write error therefore leaves the original user text intact. Prompt
names are lower-case slash slugs, deduplicated with numeric suffixes, and are
never allowed to shadow a built-in slash command.

The slash autocomplete and empty-state examples both fill the compose box;
neither path sends a request. Because the pop-out receives the same settings
payload through the existing settings relay, it uses the same prompt list and
menu behavior without a new `window.opener` path.
