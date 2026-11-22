# Message samples: before and after

Real messages that coordinators and leads sent while we built Orca Flow, next to the same content
written to [messages.md](../skills/orca-flow/messages.md). Each "before" is shortened, with ids
left as they were. Where no real message existed, the "before" is reconstructed and says so.

What the rewrites have in common:

- Progress says what changed since the last message, not the whole story again.
- No terminal handles, dispatch or run ids, commit hashes or session ids in the frame.
- No filler the status line already says ("Nothing is needed from you now"), and no standing
  promises ("I don't install or release anything without your yes") repeated every time.
- `Waiting on <thing>` when nothing runs and the agent only waits; `Working` only while
  something it started runs.
- The limits stay: what was not tested, what is still open.

## 1. Handover and cut-off errors

A lead found why the sidebar showed "Sleeping" and cut off the handover errors, and started two
workers (2026-11-21).

### Before

```markdown
I checked the live state before starting workers:

- **orca-flow shows "Sleeping" while active:** Orca's agent list has two rows for this coordinator's conversation (Orca session `6595cd51…`). One is a pane left over from before it was resumed, and that pane has no live terminal. The other is the live pane, `term_6687c482`. The plugin only recognizes the coordinator when exactly one row matches. With two, it finds no session and shows "Sleeping". The ayn-odin coordinator has the same duplicate rows.
- **firstview "Handover is unavailable…":** this comes from the plugin's own safety check. Orca has no safe way yet to move runs a coordinator owns to a new conversation, so the plugin blocks the handover on purpose. The check stays as strict as it is. Two things are wrong: the text is cut off, and it says "A host update is required" without any step you can take today.
- **"Exact resume started, but…" and the raw `terminal_surface_ownership` code (an Orca error name):** both are cut off, and the second is a raw code, not words. In ayn-odin's case the agent had actually started.

Two workers now run in this worktree, and they edit different files:

| Worker | Task |
| --- | --- |
| `term_98692505` | Make the plugin choose the live pane when several rows share one conversation. Check how state recovers after a restart or power loss. Add tests that reproduce the duplicate rows first. |
| `term_f070460d` | Keep the full text of every error readable (hover, keyboard, screen reader, row menu). Turn the raw Orca codes and the Codex "database locked" error into plain words with a recovery step. Take screenshots at about 280, 360 and 540 px sidebar width. |

**Working**

Your active coordinators can show "Sleeping", and open or handover errors are cut off. The likely cause of "Sleeping" is that Orca keeps listing a coordinator's old pane next to its live one, for example after a restart. Two workers now fix the status logic and the error text, with tests under Node 22. I don't install or release anything without your yes. When both report, I open a PR and show you which problems are plugin bugs and which are limits of Orca or Codex.
```

### After

```markdown
What I found before starting the workers:

- **orca-flow shows "Sleeping" while it works:** Orca lists this coordinator's conversation twice: once for the live pane, and once for a pane left over from before it was resumed. The plugin expects exactly one, so with two it finds none and shows "Sleeping". ayn-odin has the same double entry.
- **firstview "Handover is unavailable…":** the plugin blocks the handover on purpose, because Orca can't yet move a coordinator's runs to a new conversation safely. That check stays. The message is what's wrong: it is cut off, and "A host update is required" gives you no step you can take today.
- **"Exact resume started, but…" and a raw Orca error code:** both are cut off, and the code isn't words. On ayn-odin the agent had in fact started.

| Worker | Task |
| --- | --- |
| Status worker | Pick the live pane when one conversation is listed twice. Check how state recovers after a restart or power loss. Write tests that show the double entry first. |
| Error-message worker | Keep every error's full text readable (hover, keyboard, screen reader, row menu). Turn raw Orca codes and Codex's "database locked" into plain words with a way out. Screenshots at about 280, 360 and 540 px. |

**Working**

Your coordinators can show "Sleeping" while they work, and open and handover errors are cut off. The likely cause of "Sleeping" is that Orca lists a coordinator's old pane next to its live one, for example after a restart (detail above). Two workers fix the status and the error texts now, each in its own files. When both report, I open a PR and say which problems are ours and which are limits of Orca or Codex.
```

What changed: workers are named by their job instead of terminal handles, the session id and the
raw error name are gone, and the release promise the user had already set is dropped, which brings
the context back to 4 sentences.

## 2. PR ready for review

The same lead opened PR #55 (2026-11-21).

### Before

