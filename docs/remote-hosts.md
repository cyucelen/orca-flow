# Paired hosts

Orca can pair other machines (servers) with this one, for example a machine with more RAM to take
work this one has no room for. Orca Flow lets a lead or coordinator see those hosts and start a lead
or worker on one, when the user chooses it. Nothing moves to another host on its own.

This is opt-in: it stays off until **Paired hosts** is switched on in Orca Flow Settings → Features (off, no host is polled or shown, and `hosts`, `dispatch --on` and `capacity --on` refuse). It needs Orca host API 1.11 ([stablyai/orca#51918](https://github.com/stablyai/orca/pull/51918)); Orca Flow does not detect the Orca version for this.

## Supported

- **`orca-flow hosts [--json]`**: this machine and each paired host, read-only: reachable or
  unavailable (with a reason), Orca version, RAM total and available, installed agents, whether it
  takes remote workers, its worktree count, and its host-version limits (below). Each command has
  its own timeout (8 s) and at most 2 hosts are read at once. With no paired host it prints one line.
- **`orca-flow capacity --on <host> [--repo <name>] [--json]`**: the capacity verdict on that
  host, priced as `orca-flow capacity` prices it here: its available memory minus the margin,
  against one agent (the median of that host's agent sessions) plus the project's environment.
  This machine's memory is not part of it.
- **`orca-flow dispatch --on <host> ...`** for leads and workers. `--on` takes the host's name (any
  case) or its environment id; a name two hosts share is refused with their ids. Before anything
  starts, each read-only and bounded:
  1. the host is reachable (else "caca is unavailable: <reason>");
  2. its Orca lists `orchestration.federation.v1` (else refused, naming its version);
  3. the placement exists there: `--worktree new-top-level` or `new-child` with `--repo` naming a
     project on that host, or an exact selector (`id:`, `path:`, `name:`, `branch:`, `identity:`)
     of a worktree on that host. `--worktree current`, or none, is this machine's worktree and is
     refused;
  4. the routed agent, or the one the user named, is installed there (else refused, listing what it
     has; nothing is swapped);
  5. that host's memory has room (exit 2 when it does not, or when it cannot be read: capacity
     there is never guessed).

  Then `orca orchestration worker-start --on <environment id>` with everything else as for a start
  here (task, spec, model, effort, `--keep-open`, `--run`, `--parent`, `--deps`). The Run and the
  mailbox stay on this machine, so the worker's questions and `worker_done` reach the lead that
  started it, as for a local worker. Address it by its dispatch id.
- **`--dry-run` with `--on`** runs every check and prints the exact `worker-start` command and the
  host's verdict; it starts nothing.
- **Unknown outcome**: the pending-start record carries `--on`, so running the same command again
  replays the start to the same host and never starts a second worker.
- **`--retry-of` a start that ran on a host** is refused unless `--on` is given again: Orca's
  `worker-start` does not carry placement over, and a retry without it would start on this machine.
  The refusal names the previous host and worktree.
- **routes.jsonl**: a start on a host gains `host: { id, name }` (`id` is Orca's host id,
  `runtime:<environment id>`). Local starts have no `host` field, so older readers are unaffected.

With no host paired (or `orca environment list` failing), every command works exactly as before:
dispatch never reads the host list unless `--on` is given.

## Host-version limits found

Checked read-only on 2026-11-28 with this machine on Orca 1.4.263 and caca on 1.4.232:

- caca's `orca status` lists `orchestration.federation.v1`, so it takes workers started from here,
  but not `orchestration.remote-owned-workers.v1`, `orchestration.peer-mail.v1`,
  `orchestration.worker-auto-release.v1` or `orchestration.worker-keep-open.v1`, which this machine
  lists. `orca-flow hosts` shows those as its host-version limits; dispatch adds a note when
  `--keep-open` goes to a host whose Orca does not list `worker-keep-open`. Orca's own docs say an
  Orca too old for mail between hosts answers `server_mail_unsupported`, and one too old to nest
  across machines starts a `new-child` worker top-level with a warning in the receipt.
- Orca lists no models for another host: the model and effort pass through unverified, and the
  agent runs on that host's own account.
- The plugin API's `workspace.list` does not list a paired host's workspaces, so the sidebar
  cannot open or focus a remote workspace.
- `orca worktree ps` here names a paired host under `hostScope.omittedHostIds` and returns only
  this machine's rows; a paired host's own rows call themselves `hostId: 'local'` and are re-keyed
  by host id before any join (skills/orca-flow/scripts/hosts.mjs).
- `orca diagnostics memory --environment` is a process sweep (about 0.4 s on caca), so it is read
  per command, not polled fast. Memory pressure is a macOS reading of this machine and is not read
  on a host.
- Project environments (dev servers) are measured on this machine only, so a project on a host is
  priced at the 1.5 GB fallback.
- `worker-start --on` takes a saved environment by name or id; dispatch passes the environment id,
  since two hosts may share a name. This was checked only with refused calls against host names
  that do not exist; no worker was started on caca.

## Not supported

- Moving a live session (a running lead or worker) from one host to another.
- Automatic placement: Orca Flow never picks a host, and never moves work to a host when this
  machine's gate says no.
- Remote cleanup: the finished-worktree sweep stays on this machine; nothing is stopped, removed or
  archived on a paired host.
- `orca-flow plan` on a host: a plan runs in one worktree on this machine.
- Pairing, waking, updating or changing a host, or copying accounts or secrets to it: do that in
  Orca (Settings, or `orca pair`).
