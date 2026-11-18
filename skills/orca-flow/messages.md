# Messages to the user

Every message you write to the user uses one fixed frame. The middle of the frame is one of 7
bodies. An ask uses one of 4 reply forms. A coordinator that only routes work writes one route line
instead.

**Who uses it:** coordinators and leads, in every message to the user. A worker's `worker_done`
report to its lead is exempt. Orchestration commands (`ask`, `send`, `reply`) are not messages to
the user.

## The frame

Write the frame as one column. Each block starts with its bold label, and the text follows on the
same line. Use the blocks in this order:

1. **Header:** the whole line is bold: ticket · workstream · level, for example
   `**BOU-4206 · Split short docs into lessons · today**`. No ticket: workstream · level.
2. **Status:** one of the five status words (below).
3. **Body:** the blocks of one body (below). One message can hold more than one body, in this
   order: Diagnosis, Plan, Progress, Result.
4. **Ask:** only when you need the user. One question, at most 25 words.
5. **Reply:** only with an Ask, or with Status Blocked. The exact words the user types.
6. **Warning / Caution:** only when something is risky. Warning: the user cannot undo it, or it
   costs money. Caution: it can break work. Put it before the step it is about.
7. **Next:** what you do after the reply, or meanwhile. With no Ask: `Next: nothing needed from
   you.`

The frame is always the last part of the message. The user enters a session at its bottom. Put
detail that does not fit a block (long reasoning, logs, file lists) above the frame, never in it.

## Status words

Use exactly one of these on the Status line. The sidebar reads it as it is.

| Status | Means | Has an Ask |
| --- | --- | --- |
| Working | You or your workers are busy. Nothing needed from the user. | No |
| Waiting on you: <type> | You stopped until the user replies. Type: decision, approval, review or info. | Yes |
| Blocked | Something outside the code stops the work: a device, an account, a person. Usually a Procedure. | Yes |
| Ready for review | The work is finished. A PR or result waits for the user to look at it. | Yes (review) |
| Done | The workstream is finished: the PR merged, or the user called it done. | No |

## Bodies

| Body | Use it when | Blocks, in order |
| --- | --- | --- |
| Progress | You started, or finished a step | Done: 1–3 bullets |
| Plan | Before bigger work, so the user can stop a wrong approach early | Plan: numbered steps, one action each |
| Diagnosis | You found why something behaves wrongly | Problem, Cause, Evidence |
| Procedure | The user must do something by hand (phone, account, secret) | Steps: numbered, one action each |
| Result | Work is finished and ready to look at | Result, Evidence, Link |
| Answer | The user asked a question | Answer, Evidence |
| Briefing | A coordinator greets the user, or the user asks what is next (coordinators only) | Waiting, Running, Room |

A Briefing has no Status line.

**Route line:** when a coordinator only hands work to a lead, it writes one line and no frame:
`BOU-4206 → lead in mono/bou-4206-aic-split-lessons · today`
(`<ticket or workstream> → lead in <repo>/<worktree> · <level>`).

## Asks

| Ask type | The Ask holds | Reply line |
| --- | --- | --- |
| decision | The question, then options A, B, C as bullets. Mark one option recommended. Give each option its result in one line. | `Reply: A or B` |
| approval | One thing that is ready, as a yes/no question | `Reply: yes or no` |
| review | The link, and what to look at first | `Reply: approve, or your comments` |
| info | The one fact you need, and why | `Reply: the fact (for example: the file path)` |

Something only the user can do outside the chat (a setting, a login, a command) is not an ask
type. Use Status Blocked with a Procedure body, then `Reply: done`.

One Ask per message. When you have more questions, ask the most important one and add `(+2 more)`.

## Writing rules