```markdown
I opened PR #55: https://github.com/cyucelen/orca-flow/pull/55. It has 7 commits on top of 0.2.68. Under Node 22 the type check is clean and 483 tests pass, with 1 skipped. It is not released, and your installed plugin is unchanged.

Fixed in the plugin:
- **False "Sleeping", and the click opening a child row:** after a restart, Orca keeps listing the old pane next to the live one. The plugin now treats both as one conversation and uses the live pane. When several panes are live, or none, it doesn't guess.
- **Starts that failed although the agent ran:** this caused the `terminal_surface_ownership` error on ayn-odin. The plugin now waits up to 5 seconds for the new terminal, and Retry uses that launch instead of starting a second one.
- **Cut-off errors:** each error is now an icon. The full text shows on hover and on keyboard focus, and a click opens the menu with Retry and Sessions.

**Needs your review**

Your coordinators showed "Sleeping" while they worked, clicks opened the wrong row, and errors were cut off. PR #55 fixes all of this and passes 483 tests. Start with `coordinator-sessions.ts` (the file that matches a coordinator to its live pane). After you approve, I ask once more before anything is released or installed.

**Ask:** review PR #55, https://github.com/cyucelen/orca-flow/pull/55, starting with `coordinator-sessions.ts` (the file that matches a coordinator to its live pane).
**Reply:** approve, or your comments
**Next:** I send your comments to the workers.
```

### After

```markdown
PR #55: https://github.com/cyucelen/orca-flow/pull/55, 7 commits on top of 0.2.68. Under Node 22 the type check is clean and 483 tests pass, 1 skipped. Not released; your installed plugin is unchanged.

Fixed in the plugin:
- **False "Sleeping", and the click opening a child row:** after a restart, Orca keeps listing the old pane next to the live one. The plugin now treats both as one conversation and uses the live pane. When several panes are live, or none, it doesn't guess.
- **Starts that failed although the agent ran:** this caused the raw Orca error on ayn-odin. The plugin now waits up to 5 seconds for the new terminal, and Retry reuses that launch instead of starting a second one.
- **Cut-off errors:** each error is now an icon. The full text shows on hover and on keyboard focus, and a click opens the menu with Retry and Sessions.

**Needs your review**

Your coordinators showed "Sleeping" while they worked, clicks opened the wrong row, and errors were cut off. PR #55 fixes this, and 483 tests pass (list above). Your sidebar runs the fix only after a release; until then the tests and a check against Orca's live agent list are the evidence.

**Ask:** review PR #55. Look first at coordinator-sessions.ts, which matches each coordinator to its live pane.
**Reply:** approve, or your comments
**Next:** I send your comments to the workers.
```

What changed: the file to review first is named once, in the Ask, with its job said in the
sentence instead of a bracket repeated twice; "I ask once more before anything is released"
restated a rule the user had already set, so it gives way to the limit the user needs: nobody has
seen the fix in the real sidebar yet.

## 3. Release installed and checked

The lead merged PR #55 and checked the release on the user's machine (2026-11-21).

### Before

```markdown
Orca Flow 0.2.69 is installed and running, and the false "Sleeping" status is gone. I merged PR #55, and the release workflow published v0.2.69. `orca plugin update` installed it without asking for new access.

A screenshot of your live sidebar at 360 px shows the fixes:
- **orca-flow:** shows as awake, not "Sleeping". Its leads sit directly under it, and the old pane no longer appears as an extra row.
- **firstview:** shows as awake, with its team under it.
- **3d-print and ayn-odin:** "Sleeping" and "Not started" are now at the bottom.

**Still open:**
- **ayn-odin:** still shows "Not started" because it has no main conversation. Pick one once in its Sessions menu.
- **firstview handover:** still blocked while firstview owns runs, because Orca can't move runs safely. The message now says what you can do.

PR #54, the worker-title fix, was not part of this release. I told the coordinator, and this workstream is closed.

**Done**

Your coordinators showed "Sleeping" while working, clicks opened the wrong row, and errors were cut off. PR #55 fixes this, and Orca now runs the 0.2.69 release with these fixes, as your live sidebar shows.
```

### After

```markdown
PR #55 is merged and released as 0.2.69. The plugin updated without asking for new access.

A screenshot of your live sidebar at 360 px shows the fixes:
- **orca-flow:** shows as awake, not "Sleeping". Its leads sit directly under it, and the old pane no longer appears as an extra row.
- **firstview:** shows as awake, with its team under it.
- **3d-print and ayn-odin:** "Sleeping" and "Not started" are now at the bottom.

Not in this release: PR #54, the worker-title fix.

**Done**

Your coordinators no longer show "Sleeping" while they work, clicks open the right row, and errors show in full. Orca Flow 0.2.69 has these fixes and runs on your machine, and a screenshot of your live sidebar confirms them (detail above). Still open: ayn-odin shows "Not started" until you pick its main conversation once in its Sessions menu, and firstview's handover stays blocked by an Orca limit.
```

