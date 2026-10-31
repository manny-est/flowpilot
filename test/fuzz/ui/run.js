"use strict";

const fs = require("fs");
const path = require("path");
const { ACTIONS, chooseActions } = require("./actions");
const { buildInPageEvaluator, INVARIANT_NAMES } = require("./invariants");
const { OpenClawDriver, safeError } = require("./driver");
const { scenarioMarkdown, shrinkActions } = require("./shrink");
const fixtures = require("./fixtures");

function parseArgs(argv) {
  const result = { length: 25, sequences: 1, seed: 1, instance: "nrt", profile: "fz-nrt", modelLabel: "unspecified", out: path.resolve("test/fuzz/ui/out") };
  let profileProvided = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--allow-provider-switch") { result.allowProviderSwitch = true; continue; }
    if (arg === "--help" || arg === "-h") { result.help = true; continue; }
    if (arg === "--shrink") { result.shrink = argv[++i]; continue; }
    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      result[key] = argv[++i];
      if (key === "profile") profileProvided = true;
    }
  }
  ["seed", "sequences", "length"].forEach(key => {
    if (result[key] !== undefined) result[key] = Number(result[key]);
  });
  if (result.instance !== "nr" && result.instance !== "nrt") throw new Error("--instance must be nr or nrt");
  if (!profileProvided) result.profile = result.instance === "nr" ? "fz-nr" : "fz-nrt";
  if (!result.url) result.url = result.instance === "nr" ? "http://192.168.1.220:1880" : "http://192.168.1.220:1850";
  result.out = path.resolve(String(result.out));
  return result;
}

function usage() {
  return [
    "node test/fuzz/ui/run.js [options]",
    "  --seed N --sequences N --length N --instance nr|nrt --profile NAME",
    "  --model-label LABEL --out DIR [--allow-provider-switch]",
    "  --shrink finding-SEED-N.json"
  ].join("\n");
}

function formatResultLine(modelLabel, instance, sequences, actions, violations, byInvariant) {
  return "UI-FUZZ RESULT: " + modelLabel + " " + instance + " sequences " + sequences +
    " · actions " + actions + " · violations " + violations + " · by invariant " + JSON.stringify(byInvariant);
}

function messageSnapshotSource() {
  return "() => [...document.querySelectorAll('#fp-messages > *')].map((element, index) => ({ id: element.getAttribute('data-fp-record-id') || element.id || 'dom-' + index, text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim() }))";
}

async function readMessages(driver) {
  const value = await driver.evaluate(messageSnapshotSource());
  return Array.isArray(value) ? value : [];
}

async function readSettings(driver) {
  const value = await driver.evaluate("() => { const auto = document.getElementById('fp-auto-toggle'); const restricted = document.getElementById('fp-restricted-toggle'); const provider = document.getElementById('fp-provider-select'); return { auto: !!(auto && auto.checked), restricted: !!(restricted && restricted.checked), provider: provider && provider.value }; }");
  return value || {};
}

async function restoreSettings(driver, settings) {
  if (!settings) return;
  await driver.evaluate("() => { const expected = " + JSON.stringify(settings) + "; const auto = document.getElementById('fp-auto-toggle'); const restricted = document.getElementById('fp-restricted-toggle'); const provider = document.getElementById('fp-provider-select'); if (auto && auto.checked !== expected.auto) { auto.click(); } if (restricted && restricted.checked !== expected.restricted) { restricted.click(); } if (provider && expected.provider && provider.value !== expected.provider) { provider.value = expected.provider; provider.dispatchEvent(new Event('change', { bubbles: true })); } const save = document.getElementById('fp-save-settings'); if (save) save.click(); return true; }");
}

