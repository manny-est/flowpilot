# Prompt fuzzer

The prompt fuzzer exercises FlowPilot's real HTTP routes and browser-shaped agent loop against the fixture flows in `prompt/fixtures/`. It applies accepted writes to an in-memory graph, then runs the same consent and diff-gate code used by the engine corpus. The code judge checks graph truth, port and wire validity, overlaps, validation, lint, expected types, targets, and write/consent outcomes. The OpenAI judge receives the original prompt(s), a code-built graph summary, and FlowPilot's final user-facing text.

## Stage into `nodered-test`

From the repository root, stage the test tree using the same archive pattern as the other corpora:

```sh
git archive --format=tar HEAD test/fuzz | docker exec -i nodered tar -x -C /data/routing-s2
```

The container must have the FlowPilot package and its test provider setup already available. The runner reads Node-RED credentials from `NR_USER`/`NR_PASS`, or from `/data/.fp-test.env` when those variables are absent. It reads the `apiKey` only from the `openai-test` provider in `/data/flowpilot/settings.json`; the key is held in memory for the judge request and is never included in a result file or log.

## Run

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