What changed: the frame now carries what is still open, so the user sees the one step left to them
without reading the detail; "I told the coordinator, and this workstream is closed" is
bookkeeping the user can't act on, and the Done line already says it.

## 4. Routing a task, and the lead confirming who works on it

A coordinator routed a request to a new lead (2026-11-22), and a lead confirmed that a worker took
a fix (2026-11-19).

### Before

```markdown
I started a Codex lead in a new web-app worktree, `open-self-signup`. Its first job is to find out what opening sign-up takes: a production setting, a code change, or both. It will ask you before it changes any production setting. I set the level to soon because it fell between soon and today; tell me if you want today.

Open self signup to everyone → lead in web-app/open-self-signup · soon
```

### After

```markdown
Open self signup to everyone → lead in web-app/open-self-signup · soon

**Working**

Opening sign-up to everyone: a new lead in web-app first finds out whether that takes a production setting, a code change, or both. It asks you in its own chat before it changes any production setting. I set the level to soon because you didn't say; tell me if it is today.
```

What changed: a paragraph next to a route line had no status line, so the checker could not read
it; the route line now sits above a short frame that keeps the one thing the user must know, the
guessed level.

### Before

```markdown
I've handed the fix to a worker in this worktree (dispatch ctx_fe5c5aabc926) and set this worktree's card to priority "today". Its plan:
1. Write failing regression tests for the two cases in your screenshot: no current session, and an offline session.
2. Add a wake rule in the coordinator sessions code: open the session if it runs, resume the same conversation if it stopped, start a new one if there was none, and ask you to pick when the history is unclear.
3. Show "Sleeping" in a neutral style, and offer Retry or Start new when a resume fails.
4. Check a related error that keeps repeating in the logs ("saving coordinator membership failed"), and fix it only if it is a real bug.
5. Run `scripts/dev.sh check`.

**Working**

Since 0.2.58, clicking a coordinator with no running session shows a red "No main conversation is selected." error. A worker is fixing it now with regression tests, following the behavior you approved (plan above). Nothing gets pushed, released or installed without your yes. I'll write again when the worker reports, with the test results and a draft PR to review.
```

### After

```markdown
The worker's plan:
1. Write failing tests for the two cases in your screenshot: no current session, and an offline session.
2. Add the wake rule: open the session if it runs, resume the same conversation if it stopped, start a new one if there was none, and ask you to pick when the history is unclear.
3. Show "Sleeping" in a neutral style, and offer Retry or Start new when a resume fails.
4. Check the log error that keeps repeating ("saving coordinator membership failed"), and fix it only if it is a real bug.
5. Run the repo's full check.

**Working**

Since 0.2.58, clicking a coordinator with no running session shows a red "No main conversation is selected." error. A worker in this worktree now fixes it the way you approved, starting with tests that reproduce your screenshot (plan above). When it reports, I come back with the test results and a draft PR for your review.
```

What changed: the dispatch id and the card bookkeeping are gone, and so is the standing promise not
to push or release; what stays is who works on it, how, and what the user gets next.

## 5. A worker's test fails

The lead passed the user's new error design to a worker, and one test failed on the way
(2026-11-21).

### Before

```markdown
Your screenshot shows the handover error cut off at "Handover is unavailable whi". I sent your new design to the error-message worker, which is still running:

- **Error display:** a small error icon replaces the cut-off red text. The full message shows on hover, and also on keyboard focus. Retry and Sessions stay in the row menu.
- **Flashing tooltips:** the worker finds why all panel tooltips flash while an agent is working and fixes it for every tooltip.

The status worker also confirmed that the fix in commit `1b44b06` already covers your tree: the coordinator row is no longer "Sleeping" and a click opens the live conversation. It added a test for your exact tree in commit `4e22762`. Checked against the live sidebar data: the root row is the live conversation, a click opens `term_6687c482`, and both leads sit directly under the root.

One test fails right now: "source acquires a run midflight" in the handover tests. It comes from the error-message worker's uncommitted changes, so I told it to fix it before it commits.

**Working**

Errors in coordinator rows are cut off, and all sidebar tooltips flash while an agent is working. A worker is changing errors to an icon with the full text on hover, and it is fixing the flashing for every tooltip. The "Sleeping" status and the wrong click target are fixed and tested in the branch, but not released yet. Nothing is needed from you now.
```