// Only a real FlowPilot pop-out tab counts; any other open tab (an unrelated
// editor tab) would make every parity check a false finding.
async function findPopout(driver, mainTab) {
  const tabs = await driver.tabs();
  const key = tab => tab && (tab.targetId || tab.tabId || tab.id);
  const mainId = key(mainTab);
  const candidate = tabs.find(tab => key(tab) !== mainId && /\/flowpilot\/popout\//.test(String(tab.url || "")));
  driver.popoutTab = candidate || null;
  return candidate || null;
}

async function capturePopoutMessages(driver, mainTab) {
  const popout = await findPopout(driver, mainTab);
  if (!popout) return null;
  try {
    await driver.focus(popout);
    return await readMessages(driver);
  } finally {
    if (mainTab) await driver.focus(mainTab);
  }
}

// Every sequence works on its OWN Node-RED flow tabs. The instance's own tabs
// (recorded once, before the first sequence) are never edited, never the
// target of a fixture or a build, and never deleted: guardFuzzTab() moves back
// to a fuzz tab before every action, and cleanup deletes only fuzz tabs.
const GUARD_JS = "() => { const base = window.__fzBase || []; const mine = (window.__fzTabs || []).filter(id => RED.nodes.workspace(id));" +
  " if (!mine.length) { RED.actions.invoke('core:add-flow'); mine.push(RED.workspaces.active()); }" +
  " window.__fzTabs = mine; if (base.includes(RED.workspaces.active()) || !mine.includes(RED.workspaces.active())) { RED.workspaces.show(mine[0]); }" +
  " return RED.workspaces.active(); }";

async function guardFuzzTab(driver) {
  return driver.evaluate(GUARD_JS);
}

async function startSequence(driver, url, initialTabs, baseWorkspaces) {
  await driver.open(url);
  // A real desktop window with Node-RED's default 300 px sidebar (the design
  // width, ADR-015 Amendment 3), not OpenClaw's 800x513 default viewport.
  await driver.resize(1600, 1000);
  await new Promise(resolve => setTimeout(resolve, 8000));
  await driver.evaluate("() => { window.__fzBase = " + JSON.stringify(baseWorkspaces || []) + "; window.__fzTabs = [];" +
    " const c = document.getElementById('red-ui-sidebar'); if (c) { c.style.width = '300px'; RED.events.emit('sidebar:resize'); }" +
    " if (RED.sidebar && RED.sidebar.show) { RED.sidebar.show('flowpilot'); } return true; }");
  await guardFuzzTab(driver);
  await driver.click("#fp-clear-chat");
  await new Promise(resolve => setTimeout(resolve, 300));
  return driver.mainTab || (await driver.tabs()).slice(-1)[0] || initialTabs[initialTabs.length - 1];
}

async function cleanupSequence(driver, mainTab, initialTabs, settings) {
  try {
    if (driver.popoutTab) await driver.deleteTab(driver.popoutTab);
    if (mainTab) {
      await driver.focus(mainTab);
      // Delete only this run's flow tabs (never the instance's own), then deploy.
      // Never deploy unless every one of the instance's own tabs is loaded:
      // a deploy from a half-loaded editor could overwrite the user's flows.
      const safe = await driver.evaluate("() => { const base = window.__fzBase || []; const order = RED.nodes.getWorkspaceOrder(); if (!base.length || !base.every(id => order.includes(id))) return false; order.filter(id => !base.includes(id)).forEach(id => { const ws = RED.nodes.workspace(id); if (ws) RED.workspaces.delete(ws); }); return true; }");
      if (safe === true) { await driver.deploy(); }
    }
    await restoreSettings(driver, settings);
  } catch (error) {
    // Cleanup is best effort; the finding contains the original invariant
    // evidence and the final tab count is still recorded below.
  }
  const current = await driver.tabs().catch(() => []);
  const key = tab => tab && (tab.targetId || tab.tabId || tab.id);
  const originalIds = new Set(initialTabs.map(key));
  for (const tab of current) {
    const id = key(tab);
    if (!originalIds.has(id)) await driver.deleteTab(tab);
  }
  return driver.tabs().catch(() => []);
}

async function runAction(driver, item, state, context, rng) {
  const result = await item.do(driver, state, rng, context);
  return result || {};
}

async function checkAfterAction(driver, context, beforeMessages, actionName) {
  const consoleErrors = await driver.captureConsole().catch(() => []);
  const currentMessages = await readMessages(driver).catch(() => []);
  // The pop-out mirrors through postMessage, so give it a moment to settle:
  // compare up to 3 times, 1.5 s apart, before calling it a mismatch.
  let popoutMessages = await capturePopoutMessages(driver, context.mainTab).catch(() => null);
  const squash = list => JSON.stringify((list || []).map(item => String(item.text || "").replace(/\s+/g, "")));
  for (let tries = 0; popoutMessages && tries < 2 && squash(popoutMessages) !== squash(currentMessages); tries++) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    popoutMessages = await capturePopoutMessages(driver, context.mainTab).catch(() => null);
  }
  const currentNodeIds = await driver.evaluate("() => { const z = RED.nodes && RED.nodes.workspace ? RED.nodes.workspace.id : (RED.workspaces && RED.workspaces.active ? RED.workspaces.active() : undefined); return RED.nodes && RED.nodes.filterNodes ? RED.nodes.filterNodes({ z }).map(node => node.id) : []; }").catch(() => []);
  if (Array.isArray(currentNodeIds)) {
    context.touchedNodeIds = Array.from(new Set(context.touchedNodeIds.concat(currentNodeIds)));
  }
  const expected = {
    afterReload: actionName === "reload",
    reloadMessages: actionName === "reload" ? beforeMessages : undefined,
    popoutMessages: popoutMessages || undefined,
    consoleErrors,
    touchedNodeIds: context.touchedNodeIds,
    fetchFlows: true
  };
  const result = await driver.evaluate(buildInPageEvaluator(expected));
  return { result: result || { violations: [], evidence: {} }, currentMessages, popoutMessages };
}

