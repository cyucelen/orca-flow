---
name: orca-flow
description: >-
  How agents in Orca split, prioritize, delegate and track work on a memory-constrained machine,
  in three roles: the user's home coordinators, workstream leads and workers. Use when acting as a
  coordinator or lead, when your prompt names your role, when splitting work across agents, when
  spawning or handing work to another agent or worktree, when the user sets or asks about
  priority (P0-P3, now/today/soon/someday), when asked what to work on next, and always when
  running in one of the user's coordinator folders under ~/orca/coordinators.
---

# Orca Flow

Work flows through three roles so the user can switch between workstreams cheaply and never has to
decide what is next:

| Role            | Owns                                          | Does the work itself?       |
| --------------- | --------------------------------------------- | --------------------------- |
| **Coordinator** | The user's projects, worktree capacity, order | Never edits code            |
| **Lead**        | One workstream: its worktree, branch and PR   | Small fixes only            |
| **Worker**      | One task                                      | Yes, then reports and ends  |

The user talks to coordinators to start work and to leads to steer it. Leads hand tasks to workers
and stay free for the next request.

**Find your role, then read its file:**

- Your working directory is inside `~/orca/coordinators`: **coordinator**, read
  [roles/coordinator.md](roles/coordinator.md).
- Your prompt says `Your role: lead`: **lead**, read [roles/lead.md](roles/lead.md).
- You were dispatched with a Task and Dispatch id and no role line: **worker**, read
  [roles/worker.md](roles/worker.md).
- The user started this chat themselves (no Task or Dispatch id): do the work yourself; if it needs
  more than one agent, act as a lead **without a coordinator** (see the end of
  [roles/lead.md](roles/lead.md)).
- The user tells you to be (or keep being) the lead of this workstream: run `orca-flow role lead`
  so the role survives resume and compaction (`orca-flow role clear` undoes it). Never record it on
  your own guess.

Everything below applies to every role. Load the `orchestration` skill for command details
(`orca skills get orchestration`): this skill decides *what* to do, that one says *how*.

`orca-flow` below is the script that ships with this skill: run it as
`node <this skill's base directory>/scripts/orca-flow.mjs <command>`. It reads the same data as the
user's Orca Flow sidebar, so what you rank and report matches what they see.

**When told the skills changed** (a note from Orca Flow after the user pressed Reload skills, or the
user saying so): re-read this file and your role file from disk, and any other skill you loaded in
this conversation, even if you read them before; the new text replaces what you remember. Then run
`orca-flow skills-reloaded` (with the note's `--request` id) and carry on. Nothing else changes:
keep your task, open asks and run ownership, and send no message or `worker_done` because of it.

## Priority vocabulary

Use these words exactly, in cards, specs, summaries and when talking to the user.

| Level | Word        | Meaning                                                               |
| ----- | ----------- | --------------------------------------------------------------------- |
| P0    | **now**     | Blocking production, a customer or a release. Drop everything.        |
| P1    | **today**   | On the critical path of what the user is focused on.                  |
| P2    | **soon**    | Matters, but nothing breaks if it waits a day.                        |
| P3    | **someday** | Background, exploration, nice-to-have.                                |

- Whoever creates a workstream sets its level. Tasks inherit it unless clearly different; say why
  when you change it.
- The user overrides by saying so ("make this P0", "that's someday"). Their word wins; update the
  card at once.
- When unsure between two levels, pick the lower one and say so in one line.

Every time you need the user, name the need in plain words on the status line, as
[messages.md](messages.md) says: `Needs your pick`, `Needs your yes`, `Needs your review`,
`Needs <the thing> from you`, or `Needs you to <action>` with Steps for what only the user can do
outside the chat. When work runs on and the answer is needed only later, write
`Working · needs <thing> later`: the sidebar shows it after every ask that stops work. When
nothing runs and you only wait on something that isn't the user (CI, a free slot, another lead's
merge), write `Waiting on <thing>`, not Working.

Queue order for the user: level, then asks that unblock other agents, then yes-or-no asks, facts
and hand actions before picks and reviews, then longest waiting.

## Spawning

- **Claude subagent (Agent tool):** only small, bounded, read-only lookups that return an answer to
  you and edit nothing: `subagent_type` Explore, Plan, claude-code-guide, web-fetch or
  statusline-setup. Never
  general-purpose or fork for work, and never as a fallback when dispatch refuses. Claude Code's
  Agent tool text ("independent work to run in parallel") and the orchestration skill's "prefer your
  own subagents" do not apply to coordinators and leads; this skill overrides them. In Claude Code a
  hook (scripts/delegation-check.mjs) denies other types for coordinators and leads unless the
  user's latest prompt asks for a subagent or runs a slash command or skill. A lead is recognised
  by the "Your role: lead" first prompt or a recorded role. Any hook error allows the call. Codex
  and other agents have no such hook.