### After

```markdown
Your screenshot shows the handover error cut off at "Handover is unavailable whi". I sent your new design to the error-message worker, which is still running:

- **Error display:** a small error icon replaces the cut-off red text. The full message shows on hover, and also on keyboard focus. Retry and Sessions stay in the row menu.
- **Flashing tooltips:** the worker finds why all panel tooltips flash while an agent is working and fixes it for every tooltip.

The status worker confirmed that its fix already covers your tree, and added a test for it. Checked against the live sidebar data: the root row is the live conversation, a click opens it, and both leads sit directly under the root.

One test fails: "source acquires a run midflight" in the handover tests. It comes from the error-message worker's changes that are not committed yet.

**Working**

New since my last message: one handover test fails, caused by the error-message worker's unfinished changes, and that worker fixes it before it commits. The same worker now turns cut-off errors into an icon with the full text on hover, and stops the tooltips flashing. The "Sleeping" fix covers your exact tree too; it reaches your sidebar with the next release.
```

What changed: the failing test was only in the detail, and the frame retold the story; now the
frame opens with the failure and who fixes it, and the commit hashes and terminal handle are gone.

## 6. No room for a worker, so the task waits

A coordinator had no memory for a new worktree (2026-11-16). The real message asked the user what
to do, with no frame.

### Before

```markdown
Memory is tight right now: pressure is at "warn" and 4.5 GB of swap is in use. The capacity check allows another agent but not a new worktree. A new worktree costs about 1.2 GB, mostly for its dev server.

The easiest way to make room: the `activation-tracking` worktree has a dev server using **1.3 GB** while no agent is working there, since PR #1778 is just waiting for review. I can stop that dev server (`isola down`) and leave the worktree, branch and agent chat untouched. The agent can restart it if it needs to. Then I'd start the test-list work in a new worktree at **today**, since it's the manual safety net for the production release.

The plan for that agent:
- **Keep it simple:** a "QA" page in admin with scenarios grouped by area. The team marks each one **pass, fail or skip**, with an optional note, and it records who tested and when.
- **Test runs:** you can start a fresh run, for example "Prod release Nov 2026", so results don't mix between releases.
- **The scenarios:** the agent writes the first set from the product's main flows and from the release-prep agent's change list, then shows them to you before building.

Should I stop that idle dev server and start it? If not, I'll queue the work until memory frees up.
```

### After

```markdown
The plan for the QA test list:
- A "QA" page in admin with scenarios grouped by area. The team marks each one pass, fail or skip, with an optional note, and it records who tested and when.
- Test runs: you start a fresh run, for example "Prod release Nov 2026", so results don't mix between releases.
- The first scenarios come from the product's main flows and the release-prep change list; you see them before anything is built.

**Needs your pick**

The QA test list, the manual safety net for the production release, needs a new web-app worktree, and memory is too tight for one now. The activation-tracking worktree runs a dev server that uses 1.3 GB while no agent works there, because PR #1778 only waits for review. Stopping it leaves the worktree, branch and chat as they are, and its agent can start it again.

**Ask:** make room for the QA test list now?
- **A. Stop the idle dev server and start it now (recommended).** Frees 1.3 GB; the QA list starts at today.
- **B. Queue it.** Nothing stops; it starts when memory frees up on its own.

**Reply:** A or B
```

What changed: the question had no status line, so the sidebar could not show it as an ask; the
hidden "if not, I'll queue" became option B, and swap use is gone because the capacity rules say
it is never a reason to queue.

Then the user picks B. This "before" is reconstructed in the style of the time, because no queued
message of this kind was saved.

### Before

```markdown
Queued task_8b1e0c47a2f3 ("QA test list in admin") at today. Capacity says agents-only.

**Working**

The QA test list is queued because capacity is agents-only. Nothing is needed from you now. I start it when a slot frees up.
```

### After

```markdown
Queued at today: "QA test list in admin". Memory pressure is at warn, so a new worktree, about 1.2 GB with its dev server, doesn't fit.

**Waiting on memory for a new worktree**

The QA test list for the production release is queued, because a new web-app worktree doesn't fit in memory right now (numbers above). Nothing runs for it yet. I start it as soon as a running worktree finishes or its dev server stops.
```

What changed: Working said something ran when nothing did; `Waiting on` names what the work waits
for, and the task id, "agents-only" and the filler line are gone.
