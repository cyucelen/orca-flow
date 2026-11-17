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
  title, a one-line "about" and the ask, so you can switch back in seconds.
- **Branch and PR:** each agent row shows its worktree's branch after the GitHub mark (without its
  `user/` prefix; hover for the whole branch), then its PR's number when there is one, colored the
  way Orca colors it; hover for the title, click to open the PR.
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
- The `claude` CLI, logged in. Summaries use Claude Haiku through the same login Orca's agents use.
- Node 22.18 or newer on your PATH, for the `orca-flow` script agents run.

## Install

```sh
orca plugin install cyucelen/orca-flow
```

Orca lists the access the plugin asks for: running its own worker process, reading and opening
workspaces, getting agent status changes, and starting agents (to open coordinator sessions).
Approve it, then open **Orca Flow** from the right sidebar (the layers icon).

On its first start the plugin sets up two things outside its own folder:

| Path | What it is |
| --- | --- |
| `<Claude profile>/skills/orca-flow` | A link to the plugin's skill, so every Orca agent can load it. It follows the plugin across updates. |
| `~/orca/coordinators/CLAUDE.md` | Instructions every coordinator inherits, copied once. From then on it is yours: coordinators keep your project notes in it, and updates never change it. |

A real file already at either path is left alone. The Claude profile is the one Orca's agents use
(Orca's selected profile, else `~/.claude`).

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

You can also ask a coordinator "what's next?" at any time; it answers with one decision at a time.

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

## Capacity

Capacity is memory, not a count of worktrees or agents: a worktree on disk costs nothing, while
agents (about 0.5 GB each) and dev servers (often 2 GB or more) are what slow the machine. The
plugin compares free memory with what starting something costs on your machine, measured from your
own open sessions and from the processes each project's worktrees started. When macOS reports
memory pressure, no new dev environments start; when the pressure is critical, only urgent (P0)
work does.

Change the margin in `~/.orca-flow/config.json`:

```json
{ "marginGB": 2 }
```

## Privacy

Summaries run on your machine with your own Claude login. After each turn the plugin sends Claude
Haiku an excerpt of that agent's conversation: its first request, the latest turn's prompts and
messages, and the commands and file paths its tools used. The result is written to
`~/.orca-flow/agents/`; nothing is sent anywhere else. Each summary costs a fraction of a cent.

## Where things live

- `~/.orca-flow/agents/`: one summary per agent session.
- `~/.orca-flow/cards/`: a card per worktree (priority, goal), written by coordinators.
- `~/.orca-flow/config.json`: your settings, if you change any.
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
your Claude profile's `skills` folder, `~/.orca-flow`, and `~/orca/coordinators` (your coordinators
and notes).

## Limitations

- macOS only: memory, disk and process readings use macOS tools.
- The panel reads `orca worktree ps --json`, Orca's CLI output, because the plugin API has no call
  for every agent's status. A change to that output in an Orca update can break the panel until
  the plugin is updated.
- Summaries need Claude Code agents.
- Free memory refreshes every 15 seconds, and what each project's dev servers cost every 5 minutes.

## Develop

```sh
scripts/dev.sh check   # types, tsc, plugin tests and orca-flow tests
scripts/dev.sh load    # load this folder into Orca as local.flow and (re)start its worker
scripts/dev.sh shot    # screenshot the panel to /tmp/orca-sidebar-shots
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
