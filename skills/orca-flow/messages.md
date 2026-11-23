# Messages to the user

The user runs many agents at once and reads each chat in short visits, often hours apart. Every
message to them ends the same way, so they see in two seconds what is going on and whether you
need them. The sidebar reads the same lines to fill the agent's card and the user's queue.

**Who writes this way:** coordinators and leads, in every message to the user. A worker's report
to its lead is not a message to the user, and neither are `orca orchestration` commands.

## The frame

End every message with these parts, in this order. Leave out the ones you don't need.

1. **Status line:** bold, alone on its line: `**Working**`, `**Needs your pick**`. It says in plain
   words what is going on, or what you need. No label and no header above it: the sidebar already
   knows which worktree this is.
2. **Context:** one short paragraph of 2 to 4 sentences. Open with the problem or the goal, then
   why you need the user (when you do), then what they must know. Point to detail instead of
   repeating it: "(table above)".
3. **Ask:** only when you need the user. One question, at most 25 words; a pick's options follow.
4. **Reply:** with every Ask and every hand action: the exact words the user types back.
5. **Steps:** only for a hand action (`Needs you to ...`): numbered, one action each.
6. **Warning / Caution:** only when something is risky. Warning: the user can't undo it, or it
   costs money. Caution: it can break work. Put it before the step it is about.
7. **Next:** only when the options don't already show what you do after the reply. It is last.

Put everything else (tables, logs, file lists, reasoning, code) above the frame. The frame always
comes last, because the user enters a chat at its bottom.

## Status lines

| Status line | Use it when | Ask? |
| --- | --- | --- |
| `Working` | Something you started runs now: your workers, a test run, a build. | No |
| `Waiting on <thing>` | Nothing runs here, and you wait on something that isn't the user: CI, a free slot for a worker, another lead's merge, your coordinator, a release workflow. | No |
| `Working · needs <thing> later` | Work runs, and you will need the user later, not now. | Yes |
| `Needs <plain words>` | You stopped until the user replies: `Needs your pick`, `Needs 2 files from you`. `Needs you to <action>` is a hand action, with Steps. | Yes |
| `Idle` | Nothing runs and nothing is asked. The workstream stays open, for example while you wait for the user's feedback. | No |
| `Done` | The workstream is finished: the PR merged, or the user called it done. | No |

Write `Working` only while something you started runs. When you only wait, say on what
(`Waiting on CI`), so the user sees nobody is busy and nobody needs them. The user is never the
thing you wait on: write `Needs ...`, never `Waiting on you` or `Waiting on your review`.

## Asks

| What you need | Status line | The Ask holds | Reply line |
| --- | --- | --- | --- |
| A pick | `Needs your pick` | The question, then options A, B, C as bullets (`- **A. ...**`). Mark one option (recommended). Give each option its result in one line. | `Reply: A or B`, or `Reply: A, B or no` when saying no is a real choice |
| A yes or no | `Needs your yes` | One thing that is ready, as a yes/no question | `Reply: yes or no` |
| A review | `Needs your review` | The link, and what to look at first | `Reply: approve, or your comments` |
| A fact or a file | `Needs <the thing> from you` | The one thing you need. The context says what it is and where you already looked ("not in the repo"), so the user doesn't look there again. | `Reply: the thing (for example: the file path)` |
| A hand action | `Needs you to <action>` | No Ask: numbered Steps for what only the user can do outside the chat (a setting, a login, a device) | `Reply: done` |

The sidebar tells the kinds apart by shape: lettered options are a pick, `Reply: yes or no` a yes
or no, a Reply that starts with "approve" a review, Steps or `Reply: done` a hand action, any other
ask a fact. Its names for them (decision, approval, review, info, action) never go in a message.

One Ask per message. With more questions, ask the most important one and add `(+2 more)`.

## What each message says

- **Progress:** what changed since your last message, and what runs now. Don't retell the story.
- **Result:** what is done, how you know, what was not tested, and where to look (the PR).
- **Diagnosis:** the cause in one sentence, and where the evidence is: "(log above)".
- **Plan or answer:** one or two sentences. The full plan goes above the frame.

## Readable cold

