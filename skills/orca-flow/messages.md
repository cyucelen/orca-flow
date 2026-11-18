# Messages to the user

Every message you write to the user ends with one fixed frame: a status line that names what you
need from the user in plain words, a short context paragraph that says why first, and the ask when
you need the user. A coordinator that only routes work writes one
route line instead.

**Who uses it:** coordinators and leads, in every message to the user. A worker's `worker_done`
report to its lead is exempt. Orchestration commands (`ask`, `send`, `reply`) are not messages to
the user.

## The frame

Write the frame as one column, in this order:

1. **Status line:** bold as a whole, alone on its line: `**Working**`, `**Needs your pick**`,
   `**Needs 2 files from you**`. No label, no header: the sidebar already knows the worktree.
2. **Context:** one short paragraph of 2-4 sentences. With an ask, its first sentence says why you
   need it. Then what the user must know to answer, or what happened. It points to detail above
   the frame ("table above"); it never repeats it.
3. **Ask:** only when you need the user. One question, at most 25 words. For a pick, the
   options follow as bullets.
4. **Reply:** with an Ask, and with a hand action. The exact words the user types.
5. **Steps:** only with a hand action (`Needs you to ...`): what the user does by hand, numbered,
   one action each.
6. **Warning / Caution:** only when something is risky. Warning: the user cannot undo it, or it
   costs money. Caution: it can break work. Put it before the step it is about.
7. **Next:** only when the options do not already make it clear: what you do after the reply, or
   meanwhile. When it is there, it is the last line.

The frame is always the last part of the message. The user enters a session at its bottom. Put
detail (tables, logs, file lists, long reasoning, code) above the frame, never in it.

**Kinds of message.** Progress, a plan, a diagnosis, a result and an answer are all one context
paragraph, not labelled blocks:

- Progress: what finished, and what runs now.
- Plan: who does what next, in one or two sentences (the full plan goes above).
- Diagnosis: the problem, its cause, and the evidence in a few words ("log above").
- Result: what is done, how you know, and where to look (the PR).
- Answer: the answer, and where it comes from.

## Status lines

The status line is one of these. It says what you need in plain words: the user never sees an ask
type. The sidebar reads the line as it is.

| Status line | Means | Has an Ask |
| --- | --- | --- |
| `Working` | You, your workers or a job you started run now. Nothing needed from the user. | No |
| `Working · needs <thing> later` | Work runs on, and you will need something from the user later, not now. | Yes |
| `Needs <plain words>` | You stopped until the user replies. Name the need: `Needs your pick`, `Needs 2 files from you`. | Yes (a hand action: Steps) |
| `Idle` | Nothing runs and nothing is asked. The workstream stays open, for example while you wait for the user's feedback or next request. | No |
| `Done` | The workstream is finished: the PR merged, or the user called it done. | No |

Use Working only while something runs. When it stops and nothing is asked, use Idle; use Done only when the workstream is finished.

## Asks

| What you need | Status line | The Ask holds | Reply line |
| --- | --- | --- | --- |
| A pick | `Needs your pick` | The question, then options A, B, C as bullets (`- **A. ...**`). Mark one option (recommended). Give each option its result in one line. | `Reply: A or B`, or `Reply: A, B or no` when declining is a real choice |
| A yes or no | `Needs your yes` | One thing that is ready, as a yes/no question | `Reply: yes or no` |
| A review | `Needs your review` | The link, and what to look at first | `Reply: approve, or your comments` |
| A fact or a file | `Needs <the thing> from you` | The one thing you need. The context says what it is and where you already looked. | `Reply: the thing (for example: the file path)` |
| A hand action | `Needs you to <action>` | No Ask: Steps, numbered, for what only the user can do outside the chat (a setting, a login, a device) | `Reply: done` |

