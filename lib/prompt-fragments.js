"use strict";

const SECTION_SEPARATOR = "\n\n---\n\n";

function composePromptSections(sections) {
  return (Array.isArray(sections) ? sections : [])
    .filter(function (section) { return typeof section === "string" && section.length > 0; })
    .join(SECTION_SEPARATOR);
}

function buildSuggestedActionFragment(options) {
  const opts = options || {};
  const responseContext = opts.responseContext
    ? " — " + opts.responseContext + " —"
    : ",";
  const responseTarget = opts.responseTarget || '"explanation"/"flow"';
  const optionalPrefix = opts.inlineOptional ? " optional" : "\noptional";

  return `Optional: suggesting a follow-up action (a "chip"):

If there's an obvious, single one-click follow-up the user would want after this
response${responseContext} include an${optionalPrefix} "suggestedAction" key alongside ${responseTarget}:

{
  "suggestedAction": { "mode": "generate" | "document" | "modify" | "chat", "prompt": "...", "selectionHint": "..." }
}

- "mode": which FlowPilot action the chip switches to ("chat" for a follow-up
  conversation with no further generate/modify/document action).
- "prompt": the exact instruction text to pre-fill in the user's compose box —
  written as a ready-to-send request to FlowPilot, in the user's voice.
- "selectionHint" (optional): plain-language description of which node(s) the user
  should select before sending (only useful for "modify"/"document", which act on a
  selection).

The user reviews the prepared prompt and clicks Send themselves — nothing is sent
automatically. Omit "suggestedAction" if there's no clear follow-up; most responses
won't have one.`;
}

module.exports = {
  SECTION_SEPARATOR: SECTION_SEPARATOR,
  composePromptSections: composePromptSections,
  buildSuggestedActionFragment: buildSuggestedActionFragment
};
