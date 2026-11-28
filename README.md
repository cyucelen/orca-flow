# Orca Flow

A calmer sidebar for [Orca](https://github.com/stablyai/orca) when you run many Claude Code agents
at once. It answers two questions at a glance: **what needs me next**, and **can the machine take
more work**. And it gives you coordinators: long-lived Claude sessions that take a request, hand it
to a lead and workers, and keep you out of the details.

macOS only for now.

**Antigravity CLI** sessions show their host-reported title, state and worker relationships.
The Antigravity mark appears beside the role avatar in mixed-provider sidebars. Terminal
coordination and exact-session resume have fixture coverage. Live sign-in, dispatch and resume
remain untested. Flow has no Antigravity transcript summary or structured handover adapter.
[Support details and verification](docs/antigravity.md)

## What you get

- **Top bar:** free memory and free disk, always visible. Click it for the details: RAM and swap,
  the heaviest sessions with the dev servers they started, and one-click cleanup.
- **Up next:** every agent waiting on you, most urgent first, each with what the work is about and
  the question it is asking, and a button to jump to it.
- **Coordinators:** your coordinators, each with its leads and workers nested under it, plus the
  chats you started yourself. Click a coordinator to open its session; right-click anything for
  actions.
- **Analytics:** what your agents run at and what they spend. The sidebar section keeps Token
  Speed's glance: output tok/s over the last minute (summed over every agent), the agents' network
  traffic and the last internet speed result kept from earlier (there is no Test button any more),
  two charts for the last hour or 24 h, and each model's median response speed.
  One line under them, "This week 52.4M tokens · ≈ $48 · Usage ›", opens the **Usage tab**: a
  full-width editor tab in the workspace you are in (with no workspace focused the sidebar says so
  and opens nothing). It has one window toggle (7 days, 30 days, All) and answers, in order of the
  goal, which kinds of task cost what: a headline strip (tokens and estimate, biggest workstream,
  model share, input served from cache, most expensive task); **By task kind**, one row per
  Settings → Models row (tasks finished, median tokens and cost, failed or retried, median time, and
  when the fallback ran) that opens its tasks and each task its workstream; **Lead overhead** (how
  much of a workstream's tokens its lead spends); a **Policy comparison** of two labelled arms; and
  the **Biggest workstreams**. A workstream shows its lead sessions, workers and retries with model,
  tokens and estimate; **Details** adds the four token categories (input, cache read, cache write,
  output). Runs with logs missing say "Partial"; usage from sessions Orca did not dispatch is kept in
  its own bucket ("Coordinators and plain terminals"); a model with no known price shows "no
  estimate". Before anything is recorded the tab says "Analytics starts recording now; backfill
  reading N of M logs".
  - **The estimate is not your bill.** Costs are token counts times Anthropic's API list prices
    (`src/prices.ts`, dated and versioned; Claude Max and ChatGPT plans are flat subscriptions).
    Codex and other non-Anthropic models show "no estimate" until their prices are confirmed.
  - **What it records, and where.** Per model response: provider, session id, response id, model,
    start and end time, and the four token counts, read from the Claude Code and Codex logs every
    30 s (never a message, only ids, times, model names and counts). Kept in
    `~/.orca-flow/usage/` (one `YYYY-MM.jsonl` per month, plus the links from Orca's dispatches to
    their sessions, the logs' coverage, the backfill's progress, and Orca's task titles) for
    **90 days**; older records are dropped. The first time Analytics runs it reads the logs still on
    disk from the last 90 days once (a backfill, in small slices; where logs were rotated that
    period stays "not recorded"). The sidebar's speed history stays in `~/.orca-flow/token-speed.json`.
  - **The Usage tab's file.** Orca opens an editor tab only for a file in a workspace, so Orca Flow
    keeps an empty note `usage.orcaflow-usage` in `<workspace>/.orca/orca-flow/`, beside a
    `.gitignore` containing `*` (so the folder never shows in `git status`). It is created when you
    press Usage › and is safe to delete. The Completed goals tab keeps its own note, `goals.orcaflow-goals`, in the same folder.
  - **Comparing two ways of splitting work.** Label the arms when you start them:
    `orca-flow dispatch --arm baseline --pair <id> …` and `--arm variant --pair <id>` (the same
    `<id>`, same task and acceptance checks, same models; `--arm` needs `--pair`, and a `--retry-of`
    keeps its first attempt's arm). Analytics then compares tokens and estimate per accepted run,
    time and passed runs, failed runs and retries included, and says why when a pair cannot be
    compared (models changed, an arm missing, fewer than 3 runs).
- **End-of-turn summaries:** when an agent finishes a turn, Claude Haiku turns it into a short
  title, a one-line "about" and the ask, so you can switch back in seconds. If Haiku is
  unavailable, the writer uses GPT-6 Luna (`gpt-6-luna`) through the Codex CLI. Pick the
  writers, their order and Claude's model in [Settings](#settings).
  When a coordinator's or lead's message ends in a valid [message frame](#message-format), its
  status, Ask and Reply are read as written: Up next labels the ask with the message's own status
  line ("Needs 2 files from you") and shows the Reply under it. An ask the agent needs only later
  ("Working · needs 2 files later") comes after every ask that stops work.
- **Model routing:** a worker task goes by its task type first, then its difficulty. You can define
  task types of your own (such as Browser checks or Images), each with a model and a fallback; a
  typed task runs on its type's model, retries once on its fallback, then asks you. Every other task
  runs on the model, effort and fallback you pick for simple, normal and hard, and a failed one
  moves up a row. Coordinators and leads get one each, with Balanced, Economy and Best quality
  presets to start from. Each dispatch starts on the model for its task, says why, and refuses rather than
  silently using another. Leads and coordinators hand implementation to Orca workers, not to native
  subagents. [Details and limits](docs/model-routing.md)
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
- **Reload skills:** after a skill update, running agents keep the old text in their conversation.
  Right-click a coordinator and choose **Reload skills** (its session, leads and workers), or use the
  circular-arrows button on the Coordinators heading (every running agent). A confirmation names who
  gets it, in a few short lines ("1 coordinator, 2 leads, 1 worker re-read their skills at their
  next turn. Needs approval: 1 Codex. Skipped: 1 finished."). Each Claude Code, Codex and Antigravity
  session gets a short note at its next turn, or after its next tool call when busy: re-read the
  skill files, then confirm. Nothing is typed into a terminal and no mail is sent; tasks, open asks
  and runs stay as they are. Rows show waiting, reading, reloaded or unsupported (with the reason);
  requests expire after 24 h. Other agents cannot reload live: restart them.
  **Codex, once:** Orca Flow adds three hooks named *Orca Flow: Reload skills* to
  `~/.codex/hooks.json`. Orca copies them into a Codex account each time it starts a Codex agent
  there. The first Codex agent you start in Orca afterwards shows **Hooks need review**: choose
  **Trust all and continue** (or review them, or use `/hooks`). Then restart Codex sessions that were
  already running. Orca carries your approval to your other Codex accounts. Until then the sidebar
  shows Codex sessions as unsupported, with that one step.
  **Antigravity (fixture-tested, not live-tested):** an `orca-flow-reload` definition in
  `~/.gemini/config/hooks.json`, next to Orca's own, gives the note through agy's documented
  `PreInvocation` hook. Google documents no approval step for hooks.
  [How it works and what each provider supports](docs/skill-reload.md)

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

Switching back from the Bounti fork (`bounti-hq.flow`)? Disable or uninstall the fork first, so its
Alt+1..9 shortcuts don't collide with this plugin's. On macOS the panel preferences live in
`~/Library/Application Support/orca/plugins-data/bounti-hq.flow/storage.json`; copy that file into the
sibling `cyucelen.flow` directory before the first install to keep them. Both use the same
`~/.orca-flow` settings and coordinator folders. The skill links move to this plugin's release by themselves.

The installed copy sets up these files outside its own folder:

| Path | What it is |
| --- | --- |
| `<Claude profile>/skills/orca-flow` | A link to the plugin's skill, so every Orca agent can load it. It follows the plugin across updates. |
| `~/.agents/skills/orca-flow` | The Codex USER skill link, shared across Orca Codex accounts. Account selection changes `CODEX_HOME`, not this user skill directory. |
| `~/orca/coordinators/CLAUDE.md` | Instructions every coordinator inherits, copied once. From then on it is yours: coordinators keep your project notes in it, and updates never change it. |
| `~/orca/coordinators/<name>/AGENTS.md` and `CLAUDE.md` | Missing local instructions are seeded for new and existing coordinator folders. Launch prompts also explicitly supply the coordinator role and skill path. |
| `<Claude profile>/settings.json` | One Stop hook that checks a coordinator's or lead's last message against the [message format](#message-format), and one UserPromptSubmit hook that passes its quiet reminders to the agent; both do nothing until you opt in. One SessionStart hook gives a lead its role instructions back when its session resumes or compacts (see [How work flows](#how-work-flows)); it needs no opt-in and gives other agents nothing. One PreToolUse hook on the Agent tool denies a coordinator's or lead's native subagent so the work goes to an Orca worker; it is on by default ([Delegation](docs/model-routing.md#delegation)). One PostToolUse hook hands a busy agent the [Reload skills](docs/skill-reload.md) note; it starts `node` only while a reload request waits. The UserPromptSubmit and SessionStart hooks give that note too, with no opt-in, and only to the sessions a request names. All five run only in Orca's agent panes. Your other settings and hooks stay as they are. |
| `~/.codex/hooks.json` | Three hooks named *Orca Flow: Reload skills* (UserPromptSubmit, SessionStart, PostToolUse), next to anything you keep there. The file is created if missing. Orca copies them into each Orca-managed Codex account's `hooks.json` when it starts Codex there, so Codex sessions can take [Reload skills](docs/skill-reload.md#codex-approve-orca-flows-hooks-once). Codex runs them only after you approve them once (**Hooks need review** → **Trust all and continue**). Outside Orca's panes they do nothing. Orca Flow never writes Codex's trust state, `config.toml` or `auth.json`, and never writes the account homes Orca manages. |
| `~/.gemini/config/hooks.json` | An `orca-flow-reload` definition (PreInvocation, PostToolUse on `run_command`) next to Orca's `orca-status`, so Antigravity sessions can take [Reload skills](docs/skill-reload.md#antigravity-cli-agy-documented-hooks-fixture-tested-only). It is added only when Orca has created the file, and a definition you turned off stays off. Fixture-tested, not live-tested. |

A real file or another source's symlink is left alone, including a dangling link whose ownership
cannot be verified. Only our installed release links are repointed. A `settings.json` that is not
valid JSON is not changed. The Claude profile is Orca's selected host profile, then an explicit
`CLAUDE_CONFIG_DIR`, else `~/.claude`. Development copies leave installed links, hooks and existing
coordinator folders alone at startup. Codex receives instructions, not a port of Claude's Stop hooks;
this does not claim identical enforcement between providers.

## Getting started

1. **Create a coordinator.** In the panel, click **New coordinator**, pick a name and a look. Orca
   creates its folder under `~/orca/coordinators/` without launching. Click its row to start: if
   several supported harnesses are enabled, pick a logo (or provider name) in the anchored menu.
   One usable harness starts directly; unavailable agents give feedback and a Retry action.
   See [first-session provider support](docs/coordinator-first-session.md) for the host capability boundary.
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
in history. Click the provider badge beside the coordinator name to choose **Handover to Claude**
or **Handover to Codex**. If wake needs an existing conversation, it opens a separate picker.

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

**Goals** (off until Settings → Features → Goals is on). The first section, above the workstreams, holds what you need to get done. A goal need
not be a Linear issue: it can span several, or have no issue, worktree or agent at all (a document for
a lawyer, product research). Each row is two lines: the title with its todo count (`2/4`) on the right,
and under it the next step. Avatars show the agents on its linked worktrees that are still live, in any state (each face shows working, asking or done), until they sleep or the worktree goes; with avatars the goal offers Jump →, without them Assign → (or Jump → to the coordinator the step was assigned to). Hovering (or
keyboard-focusing) an open goal shows one pill after its avatars and progress, centered in the row, like a Linear row's **Send →**: **Jump →** focuses the session of an agent on a linked worktree that still has a live session (one working, else one waiting
for you, else the worktree's lead even when it is done and waiting for review, else any other live agent there), or of the coordinator the step was assigned to (checked against a fresh snapshot first: a
session that is gone is never focused). With nobody on it, **Assign →** picks one of your coordinators with a live
session and types the exact step (the row shows "Assigning…" until it lands), with the goal's title, id and `orca-flow goal` commands, into its current session; the goal
records it (`orca-flow goal show` names the coordinator) until the next step changes. Click a row for its card: edit the next step, tick todos, edit the description and done criteria (edits
save when you leave the field or press Enter), and see the Linear issues and worktrees it links. **Mark done** moves it to the **Completed goals** tab: **Completed ›** in the Goals header (shown once a goal is completed; its tooltip has the total) opens that tab in the focused workspace. There you search across titles, descriptions, done criteria, next steps, todos, Linear ids and worktree names; filter by when it was completed (7, 30, 90 days, all time) and by what it links (a Linear issue, a worktree, nothing); sort newest or oldest first; and open a goal for its details (who completed it, todos, links: a Linear id opens the issue, a worktree goes to it while it exists). **Reopen** puts a goal back in the Goals list at its usual place (it scrolls into view and flashes once), with an **Undo** that restores its original completion date. The tab updates when a goal is completed or reopened in the sidebar or by an agent, and keeps the *Completed within* and *Sort* choices. **+** adds a goal from
one line (Enter adds, Esc cancels). Agents keep goals current with `orca-flow goal` (a lead ticks todos
and updates the next step), but only propose done: such a goal reads "lead says done", and its card
asks **Confirm done** or **Not yet** (back to open). The section folds like Linear and hides while you
search. Edits you make record "you"; changes agents make show in the panel within a second.

**Top bar.** Memory shows what Orca reports as available, minus a 2 GB safety margin. It turns
amber when only another agent would fit (not a new worktree with its dev servers), and red when
nothing fits. Disk turns amber under 25 GB and red under 10 GB.

**Bots** (off until Settings → Features → Bots is on). Between Up next and Linear, one line per Orca bot (`orca bot list`): its avatar, name,
what it is for, and on the right whether it waits on you, works, is paused, or when it runs next.
A click opens its Home chat's workspace. Bots sit under the coordinator whose `coordinator.json`
lists them in `bots` (by name or folder name; ask the coordinator to adopt one), else under
Personal. A bot chat shows in Up next only while Orca says it is stopped on you (a permission prompt or
its question tool); an idle bot, waiting for its next message, never does. Bot workspaces never
show as ordinary rows. Agents find a project's bots with `orca-flow bots --repo <repo>` and hand
them work by mail.

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
orca-flow bots [--repo]      # a project's Orca bots, with the command that hands each one work
orca-flow role lead|clear    # record (or clear) that you made this Claude session a lead
```

(`orca-flow` here means `node <skill folder>/scripts/orca-flow.mjs`.)

A lead keeps its role across Claude resume and compaction. A lead started with `Your role: lead`
in its first prompt is known by that line. A session you make a lead yourself (a worker you keep
steering, a chat you started) records it with `orca-flow role lead` when you tell it to; the record
lives in `~/.orca-flow/roles.json`, keyed by the Claude session id. The SessionStart hook then gives
the lead instructions back on every resume and compaction, and the sidebar shows it as a lead.
Claude only: Codex and Antigravity have no such hook here.

## Settings

The gear at the top of the panel opens Settings, laid out like macOS System Settings: a page
per topic, one row per setting, and the explanation of each row in its tooltip (hover the label).
Changes apply at once; there is no Save button. Close it with the × or Escape.

- **Titles & Summaries:** the card writers, tried top to bottom (drag a row's handle, or focus it
  and press the up and down arrows). Each row has Claude's model menu (Haiku, the default, or
  Sonnet), a status dot and a switch. The dot's tooltip says what the writer last saw (its last
  card, or a usage-limit or sign-in cooldown with the time left) or, for a writer not used since
  Orca Flow started, whether `orca agent installed` lists its CLI. Nothing is tested from the
  dialog. "Writing now" names the writer the next card would use. Antigravity is "Not available
  yet" (see [Card writer](#card-writer)).
- **Models:** a preset (Balanced, Economy, Best quality, your saved ones or Custom), the model and
  effort for coordinators and leads, a model, effort and fallback per worker task kind
  ([Model routing](docs/model-routing.md)). The page also lists your task types: add, edit and
  remove them, with suggestions.
- **Message Check:** Off, All agents (every coordinator and lead) or Some folders, with the folder
  list ([Message format](#message-format)).
- **Capacity:** the memory always kept free and the extra room under memory pressure
  ([Capacity](#capacity)).
- **Features:** Bots (off by default; shows the Bots section, bot chats in Up next and the waiting
  count), Goals (off by default, enables the Goals section and the `orca-flow goal` commands),
  Linear and Analytics (on by default; each shows its sidebar section). Display only:
  Orca's bots, schedules and chats, your Linear credentials and the recorded usage and speed history
  are untouched. Turning Goals off preserves saved goals and disables goal reads and edits.
  While Bots is off Orca Flow does not read `orca bot list`; while Linear is off it reads
  nothing from Linear and sends no issue; while Analytics is off it does not read the agents' logs,
  record usage, sample their traffic or run the internet test. Turning one on shows its section at
  once with fresh data. Saved as `features.bots`, `features.goals`, `features.linear` and `features.tokenSpeed` (the
  name Analytics had as Token Speed, kept so existing settings files keep working) in the settings file.
- **Advanced:** Linear test mode (log the Linear comments and status changes Orca Flow would send,
  and send nothing) and Show in Finder for the settings file.
- **About:** the running version, and Check for Updates (see
  [Updating and uninstalling](#updating-and-uninstalling)).

A page that differs from its defaults shows Reset to Defaults at its bottom. If a save fails, the
control goes back to the saved value and the page says "Couldn’t save", with the reason in its
tooltip. The writer reads the settings again for every card, so a change applies to the next one.

Everything is saved in `~/.orca-flow/config.json` by the plugin's worker. Only settings that
differ from their defaults are written, a setting put back to its default is removed, and keys
Orca Flow does not know are kept. The file is replaced atomically. If the file is not valid JSON,
the dialog says "Settings file can’t be read", Orca Flow uses the defaults, and the controls stay
off so the file is never overwritten; fix or remove it by hand. You can also edit the file directly:

```json
{
  "writers": [
    { "provider": "codex", "model": "gpt-6-luna", "enabled": true },
    { "provider": "claude", "model": "sonnet", "enabled": true },
    { "provider": "antigravity", "enabled": false }
  ],
  "messageFormat": "all",
  "marginGB": 3,
  "warnHeadroomGB": 2,
  "linearDryRun": false
}
```

`writers` is tried in order; a writer left out of the list is off. Without `writers` (or with an
unusable value) the writer behaves as before: Haiku, then GPT-6 Luna through Codex. Claude's
`model` is `haiku` or `sonnet`; Codex's is `gpt-6-luna`.

## Message format

Coordinators and leads end each message with a fixed frame: a bold status line that names what
they need from you in plain words (Working, "Waiting on CI", Idle, Done, "Needs your pick",
"Working · needs 2 files later"), a context paragraph of 2-4 sentences that says why first, and an **Ask:** with its options
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
replaces the point, that no terminal handles, ids or commit hashes reach the part you read, and
that a cost warning gives a number. A coordinator can also answer with route lines only. Workers and your own
chats are never checked. The one plain line an agent writes after an Orca mail notice or a task notification (a wake, not you) is not checked, and the sidebar keeps the ask from the agent's last frame.

The check is off until you turn it on in [Settings](#settings) (Message check) or in
`~/.orca-flow/config.json`, for every agent or only for agents working in some folders (a folder
and everything under it):

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
own open sessions and from the processes each project's worktrees started. Those are counted by
what they keep hot in RAM: their footprint minus compressed pages, since an idle dev server or
emulator keeps most of its footprint compressed or in swap. Each checkout's last measurement is
kept in `~/.orca-flow/env-costs.json` (the newest 10 per project, for 30 days), and a project costs
the median of them, so one heavy checkout does not set the price; a project that starts nothing
costs 0, one never seen here 1.5 GB. `orca-flow capacity --repo <name>` shows the checkouts a price
comes from, and each idle environment's processes. When
macOS reports memory pressure "warn", a new worktree also needs headroom: 2 GB, or half its
environment when that is more. When the pressure is critical, only urgent (P0) work starts.

Change the margin and the minimum headroom in [Settings](#settings) (Capacity) or in
`~/.orca-flow/config.json`:

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

### Card writer

The writer invokes local CLIs using your existing logins. After each turn it sends the first
writer turned on in [Settings](#settings) (by default Claude Haiku) an excerpt of that agent's
conversation: its first request, the latest turn's prompts and messages, and the commands and file
paths its tools used. On an availability failure, that same excerpt is sent to the next writer
turned on (by default OpenAI's [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
through Codex). A writer you turn off is never sent anything. Provider usage limits and billing
apply to the selected accounts; Sonnet uses more of a Claude plan than Haiku.

Writers: Claude (`claude -p --model haiku|sonnet`) and Codex (`codex exec --model gpt-6-luna`).
Antigravity is not available as a writer yet. Its CLI documents a one-shot JSON mode
(`agy -p … --output-format json --json-schema`), but its docs give no way to run that request with
tools off, no system-prompt flag and no option to skip saving the conversation, and headless runs
default to `auto` mode. A conversation excerpt is untrusted text, and both other writers run with
tools disabled, so the Antigravity row stays off until its CLI can be isolated the same way.

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
30 seconds. A later request probes the first writer again, restoring it as primary after recovery. The worker
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
- `~/.orca-flow/config.json`: your settings, if you change any (see [Settings](#settings)).
- `~/.orca-flow/format-misses.jsonl`: one line per message that missed the message frame.
- `~/.orca-flow/goals/`: one JSON file per goal (`<id>.json`), written by you in the panel and by agents with `orca-flow goal`.
- `~/orca/coordinators/<name>/`: one folder per coordinator, with its `coordinator.json`.
- `~/orca/coordinators/CLAUDE.md`: shared coordinator instructions and your project notes.

## Updating and uninstalling

Update to the newest release with the same command:

```sh
orca plugin install cyucelen/orca-flow
```

Orca asks for approval again only when a release needs different access. The release that adds the
Usage tab contributes a custom editor, so Orca asks you to approve Orca Flow again when you update
to it.

Orca Flow also looks for a newer release every 15 minutes, and at once from Settings > About >
Check for Updates. A newer release shows there as "0.2.65 available" with an Update button, in the
status bar, and as the panel's update button; all three update through the same confirm. Only a
release newer than the running version is ever offered. A copy that cannot update to a release
shows Check for Updates turned off, with the reason in its tooltip: a development folder, a
manifest without a version, a folder install, or a Git install whose commit is not its version's
release tag (installed from a branch or a commit). `orca plugin update` would move such a copy along
its branch or leave a commit pin where it is, not install the release, so reinstall from a release
(the command above) to get updates.

To uninstall:

```sh
orca plugin uninstall cyucelen.flow
```

Then remove what it set up outside its folder, if you no longer want it: the `orca-flow` link in
your Claude profile's `skills` folder, the hooks that run `stop-check.mjs`, `prompt-check.mjs`, `session-start.mjs`,
`delegation-check.mjs` and `reload-check.mjs` in its `settings.json` (and the three *Orca Flow: Reload skills* entries in each Codex account's `hooks.json`, and `orca-flow-reload` in `~/.gemini/config/hooks.json`), `~/.orca-flow`, and `~/orca/coordinators` (your coordinators and notes).

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
node scripts/build-frames.mjs   # regenerate the .js the panel and editors load (after editing any .ts they import)
scripts/dev.sh check   # generated .js fresh, types, tsc, plugin tests, orca-flow tests and the cold-start check
scripts/dev.sh load    # copy this folder to ~/.orca-flow/dev/flow and run it as local.flow (installed copy off; back on if it fails)
scripts/dev.sh off     # unload local.flow and run the installed cyucelen.flow again
scripts/dev.sh shot    # screenshot the panel to /tmp/orca-sidebar-shots
node scripts/settings-preview.mjs                       # the Settings dialog in a browser, with fixture data
node scripts/settings-preview.mjs --shots /tmp/orca-settings-shots-v2 --tips   # every page, dark and light, 360 px and wide, plus tooltips
node scripts/skill-reload-preview.mjs --shots /tmp/orca-flow-reload-shots   # Reload skills: status, coordinator menu, both confirmations
node scripts/goals-preview.mjs                          # the Goals section in a browser, with fixture goals (?open=<id>, ?add=1, ?theme=light)
node scripts/goals-preview.mjs --shots /tmp/orca-goals-shots   # section, open card, add box, dark and light, 360 px
node scripts/goals-preview.mjs --selftest               # clicks through add, tick, edit, mark done, confirm, Jump → and Assign → in headless Chrome
node scripts/goals-history-preview.mjs                  # the Completed goals tab and the sidebar over one fixture worker (/tab, /side, /both)
node scripts/goals-history-preview.mjs --shots /tmp/orca-goals-history-shots   # the tab at 1000 and 600 px, light and dark, every state, and the sidebar header
node scripts/goals-history-preview.mjs --selftest       # search, filters, no matches, empty, Reopen, Undo, live updates and the states in headless Chrome
node scripts/cold-start-check.mjs --shots /tmp/orca-flow-cold-start   # the frames under a busy cold start, from fixture saved state (below)
```

The settings preview bundles the real panel with a stubbed `orca` global: no plugin load, worker
or config writes.

To verify the installed Codex CLI's configuration merging, tool isolation, provider routing and
model rejection behavior against a local synthetic server (no real model/MCP calls):

```sh
ORCA_FLOW_CODEX_VERIFY=1 node --test test/writer-cli.test.mjs
```

Only one copy can run: both bind Alt+1..9, and Orca errors both when they run together. `load`
and `off` swap between them, so `cyucelen.flow` stays installed and its skill links and hooks keep
working. Orca ties a development plugin's approval to its exact files, so any edit drops it to pending:
`load` therefore runs a copy, and edits here show in the sidebar only after the next `load`.
`check` type-checks a temporary copy, so no `.orca/` is written here. `src/worker.ts` is the plugin's worker;
`src/view.ts` renders the panel as HTML, which `src/panel/app.ts` draws and wires up. See Orca's
[plugin authoring guide](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md).

### Generated frame JavaScript

You write TypeScript everywhere, and there are no dependencies to install. Orca runs the worker's TypeScript as it is.
The panel (`src/panel/index.html`) and the two editors (`src/editor/index.html`, `src/editor/goals.html`) load plain
JavaScript instead: `app.js`, `main.js` and `goals-main.js`, and the `.js` next to every `.ts` they import.
`node scripts/build-frames.mjs` generates those files with Node's built-in type stripping (Node 22.13 or later). Each
line keeps its line and column, so an error at `view.js:120:7` is at `view.ts:120:7`. The files are committed, because
Orca installs the tagged tree as it is. Each one ends with a "Generated … Do not edit" line, and `.gitattributes` marks
them as generated.

Why: Orca transpiles every `.ts` that a panel or editor imports in a worker thread, under a 2000 ms timer on its main
thread. During a cold boot or a relaunch the main thread is busy for longer than that, so even a one-line file times
out. Orca then keeps the failure until it quits, and the panel stays black. Orca serves `.js` and `.mjs` without
transpiling them. The worker is not affected, because Orca's plugin host loads it in its own process with no timer.

What keeps the generated files right:

- `scripts/dev.sh check` fails when a generated file is stale, missing, or no longer loaded. It also fails when any
  HTML entry's import graph, static or dynamic, contains a file Orca would transpile. Both checks are in
  `test/frames-js.test.mjs`.
- tsc runs with `--erasableSyntaxOnly --verbatimModuleSyntax`. Stripping types is exact only for TypeScript that
  needs no transformation, and with type-only imports marked as `type`.
- `scripts/dev.sh load` regenerates the files in the copy it runs.
- The release workflow runs `node scripts/build-frames.mjs --check` before it commits or tags anything, so a tag never
  ships stale JavaScript.

`node scripts/cold-start-check.mjs` reproduces a busy cold start outside Orca. The worker's own `snapshot()` reads
saved coordinators, sessions and goals from a fixture HOME, once with the Orca CLI not ready and once with it ready.
Every module Orca would transpile is answered with Orca's timeout error. Headless Chrome then loads each frame, which
must draw that state with no error. The old `.ts` entry must fail as Orca did. If an entry module ever fails to load,
the frame shows "Orca Flow could not load. Restart Orca to try again." instead of staying blank.

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