The sidebar works out the kind of ask from the frame's shape: lettered options are a pick, `Reply:
yes or no` a yes or no, a Reply that starts with "approve" a review, Steps or `Reply: done` a hand
action, any other ask a fact. Those kind names (decision, approval, review, info, action) are
internal: never write them in a message.

One Ask per message. When you have more questions, ask the most important one and add `(+2 more)`.

## Rules

- **Why first.** With an ask, the first sentence of the context says why you need it. Other news
  (a worker runs) comes after it, or goes above the frame.
- **Say where you looked.** An ask for a fact or a file says what the thing is and where you
  already looked ("not in the repo, not in the BOU-4116 attachments"), so the user can find it.
- **Ask early, block late.** When work runs on and the answer is needed only later, use
  `Working · needs <thing> later`, not a `Needs` line. The sidebar shows it after every ask that
  stops work.
- **The frame never repeats detail.** Detail stays above the frame; the context points to it.
- **A real choice is a pick.** When there is more than one way to go, give the options. Never
  ask yes/no for a choice between options.
- **No hidden options.** An option in a Warning, Caution or Next line ("or leave peri out") is a
  real option: put it under the Ask.
- **Risks have numbers.** A cost warning gives the amount ("about $6"). A risk warning names what
  is at risk ("1,240 staging rows").
- **No silent drops.** An earlier ask that is still open is named in one phrase in the context:
  held, superseded or answered.
- **Letters belong to the current Ask.** Option letters name only the options of this message's
  Ask. Earlier options, tested variants and table columns are named by what they are ("all
  documents", "courses under 1,200 tokens"), never by a letter. This holds in the detail above the
  frame too.
- **Name a returning option.** When an earlier option comes back in a new Ask, the context says so
  with the bare letter: "C is the earlier courses-under-1,200 rule".
- **No ask, short message.** With no ask: the status line and the context, and Next only when it is
  not obvious.

**Route line:** when a coordinator only hands work to a lead, it writes one line and no frame:
`BOU-4206 → lead in mono/bou-4206-aic-split-lessons · today`
(`<ticket or workstream> → lead in <repo>/<worktree> · <level>`).

**Coordinator Briefing:** when a coordinator greets the user or the user asks what is next: the
status line (Idle, or `Needs ...` when the coordinator itself asks), one context paragraph with
what runs and the room left, then the top waiting items as a numbered list, one line each, in
plain words: `1. today · BOU-4206 needs your pick: ...`. Only a coordinator may put a list there.

## Writing rules

Write about 80% of [ASD-STE100 Simplified Technical English](https://themenonlab.blog/blog/asd-ste100-simplified-technical-english-prompting).
Normal phrasing is permitted; these rules are not optional:

- Use one meaning per word, and the same term every time. A worktree is never a checkout or a branch.
- Write at most 20 words in an instruction sentence, and 25 in a description.
- Write one action per step, in the imperative: Turn on Developer Mode.
- Use the active voice. Say who does it.
- Put no more than 3 nouns in a row.
- Never change the labels, the fixed status words (Working, Idle, Done, Needs, needs ... later) or
  the priority words (now, today, soon, someday).

## Examples

Each example is a whole message: the detail first, then the frame that points to it.

1. A lead needs a pick before it spends money. An earlier decision waits for it:

```markdown
| Document | Passages | Under 400 tokens | Eval cost |
| --- | --- | --- | --- |
| peri | 212 | 180 | $5.10 |
| Hygiene | 14 | 12 | $0.20 |
| 8 more + Kaimug | 96 | 71 | $0.70 |

**Needs your pick**

The plan eval shows if the 1 topic = 1 lesson rule is safe for long documents, and it costs money. Most passages in the 10 eval documents are under 400 tokens (table above), so the rule changes long documents too. The decision on 1 topic = 1 lesson is held until this test ends.

**Ask:** run the plan eval on Azure OpenAI?
- **A. All 10 documents + Kaimug (recommended).** About $6. peri is $5 of it.
- **B. Without peri.** About $1.

**Reply:** A, B or no
```

2. A lead needs 2 files and cannot go on without them:

```markdown
Where I looked for the JBC and Foodelity source PDFs:
- mono: apps/ai-create/eval/docs holds 10 PDFs, none for JBC or Foodelity.
- BOU-4116: 3 attachments, all screenshots.

**Needs 2 files from you**

The plan eval needs the JBC and Foodelity source PDFs: the documents their courses were made from. They are not in the repo and not in the BOU-4116 attachments (search above). The eval stops until I have them.

**Ask:** where are the JBC and Foodelity source PDFs?
**Reply:** the 2 file paths, or a link
```

3. A lead handed a plan to a worker:

```markdown
Plan for the worker:
1. Set LESSON_FLOOR in plan.ts from 400 to 80 tokens.
2. Make the planner prompt give 1 lesson per topic.
3. Run the planner tests and the Kaimug fixture.

**Working**

A worker changes the planner as in the plan above. It runs the planner tests when the change is in. I write again when it reports.
```

4. Work runs on, and the lead will need 2 files later:

```markdown
Worker 1 runs the plan eval on the 8 documents in apps/ai-create/eval/docs.

**Working · needs 2 files later**

The eval needs the JBC and Foodelity source PDFs before it ends, in about 40 minutes. A worker runs it on the other 8 documents now (above). The 2 PDFs are not in the repo and not in the BOU-4116 attachments.

**Ask:** where are the JBC and Foodelity source PDFs?
**Reply:** the 2 file paths, or a link
```

5. The user must do something by hand:

```markdown
xcodebuild: error: Developer Mode disabled on "iPhone 15".

**Needs you to turn on Developer Mode**

The device build needs Developer Mode on the iPhone, and only you can turn it on. Without it the build stops at Xcode (error above).

**Steps:**
1. On the iPhone, open Settings > Privacy & Security > Developer Mode.
2. Turn on Developer Mode. Let the phone restart.
3. After the restart, tap Turn On and enter the passcode.
4. Keep the phone unlocked and on the same Wi-Fi as the Mac.