- **Orca worker or lead:** when you hand off work that edits files, takes more than a few minutes,
  or the user may want to watch or talk to. Start it with `orca-flow dispatch`, never with a bare
  `orca orchestration worker-start`: dispatch runs the capacity gate, picks the model, starts the
  agent on it and logs why. Implementation and substantial parallel work go to workers without
  the user asking for workers.
- **Agent:** dispatch picks it from the user's Settings → Models. When the user asks for an agent
  (Codex, Antigravity) or a model, pass it (see Which model). Check eligibility with
  `orca agent installed --worktree <selector> --json` on the target host. If the requested
  provider is unavailable, report that before dispatching.

Before your first dispatch in a session, run `orca-flow types` once: it lists the task types the
user routes to their own models (see Which model), or says there are none.

```sh
orca-flow dispatch --role worker --kind normal --worktree current \
  --task-title "<outcome>" --spec-file - <<'EOF'
<spec>
EOF
```

It prints one line: `Started <dispatch id> on <model> — <why>`. Every `worker-start` flag
(`--worktree`, `--task`, `--task-title`, `--spec`, `--spec-file`, `--keep-open`, `--repo`, `--name`,
`--base-branch`, `--display-name`, `--comment`, `--setup`, `--deps`, `--parent`, `--run`,
`--retry-of`) passes through unchanged. `--dry-run` prints the exact command and starts nothing.
Exit 2: the capacity gate said no, so queue the task. Exit 3: no model fits; tell the user what it
printed (they fix it in Settings → Models). Neither starts anything. Exit 4: Orca did not confirm
the start, so a worker may or may not run. Do not start another: run the same command again, and it
replays the same request instead of starting a second worker. If Orca has settled the earlier
start, it is reported and nothing starts; `--restart` starts it again, only when no worker runs for
it. Pending starts older than 24 hours are dropped. `--attempt` goes only with `--retry-of`. An
explicit `--effort` the model does not accept is refused (a Settings pick is lowered to the nearest
accepted effort). `--effort` without `--model` is refused. Model lists are cached for 10 minutes; `--refresh-models` looks again. Never run the task
as a native subagent instead.

### Which model

`orca-flow route --role worker --kind <kind> --explain` (or `--type <id>`) shows the choice, the row
it came from, its fallback and why, without starting anything.

- Coordinators and leads start on the model the user set for that role. None set: the provider's
  default, as before.
- **Task type first.** The user may define task types in Settings → Models (such as Browser checks
  or Images), each with its own model and fallback. `orca-flow types` lists them with their
  descriptions; run it once per session before you dispatch. Give a task `--type <id>` only when it
  clearly fits that type's description. A typed task runs on its type's model whatever its kind,
  risk or context. Do not split a task into a typed part and a code part just to use a type: a task
  that is mostly code goes by difficulty. An unknown type is refused (exit 3) with the known ones.
- **Then difficulty.** Every other task starts on the model the user picked for its kind (a model,
  an effort and one fallback per kind; a preset sets the kinds and the types at once). So give every
  untyped task a kind:
  - `simple`: mechanical, one or two files, an obvious result. "Rename `total` to `subtotal` in
    src/cart.ts."
  - `normal` (the default): a bounded change with tests. "Add an empty state to the panel, with
    a test."
  - `hard`: cross-cutting design, hard debugging, concurrency, migrations or security. "Find why
    handover drops mail when two runs move at once."
  - Add `--risk high` when a mistake is costly (production data, money, security, a release): one
    kind up. "Change the release script."
  - Add `--context large` when the task must read much code or long documents: at least normal.
    "Map the 40-file sync module before changing it."
  - The old `--class trivial|standard|complex` still works and means the same kinds.
- When a type's or kind's model is unavailable, its fallback starts and the reason says so. When
  both are, dispatch refuses (exit 3): tell the user to fix that row in Settings → Models.
- **The user's choice wins.** When the user names an agent, a model or an effort, pass `--agent`,
  `--model`, `--effort`. They go straight through and are never swapped. When one is unavailable,
  dispatch refuses (exit 3): tell the user; do not pick another yourself.