Write about 80% of [ASD-STE100 Simplified Technical English](https://themenonlab.blog/blog/asd-ste100-simplified-technical-english-prompting).
Normal phrasing is permitted; these rules are not optional:

- Use one meaning per word, and the same term every time. A worktree is never a checkout or a branch.
- Write at most 20 words in an instruction sentence, and 25 in a description.
- Write one action per step, in the imperative: Turn on Developer Mode.
- Use the active voice. Say who does it.
- Put no more than 3 nouns in a row.
- Never change the labels, the status words or the priority words (now, today, soon, someday).

## Examples

1. A Linear task comes to a coordinator. The coordinator writes a route line only:

```markdown
BOU-4206 → lead in mono/bou-4206-aic-split-lessons · today
```

The lead's first message is a Plan:

```markdown
**BOU-4206 · Split short docs into lessons · today**
**Status:** Working

**Plan:**
1. Find why the Kaimug PDF gives 1 lesson.
2. Change the planner so a short topic can be a lesson.
3. Run the plan eval on the corpus and on Kaimug.

**Next:** nothing needed from you. I write again when I know the cause.
```

2. The lead found a cause and needs a decision:

```markdown
**BOU-4206 · Split short docs into lessons · today**
**Status:** Waiting on you: decision

**Problem:** the Kaimug PDF gives 1 lesson. Expected: about 4.
**Cause:** the planner merges each lesson under 400 tokens into a neighbor. 4 of the 5 Kaimug topics are under 400 tokens.
**Evidence:** plan.ts:173 sets LESSON_FLOOR to 400. Topic sizes are 103, 181, 15, 411 and 93 tokens.

**Ask:** make 1 topic = 1 lesson, with a minimum of 80 tokens. Which documents get this rule?
- **A. All documents (recommended).** Hygiene changes from 1–3 lessons to 6–10.
- **B. Only documents under 1,200 tokens.** Long manuals do not change. The planner gets a special case.
**Reply:** A or B

**Caution:** the plan eval uses Azure OpenAI credits. I ask before I run it.
**Next:** I change the prompt, the minimum, the screen count and the quiz size. Then I run the tests.
```

3. The user must do something by hand:

```markdown
**Isola on-demand services · soon**
**Status:** Blocked

**Problem:** the iPhone build stops at Xcode. Developer Mode is off on the phone.

**Steps:**
1. On the iPhone, open Settings > Privacy & Security > Developer Mode.
2. Turn on Developer Mode. Let the phone restart.
3. After the restart, tap Turn On and enter the passcode.
4. If "Trust This Computer?" shows, tap Trust.
5. Keep the phone unlocked and on the same Wi-Fi as the Mac.

**Reply:** done
**Next:** I run the device build again.
```

4. A worker finished and the PR is ready:

```markdown
**Isola on-demand services · soon**
**Status:** Ready for review

**Result:** every isola service in mono starts on demand. A Metro service runs the Expo app.
**Evidence:** pnpm dev:native works on the iOS simulator and the Android emulator. A real iPhone run is not tested.
**Link:** PR #6227

**Ask:** review the PR. Look first at the on-demand config in isola.yaml.
**Reply:** approve, or your comments
**Next:** I fix your comments. I send worker_done when the PR merges.
```

5. A step finished, and nothing is needed:

```markdown
**AI Create v2 production readiness · today**
**Status:** Working

**Done:**
- Runs are durable and rate-limited.
- Image dedup is in. 2 workers measure course memory now.

**Next:** nothing needed from you. I write again when the memory numbers are in.
```

6. The user asked a question:

```markdown
**orca-flow · sidebar**
**Status:** Done

**Answer:** the row is gray because the worker finished. A finished session stays in its place, dimmed, until Orca closes it.
**Evidence:** view.ts marks the row finished. panel.css:105 sets its opacity to 0.55.

**Next:** nothing needed from you.
```

7. A coordinator briefing:

```markdown
**bounti · briefing**

**Waiting:**
1. today · BOU-4206 needs a decision: 1 topic = 1 lesson for all documents?
2. soon · Isola on-demand services needs a review: PR #6227.
**Running:** AI Create v2 production readiness, Draft shifts missing from calendar.
**Room:** 1 more worktree, or 4 more agents.

**Next:** nothing needed from you. Say "next" to open item 1.
```

## How it is checked

- The check reads only the last message of a turn.
- The frame starts at the Header: a line that is bold as a whole (`**...**`) with at least one
  ` · `. Text above it is free.
- A `**Status:**` line comes right after the Header, with exactly one of: Working · Waiting on
  you: decision|approval|review|info · Blocked · Ready for review · Done. A coordinator Briefing
  (Waiting, Running, Room) has no Status line.
- The last non-empty line starts with `**Next:**`.
- Status Waiting on you, Blocked or Ready for review: a `**Reply:**` line is present.
- Every bold label at the start of a frame line is one of: Status, Done, Plan, Problem, Cause,
  Evidence, Steps, Result, Link, Answer, Waiting, Running, Room, Ask, Reply, Warning, Caution,
  Next. Option bullets such as `- **A. ...**` are not labels.
- A coordinator message made only of route lines (`X → lead in <repo>/<worktree> · <level>`)
  passes with no frame.
- The check ignores lines in ``` code fences.
- Where it runs: a Claude Code Stop hook that the plugin installs. It runs only in Orca agent
  terminals, only for coordinators and leads, and only where the user opted in: `"messageFormat"`
  in `~/.orca-flow/config.json` is `"all"`, or a list of worktree or coordinator folder paths.
- On a miss, it stops the turn one time and names the rule. Fix the frame and end the turn again.
  It logs misses to `~/.orca-flow/format-misses.jsonl`.

The format changes with the user's feedback. Each change updates this file and the checker
(`scripts/frame.mjs`) together.
