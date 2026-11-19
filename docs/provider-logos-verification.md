# Provider logo verification — 2026-11-19

Implemented from `4dec24f` (0.2.55), without changing the version, installing/releasing, pushing,
or opening a PR. No host code, coordinator classification, session routing or other worktree was
modified. No agents were restarted and no prior Claude coordinator session/transcript was read.

## Checks

- `scripts/dev.sh check`: exit 0; host types and TypeScript passed; 10 plugin test files passed;
  standalone script tests 55 passed / 0 failed.
- `orca plugin test .`: 280 tests passed / 0 failed / 0 skipped, across 10 files (includes the script tests).
- `orca plugin check . --json`: valid, no errors, version remains 0.2.55. This is an HTML panel,
  so the check has no component-panel render; browser evidence follows.
- `git diff --check`: passed.

The ten new tests in `src/providers.test.ts` cover single/mixed/lifecycle behavior, metadata
mapping, coordinator/folder rows, malformed/unknown providers, descendant visibility, cycle safety
and click/focus targets. All existing 0.2.55 tests remain passing.

## Actual metadata and the missing Codex worker

Read-only `orca worktree ps --json` inspection, restricted in output to the three Codex panes in
this task's ancestry, confirmed this chain:

| Role in the chain | Pane | Host evidence |
| --- | --- | --- |
| Codex continuation in coordinator folder | `d49550bd-57e5-44f3-8f9f-f0807c9eb7de:919ade6a-df9e-4b95-9146-eaabe0db908f` | `agentType: codex`, `hasLivePty: true` |
| This workstream lead | `3f5450ce-fa67-4ebe-85a6-7a0c755fa0d5:3841c6dd-8849-4e1c-8b02-6261ca4d1b75` | Parent is the continuation; `hasLivePty: true` |
| This worker | `6e09c0a8-9db4-4834-a32e-def40604786d:dfaea38c-9672-4c47-ab04-c7a955f7edfd` | Parent is the lead; `state: working`, `hasLivePty: true` |

`worker-list` confirmed `ctx_ef27111af758` / `task_8bef9d2c37ae` is a live Codex worker with
`outcome: in_progress`, terminal `term_95409e5d-ae89-4107-9644-a123a8483c0e`, in this worktree.
The worker was present in host metadata. `treeBlocks` previously rendered only roots and immediate
children, dropping the third row when the continuation appeared above its lead. The regression
reproduces that shape through `assignCoordinators`, preserves the worker's actual lead, and verifies
the worker's rendered status, terminal target, focus and shortcut order. Coordinator membership is
deliberately unchanged; its separate diagnosis may remove the extra continuation row later.

## Browser evidence

Used `orca-cli` and the actual `src/panel/index.html`, CSS and bundled app code through
`scripts/provider-preview.mjs`, with synthetic sessions and a stub host bridge. Viewed screenshots
in Orca's embedded browser at 390×844 dark and 320×700 light (including host theme variables).

- Mixed case: seven tree badges, including the coordinator, lead, deep worker, folder helper and
  unknown fallback; the settled Gemini worker has no badge. Accessibility snapshot exposes the
  provider names as images and the real Codex worker as a button.
- Hovering the worker badge produced visible tooltip text `Codex`.
- Real pointer down/up on that badge recorded `sidebar.open` with
  `{ workspaceId: "feature", terminal: "term-Codex worker" }`.
- `previewCase('single')` and `previewCase('closed')` each produced zero badges; the current marker
  remained `agent:Codex worker`.
- No horizontal overflow in either viewport; badges measured 14 pixels; browser console empty.
- Fixture tab and server were closed after verification.

Screenshots are retained locally in ignored `.orca/provider-preview/` as `mixed-dark.png`,
`single-dark.png`, `mixed-light.png` (a future `scripts/dev.sh check` removes `.orca`). They show
fixture rendering, **not** the newly installed sidebar. Installation and end-to-end verification
against real sessions remain delivery steps for the lead.

## Shared interfaces and changed files

- `src/protocol.ts`: optional `AgentInfo.live` only; `agentType` semantics documented.
- `src/worker.ts`: accepts per-agent `hasLivePty` / `structuredHostOwned` and maps them to `live`.
- `src/providers.ts`, `src/provider-logos.ts`: independent provider normalization, global gate,
  live-session policy, accessible markup and bundled assets.
- `src/view.ts`: passes the gate to coordinator/agent/Up-next/search rendering; includes positively
  live native chats; traverses all existing descendants. No coordinator assignment changes.
- `src/panel/panel.css`: provider badge size/foreground only.
- `src/providers.test.ts`: ten regression tests.
- `scripts/provider-preview.mjs`: isolated browser fixture.
- `README.md`, `docs/provider-logos.md`, this file: behavior, sources and evidence.

## Suggested PR

**Title:** Show provider logos for mixed live agents and keep nested workers visible

**Description:** When the sidebar contains live sessions from two or more known providers, show
each coordinator, lead and worker's provider logo with an accessible name and hover tooltip.
Count idle/waiting live sessions using host per-pane metadata; exclude settled dispatches and
closed history, and use a neutral fallback for unknown providers. Walk all existing descendant
relationships so a Codex continuation → lead → worker chain no longer hides the worker.

Validated with TypeScript, 280 plugin tests, 55 standalone script tests, plugin validation, and
actual panel code in Orca's browser using synthetic mixed/single/closed snapshots, dark/light
screenshots, tooltip and terminal-target checks. Version remains 0.2.55; installed-host verification
follows delivery.