async function writeFinding(driver, outDir, seed, number, actionLog, violation, evidence) {
  const base = "finding-" + seed + "-" + number;
  const screenshot = await driver.screenshot(path.join(outDir, base + ".png")).catch(() => null);
  const finding = {
    seed,
    actionLog,
    invariant: violation.invariant,
    violation,
    evidence,
    screenshotPath: screenshot || path.join(outDir, base + ".png")
  };
  fs.writeFileSync(path.join(outDir, base + ".json"), JSON.stringify(finding, null, 2) + "\n");
  return finding;
}

async function runSequence(driver, options, sequenceNumber) {
  const seed = Number(options.seed) + sequenceNumber;
  const initialTabs = await driver.tabs();
  let settings = {};
  const context = {
    allowProviderSwitch: !!options.allowProviderSwitch,
    fixtures,
    touchedNodeIds: [],
    mainTab: null
  };
  const actionLog = [];
  const findings = [];
  let actionsRun = 0;
  let mainTab;
  try {
    mainTab = await startSequence(driver, options.url, initialTabs, options.baseWorkspaces);
    context.mainTab = mainTab;
    settings = await readSettings(driver).catch(() => ({}));
    for (let actionIndex = 0; actionIndex < options.length; actionIndex += 1) {
      const beforeMessages = await readMessages(driver).catch(() => []);
      const state = await driver.actionState().catch(() => ({}));
      const item = chooseActions({
        seed: String(seed) + ":" + actionIndex,
        length: 1,
        context,
        state
      })[0];
      await guardFuzzTab(driver);
      const entry = { index: actionsRun, name: item.name };
      actionLog.push(entry);
      // An action the page refuses (a stale button, a gateway hiccup) is
      // logged and the sequence goes on; only invariants make findings.
      try { await runAction(driver, item, state, context, chooseRngForAction(seed, actionsRun)); }
      catch (error) { entry.error = String(error && error.message || error).split("\n")[0].slice(0, 200); }
      actionsRun += 1;
      const checked = await checkAfterAction(driver, context, beforeMessages, item.name);
      const violations = Array.isArray(checked.result.violations) ? checked.result.violations : [];
      if (violations.length) {
        for (const violation of violations) {
          const finding = await writeFinding(driver, options.out, seed, findings.length, actionLog, violation, checked.result.evidence && checked.result.evidence[violation.invariant]);
          findings.push(finding);
        }
        break;
      }
    }
  } finally {
    const endTabs = await cleanupSequence(driver, mainTab, initialTabs, settings);
    if (endTabs.length !== initialTabs.length) {
      const violation = { invariant: "tab-hygiene", message: "browser tab count was not restored" };
      const finding = await writeFinding(driver, options.out, seed, findings.length, actionLog, violation, { initial: initialTabs.length, final: endTabs.length });
      findings.push(finding);
    }
  }
  return { seed, actions: actionsRun, findings, actionLog };
}

