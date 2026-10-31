# FlowPilot fuzzers (round 4)

## Prompt fuzzer

The prompt fuzzer exercises FlowPilot's real HTTP routes and browser-shaped agent loop against the fixture flows in `prompt/fixtures/`. It applies accepted writes to an in-memory graph, then runs the same consent and diff-gate code used by the engine corpus. The code judge checks graph truth, port and wire validity, overlaps, validation, lint, expected types, targets, and write/consent outcomes. The OpenAI judge receives the original prompt(s), a code-built graph summary, and FlowPilot's final user-facing text.

### Stage into `nodered-test`

From the repository root, stage the test tree using the same archive pattern as the other corpora:

```sh
git archive --format=tar HEAD lib test flowpilot.js package.json | docker --context minux exec -i nodered-test tar -x -C /data/routing-s2
```

The container must have the FlowPilot package and its test provider setup already available. The runner reads Node-RED credentials from `NR_USER`/`NR_PASS`, or from `/data/.fp-test.env` when those variables are absent. It reads the `apiKey` only from the `openai-test` provider in `/data/flowpilot/settings.json`; the key is held in memory for the judge request and is never included in a result file or log.

### Run

Run from the staged repository (or from the checkout):

```sh
node test/fuzz/prompt/run.js
```

Useful controls are `ONLY=id1,id2`, `LIMIT=5`, `SEED=42`, `DELAY_MS=4000`, `OUTPUT_DIR=/data/routing-s2/test/fuzz/prompt/results`, and `JUDGE_MODEL=gpt-4.1`. Requests are serial; the default delay is four seconds for Spark's single stream. `node test/fuzz/prompt/run.js` leaves the active provider unchanged. Sr-Dev can switch providers with the existing `/data/ab-switch.js` workflow before starting a run.

The runner prints a category table and ends with the machine-readable line:

```text
PROMPT-FUZZ RESULT: <model> code <p>/<n> (<pct>%) · judge <p>/<n> (<pct>%) · both <p>/<n> (<pct>%) · errors <k>
```

Each `results-<timestamp>.json` contains the summary, code verdicts, LLM verdict and gaps, serialized tool-call transcript, and timings for every prompt. Read `code.failures` first: every code miss should be fixed or recorded with a reason. Then inspect `judge.gaps` for behavior the structural checks cannot see. Result files are intentionally not committed.

## UI fuzzer

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
