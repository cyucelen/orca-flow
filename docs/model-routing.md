# Model routing and worker delegation

Orca Flow picks the model for every coordinator, lead and worker it starts, from choices you make
once in Settings → Models. This page says what you can set, what happens on a dispatch, and what it
does not do.

- [Settings → Models](#settings--models)
- [What a dispatch does](#what-a-dispatch-does)
- [Availability](#availability)
- [Commands](#commands)
- [Delegation](#delegation)
- [Where decisions show](#where-decisions-show)
- [Limits](#limits)

## Settings → Models

**Preset.** One pop-up sets the coordinator, the lead and all three worker rows at once. The limits
below and your saved presets stay as they were.

- **Balanced, Economy, Best quality:** built-in starting points. They are fixed; edit a row and the
  pop-up shows Custom.
- **Saved presets:** use Save as… to keep the current setup under a name (up to 10). The same name
  replaces that preset. A built-in's name is refused. A saved preset can be deleted; a built-in one
  cannot.
- **Custom:** shown while nothing matches a preset.

The built-ins, all on Claude. Each row is the model and effort, then the fallback:

| Preset | simple | normal | hard |
| --- | --- | --- | --- |
| Balanced (the default) | Haiku, then Sonnet · low | Sonnet · medium, then Opus · medium | Opus · high, no fallback |
| Economy | Haiku, then Sonnet · low | Sonnet · low, then Opus · low | Sonnet · high, then Opus · high |
| Best quality | Sonnet · low, then Opus · low | Opus · medium, then Sonnet · high | Fable · high, then Opus · xhigh |

All three leave the coordinator and the lead on the provider default. Haiku has no effort, because
Orca takes none for it.

**Coordinator and lead.** A model and an effort each, or Provider default. Provider default passes no
model, which is how Orca Flow started them before routing existed. Each pop-up lists the agents Orca
has installed.

**Workers, by task kind.** Whoever splits the work calls each task `simple`, `normal` or `hard`:

- `simple`: mechanical, one or two files, an obvious result.
- `normal`: a bounded change with tests. This is the default.
- `hard`: cross-cutting design, hard debugging, concurrency, migrations or security.

Each kind has a row: a model, an effort and one fallback. A model shown dimmed is not available on
this machine; its tooltip says why and whether a fallback will be used.

**Workers at once.** How many workers one lead runs at the same time (1 to 6, default 3). The memory
check still applies to every start.

**Moves up after a failure.** How many times a failed task may be retried one kind up (0 to 2,
default 1). Past that, dispatch refuses and the agent asks you.

## What a dispatch does

Order of precedence, first match wins:

1. **The task's own `--agent`, `--model` or `--effort`.** Passed straight through. An explicit model
   that is unavailable is refused, and nothing is substituted. The same goes for an effort the model
   does not take.
2. **The coordinator or lead pick** from Settings, for those roles.
3. **The kind's row** from Settings, for workers.

For a worker, the row is worked out first:

- **Risk high** (`--risk high`) moves up one kind.
- **Large context** (`--context large`) means at least `normal`.
- **A retry** (`--retry-of`) moves up one kind per earlier failure, up to the limit above. Past
  `hard` the kind stays `hard` and each extra step raises the effort one level. The retry keeps the
  earlier context, risk and explicit model. An explicit model is never swapped: the retry runs on
  the same model at the next effort. If a retry would land on the model that failed, it is refused
  with exit 3 and nothing starts.

Then the model:

- **Row's model unavailable:** the row's fallback starts, and the reason says so.
- **Both unavailable, or no fallback:** the dispatch is refused with exit 3 and names the row to fix.
  It never falls back to a provider default or a premium model on its own.
- **A coordinator or lead pick whose model is unavailable:** that agent's default model starts, and
  the reason says so. If the agent itself is not installed, it is refused.
- **Effort:** passed only where the provider reports it and Orca accepts it at launch. If the effort
  asked for is not accepted, the nearest lower one is used. `--effort` without `--model` is refused:
  an effort needs a model to apply to. Orca 1.4.263 takes no effort for the
  `haiku` alias, so a Haiku start carries none.

A decision applies to **new launches only**. A running session keeps its model, and a resumed
conversation keeps the one it had. Nothing is relaunched when you change Settings.

Plan tasks keep the route recorded when the plan started, so a settings change never switches
pending work. If a recorded model has become unavailable, that task is routed again and the new
route is printed.

## Availability

What Orca Flow can verify on this machine, with no API call:

- **Agents:** `orca agent installed --json`.
- **Claude models:** Claude Code's own `list_models` request, sent to a local `claude` process. It
  lists models, display names and efforts without a model turn.
- **Codex models:** `codex debug models`.

Orca has no model listing API for plugins, so these are the sources. If Claude's list cannot be
read, the aliases (`haiku`, `sonnet`, `opus`, `fable`) and full `claude-*` ids are accepted without
being checked. A model another agent does not list is refused.

## Commands

These run from `skills/orca-flow/scripts/orca-flow.mjs` (agents reach it through the skill link).
Examples use `orca-flow` for short.

**Show a decision, start nothing.** `--explain` adds the row, its fallback and what was passed over.

```sh
orca-flow route --role worker --kind hard --risk high --explain
```

**Start a worker.** Runs the capacity gate, routes, then `orca orchestration worker-start` with the
routed flags. Exit 2: capacity said no (queue it). Exit 3: no model fits. Neither starts anything.
Exit 4: Orca did not confirm the start, so the outcome is unknown. `--dry-run` prints the command
and starts nothing.

Model lists are cached for 10 minutes in `~/.orca-flow/models-cache.json`. Add `--refresh-models` to
look again.

After exit 4, run the same dispatch again. It replays Orca's request (`--retry-request <id>`, which
you can also pass yourself), so a worker is never started twice.

```sh
orca-flow dispatch --role worker --kind normal --worktree current \
  --task-title "Add the empty state" --spec-file - <<'EOF'
<spec>
EOF
```

**Run a plan.** Several independent tasks, each owning files, in one JSON file.

```sh
orca-flow plan check plan.json    # file ownership, dependencies, waves
orca-flow plan start plan.json    # one Orca task each, started in waves
orca-flow plan next plan.json     # start what became ready
orca-flow plan status plan.json   # the table
```

A plan has at most 8 tasks. `kind` defaults to `normal`. Its state is kept in
`~/.orca-flow/plans/<slug>-<hash>.json`: the title, and a hash of the plan file's path, so two plans
with the same title do not share a file.

`plan start` finishes a plan that only partly started, for example after a failure part way or after
tasks were added. It creates only the tasks that are missing. A task whose start Orca did not
confirm (exit 4) is replayed by `plan next`. If Orca gave no request id, check
`orca orchestration task-list`. Only if no worker runs for that task, restart it:

```sh
orca-flow plan next plan.json --restart ui
```

```json
{
  "title": "Empty state",
  "tasks": [
    { "id": "ui", "title": "Empty state in the panel", "spec": "…", "kind": "normal",
      "files": ["src/panel/"], "deps": [] },
    { "id": "docs", "title": "Document it", "specFile": "docs-spec.md", "kind": "simple",
      "risk": "low", "context": "normal", "files": ["README.md"], "deps": ["ui"] }
  ]
}
```

A task may also set `agent`, `model` and `effort`, which win as in the precedence above.

**Escalate a failure.** After a worker reports `--outcome failed`, run the task again one kind up. It
reads the last attempt from `routes.jsonl`, reuses the task, its kind, context, risk and explicit
model, and refuses past the limit or when it would land on the model that failed.

```sh
orca-flow dispatch --role worker --retry-of <failed dispatch id> --worktree current
```

## Delegation

Leads and coordinators hand implementation to Orca workers, started with `orca-flow dispatch` or
`orca-flow plan start`. A worker has an Orca task, a row in the sidebar, the model you picked for its
kind and the capacity gate. A native Claude Code subagent has none of these.

For Claude Code, a **PreToolUse hook** on the Agent tool (`delegation-check.mjs`) enforces this. It
denies the call only when all of these hold:

- the agent runs in an Orca pane;
- it is a coordinator or a lead;
- the subagent type is not read-only. Always allowed: `Explore`, `Plan`, `claude-code-guide`,
  `web-fetch`, `statusline-setup`;
- your latest prompt does not ask for a subagent (it names a "subagent", "sub-agent", "Agent tool" or
  "native agent" outside a negation like "no subagents").

So if you ask for a subagent, you get one. The denial tells the agent to start a worker instead, and
to queue the task or tell you if capacity or routing refuses. Workers, chats you started yourself and
every other tool are not touched. If the hook errors, the call is allowed.

The hook is on by default. Turn it off in `~/.orca-flow/config.json`:

```json
{ "delegationCheck": "off" }
```

Each denial is logged to `~/.orca-flow/delegation.jsonl`: time, session, role, subagent type and the
call's description.

**What it does not enforce:**

- **Codex and other providers.** They have the instructions in the skill, not a hook.
- **A lead Orca Flow has no record of.** The hook knows a lead from a recorded role (see
  [How work flows](../README.md#how-work-flows)). An unrecorded one is treated as any other chat.
- **A lead doing the work itself.** The hook watches subagents. A lead that edits files itself is not
  stopped.

## Where decisions show

- **One line from dispatch:** `Started <dispatch id> on <model> — <why>`.
- **`~/.orca-flow/routes.jsonl`:** one line per routed start, with the choice, the source, the reason,
  the kind, the risk and the attempt. `--retry-of` reads it too.
- **The sidebar:** a worker's row shows the model its dispatch was routed to in its tooltip, from
  `routes.jsonl`.

## Limits

- Presets and kinds are your choices, not measured quality. The built-ins are starting points to
  edit.
- No token prices and no plan usage are read. Economy is not a cost promise.
- The coordinator model needs the `orca agent launch` CLI, because the plugin host's `agent.launch`
  takes no model. With the default (Provider default) the host call is used as before.
- The hook takes effect only after the installed copy updates, because it lives in the plugin's
  scripts and your Claude profile's `settings.json` points at the installed copy. A development
  folder leaves the installed hooks alone.
