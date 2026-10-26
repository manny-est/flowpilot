"use strict";

// R11-7: one implementation of "put nodes on the canvas", two front doors.
// (1) The agent WRITE executors and the classic Apply path call the same
//     core functions (applyInsertions / applyModifications / the shared
//     group creation) — checked against the REAL client source.
// (2) createGroupSafely (apply-review.js), now shared by both paths: creates
//     on success, removes exactly the group a failed createGroup orphaned,
//     and retries once.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const core = path.join(__dirname, "..", "lib", "core");
const main = fs.readFileSync(path.join(core, "main.js"), "utf8");
const review = fs.readFileSync(path.join(core, "apply-review.js"), "utf8");

function body(src, name) {
  const m = src.match(new RegExp("function " + name + "\\(([^)]*)\\) \\{[\\s\\S]*?\\n    \\}\\n"));
  assert.ok(m, "found " + name);
  return m[0];
}

// (1) shared core
assert.ok(/applyInsertions\(/.test(body(main, "executeApplyStepTool")), "apply_step inserts via applyInsertions");
assert.ok(/applyModifications\(/.test(body(main, "executeApplyStepTool")), "apply_step patches via applyModifications");
assert.ok(/applyModifications\(/.test(body(main, "executeRemoveStepTool")), "remove_step removes via applyModifications");
assert.ok(/applyModifications\(/.test(body(main, "executeRenameNodeTool")), "rename_node renames via applyModifications");
assert.ok(/createGroupSafely\(/.test(body(main, "executeGroupNodesTool")), "group_nodes creates via createGroupSafely");
assert.ok(!/RED\.group\.createGroup\(/.test(body(main, "executeGroupNodesTool")), "group_nodes has no private createGroup call");
assert.ok(/createGroupSafely\(/.test(body(review, "applyGroupChanges")), "classic Apply creates groups via createGroupSafely");
assert.ok(!/RED\.group\.createGroup\(/.test(body(review, "applyGroupChanges")), "classic Apply has no private createGroup call");
function codeCalls(src) { return src.split("\n").filter(function (l) { return !/^\s*\/\//.test(l) && /RED\.group\.createGroup\(/.test(l); }).length; }
assert.ok(codeCalls(review) === 1 && codeCalls(main) === 0,
  "exactly one createGroup call site in the client");

// (2) createGroupSafely against a fake RED
function makeRed(failures) {
  const groups = [];
  let calls = 0;
  const RED = {
    nodes: { groups: function (z) { return groups.filter(function (g) { return g.z === z; }); } },
    group: {
      createGroup: function (nodes) {
        calls++;
        const g = { id: "g" + calls, z: nodes[0].z, nodes: nodes.slice() };
        groups.push(g); // registered before population, like Node-RED core
        if (calls <= failures) { g.nodes = []; if (calls % 2) { throw new Error("boom " + calls); } return undefined; }
        return g;
      },
      ungroup: function (g) { const i = groups.indexOf(g); if (i !== -1) { groups.splice(i, 1); } }
    }
  };
  return { RED: RED, groups: groups, calls: function () { return calls; } };
}
const createSrc = body(review, "createGroupSafely");
function run(failures, preexisting) {
  const env = makeRed(failures);
  (preexisting || []).forEach(function (g) { env.groups.push(g); });
  const fn = new Function("RED", createSrc + "return createGroupSafely;")(env.RED);
  const res = fn([{ id: "a", z: "t1" }, { id: "b", z: "t1" }]);
  return { res: res, env: env };
}
let r = run(0);
assert.ok(r.res.group && r.env.calls() === 1 && r.env.groups.length === 1, "success: one call, one group");
r = run(1, [{ id: "user-group", z: "t1", nodes: [] }]);
assert.ok(r.res.group && r.env.calls() === 2, "one failure (throw) then retry succeeds");
assert.deepStrictEqual(r.env.groups.map(function (g) { return g.id; }).sort(), ["g2", "user-group"], "the orphan is removed; the user's own group is kept");
r = run(2);
assert.ok(!r.res.group && r.env.calls() === 2 && r.env.groups.length === 0, "two failures: no group, no orphan left");
console.log("apply-path-consolidation tests passed");