An ask or a result must make sense to someone who reads only the frame, after a week away,
without the earlier messages or the detail above.

- **The problem or goal first.** Then why you ask, then what the user must know to answer. Other
  news (a worker runs) comes after.
- **Point after the point.** State the cause or the result in one sentence, then add "(detail
  above)", once per message. "The root cause is above" tells the reader nothing.
- **Options stand alone.** Each option makes sense without the context, and gives its cost when it
  has one: "about 10 minutes and $0.40 of image credits".
- **Name things once, fully.** A document, ticket or person gets one phrase that identifies it:
  "the Kaimug onboarding PDF Anja tested", "BOU-4116, the 26-slides ticket".

## Plain words

Write the way you would explain it to a colleague at their desk: everyday words, short sentences,
who does what. Each rule below comes from real messages that got it wrong.

**Say what changed, not the whole story.** Three messages in a row that open with the same recap
make the user hunt for the news.
- Bad (the third time): "Two workers are fixing the false Sleeping status and the cut-off errors."
- Good: "The release lead merged #51 and #52. Neither touches our files, so both workers go on."

**Leave out what the status line already says.** "Nothing is needed from you now" under Working
only repeats it.

**Trust the user's standing instructions.** What the user told you holds until they change it.
Don't ask again for what they already allowed. Don't announce what you won't do ("I don't release
anything without your yes") unless it matters now.
- Bad, when the user asked for the release: "After you approve, I ask once more before I release."
- Good: "After you approve, I merge and release it."

**No internal names.** The user can do nothing with terminal handles, dispatch or run ids, commit
hashes, session ids, or Orca words like worker_done, dispatch, status note or frame. Say who does
what: "a worker" (an Orca worker), "the release lead", "the fix". An id goes only in the detail
above the frame, or in Reply or Steps when the user must type it.
- Bad: "I've handed the fix to a worker (dispatch ctx_fe5c5aabc926)." / "Fixed in commit `1b44b06`."
- Good: "A worker is fixing it now." / "That is fixed and tested on this branch."

**Prefer plain words to code names.** A word you made up, or a name from the code, makes the user
stop. Name a file, function or command only when the user needs it to act: the file to review
first, a command to type. Explain it once, in the sentence, not in brackets after every name.
- Bad: "the raw `terminal_surface_ownership` code (an Orca error name)"
- Good: "a raw Orca error code instead of words"
- Good, because the user acts on it: "Look first at coordinator-sessions.ts, which matches each
  coordinator to its live pane."

**Keep the limits.** Plain doesn't mean rosy: say what was not tested and what is still open.
- Bad: "PR #55 fixes all of this and passes 483 tests."
- Good: "PR #55 fixes this, and 483 tests pass. Your sidebar runs it only after a release."

**One recommendation.** Every pick marks exactly one option (recommended), and its line says why.

**Short and consistent.** About 20 words per sentence. Each step is one command: "Turn on
Developer Mode." Say who does it. Use the same word for the same thing: a worktree is never "a
checkout" or "a branch".

**Fixed words never change:** the labels, the status words (Working, Waiting on, Needs, needs ...
later, Idle, Done) and the priority words (now, today, soon, someday).

## More rules

- **Ask early, block late.** When work runs on and you need the answer only later, ask now with
  `Working · needs <thing> later`, so the user can answer while the work runs.
- **A real choice is a pick.** More than one way to go: give the options, never a yes or no. An
  option tucked into a Warning, Caution or Next ("or leave peri out") goes under the Ask too.
- **Risks have numbers.** A cost gives the amount ("about $6"). A risk names what is at risk
  ("1,240 staging rows").
- **No silent drops.** In a message you send the user anyway, an earlier ask of yours that is still
  open gets one phrase in the context: held, replaced or answered. (A wake is not such a message:
  see Mail and notifications.) A coordinator never carries a lead's open ask: the lead asks again
  in its own chat.
- **Letters belong to this Ask.** Earlier options, tested variants and table columns are named by
  what they are ("all documents"), never by a letter, in the detail above too. When an earlier
  option comes back, say so with its new letter: "C is the earlier courses-under-1,200 rule".
