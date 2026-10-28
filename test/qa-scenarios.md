# FlowPilot QA scenarios: the standing script for every beta

This is the independent QA pass every beta must get before it reaches the product owner. The tester is a fresh
session that **hasn't seen the code changes**. It gets this file and `USER-GUIDE.md`, and it drives the real
Node-RED editor in a browser.

## Setup

- **Instance:** `nodered-test` (port 1850), with the build under test installed. Log in as the test user. The
  credential comes from the operator, never from this file.
- **Providers:** run every scenario on **both**:
  - **OpenAI `gpt-4.1`**;
  - **Spark 27B** (the LocalAI provider, thinking off). It's slower; allow 1–3 minutes per build step.
- **Debug mode on** (Settings, or `/debug`), so failures can be traced.
- **Windows:** run scenarios in the main sidebar. Run **2, 4, 6 and 8** a second time in the **pop-out** (↗ in the
  FlowPilot header).
- **Widths:** run the default sidebar width. Repeat **15**, plus a look at every card you saw, at the narrowest
  sidebar (**180 px**).
- **Hygiene:** start each scenario on a **new empty tab** (or the tab the scenario names) and press **Clear** first,
  unless the scenario says otherwise.

## Scenarios

Each scenario lists what to do and what must be true. Anything else that looks wrong counts as a finding too.

1. **A question about a selected flow.**
   - Build or import a small flow (inject → function → debug). Select it and ask "What does this flow do?"
   - **Pass:** a plain answer that names *these* nodes. No card, nothing changes on the canvas.
2. **A rename by direct edit, then Undo.**
   - Select one node and type "Rename this node to Formatter".
   - **Pass:** a result card (what changed, checks, Undo) and the node renamed. **Undo** on the card restores the
     old name.
3. **A function fix, then Test it.**
   - Make a function node with a bug (e.g. `msg.payload = msg.payload.toUppercase(); return msg;`) wired
     inject → function → debug. Select the function and ask FlowPilot to fix it.
   - **Pass:** the code is fixed. Press **Test it**: the run line shows the value observed at the end of the flow
     (e.g. `HELLO`). No FlowPilot test nodes are left on the canvas.
4. **A 5–7 node build from nothing.**
   - On an empty tab: "Fetch the weather from a public API every 5 minutes, store the temperature in a global
     variable, and show it in debug."
   - **Pass, all of these:**
     - every node is **wired** (no loose nodes);
     - the nodes are **laid out** left to right and none are stacked on another;
     - after Test it (or the run's own check), the run line shows a value **observed at the end node** (the
       store or debug node), not just the trigger's timestamp;
     - no red "Cannot wire" errors.
   - An unwired or partly wired result must **not** say "observed". It should say no output reached the end node.
5. **The same build with Auto off.**
   - Untick **Auto** and repeat scenario 4. **Pass:** a plan card with real steps (not just your sentence repeated);
     **Approve** builds it to the same standard as scenario 4.
6. **Deleting a 7-node selection.**
   - Select 7 nodes and type "Delete the selected nodes".
   - **Pass:**
     - **one** consent prompt that covers all 7 ("Delete these 7 nodes?");
     - one Proceed deletes them all;
     - one Undo brings them all back;
     - no stray "Plan: …" message afterwards.
7. **Adding a node that reaches outside Node-RED.**
   - Select an inject and type "Add an http request node after this that GETs https://api.github.com/zen". Repeat
     with an mqtt out node.
   - **Pass:** FlowPilot asks **before** adding it, in plain words ("wants to add an http request node (reaches
     outside Node-RED)"), with **Proceed / Skip this step**. Both choices behave as labelled.
8. **Clear and Stop at awkward moments.** Do each of these three times, and after each one, send "hi" to check it
   sends normally (not "queued"):
   - **(a)** Clear while a Proceed/Skip consent is waiting (use scenario 7).
   - **(b)** Clear while a question with options is waiting (e.g. "/modify" with nothing selected, or a vague
     request).
   - **(c)** Press **Stop** while a build is mid-run (scenario 4).
   - **Pass:** Send is enabled, the prompt box has its normal placeholder, and the next message runs. A click on an
     old chip from before the Clear does nothing.
9. **A queued message during a run.**
   - Start scenario 4, then type and send "also add a comment node explaining the flow" while it works.
   - **Pass:** the message is shown as queued. At the next step FlowPilot offers "Stop and do this instead" or "Do it
     after", and both work.
10. **A creative prompt with constraints.**
    - "Do something cool and unique, something I likely haven't seen before, but no http or exec nodes."
    - **Pass:** FlowPilot plans or builds something. It **doesn't** answer with a node picker or a "what would you
      like to do" question, and the result has **no http or exec nodes**.
11. **Targets.**
    - **(a)** With nothing selected, type `/modify make it faster`. **Pass:** a "Which one?" picker, not an error.
    - **(b)** On a tab with nodes named "Process" and "Output", select "Process" and ask "Set Process to multiply by
      2 and rename the Output debug node to Result". **Pass:** both changes are made without a pause asking about
      Output.
12. **Slash commands and saved prompts.**
    - **(a)** `/build fetch a random quote every minute and show it in debug`. **Pass:** the text is used as the goal
      (it doesn't ask for it again).
    - **(b)** Settings → Saved prompts: add `/explain-tab` ("Explain what the nodes on this tab do, in three
      bullets."), then Save. Type `/`: it's listed (saved prompts first). Pick it: the text fills the box and
      doesn't send. Send it: three bullets.
    - **(c)** Type `/ex` and press Enter: it picks the match, and it doesn't send "/ex" as a message.
13. **Restricted mode.**
    - Settings → **Restricted mode** → Save. Repeat scenario 2 and press Test it on any card.
    - **Pass:** a plan card even with Auto on; Test it says it can't run here ("You deploy, I'll watch"); nothing is
      deployed and no test nodes are added.
    - Turn Restricted mode off afterwards.
14. **A forced error.**
    - Settings → the LocalAI provider → Model: `no-such-model` → Save. Send "hi".
    - **Pass:** a plain, readable sentence (no HTML or stack trace), and the chat stays usable. Put the model back,
      Save, run Test Provider if asked, and check that a normal message works again.
15. **The ▾ menu and every card at 180 px and at the default width.**
    - At both widths, open the **▾** menu next to Send.
    - **Pass:**
      - the menu sits fully inside the panel;
      - the plan card, result card, consent prompt, `/` menu and Settings (scrolled to the bottom) show no clipped
        text and need no sideways scrolling.
    - Check the pop-out at a narrow width too.

## Exploratory (15 minutes, unscripted)

Try to break it, for example:
- with odd phrasing, typos and two requests in one message;
- by interrupting a run, double-clicking buttons, or pressing Clear twice;
- by switching providers mid-conversation;
- on a busy canvas with several tabs and nodes with the same name;
- by refreshing the page mid-run.

Write down everything that looks wrong, confusing or slow.

## Report format

- **Header:** the build (version and commit), the instance, and the date.
- **Table:** scenario × model (gpt-4.1 / Spark) × window (main / pop-out where run). Each cell is **Pass** or **Fail**.
- **Every failure:**
  - what you did;
  - what you expected;
  - what happened;
  - a **screenshot or GIF**;
  - the time (so the debug log can be matched).
- **Exploratory findings,** as a list, each with a screenshot where it's visual.
- **Verdict:** clean, or the list of failures.

A failure goes back to the developers. The rerun covers the failed scenarios **plus scenarios 4, 6 and 8**.
Loop until clean.
