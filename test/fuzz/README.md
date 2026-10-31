# UI fuzzer

The UI fuzzer drives the real Node-RED editor through the OpenClaw browser CLI. It uses a seeded action pool, checks invariants after every action, records the first failing sequence, and can delta-shrink a finding into a QA scenario.

Run one deterministic batch from the repository root:

```sh
node test/fuzz/ui/run.js \
  --seed 104729 --sequences 200 --length 25 \
  --instance nrt --profile fz-nrt --model-label gpt-4.1 \
  --out test/fuzz/ui/out
```

Use `--instance nr` with profile `fz-nr` for the other browser. Provider switching is deliberately disabled unless `--allow-provider-switch` is supplied. The harness reads `NR_USER` and `NR_PASS` only through the inherited environment when a live Node-RED session needs them; it never writes or reports those values.

Each sequence opens a fresh tab, clears the conversation, resizes to the normal 800×513 viewport, and checks the tab count, settings, provider, and deployment during cleanup. The action pool covers sending real prompts, busy Enter/Stop, Clear/Escape, plan and consent choices, queue choices, reload, settings, pop-out lifecycle, node selection, fixture import, and tab switching. Fixtures are imported with `RED.nodes.import(...)`.

The in-page evaluator returns one JSON object per check. It verifies:

- idle controls and the normal prompt placeholder;
- FlowPilot browser console errors;
- raw HTML/JSON, stack traces, node ids, and internal text in chat;
- approved/answered controls are disabled;
- result cards against `RED.nodes` and editor-authenticated `GET /flows`;
- rectangle overlap for touched nodes;
- duplicate message/card records;
- main/pop-out message record ids and text;
- exact conversation restoration after reload;
- `node.valid === false` for touched nodes.

Findings are `finding-<seed>-<n>.json` plus a screenshot path. Shrink one with:

```sh
node test/fuzz/ui/run.js --shrink test/fuzz/ui/out/finding-104729-0.json
```

The output is a Markdown scenario compatible with `test/qa-scenarios.md`. Every normal run writes `summary.json` and ends with a machine-readable `UI-FUZZ RESULT:` line.
