"use strict";

// ---- Provider presets (0.6.3, §2C / ADR-012) -------------------------------
// Presets are DATA, not code branches — see ADR-012. Adding a future
// provider means adding an entry here, never a new Settings field or a new
// code path. Every baseUrl/authHeader/apiKeyRequired default below is
// confirmed against that provider's own CURRENT official docs (checked
// 2026-09-23, source cited per entry) — not recollection.
//
// Shape of one preset entry:
//   id                — stable string, stored on the provider profile as
//                       presetId (purely descriptive; providerType/baseUrl/
//                       etc. are still what the adapters actually read).
//   label             — shown in the Provider dropdown.
//   providerType      — "openai-compatible" or "anthropic" (which adapter
//                       lib/provider-*.js this preset uses).
//   baseUrl           — the documented base URL. For "anthropic", "" means
//                       "leave blank for the default api.anthropic.com",
//                       matching that adapter's own existing convention.
//   apiKeyRequired    — whether the API key field shows by default. Local
//                       servers without auth hide it (per §2C); a user who
//                       genuinely needs one on a local server (e.g. vLLM
//                       with --api-key) can still use the Custom preset,
//                       which always shows the field — kept simple
//                       deliberately, per the guiding rule.
//   modelIdsMaySlash  — true when this provider's own model ids contain "/"
//                       (e.g. "anthropic/claude-sonnet-5") — a flag for any
//                       code that might otherwise treat the model string as
//                       a path segment, filename, cache key, or DOM id.
//   capabilitiesField — for OpenAI-compatible presets whose /models response
//                       exposes a field indicating tool-calling support
//                       (OpenRouter: "supported_parameters", containing
//                       "tools" when the model supports it) — null when the
//                       provider doesn't expose this, meaning FlowPilot
//                       falls back to its own live capability probe.
//   supportsZdr       — whether this preset exposes the ZDR (zero data
//                       retention) request toggle (OpenRouter-specific,
//                       §2D) — sends `provider:{zdr:true}` in the request
//                       body when the user turns it on. Off by default;
//                       this can only ENFORCE ZDR per request, never
//                       disable an account-level enforcement setting.
//   supportsAttribution — whether this preset exposes the optional
//                       attribution-header toggle (OpenRouter-specific,
//                       §2D/§5open#1) — HTTP-Referer + X-Title. Off by
//                       default pending Manny's decision (§5).
//   docsUrl           — the official doc this entry's defaults were
//                       confirmed against.
const PROVIDER_PRESETS = [
  {
    id: "openai",
    label: "OpenAI",
    providerType: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyRequired: true,
    modelIdsMaySlash: false,
    capabilitiesField: null,
    supportsZdr: false,
    supportsAttribution: false,
    docsUrl: "https://developers.openai.com/api/reference/overview"
  },
  {
    id: "anthropic",
    label: "Anthropic",
    providerType: "anthropic",
    baseUrl: "",
    apiKeyRequired: true,
    modelIdsMaySlash: false,
    capabilitiesField: null,
    supportsZdr: false,
    supportsAttribution: false,
    docsUrl: "https://docs.claude.com/en/api/messages"
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    providerType: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyRequired: true,
    modelIdsMaySlash: true,
    capabilitiesField: "supported_parameters",
    supportsZdr: true,
    supportsAttribution: true,
    docsUrl: "https://openrouter.ai/docs/quickstart"
  },
  {
    id: "ollama",
    label: "Ollama",
    providerType: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    apiKeyRequired: false,
    modelIdsMaySlash: false,
    capabilitiesField: null,
    supportsZdr: false,
    supportsAttribution: false,
    docsUrl: "https://docs.ollama.com/api/openai-compatibility"
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    providerType: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    apiKeyRequired: false,
    modelIdsMaySlash: false,
    capabilitiesField: null,
    supportsZdr: false,
    supportsAttribution: false,
    docsUrl: "https://lmstudio.ai/docs/developer/openai-compat"
  },
  {
    id: "localai",
    label: "LocalAI",
    providerType: "openai-compatible",
    baseUrl: "http://localhost:8080/v1",
    apiKeyRequired: false,
    modelIdsMaySlash: false,
    capabilitiesField: null,
    supportsZdr: false,
    supportsAttribution: false,
    docsUrl: "https://localai.io/docs/features/authentication/"
  },
  {
    id: "llamacpp",
    label: "llama.cpp server",
    providerType: "openai-compatible",
    baseUrl: "http://127.0.0.1:8080/v1",
    apiKeyRequired: false,
    modelIdsMaySlash: false,
    capabilitiesField: null,
    supportsZdr: false,
    supportsAttribution: false,
    docsUrl: "https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md"
  },
  {
    id: "vllm",
    label: "vLLM",
    providerType: "openai-compatible",
    baseUrl: "http://localhost:8000/v1",
    apiKeyRequired: false,
    modelIdsMaySlash: false,
    capabilitiesField: null,
    supportsZdr: false,
    supportsAttribution: false,
    docsUrl: "https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/"
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    providerType: "openai-compatible",
    baseUrl: "",
    // Custom always shows the API key field — this is the deliberate
    // escape hatch for any provider/setup a named preset doesn't cover
    // (including a local server someone HAS put a key on).
    apiKeyRequired: true,
    modelIdsMaySlash: false,
    capabilitiesField: null,
    supportsZdr: false,
    supportsAttribution: false,
    docsUrl: null
  }
];

function getPreset(id) {
  return PROVIDER_PRESETS.find(function (p) { return p.id === id; }) || null;
}

// Migration (§2C): every existing saved provider (predates presets
// entirely) maps to a preset with ZERO behavior change and confirmation
// preserved. providerType "anthropic" always maps to the "anthropic"
// preset; anything else (today, always "openai-compatible") maps to
// "custom" — never to a named preset like "openai"/"openrouter", since a
// pre-existing provider's own baseUrl/apiKeyRequired shape must be left
// exactly as the user configured it, not silently reinterpreted as
// matching some preset's own defaults.
function presetIdForExistingProvider(provider) {
  if (provider && provider.type === "anthropic") { return "anthropic"; }
  return "custom";
}

module.exports = { PROVIDER_PRESETS, getPreset, presetIdForExistingProvider };
