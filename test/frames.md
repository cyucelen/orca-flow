# Frame fixtures

The frames the checker (skills/orca-flow/scripts/frame.mjs) and the sidebar (src/summarize.ts) are
tested on, one per kind, in this order: DECISION, STYLE, INFO, PLAN, LATER, BLOCKED, REVIEW, RELEASED, ANSWER, APPROVAL, BRIEFING, ROUTE.
They started as the examples in skills/orca-flow/messages.md; the tests read them from here so a
rewrite of that doc does not break them. test/frame.test.mjs still checks that every example in
messages.md passes.

## DECISION

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

## STYLE

```markdown
Kaimug course, 8 images: 5 flat drawings, 3 photo-like (images 2, 5 and 7).
Each image prompt has one style line ("flat illustrated style, soft colors") and one reference photo from the PDF, a different photo per image.
The photo-like images all got a reference photo of a real kitchen.

**Needs your pick**

The images in one AI Create course come out in different styles: some are flat drawings, some look like photos. The cause is that each image follows its reference photo (a picture from the PDF, different for each image) more than the one loose line of style words (detail above). Before you pick the fix, I can make the problem happen again on my machine, to test the fix against it. Your earlier pick between "one fixed sample image plus clearer style words" and "clearer style words only" is held until then.

**Ask:** do I make the problem happen again first, with the Kaimug onboarding PDF Anja tested?
- **A. Yes, test first (recommended).** I make the Kaimug course again and count the photo-like images. About 10 minutes and $0.40 of image credits.
- **B. No, pick the fix now.** No time or cost now, but no proof that the fix works.

**Reply:** A or B
```

## INFO

```markdown
Where I looked for the JBC and Foodelity source PDFs:
- mono: apps/ai-create/eval/docs holds 10 PDFs, none for JBC or Foodelity.
- BOU-4116: 3 attachments, all screenshots.

**Needs 2 files from you**

The test run for the lesson fix needs the JBC and Foodelity source PDFs: the documents their courses were made from. They are not in the mono repo and not in the attachments of BOU-4116, the 26-slides ticket (search above). The test run stops until I have them.

**Ask:** where are the JBC and Foodelity source PDFs?
**Reply:** the 2 file paths, or a link
```

## PLAN

```markdown
Plan for the worker:
1. Set LESSON_FLOOR in plan.ts from 400 to 80 tokens.
2. Make the planner prompt give 1 lesson per topic.
3. Run the planner tests and the Kaimug fixture.

**Working**

A worker now changes the lesson planner so that each topic of a short document becomes its own lesson (plan above). It runs the planner tests when the change is in. I write again when it reports.
```

## LATER

```markdown
Worker 1 runs the plan eval on the 8 documents in apps/ai-create/eval/docs.

**Working · needs 2 files later**

The test run for the lesson fix needs the JBC and Foodelity source PDFs before it ends, in about 40 minutes. A worker runs it on the other 8 documents now (list above). The 2 PDFs are not in the mono repo and not in the attachments of BOU-4116, the 26-slides ticket.

**Ask:** where are the JBC and Foodelity source PDFs?
**Reply:** the 2 file paths, or a link
```

## BLOCKED

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

## REVIEW

```markdown
pnpm dev:native, iOS simulator: 14 services up, Metro on :8081.
pnpm dev:native, Android emulator: 14 services up, Metro on :8081.

**Needs your review**

Each service of the Isola app now starts only when the app needs it, so a local start uses less memory. Your review is the last step before the merge. Both phone simulators run the app (output above); a real iPhone run is not tested.

**Ask:** review PR #6227. Look first at the on-demand config in isola.yaml.
**Reply:** approve, or your comments
**Next:** I fix your comments. I send worker_done when the PR merges.
```

## RELEASED

```markdown
Orca Flow 0.2.39:
- The sidebar reads Status, Ask and Reply from a valid frame.
- Up next shows the Reply under the ask.

**Idle**

Orca Flow 0.2.39 is released: the sidebar now shows each agent's ask and the words to reply with, as the agent wrote them (changes above). Nothing runs now. Send feedback here when you have tried it.
```

## ANSWER

```markdown
view.ts marks the row finished, and panel.css:105 sets its opacity to 0.55.

**Idle**

A worker's row in the Orca Flow sidebar turns gray when the worker finishes (code above). The row stays in its place, dimmed, until Orca closes the worker.
```

## APPROVAL

```markdown
Migration 0042_merge_accounts: 1,240 staging users share an email with another user.

**Needs your yes**

Some users have 2 accounts with the same email, and the fix merges them into one. The fix changes the staging database, so it needs your yes first. Its tests pass, and it touches 1,240 staging users (count above).

**Ask:** run the account merge on the staging database?
**Reply:** yes or no
**Caution:** the merge changes 1,240 staging user rows. A restore from the nightly backup undoes it.
```

## BRIEFING

```markdown
**Idle**

2 agents wait on you. AI Create v2 production readiness and Draft shifts missing from calendar run now. There is room for 1 more worktree, or 4 more agents.

1. today · BOU-4206, short documents as 1 lesson: the lead needs your pick, in its chat.
2. soon · Isola app on-demand services: the lead needs your review, in its chat.

**Next:** say "next" to open item 1.
```

## ROUTE

```markdown
BOU-4206 → lead in mono/bou-4206-aic-split-lessons · today
```
