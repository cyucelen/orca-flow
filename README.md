# Orca Flow

A calmer sidebar for [Orca](https://github.com/stablyai/orca) when you run many Claude Code agents
at once. It answers two questions at a glance: **what needs me next**, and **can the machine take
more work**. And it gives you coordinators: long-lived Claude sessions that take a request, hand it
to a lead and workers, and keep you out of the details.

macOS only for now.

## What you get

- **Top bar:** free memory and free disk, always visible. Click it for the details: RAM and swap,
  the heaviest sessions with the dev servers they started, and one-click cleanup.
- **Up next:** every agent waiting on you, most urgent first, each with what the work is about and
  the question it is asking, and a button to jump to it.
- **Coordinators:** your coordinators, each with its leads and workers nested under it, plus the
  chats you started yourself. Click a coordinator to open its session; right-click anything for
  actions.
- **End-of-turn summaries:** when an agent finishes a turn, Claude Haiku turns it into a short
  title, a one-line "about" and the ask, so you can switch back in seconds. If Haiku is
  unavailable, the writer uses GPT-6 Luna (`gpt-6-luna`) through the Codex CLI.
  When a coordinator's or lead's message ends in a valid [message frame](#message-format), its
  status, Ask and Reply are read as written: Up next labels the ask with the message's own status
  line ("Needs 2 files from you") and shows the Reply under it. An ask the agent needs only later
  ("Working · needs 2 files later") comes after every ask that stops work.
- **Issue, PR and age:** the title gets the row; on its right, the worktree's Linear issue when it
  has one, then its PR's number, colored the way Orca colors it (hover for the title, click to open
  the PR), the project and the age. The branch shows only as the color of the row's tree lines.
- **Tree lines:** drawn like a git graph: a neutral trunk from each coordinator, one connector into
  each chat, and each lead's lane running on into its workers in the lead's branch color
  (long-lived branches like `main` or `dev` stay neutral), quiet at rest and clear on hover and on
  the current chat. Each chat is a ring around its character in its state: a shimmer travels around
  it while working, it wears its ask's color while asking, and it fades once finished. The lead's PR
  is a bead on its ring.
- **Focus:** the chat or coordinator in front in Orca wears a slim bar on its left edge, in its
  branch's color.
- **The `orca-flow` skill:** teaches agents the coordinator, lead and worker roles, one priority
  vocabulary, and when there is room to start more.

## Requirements

- Orca 1.4.254 or newer, with Claude Code agents.
- The `claude` CLI, logged in. Summaries prefer Claude Haiku through the same login Orca's agents use.
- For writer fallback, a logged-in `codex` CLI supporting `exec --ephemeral --output-schema`
  (isolation verified with 0.170.0) and access to `gpt-6-luna`. It uses an explicit `CODEX_HOME` when set,
  otherwise Orca's selected host Codex account (or the system login when selected).
- Node 22.18 or newer on your PATH, for the `orca-flow` script agents run.

## Install

```sh
orca plugin install cyucelen/orca-flow
```

Orca lists the access the plugin asks for: running its own worker process, reading and opening
workspaces, getting agent status changes, and starting agents (to open coordinator sessions).
Approve it, then open **Orca Flow** from the right sidebar (the layers icon).

The installed copy sets up these files outside its own folder:

| Path | What it is |
| --- | --- |
| `<Claude profile>/skills/orca-flow` | A link to the plugin's skill, so every Orca agent can load it. It follows the plugin across updates. |
| `~/.agents/skills/orca-flow` | The Codex USER skill link, shared across Orca Codex accounts. Account selection changes `CODEX_HOME`, not this user skill directory. |
| `~/orca/coordinators/CLAUDE.md` | Instructions every coordinator inherits, copied once. From then on it is yours: coordinators keep your project notes in it, and updates never change it. |
| `~/orca/coordinators/<name>/AGENTS.md` and `CLAUDE.md` | Missing local instructions are seeded for new and existing coordinator folders. Launch prompts also explicitly supply the coordinator role and skill path. |
| `<Claude profile>/settings.json` | One Stop hook that checks a coordinator's or lead's last message against the [message format](#message-format), and one UserPromptSubmit hook that passes its quiet reminders to the agent. Both run only in Orca's agent panes and do nothing until you opt in. Your other settings and hooks stay as they are. |

A real file or another source's symlink is left alone, including a dangling link whose ownership
cannot be verified. Only our installed release links are repointed. A `settings.json` that is not
valid JSON is not changed. The Claude profile is Orca's selected host profile, then an explicit
`CLAUDE_CONFIG_DIR`, else `~/.claude`. Development copies leave installed links, hooks and existing
coordinator folders alone at startup. Codex receives instructions, not a port of Claude's Stop hooks;
this does not claim identical enforcement between providers.

## Getting started

1. **Create a coordinator.** In the panel, click **New coordinator**, pick a name and a look. Orca
   opens its session in a folder under `~/orca/coordinators/`.
2. **Tell it what it is for**, for example "you own the `web` and `api` repos". It records that in
   its own `coordinator.json`. A coordinator with no scope takes any project.
3. **Ask for work.** "Add guest checkout" makes the coordinator check there is room, create a
   worktree, and start a **lead** for that workstream. The lead appears under the coordinator.
4. **Steer the lead.** Talk to the lead directly for fixes and follow-ups. It does small fixes
   itself and hands bigger ones to **workers** in its worktree, then goes back to being available.
5. **Answer what is asked.** Anything waiting on you shows in **Up next** and gets a `?` badge.
6. **Sleep what you are not using.** Right-click a coordinator or session and choose **Sleep** to
   free its memory. Clicking a sleeping coordinator wakes it in the same conversation.

The coordinator menu also has a compact **Handover** row with target-provider logos. It offers
available Claude/Codex alternatives, excluding the current provider; tooltips name each target. It reads the
stored source transcript, including when the source has exhausted its quota, and launches the target
in the same workspace with scope, workstreams and pending decisions. Original conversations stay
in history. The provider-logo session dropdown keeps its one-step selection; **Start new
conversation** remains a fresh start.

**Current host limitation:** menu handover refuses coordinators with owned runs before launching:
Orca exposes no atomic ownership transfer that preserves report routes and pending asks. A target
launched as a structured chat is retained as a coordinator member, but cannot become current until
the host exposes supported chat focus/navigation for this control. Terminal targets with no owned
runs can complete after verified launch, prompt delivery and identity binding. A failed/unknown
launch keeps the source current; Retry reuses the recorded operation instead of creating another
coordinator. See [handover behavior, host gaps and evidence](docs/coordinator-handover.md).
The receiving agent waits passively for cutover in its first turn, then continues its briefing
without another prompt. If the two-minute bootstrap window expires, automatic cutover is blocked.

You can also ask a coordinator "what's next?" at any time; it names one agent that waits on you
and offers to open its chat.

## Reading the panel

**Characters.** Color is the project. Shape is the role: your coordinators wear the look you picked,
a lead is a square with a crown, a worker is a circle, and a chat you started yourself is a rounded
square. The face and the badge at the bottom right show what Orca reports:

| Badge | Meaning |
| --- | --- |
| Spinning ring | Working |
| Slow dashed ring | Monitoring (waiting on a background job) |
| Blue `?` | Waiting on you |
| Green check | Done, or for a coordinator or a lead that has not reported `worker_done`, available |
| Red cross | Failed |
| Faded, no badge | Sleeping |

**Top bar.** Memory shows what Orca reports as available, minus a 2 GB safety margin. It turns
amber when only another agent would fit (not a new worktree with its dev servers), and red when
nothing fits. Disk turns amber under 25 GB and red under 10 GB.

**PR number.** An open PR's number is colored by its CI checks: red when they failed, yellow while
they run, green when they passed. A merged PR is purple; closed and draft PRs are grey.

**Provider logos.** When live sessions use at least two known providers, each coordinator, lead
and worker shows its own logo and provider tooltip. Idle and waiting sessions count; settled
workers and closed history do not. See [provider semantics and verification](docs/provider-logos.md).

## How work flows

| Role | Owns | Does the work itself? |
| --- | --- | --- |
| **Coordinator** | Your projects, worktrees, what comes next | Never edits code |
| **Lead** | One workstream: its worktree, branch and PR | Small fixes only |
| **Worker** | One task | Yes, then reports and closes |

Orca manages worker lifecycles: a finished worker closes on its own, and a follow-up reopens it
with its whole conversation. The full rules live in [`skills/orca-flow`](skills/orca-flow): a
shared `SKILL.md` and one file per role.

Agents use the skill's script for what the panel knows:

```sh
orca-flow queue              # what is waiting on you, ranked
orca-flow capacity [--repo]  # does another agent or a new worktree fit in memory?
orca-flow set / get          # a worktree's card: priority, goal, what it unblocks
orca-flow resume             # a woken coordinator takes back the runs it was coordinating
```

(`orca-flow` here means `node <skill folder>/scripts/orca-flow.mjs`.)

## Message format

Coordinators and leads end each message with a fixed frame: a bold status line that names what
they need from you in plain words (Working, Idle, Done, "Needs your pick", "Working · needs 2 files
later"), a context paragraph of 2-4 sentences that says why first, and an **Ask:** with its options
and **Reply:** when they need you. Detail stays above the frame, and the frame points to it. The spec is
[`skills/orca-flow/messages.md`](skills/orca-flow/messages.md); agents read it from the skill.

The Stop hook checks that frame when a coordinator or a lead ends its turn. Only a miss that makes
the message unusable (no status line, an old status word, an ask without its Reply or options,
reused option letters) stops the turn: the hook names it and has the agent rewrite only the frame,
once per turn, so you never read the detail twice. Any other miss (length, style, wording) is
silent: you see nothing, and the agent gets a quiet reminder at its next prompt through a
UserPromptSubmit hook. It checks the status line (and names the plain line for an old status word), that there is
no header line, a short context paragraph and no detail inside the frame, the labels, that an ask
has a "Needs" status and a **Reply:** line, that a pick has options with one recommended, that
option letters name only the current Ask's options, that "above" points to detail but never
replaces the point, that a backticked code name is explained in plain words, and that a cost
warning gives a number. A coordinator can also answer with route lines only. Workers and your own
chats are never checked.

The check is off until you turn it on in `~/.orca-flow/config.json`, for every agent or only for
agents working in some folders (a folder and everything under it):

```json
{ "messageFormat": "all" }
```

```json
{ "messageFormat": ["~/orca/workspaces/mono/bou-4206-aic-split-lessons", "~/orca/coordinators"] }
```

Each miss adds a line to `~/.orca-flow/format-misses.jsonl`: when, the pane, the worktree, the role,
the session, the tier (`block` or `silent`) and the rules missed. Pending reminders wait in
`~/.orca-flow/reminders/` until the agent's next prompt.

## Capacity

Capacity is memory, not a count of worktrees or agents: a worktree on disk costs nothing, while
agents (about 0.5 GB each) and dev servers (often 2 GB or more) are what slow the machine. The
plugin compares free memory with what starting something costs on your machine, measured from your
own open sessions and from the processes each project's worktrees started (kept in
`~/.orca-flow/env-costs.json` while those are stopped; a project that starts nothing costs 0). When
macOS reports memory pressure "warn", a new worktree also needs headroom: 2 GB, or half its
environment when that is more. When the pressure is critical, only urgent (P0) work starts.

Change the margin and the minimum headroom in `~/.orca-flow/config.json`:

```json
{ "marginGB": 2, "warnHeadroomGB": 2 }
```

## Privacy

The sidebar and `summarize-run` read Claude transcripts, Codex terminal rollouts, and local Orca
structured-chat journals. Terminal discovery uses Orca's exact pane binding and verifies the
Codex rollout's native session ID. A terminal card claiming an Orca session also requires the
independent `agent-hooks/agent-identities.db` provider link to match that exact Orca ID, in the
local host/provider/native-ID namespace. The link is checked again before publication; missing
or contradictory identity metadata preserves the existing card rather than relabeling an old
transcript after pane reuse. Legacy Claude files remain readable without claiming an Orca ID.
Chat discovery uses the live inventory's Orca session ID and
its separate native provider handle, then reads only visible root items in the current journal
epoch. Sessions, transcripts, queued drafts and account settings are never modified. Injected
instructions, orchestration wake notices, reasoning and tool results are excluded from the digest.

The writer invokes local CLIs using your existing logins. After each turn it sends Claude Haiku
an excerpt of that agent's conversation: its first request, the latest turn's prompts and
messages, and the commands and file paths its tools used. On an availability failure, that same
excerpt is sent to OpenAI's [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
through Codex instead. Provider usage limits and billing apply to the selected accounts.

Both providers run separate requests without resuming or changing the source session. Codex runs
in a temporary directory with a read-only sandbox, no session persistence, and shell, MCP, apps,
web search, plugins and hooks disabled for that invocation. The writer pins the OpenAI
provider and ignores user `config.toml` for this request: empty MCP tables merge with configured
servers, so an empty-table override does not isolate a writer. `CODEX_HOME` still supplies account
authentication; custom providers, endpoint overrides and user tool settings are not inherited.
The original credentials and configuration are not rewritten by the plugin.
Only a validated card replaces `~/.orca-flow/agents/<pane>.json`; total failure keeps the existing
title and summary. Temporary schema/output files are removed after the request.

Calls are bounded to 30 seconds each. Quota, rate-limit, authentication and unavailable-provider
failures skip that provider for five minutes in the worker; timeout/transient failures skip it for
30 seconds. A later request probes Haiku again, restoring it as primary after recovery. The worker
logs sanitized, throttled diagnostics. Invalid output and unexpected integration errors preserve
the card without triggering a broad provider fallback. `summarize-run` uses the same writer;
its cooldown lasts for that command's process.
Missing or stale cards for idle sessions are retried in the background, at most once per session
every five minutes. While the worker is active, a one-minute inventory refresh also catches chat
turns on hosts whose plugin status events cover terminals only. Session identity is checked again
before publication; an old session's card is not shown as a new Codex conversation's summary.

## Where things live

- `~/.orca-flow/agents/`: cards keyed by pane, with separate Orca/native session bindings.
- `~/.orca-flow/cards/`: a card per worktree (priority, goal), written by coordinators.
- `~/.orca-flow/config.json`: your settings, if you change any.
- `~/.orca-flow/format-misses.jsonl`: one line per message that missed the message frame.
- `~/orca/coordinators/<name>/`: one folder per coordinator, with its `coordinator.json`.
- `~/orca/coordinators/CLAUDE.md`: shared coordinator instructions and your project notes.

## Updating and uninstalling

Update to the newest release with the same command:

```sh
orca plugin install cyucelen/orca-flow
```

Orca asks for approval again only when a release needs different access.

To uninstall:

```sh
orca plugin uninstall cyucelen.flow
```

Then remove what it set up outside its folder, if you no longer want it: the `orca-flow` link in
your Claude profile's `skills` folder, the hooks that run `stop-check.mjs` and `prompt-check.mjs`
in its `settings.json`, `~/.orca-flow`, and `~/orca/coordinators` (your coordinators and notes).

## Limitations

- macOS only: memory, disk and process readings use macOS tools.
- The panel reads `orca worktree ps --json`, Orca's CLI output, because the plugin API has no call
  for every agent's status. A change to that output in an Orca update can break the panel until
  the plugin is updated.
- Conversation ingestion currently requires local Claude/Codex files or Orca's local structured
  journal schema (`agent-session-domain.db`, verified on Orca 1.4.261). Remote/WSL journals,
  unavailable metadata and unknown schemas fail closed. The public plugin API has no conversation
  reader; a host schema change can require an adapter update. Codex structured-chat coverage uses
  synthetic fixtures; live Codex terminal ingestion and writer publication were validated locally.
- This fallback covers Orca Flow sidebar titles and summaries. Native Orca chat/tab name
  generation belongs to the host. `orca chat rename` and `orca terminal rename` perform deliberate
  manual renames; the public plugin API has no conditional auto-title setter or title-origin
  metadata. The plugin therefore leaves native chat tabs, terminal tabs, native sidebar names and
  Session History names alone. A host follow-up must expose an expected-session/expected-name
  auto-title update that refuses user-named conversations, or apply the writer fallback inside
  the host's own conversation-name generator.
- Free memory refreshes every 15 seconds, and what each project's dev servers cost every 5 minutes.

## Develop

```sh
scripts/dev.sh check   # types, tsc, plugin tests and orca-flow tests
scripts/dev.sh load    # load this folder into Orca as local.flow and (re)start its worker
scripts/dev.sh shot    # screenshot the panel to /tmp/orca-sidebar-shots
```

To verify the installed Codex CLI's configuration merging, tool isolation, provider routing and
model rejection behavior against a local synthetic server (no real model/MCP calls):

```sh
ORCA_FLOW_CODEX_VERIFY=1 node --test test/writer-cli.test.mjs
```

Uninstall `cyucelen.flow` first so two copies don't run. `src/worker.ts` is the plugin's worker;
`src/view.ts` renders the panel as HTML, which `src/panel/app.ts` draws and wires up. Orca
transpiles TypeScript when it loads, so there is no build step. See Orca's
[plugin authoring guide](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md).

## Releasing

Merging a PR into `main` releases it. A GitHub workflow bumps the patch version in
`orca-plugin.json`, tags `vX.Y.Z`, and creates a GitHub Release whose note is the PR's title. Label
the PR to change that:

| Label | Release |
| --- | --- |
| `no-release` | None. The change ships with the next release. |
| `release:minor` | Minor version, for example 0.2.30 to 0.3.0. |
| `release:major` | Major version, for example 0.2.30 to 1.0.0. |

A version you set by hand in `orca-plugin.json` is released as it is. Installed copies check every
15 minutes and show the update in the status bar; two clicks install it. Orca asks for approval
again only when a release needs different access.

## License

MIT. See [LICENSE](LICENSE).