function chooseRngForAction(seed, index) {
  const { createRng } = require("./actions");
  return createRng(String(seed) + ":" + index);
}

async function shrinkFinding(file, options) {
  const finding = JSON.parse(fs.readFileSync(file, "utf8"));
  const sourceActions = (finding.actionLog || []).map(item => item.name || item.action || item);
  const driver = new OpenClawDriver({ profile: options.profile, url: options.url });
  const actionMap = new Map(ACTIONS.map(item => [item.name, item]));
  const replay = async candidate => {
    const initialTabs = await driver.tabs();
    const main = await startSequence(driver, options.url, initialTabs);
    const context = { allowProviderSwitch: !!options.allowProviderSwitch, fixtures, touchedNodeIds: [], mainTab: main };
    try {
      for (let i = 0; i < candidate.length; i += 1) {
        const item = actionMap.get(candidate[i]);
        if (!item) continue;
        const state = await driver.actionState();
        await runAction(driver, item, state, context, chooseRngForAction(finding.seed, i));
        const checked = await checkAfterAction(driver, context, [], item.name);
        if ((checked.result.violations || []).some(itemViolation => itemViolation.invariant === finding.invariant)) return true;
      }
      return false;
    } finally {
      await cleanupSequence(driver, main, initialTabs, {});
    }
  };
  const shortest = await shrinkActions(sourceActions, replay);
  process.stdout.write(scenarioMarkdown(finding, shortest) + "\n");
  return shortest;
}

async function main(argv) {
  const options = parseArgs(argv || process.argv.slice(2));
  if (options.help) { process.stdout.write(usage() + "\n"); return; }
  if (options.shrink) { await shrinkFinding(options.shrink, options); return; }
  fs.mkdirSync(options.out, { recursive: true });
  const driver = new OpenClawDriver({ profile: options.profile, url: options.url });
  await driver.start();
  // The instance's own flow tabs, read once from the profile's open editor
  // tab before anything runs. Without them the fuzzer can't tell its tabs
  // from the user's, so it refuses to run.
  const base = await driver.evaluate("() => (window.RED && RED.nodes && RED.nodes.getWorkspaceOrder) ? RED.nodes.getWorkspaceOrder() : null").catch(() => null);
  if (!Array.isArray(base) || !base.length) {
    throw new Error("Open and log in to the Node-RED editor in profile " + options.profile + " first; the fuzzer needs the instance's own tab list.");
  }
  options.baseWorkspaces = base;
  const summary = {
    seed: options.seed,
    modelLabel: options.modelLabel,
    instance: options.instance,
    sequences: 0,
    actions: 0,
    violations: 0,
    byInvariant: Object.fromEntries(INVARIANT_NAMES.map(name => [name, 0])),
    findings: []
  };
  for (let sequence = 0; sequence < options.sequences; sequence += 1) {
    const result = await runSequence(driver, options, sequence);
    summary.sequences += 1;
    summary.actions += result.actions;
    summary.violations += result.findings.length;
    result.findings.forEach(finding => {
      summary.findings.push(path.basename(finding.screenshotPath || ""));
      if (summary.byInvariant[finding.invariant] === undefined) summary.byInvariant[finding.invariant] = 0;
      summary.byInvariant[finding.invariant] += 1;
    });
  }
  fs.writeFileSync(path.join(options.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(formatResultLine(options.modelLabel, options.instance, summary.sequences, summary.actions, summary.violations, summary.byInvariant) + "\n");
  return summary;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(safeError(error) + "\n");
    process.exitCode = 1;
  });
}

module.exports = {
  formatResultLine,
  main,
  parseArgs,
  runSequence,
  usage
};
