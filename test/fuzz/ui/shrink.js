"use strict";

function isPromise(value) {
  return value && typeof value.then === "function";
}

async function callsFailure(replay, actions) {
  const result = replay(actions);
  return !!(isPromise(result) ? await result : result);
}

// Delta debugging: remove increasingly large contiguous chunks, retaining a
// candidate only when the same replay predicate still fails. The result is a
// shortest locally irreducible subsequence and preserves original ordering.
async function shrinkActions(actions, replay, options) {
  const opts = options || {};
  let current = Array.isArray(actions) ? actions.slice() : [];
  if (!current.length || !(await callsFailure(replay, current))) return current;
  let granularity = Math.max(2, Number(opts.granularity || 2));
  while (current.length >= 2) {
    const chunkSize = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length; start += chunkSize) {
      const candidate = current.slice(0, start).concat(current.slice(start + chunkSize));
      if (!candidate.length) continue;
      if (await callsFailure(replay, candidate)) {
        current = candidate;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    if (granularity >= current.length) break;
    granularity = Math.min(current.length, granularity * 2);
  }
  return current;
}

function actionName(action) {
  return typeof action === "string" ? action : action && (action.name || action.action) || "unknown";
}

function scenarioMarkdown(finding, actions) {
  const invariant = finding.invariant || finding.violation && finding.violation.invariant || "unknown";
  const seed = finding.seed === undefined ? "unknown" : finding.seed;
  const lines = [
    "### UI fuzzer seed " + seed + " — " + invariant,
    "",
    "- **Invariant:** " + invariant,
    "- **Seed:** " + seed,
    "- **Shortest action sequence:** " + actions.length,
    "",
    "| Step | Action |",
    "|---:|---|"
  ];
  actions.forEach((item, index) => lines.push("| " + (index + 1) + " | " + actionName(item) + " |"));
  lines.push("", "- **Evidence:** " + JSON.stringify(finding.evidence || {}, null, 2));
  return lines.join("\n");
}

module.exports = {
  scenarioMarkdown,
  shrinkActions
};
