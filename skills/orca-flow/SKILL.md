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

- **Claude subagent (Agent tool):** only read-only lookups that return an answer to you and edit
  nothing (search, read docs, summarize code). No tracking, no extra memory.
- **Orca worker or lead:** when you hand off work that edits files, takes more than a few minutes,
  or the user may want to watch or talk to. Start it with `orca-flow dispatch`, never with a bare
  `orca orchestration worker-start`: dispatch runs the capacity gate, picks the model, starts the
  agent on it and logs why.
- **Agent:** dispatch picks it from the user's Settings → Models. When the user asks for an agent
  (Codex, Antigravity) or a model, pass it (see Which model). Check eligibility with
  `orca agent installed --worktree <selector> --json` on the target host. If the requested
  provider is unavailable, report that before dispatching.

```sh
orca-flow dispatch --role worker --class standard --worktree current \
  --task-title "<outcome>" --spec-file - <<'EOF'
<spec>
EOF
```

It prints one line: `Started <dispatch id> on <model> — <why>`. Every `worker-start` flag
(`--worktree`, `--task`, `--task-title`, `--spec`, `--spec-file`, `--keep-open`, `--repo`, `--name`,
`--base-branch`, `--display-name`, `--comment`, `--setup`, `--deps`, `--parent`, `--run`,
`--retry-of`) passes through unchanged. `--dry-run` prints the exact command and starts nothing.
Exit 2: the capacity gate said no, so queue the task. Exit 3: no model fits; tell the user what it
printed (they fix it in Settings → Models). Neither starts anything.

### Which model

`orca-flow route --role worker --class <class> --explain` shows the choice and what it passed over,
without starting anything.

- Coordinators and leads start on the model the user set for that role. None set: the provider's
  default, as before.
- Workers start on the cheapest enabled model rated for the task, so class every task:
  - `trivial`: mechanical, one or two files, an obvious result. "Rename `total` to `subtotal` in
    src/cart.ts."
  - `standard` (the default): a normal bounded change with tests. "Add an empty state to the panel,
    with a test."
  - `complex`: cross-cutting design, hard debugging, concurrency, migrations or security. "Find why
    handover drops mail when two runs move at once."
  - Add `--risk high` when a mistake is costly (production data, money, security, a release): one
    tier more. "Change the release script."
  - Add `--context large` when the task must read much code or long documents: at least Standard.
    "Map the 40-file sync module before changing it."
- Tiers (Light, Standard, Strong) and costs (1-5) are the user's own relative settings, not prices
  and not measured capability. Never quote them as money.
- **The user's choice wins.** When the user names an agent, a model or an effort, pass `--agent`,
  `--model`, `--effort`. They go straight through and are never swapped. When one is unavailable,
  dispatch refuses (exit 3): tell the user; do not pick another yourself.
- **Escalate only after a demonstrated failure:** the worker reported `--outcome failed`, or it
  could not fix its result after you sent it what was wrong. Then rerun the task one tier up:
  `orca-flow dispatch --role worker --retry-of <failed dispatch id> --worktree current`. It reads
  the last attempt from `~/.orca-flow/routes.jsonl`, reuses the task and its class, and refuses past
  the user's escalation limit; then ask the user. A task Orca still shows as completed must first be
  marked failed: `orca orchestration task-update --id <task> --status failed --result "<why>"`.
  Never escalate because a task looks hard, and never start on a stronger model "to be safe".

### Splitting work

Split only into independent, bounded tasks, each owning named files. Do not split trivial work:
one worker does a handful of small edits faster than several workers start. Several tasks go in a
plan file, which `orca-flow plan` checks and starts (see [roles/lead.md](roles/lead.md)). At most
`maxParallel` workers of one plan run at once (Settings → Models), and each start also passes the
capacity gate.

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
environment is measured: what its worktrees started (dev servers), remembered while they are
stopped. A project whose agents work and start nothing (orca-flow) costs 0 GB; a project never
seen at work here is priced at 1.5 GB.

When macOS reports `warn` memory pressure, a new worktree also needs headroom: 2 GB, or half its
environment when that is more. On this machine a new orca-flow worktree needs 0.5 + 0 + 2 = 2.5 GB
free, a new mono worktree 0.5 + 6.6 + 3.3 = 10.4 GB.

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
worktree's dev servers running while no agent there works, usually the biggest win) and
`finishedSessions`. Offer the largest as an `approval` ask; never stop anything without a yes.

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
- Answer a worker's question yourself when it follows from the task or the user's instructions;
  bring the user only what only they can decide.
- Ask the user from the agent that owns the decision, in its own chat, so its card shows the ask.
  Workers ask their lead; a lead asks the user directly about its workstream; a coordinator asks
  only about routing, capacity, worktrees and conflicts between workstreams, and never relays a
  lead's question as its own.
- A coordinator never restates a lead's question, its options or its recommendation: it points
  to the lead's chat or to Up next.

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