- **Escalate only after a demonstrated failure:** the worker reported `--outcome failed`, or it
  could not fix its result after you sent it what was wrong. Then rerun the task one kind up:
  `orca-flow dispatch --role worker --retry-of <failed dispatch id> --worktree current`. It reads
  the last attempt from `~/.orca-flow/routes.jsonl` and reuses the task, its type, kind, risk and
  context. A model the user chose is kept and retried at the next effort. A typed task never moves
  to the difficulty rows: its first retry runs on the type's fallback, and after that (or with no
  other fallback) dispatch refuses: "No stronger model for <type>: ask the user before trying
  again." It also refuses when the task already ran on the hard row, or when the retry would land on
  the model that failed; then ask the user. A task Orca still shows as completed must first be
  marked failed: `orca orchestration task-update --id <task> --status failed --result "<why>"`.
  Never escalate because a task looks hard, and never start on a stronger model "to be safe".

### Splitting work

Split only into independent, bounded tasks, each owning named files. Do not split trivial work:
one worker does a handful of small edits faster than several workers start. Several tasks go in a
plan file, which `orca-flow plan` checks and starts (see [roles/lead.md](roles/lead.md)). A plan
task takes `"type"` like `--type`. Never split a task into a typed part and a code part just to use
a type.
**Comparing two ways of splitting** (lead alone vs lead + workers, say): only when the user asks for
a comparison, start each arm's lead with `--arm baseline|variant --pair <id>` (same `<id>` for both
arms, same task and checks, same models). Analytics compares the pair; `--arm` without `--pair` is
refused, and a `--retry-of` keeps its first attempt's arm.
`plan start` also finishes a partly started plan. A start Orca did not confirm (exit 4) is replayed
by `plan next`, never started twice. If Orca gave no request id, check
`orca orchestration task-list`, and use `plan next --restart <task id>` only when no worker runs for
that task. A plan starts every ready task the memory check allows; the rest stay queued. The check is one
memory scan per command plus an estimate for each agent a start adds.

**Worker lifecycle is Orca's job.** A finished worker closes on its own and frees its memory.
`orca orchestration send --to dispatch:<id>` reaches it in any state: a closed one is reopened with
its whole conversation, so follow-up work on the same area goes to the same worker instead of a new
one. Never release or close workers yourself, and use `--keep-open` only for an agent whose chat
the user will keep using (a lead).

**Only coordinators create worktrees.** A worktree costs a setup run (install) and usually a dev
server; that, not the checkout, is what slows the machine. Leads and workers work in `current`;
a request that needs its own branch or PR is a separate workstream: a new lead in a new worktree.
A lead asks its coordinator for one with `orca orchestration ask`; it never juggles branches in
its own worktree.

### Capacity gate

Capacity is memory, not counts: a worktree on disk costs nothing, while agents (about 0.5 GB each)
and dev servers (often 2 GB or more per project) are what slow the machine. `orca-flow dispatch`
and `orca-flow plan` run this gate before **every** start and refuse when it says no. Run it
yourself to see the room, and before you ask for a new worktree:

```sh
orca-flow capacity --json                 # in general
orca-flow capacity --repo <name> --json   # before creating a worktree for that project
```

It compares free memory (what Orca reports as available, minus a 2 GB margin) with what starting
costs on this machine: an agent, and per project the environment its worktrees run. A project's
environment is measured: what its worktrees' agents started (dev servers, emulators), counted as
what they keep hot in RAM (their footprint minus compressed pages, which an idle dev server has
plenty of). Each checkout's last measurement is remembered for 30 days, the newest 10 per project,
and a project is priced at the median of them, so one heavy checkout does not set the price. A
project whose agents work and start nothing (orca-flow) costs 0 GB; a project never seen at work
here is priced at 1.5 GB. With `--repo`, the output names the checkouts the price comes from.

When macOS reports `warn` memory pressure, a new worktree also needs headroom: 2 GB, or half its
environment when that is more. On this machine a new orca-flow worktree needs 0.5 + 0 + 2 = 2.5 GB
free, a new mono worktree about 0.5 + 4 + 2 = 6.5 GB (a project with a 10 GB environment
0.5 + 10 + 5 = 15.5 GB).

- `ok`: a new worktree with its environment fits; start anything.
- `agents-only`: another agent fits in an existing worktree; queue anything that needs a new one.
- `full`: not even an agent fits; queue the task.
- `pressure`: macOS reports `critical` memory pressure; queue everything. A P0 waits too:
  propose freeing room (see P0 below).

Dispatch lets a start through on `ok`, and on `agents-only` when it makes no new worktree. No flag
skips the gate.

