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
  "suggestedAction": { "mode": "generate" | "document" | "modify" | "chat", "prompt": "...", "selectionHint": "...", "targetNodeIds": "all" | ["real-node-id", "..."] }
}

- "mode": which FlowPilot action the chip switches to ("chat" for a follow-up
  conversation with no further generate/modify/document action).
- "prompt": the exact instruction text to pre-fill in the user's compose box —
  written as a ready-to-send request to FlowPilot, in the user's voice. Keep it
  as close as possible to the user's own words and requested scope. Do not
  expand it into a longer spec or add requirements, implementation choices, or
  assumptions the user did not state.
- "selectionHint" (optional): plain-language description of which node(s) the user
  should select before sending (only useful for "modify"/"document", which act on a
  selection).
- "targetNodeIds" (only for "modify"/"document"): REQUIRED whenever the current
  selection, active flow/tab, or other provided context makes the target
  resolvable. Use "all" when the entire active flow/tab is the resolved target,
  or a non-empty array of real node ids when a specific subset is the resolved
  target. Omit it only when you genuinely cannot resolve the target from the
  current context. Modify and Document require a resolved node set: never imply
  in "selectionHint" that no selection is needed unless "targetNodeIds"
  supplies it, and never emit an empty array.

The user reviews the prepared prompt and clicks Send themselves — nothing is sent
automatically. Omit "suggestedAction" if there's no clear follow-up; most responses
won't have one.`;
}

module.exports = {
  SECTION_SEPARATOR: SECTION_SEPARATOR,
  composePromptSections: composePromptSections,
  buildSuggestedActionFragment: buildSuggestedActionFragment
};