- **No ask, short message.** Without an ask, write the status line and the context, and Next only
  when it isn't obvious.

## Mail and notifications

A **wake** is a turn the user did not start: Orca's mail notice (`You have 1 orchestration
message. Run \`orca orchestration check\`.`), a task notification (`<task-notification>`), a
duplicate notice, an idle or status event. The user is not in it, and the question they still
have open is in your last frame.

- Read the mail (`orca orchestration check`), act, or reply on the right route (a worker's
  message id, the dispatch), then end the turn.
- Reply with ONE plain line: what arrived and what you did. "A worker finished the docs fix; I'm
  checking its tests." "A worker sent a routine note; nothing to do." About 25 words at most, no
  status line, no Ask, no internal ids. Always write it: an empty reply makes Claude Code send a
  nudge ("Your previous response had no visible output"), which is not the user either.
- No recap of the mail beyond that line. No full or partial repeat of the open question, no status
  nobody asked for.
- The open ask stands as it was, in the chat that owns it. Don't restate, re-letter or replace it.
- Write to the user only for news they can act on, a blocker that needs them, or a report they
  asked for. When their question really changes (the decision changed, the options changed, events
  answered it, or a new blocker replaces it), write ONE whole frame with the full current question,
  in the chat that owns it (the lead's, for its workstream; a coordinator never relays it), and say
  the old ask is replaced.
- A person asking "status?" or "what's going on" is a normal prompt, not a wake: answer with a
  full frame.

## Coordinators: route line and Briefing

**Route line.** When a coordinator only hands work to a lead, it writes one line and no frame:
`BOU-4206 → lead in mono/bou-4206-aic-split-lessons · today`. The shape is
`<ticket or workstream> → lead in <repo>/<worktree> · <level>`, and for a lead in your own folder
`<workstream> → lead in coordinators/<your name> · <level>`. The lead tells its plan in its own
chat. When you have one more thing to say (a level you guessed), put the route line above a frame.

**Briefing.** When a coordinator greets the user or is asked what's next: the status line
(`Idle`, or `Needs ...` when the coordinator itself asks), one context paragraph with what runs and
the room left, then the top waiting items as a numbered list, one line each. An item names the
level, the workstream, who waits and the kind of need, never the question or its options:
`1. today · BOU-4206, short documents as 1 lesson: the lead needs your pick, in its chat.` Only the
coordinator's own ask goes in its Ask. Only a coordinator may put a list in the frame.

## Examples

Each example is a whole message: the detail first, then the frame. Each frame makes sense alone.

1. A pick before spending money. An earlier decision waits for it:

```markdown
| Document | Passages | Under 400 tokens | Eval cost |
| --- | --- | --- | --- |
| peri | 212 | 180 | $5.10 |
| Hygiene | 14 | 12 | $0.20 |
| 8 more + Kaimug | 96 | 71 | $0.70 |

**Needs your pick**

AI Create turns a short document, like the Kaimug onboarding PDF, into 1 lesson; the fix makes each topic its own lesson. Before it ships, the plan eval (a test run that plans the lessons of our 10 eval documents) must show it is safe for long documents, and that run costs money. Most passages in those documents are under 400 tokens (table above), so the fix changes long documents too. Your decision on the fix itself is held until this test ends.

**Ask:** run the plan eval on Azure OpenAI?
- **A. All 10 documents + Kaimug (recommended).** About $6. peri, the 212-passage manual, is $5 of it.
- **B. Without peri.** About $1, but the longest document is not tested.

**Reply:** A, B or no
```

2. One thing is ready, and it needs a yes or no:

```markdown
Migration 0042_merge_accounts: 1,240 staging users share an email with another user.

**Needs your yes**

Some users have 2 accounts with the same email, and the fix merges them into one. The fix changes the staging database, so it needs your yes first. Its tests pass, and it touches 1,240 staging users (count above).

**Ask:** run the account merge on the staging database?
**Reply:** yes or no
**Caution:** the merge changes 1,240 staging user rows. A restore from the nightly backup undoes it.
```

3. The PR is ready for review:

```markdown
pnpm dev:native on the iOS simulator and the Android emulator: 14 services up, Metro on :8081.

**Needs your review**

Each service of the Isola app now starts only when the app needs it, so a local start uses less memory. Your review is the last step before the merge. The app runs on both phone simulators (output above); a real iPhone is not tested yet.

**Ask:** review PR #6227. Look first at the on-demand settings in isola.yaml.
**Reply:** approve, or your comments
**Next:** I fix your comments, and merge when you approve.
```

4. Two files are missing, and the work can't go on without them:

```markdown
Searched: apps/ai-create/eval/docs in mono (10 PDFs, none for JBC or Foodelity) and the 3 BOU-4116 attachments (all screenshots).

**Needs 2 files from you**

The test run for the lesson fix needs the JBC and Foodelity source PDFs: the documents their courses were made from. They are not in the mono repo and not in the attachments of BOU-4116, the 26-slides ticket (search above). The test run stops until I have them.

**Ask:** where are the JBC and Foodelity source PDFs?
**Reply:** the 2 file paths, or a link
```

5. Only the user can do the next step, by hand:

```markdown
xcodebuild: error: Developer Mode disabled on "iPhone 15".

**Needs you to turn on Developer Mode**

The Isola app does not build for your iPhone: Xcode stops because Developer Mode is off on the phone (error above). Only you can turn it on.

**Steps:**
1. On the iPhone, open Settings > Privacy & Security > Developer Mode.
2. Turn on Developer Mode. Let the phone restart.
3. After the restart, tap Turn On and enter the passcode.
4. Keep the phone unlocked and on the same Wi-Fi as the Mac.

**Reply:** done
**Next:** I run the device build again.
```

6. Work runs on, and two files are needed later:

```markdown
A worker runs the plan eval on the 8 documents in apps/ai-create/eval/docs.

**Working · needs 2 files later**

The test run for the lesson fix needs the JBC and Foodelity source PDFs before it ends, in about 40 minutes. A worker runs it on the other 8 documents now (list above). The 2 PDFs are not in the mono repo and not in the attachments of BOU-4116, the 26-slides ticket.

**Ask:** where are the JBC and Foodelity source PDFs?
**Reply:** the 2 file paths, or a link
```

7. A worker took the task:

```markdown
The worker's plan:
1. Lower the smallest lesson size in plan.ts from 400 to 80 tokens.
2. Make the planner prompt give 1 lesson per topic.
3. Run the planner tests and the Kaimug sample.

**Working**

A worker now changes the lesson planner so that each topic of a short document becomes its own lesson (plan above). It runs the planner tests when the change is in. I write again when it reports, with the results.
```

8. Nothing runs here until CI ends:

```markdown
PR #6227: both review comments fixed and pushed. CI started at 14:05; the iOS build usually takes about 25 minutes.

**Waiting on CI**

Your 2 review comments on PR #6227, the Isola on-demand services, are fixed and pushed. Nothing runs here until CI ends. If it passes, I merge, as you approved; if it fails, I send the failing job to the worker.
```

9. A release is out, and the workstream stays open for feedback:

```markdown
Orca Flow 0.2.39: the sidebar shows the Ask and Reply lines the agent wrote; Up next shows the Reply under the ask.

**Idle**

Orca Flow 0.2.39 is released and installed: the sidebar now shows each agent's ask and the words to reply with, as the agent wrote them (changes above). It needed no new access. Not checked yet: an ask from a Codex agent, because none asked while I tested. Send feedback here when you have tried it.
```

10. The workstream is finished:

```markdown
PR #6227 merged at 16:40, and CI on main passed.

**Done**

Each service of the Isola app now starts only when the app needs it, so a local start uses less memory. PR #6227 is merged, and CI on main passes. Still not tested: a run on a real iPhone.
```

11. A coordinator's Briefing:

```markdown
**Idle**

Two leads wait on you, each in its own chat. AI Create v2 production readiness and Draft shifts missing from calendar run now. There is room for 1 more worktree, or 4 more agents.

1. today · BOU-4206, short documents as 1 lesson: the lead needs your pick, in its chat.
2. soon · Isola app on-demand services: the lead needs your review, in its chat.

**Next:** say "next" to open item 1.
```

12. A coordinator hands a Linear task to a lead, with a route line only:

```markdown
BOU-4206 → lead in mono/bou-4206-aic-split-lessons · today
```

## How it is checked

- The check reads only the last message of a turn, and skips lines inside ``` code fences when it
  looks for the status line. A coordinator message made only of route lines passes with no frame.
- The one plain line you write after a wake (Mail and notifications), with no status line, is not checked: it neither
  blocks nor leaves a reminder, and the sidebar keeps the ask from your last frame. A frame you
  write after a wake is checked, and decides the card, as usual.
- It runs in a Stop hook and a UserPromptSubmit hook, only in Orca agent terminals, only for
  coordinators and leads, and only where the user turned it on (`"messageFormat"` in
  `~/.orca-flow/config.json` is `"all"`, or a list of worktree or coordinator folder paths).
- Each rule has a tier:
  - **block:** the sidebar can't read the status, the ask or the reply, or the user can't answer.
    The Stop hook stops the turn once and names each miss (the silent ones too). Rewrite only the
    frame, from the status line down, and end the turn again; the user already read the detail.
  - **silent:** length, style and wording. The turn ends as usual. At your next prompt you get a
    quiet reminder, once. Don't rewrite the old message or mention the reminder; just follow the
    rules next time. Every miss is logged to `~/.orca-flow/format-misses.jsonl` with its tier.

Rules that block:

- **status** (block): the frame starts at the last line that is bold as a whole and is a status
  line: `Working`, `Waiting on <thing>`, `Working · needs <thing> later`, `Needs <plain words>`,
  `Idle` or `Done`. The frame runs to the end of the message. Text above it is free.
- **status-old** (block): no old or wrong status words (`Waiting on you`, `Waiting on your ...`,
  `Waiting on you: <type>`, `Blocked`, `Ready for review`). The miss names the `Needs ...` line.
- **status-label** (block): the status line stands alone, bold, not after a `**Status:**` label.
- **ask** (block): `Needs ...` and `Working · needs ... later` have an Ask and a Reply. A hand
  action (`Needs you to ...`) has Steps (or an Ask) and a Reply.
- **ask-status** (block): Working, Waiting on, Idle and Done have no Ask: the sidebar won't show it.
- **options** (block): an ask with lettered options, or a status line that asks for a pick, has 2
  or more option bullets.
- **letters** (block): with a lettered Ask, no line outside code fences, the detail above
  included, says "option A", "options A and B" or "A/B". Only the option bullets and the Reply use
  the letters; elsewhere a current option is named by its bare letter ("C is the earlier rule").

Rules that are silent:

- **header** (silent): no header line (bold, with ` · `) right above the status line.
- **context** (silent): a plain paragraph comes after the status line, before the first label.
- **context-long** (silent): the context has at most 4 sentences.
- **detail** (silent): after the status line, no table, heading, code fence, second paragraph, or
  list other than the options, the Steps and a coordinator's numbered waiting items.
- **label** (silent): every bold label that starts a frame line is Ask, Reply, Steps, Warning,
  Caution or Next. Option bullets such as `- **A. ...**` are not labels.
- **recommended** (silent): exactly one option is marked (recommended).
- **above** (silent): in the context, the Ask and its options, no "is above", "see above", "as
  above", "shown above", and no context that starts with "Above". "(detail above)" after the point
  is fine.
- **internal-id** (silent): the context, the Ask and its options, and a Warning or Caution hold no
  Orca handles or ids (`term_…`, `ctx_…`, `task_…`, `run_…`, `msg_…`, `dispatch:<id>`), no commit
  hashes (7 to 40 hex characters with a digit and a letter) and no UUIDs. They may go in the
  detail above, and in Reply, Steps or Next when the user must type them. PR numbers (#55),
  versions (0.2.69), ticket ids (BOU-4206) and file names are fine.
- **cost-number** (silent): a Warning or Caution about cost, credits or money gives a number.
- **next-last** (silent): when there is a Next line, it is the last line.

The format changes with the user's feedback. Each change updates this file and the checker
(`scripts/frame.mjs`, whose `TIERS` gives each rule's tier) together.