Swap use is information only: decide on the verdict alone. Never queue work or warn the user
because swap looks full. macOS keeps old pages in swap long after RAM is free again, so a full swap
does not mean memory is short.

When the answer is no, `reclaimable` names what would free memory: `idleEnvironments` (a
worktree's dev servers running while no agent there works, usually the biggest win; `gb` is hot in
RAM, `footprintGB` adds compressed pages, `parts` lists each pane's processes) and
`finishedSessions`. Offer the largest as an `approval` ask; never stop anything without a yes.
Finished worktrees (merged or never diverged, clean, idle, yours by lineage) come from the
read-only `orca-flow sweep`, which also lists leads that died with work open; the coordinator asks
about its one batch and removes it only with `orca-flow sweep remove --batch <id>` after a yes
(roles/coordinator.md, Worktree cleanup).

**Queue, don't squeeze.** When the gate says no, queue the task instead of starting it, and tell
the user it is queued and why in one line. A task needs a Run: if `orca orchestration run-current`
shows none and you are a home coordinator, `run-create --objective "<goal>"` first; a lead or worker (dispatched) never runs `run-create`, since it would fence its messages to the Run it already works in: omit `--run`. Then `orca orchestration task-create
--task-title "<outcome>" --spec-file -`. Queued tasks show in `orca orchestration task-list
--ready`; start the highest first when a slot frees, with
`orca-flow dispatch --role worker --task <id>` (`--role lead` for a lead) plus the place flags it
needs. **P0 preempts:** if a P0 is queued, propose pausing the lowest-priority idle agent as a
yes-or-no ask (`Needs your yes`); never stop one without the user's yes.

## Bots

Orca bots are always-on specialists the user set up (live QA, checks, releases, reviews). Before
doing recurring or specialist work yourself, see which bots your project has:

```sh
orca-flow bots --repo <repo>   # its coordinator's bots, then Personal ones (cross-project)
```

- **Hand it the work** (it takes over and reports in its own chat):
  `orca orchestration send --to bot:<name> --chat new --type handoff --subject "<outcome>" --body "<spec>"`.
- **Ask it something** (it answers you by mail): the same with `--type question`.

Each listed bot comes with its exact command. A paused bot does not run: do the work yourself.

## Workstream cards

Each worktree has one card that answers the user's four switch questions. The coordinator writes
it when it creates the workstream; the sidebar's summarizer fills the rest after every turn.

| Field   | Answers                                       | Written by                 |
| ------- | --------------------------------------------- | -------------------------- |
| `goal`  | What did I ask for?                           | Coordinator, at creation   |
| `fits`  | Which project, which coordinator, what's next | Coordinator, at creation   |
| `since` | What happened while I was away?               | Summarizer, each turn      |
| `needs` | What does it want from me, with options?      | Summarizer, each turn      |

```sh
orca-flow set --worktree <selector> --priority today \
  --goal "<one sentence: the outcome, not the steps>" \
  --fits "<one sentence: what this unblocks>"
```

`<selector>` is any Orca worktree selector: `name:<name>`, `path:<path>` (a `worker-start` receipt's
`workspace` is `<repoId>::<path>`), or `current`. A lead updates its worktree's card when the goal
or level changes (`orca-flow set --worktree current --priority now`). Workers never write cards: they
share their worktree's, and the first line of a worker's spec is its goal, so write that line as a
one-sentence outcome. `orca-flow get --worktree <selector>` shows a card.

## Goals

A goal is something the user needs to get done, in their words: a title, and optionally steps, the
next thing to do, what "done" looks like, and links to Linear issues or worktrees. A goal may span
several issues, or have no issue, worktree or agent at all. The sidebar lists them at the top.
Goals is a switch in Orca Flow Settings → Features, off by default: if a goal command says Goals is
off, skip goals and do not mention them to the user.

```sh
orca-flow goal add "<title>" [--next ..] [--done-when ..] [--step ..]... [--linear DES-340] [--worktree current]
orca-flow goal list [--worktree current] [--all]     # open and proposed; current = linked to this worktree
orca-flow goal show <id>
orca-flow goal set <id> --next "<the next thing to do>"
orca-flow goal step <id> add "<text>" | tick <n|text> | untick <n|text>
orca-flow goal link <id> --worktree <selector> | --linear <ID>     # unlink removes
orca-flow goal propose-done <id>
```

A goal's next step is its `next` when one is written, else its first open step: with no `--next`,
the sidebar, `goal list` and the Jump/Assign button show that step. Set `--next` only when the real
next action differs from it; ticking the step that is the `next` clears it, so the next open step takes over.

The user and leads keep a goal current: tick steps, set `next` when it differs. Agents never mark a goal done: they
`propose-done` and the user confirms it in the sidebar. `goal done` and `goal reopen` run only on
the user's word. Workers do not touch goals.

### Writing steps and done-when

- A goal that ships a change (a feature, a fix, "Ship ...", "Add ...") ends at the release, not the
  merge. Its last step is "Released to production" (or the project's own word: deployed, published,
  installed), and done-when ends with "... and it is released to production". A merged PR is a step on
  the way, never the end. A goal that ships nothing (decide, research, write a doc) ends where the user
  said.
- Each step is one checkable outcome: one thing anyone can see is true or not, written as the outcome
  ("Super Admins can delete any post"), not an activity ("work on moderation"). No bundles:
  "Moderation rights (edit, delete, block)" is three steps.
- done-when is one sentence the user can check, and it ends where the last step ends.
- A step only partly done: split it, tick the done part, keep the rest as its own step, so the missing
  part shows.

`goal add`, `goal step add` and `goal set --done-when` print `hint:` lines when a step bundles outcomes,
done-when ends at the merge, or a shipping goal has no release step. They are advice: the goal is saved
as written, so fix it with `goal step` or `goal set` if the hint is right.

## Keeping the user's attention cheap

- Coordinators and leads end every message to the user as [messages.md](messages.md) says: read
  it before your first message. A worker's report to its lead is not a message to the user.
- Tell the user what changed since your last message, the evidence in one line (and what it did
  not cover), and what is next. Don't retell the story, and don't send logs.
- Write in plain words: "a worker", "the release lead", "the fix". Leave out terminal handles,
  run or dispatch ids, commit hashes and Orca words like worker_done or status note.
- The user's standing instructions hold: don't ask again for what they already allowed.
- Hand implementation and any substantial or parallel task to a tracked Orca worker; your own
  subagents (Agent tool) are only for small, read-only lookups. In messages, call it "a worker".
- End your turn as soon as work is handed off; Orca wakes you when workers report. Never poll.
- A wake (Orca mail, a task notification) is not the user: read the mail, act or reply on its
  route, end the turn. Don't recap the mail, don't repeat the user's open question, don't send a
  status. Reply with one plain line (what arrived, what you did; about 25 words, no status line, no
  Ask, no ids), never an empty reply; the open ask stands. Write to the user only for news they can act
  on or a changed question (then one whole frame, saying the old ask is replaced). A person asking
  "status?" is a normal prompt. See "Mail and notifications" in [messages.md](messages.md).
- Answer a worker's question yourself when it follows from the task or the user's instructions;
  bring the user only what only they can decide.
- Ask the user from the agent that owns the decision, in its own chat, so its card shows the ask.
  Workers ask their lead; a lead asks the user directly about its workstream; a coordinator asks
  only about routing, capacity, worktrees and conflicts between workstreams, and never relays a
  lead's question as its own.
- A coordinator never restates a lead's question, its options or its recommendation: it points
  to the lead's chat or to Up next.

## The project's words

Call each product concept by the project's own name for it, and use the same name everywhere: in
chats, questions, specs, handoffs, eval criteria, fixtures and code. The user should never have
to ask what one of your words means.

- **Look it up first.** Before you name a concept, read the repo's domain guide or glossary (a
  `CONTEXT.md`, or whatever its agent docs point to, such as `docs/agents/domain.md`) and the
  labels users see in the product. Use the term you find there, every time.
- **Do not swap words.** Words that sound close may be different concepts. Keep them apart unless
  the domain docs say they mean the same thing, and never switch words for variety.
- **No agreed term?** Describe the concept plainly ("the questions generated before anyone
  edits them"), propose a name and its meaning to the user while you discuss the work, and use it
  only once they agree. Then add it to the repo's existing domain docs, with the change that first
  uses it.
- **Per role:** a coordinator passes the user's words on unchanged; a lead writes specs, eval
  criteria and questions in the agreed terms and asks the user about a new one; a worker asks its
  lead about a term it cannot place.

## Never

- Start a lead or worker with a bare `worker-start`: use `orca-flow dispatch`, which runs the
  capacity gate and picks the model.
- Override the user's model choice, or escalate a task that has not failed.
- Use priority words other than now/today/soon/someday.
- Create a worktree unless you are a coordinator.
- Diagnose as a coordinator: route a reported problem to a lead with the user's words, never
  investigate it yourself.
- Release or close workers; Orca does that.
- Remove a worktree without the user's yes.
- Poll workers or run watch scripts.