**Reply:** done
**Next:** I run the device build again.
```

6. A worker finished and the PR is ready:

```markdown
pnpm dev:native, iOS simulator: 14 services up, Metro on :8081.
pnpm dev:native, Android emulator: 14 services up, Metro on :8081.

**Needs your review**

The PR is ready, and your review is the last step before the merge. Every isola service in mono now starts on demand, and a Metro service runs the Expo app. Both simulators run it (output above), and a real iPhone run is not tested.

**Ask:** review PR #6227. Look first at the on-demand config in isola.yaml.
**Reply:** approve, or your comments
**Next:** I fix your comments. I send worker_done when the PR merges.
```

7. A release is out, and you wait for the user's feedback:

```markdown
Orca Flow 0.2.39:
- The sidebar reads Status, Ask and Reply from a valid frame.
- Up next shows the Reply under the ask.

**Idle**

PR #23 merged, and Orca Flow 0.2.39 is released (changes above). Nothing runs now. Send feedback here when you have tried it.
```

8. The user asked a question:

```markdown
view.ts marks the row finished, and panel.css:105 sets its opacity to 0.55.

**Idle**

The row is gray because the worker finished (code above). A finished session stays in its place, dimmed, until Orca closes it.
```

9. One thing is ready, and it needs a yes or no:

```markdown
Migration 0042_merge_accounts: 1,240 staging users share an email with another user.

**Needs your yes**

The merge migration changes staging data, so it needs your yes first. The fix for duplicate accounts is on the branch, and its tests pass. It merges the accounts that share an email (count above).

**Ask:** run the merge migration on staging?
**Reply:** yes or no
**Caution:** the migration changes 1,240 staging user rows. A restore from the nightly backup undoes it.
```

10. A coordinator briefing:

```markdown
**Idle**

2 agents wait on you. AI Create v2 production readiness and Draft shifts missing from calendar run now. There is room for 1 more worktree, or 4 more agents.

1. today · BOU-4206 needs your pick: run the plan eval with or without peri?
2. soon · Isola on-demand services needs your review: PR #6227.

**Next:** say "next" to open item 1.
```

11. A coordinator hands a Linear task to a lead. It writes a route line only:

```markdown
BOU-4206 → lead in mono/bou-4206-aic-split-lessons · today
```

## How it is checked

- The check reads only the last message of a turn, and ignores lines in ``` code fences when it
  looks for the status line.
- A coordinator message made only of route lines (`X → lead in <repo>/<worktree> · <level>`)
  passes with no frame.
- **status:** the frame starts at the last line that is bold as a whole and is a status line:
  `Working`, `Working · needs <thing> later`, `Needs <plain words>`, `Idle` or `Done`. The frame
  runs to the end of the message. Text above it is free. **status-old:** an old status word
  (Waiting on you: <type>, Blocked, Ready for review) is a miss that names the plain line to use.
- **header:** no header line (bold, with ` · `) right above the status line.
- **context:** a plain paragraph comes after the status line, before the first label.
  **context-long:** it has at most 4 sentences.
- **detail:** after the status line, no table, heading, code fence or second paragraph. The only
  lists are the options under Ask, the Steps, and a coordinator's numbered waiting items.
- **label:** every bold label at the start of a frame line is one of: Ask, Reply, Steps, Warning,
  Caution, Next. Option bullets such as `- **A. ...**` are not labels.
- **ask:** `Needs ...` and `Working · needs ... later` have an Ask and a Reply. A hand action
  (`Needs you to ...`) has Steps (or an Ask) and a Reply. **ask-status:** Working, Idle and Done
  have no Ask.
- **options:** an ask with lettered options, or a status line that asks for a pick, has 2 or more
  option bullets. **recommended:** exactly one of them is marked (recommended).
- **cost-number:** a Warning or Caution about cost, credits or money gives a number.
- **letters:** when the Ask has lettered options, no line outside code fences (the detail above
  the frame included) says "option A", "options A and B" or "A/B". Only the option bullets and the
  Reply use the letters; elsewhere a current option is named by its bare letter ("C is the
  earlier rule").
- **next-last:** when there is a Next line, it is the last line.
- Where it runs: a Claude Code Stop hook that the plugin installs. It runs only in Orca agent
  terminals, only for coordinators and leads, and only where the user opted in: `"messageFormat"`
  in `~/.orca-flow/config.json` is `"all"`, or a list of worktree or coordinator folder paths.
- On a miss, it stops the turn one time and names each rule with what to fix. Rewrite only the
  frame at the bottom, from the status line down, and end the turn again. Do not repeat the detail
  above it: the user already read it. It logs misses to `~/.orca-flow/format-misses.jsonl`.

The format changes with the user's feedback. Each change updates this file and the checker
(`scripts/frame.mjs`) together.
