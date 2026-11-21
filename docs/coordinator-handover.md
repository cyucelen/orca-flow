# Coordinator handover: supported subset and host gaps

Handover moves a coordinator to a new Claude or Codex conversation in the same workspace. It
supports the subset the host can move safely. A coordinator member (current or historical) may own
**settled runs plus at most one run with live work**. That one run moves through Orca's own
`orchestration run-use`, which the new conversation runs itself. Two or more live runs are still
refused, and the refusal names each one. The installed Orca 1.4.263 host, and upstream through
1.4.269, have no multi-run coordinator transfer. Leads' and unrelated runs remain unchanged; no
pending question is consumed, answered, deleted or readdressed by the plugin.

## Supported behavior

- Compact logo-only target buttons in the existing coordinator menu, with target/retry tooltips,
  accessible names, inline progress and errors. Host `agent installed` discovery filters to enabled
  Claude/Codex alternatives; current providers, unrelated providers and existing sessions are excluded.
  No available target (or failed discovery) displays an unavailable state instead of a launch button.
  The provider badge beside the coordinator name opens the labeled handover actions. Wake and
  recovery use their own conversation picker.
- A Claude ↔ Codex terminal handover in the same workspace when no member owns a run. It verifies
  `agent launch` receipt, `prompt.outcome` (`journaled` or `handed-to-terminal`), exact provider,
  workspace, session identity and absence of dispatch/parent provenance before changing current.
- Stored transcript recovery through `agent read --limit 100`. The source is never resumed,
  prompted or asked to summarize. When the host specifically reports a missing transcript, the
  plugin can use the selected terminal’s output after checking its exact conversation binding
  before and after reading. This snapshot is labeled partial terminal output and can include CLI
  chrome. Empty or unverifiable output stops the handover before launch. Other read errors also
  stop launch. Transcript snapshots retain the host’s `limited` flag.
- Context files contain scope, goals/cards, workstreams, pending decisions and source history.
  The prompt labels transcript/tool/summary content untrusted reference, points to authoritative
  coordinator and host state, and explicitly loads the coordinator role and skill.
- A durable `.orca-flow-handover.json` records the exact prompt, launch phase, returned operation
  ID, target and error. A retry uses `--retry-launch` only for the same recorded launch. Missing
  replay identity after an ambiguous launch blocks automatic relaunch. A successfully delivered
  target is adopted without launching again. The record survives worker restarts.
- A changed current selection is preserved. Before cutover, ownership is read again: a run that
  became live and is not the recorded one, a recorded run that moved to a non-member, or a target
  that already holds another run (run-use would release it) blocks selection. Verified targets
  become coordinator members, including after later failure; they are not reclassified as workstream
  leads. Original source asks stay with their source.
- Owned runs are classified before launch (`handover.ts classifyRun`). A run is **live** if it
  has a dispatch whose `worker-list --full` `workerState` is not succeeded/failed/stopped/abandoned/
  cancelled, an unhandled message in its coordinator mailbox (`inbox --terminal run:<id>`,
  `handled` not true), or a pending gate (`gate-list --run <id> --status pending`). Otherwise it is
  **settled**. Any read error, a worker page with `hasMore` but no cursor, a repeated cursor, or a
  full inbox page (`inbox` has no cursor; 1000 rows counts as incomplete) counts as live. The run
  inventory itself is read page by page; an incomplete inventory refuses outright.
- **Settled runs** never block Handover and nothing moves: they stay bound to the old handle (nothing
  is pending, so nothing is lost). The context file (`runs`) and the target's prompt list them with
  the switch command `orca orchestration run-use --id <id>`. They also warn that run-use releases
  the run the terminal currently holds.
- **One live run** is recorded in the Handover record (`runs`). The target's prompt tells its first
  turn to run `orca orchestration run-use --id <run>` itself, after `await-handover.mjs` returns
  ready, then `run-current` to confirm and `orchestration check` for the moved mail. The prompt also
  tells it never to add `--from`/`--takeover-legacy` and to skip `orca-flow resume` in that first
  turn, because resume could take a different run and release this one.
- **Two or more live runs** are refused before launch (`OWNERSHIP_REFUSAL` prefix, shown as
  "Handover blocked"). The refusal lists each run's id and objective, and what keeps it live: open
  dispatch ids, the unhandled-mail count, pending gate ids. It says how to recover: settle all but
  one, then choose Handover again.

### Completion ordering with one live run

1. Launch, delivery, exact binding, registration, reveal and the ownership re-checks are unchanged.
   The source stays current throughout.
2. The adoption deadline (`adoption.deadline`, 60 s) is persisted, then the selection commits to the
   target and the record moves to phase `adopting`. The commit has to come first because the
   target may only run a mutating command (run-use) after its barrier returns ready, and the barrier
   requires the committed selection. So the barrier releases on `adopting` as well as `complete`;
   its result carries `adopt` and the exact `next` command. Every other barrier rule (exact context
   token, caller terminal, current selection, two-minute local cap) is unchanged. The bootstrap
   window governs cutover only; once `adopting` is journaled, it no longer applies.
3. The plugin polls `run-list` (every page) until the run's `coordinator_handle` equals the
   target's launch handle. Only then is the record `complete` (`adopted: moved`). A run that Orca
   retired meanwhile also completes (`adopted: retired`): nothing can route to the old conversation.
4. If the deadline passes without that observation, the record stays `adopting` with a warn status:
   "Claude is open; run <id> still routes to the old conversation". The panel shows "Run not moved"
   with Retry, never "Handed over". The recovery is to ask the new conversation to run
   `orca orchestration run-use --id <id>`, then Retry. Retry never relaunches or re-commits; it reads
   `run-list` again. The original stays a member, open and untouched; the plugin never closes it.
   When the panel's 150-second request limit is reached first, the call stops at 140 seconds with
   "Moving run…" (warn), and Retry continues the same wait until the persisted deadline.
5. If the commit lands but the `adopting` journal write is lost and the bootstrap window then passes,
   Retry resumes the adoption and reports it. It does not set the attempt aside as done.
- The receiving first turn awaits the read-only `await-handover.mjs` barrier instead of ending
  while registration is incomplete. It checks the exact context token, terminal identity, final
  journal phase and current selection before continuing the briefing, without another user prompt.
  The two-minute deadline is persisted before launch and never extended by Retry. Cutover is
  refused within five seconds of expiry; older pending attempts without the barrier also fail
  closed. Temporary file-read and retry errors cannot strand the first turn during this window.
- Missing per-folder `AGENTS.md` and `CLAUDE.md` are seeded for new/existing coordinators, with a
  stable installed skill path. Existing instructions, overrides and other plugins' links stay
  untouched. Launch prompts supply the current skill path as a discovery backstop.

The development preview only serves the real panel bundle with synthetic data and a fake bridge.
It does not load another plugin worker, install links, alter account settings or touch coordinators.

## Host boundary: one run per terminal via run-use

Evidence (installed `/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out`,
`main/chunks/orcad-retained-source-*.js`; upstream `src/main/runtime/orchestration/db/runs/run-binding.ts`
in github.com/stablyai/orca). First read on 2026-11-20 with 1.4.265, then rechecked on 2026-11-21
against the installed 1.4.263 host and upstream through 1.4.269:

- `orchestration run-use --id R`, run BY the terminal that will coordinate, is the host's
  transfer. In one `BEGIN IMMEDIATE` transaction it moves the old handle's unread direct mail into
  the run mailbox and sets coordinator handle/pane/session to the caller. It also bumps
  `consumer_generation`, fences unacknowledged deliveries and re-arms unread run mail for the new
  coordinator. The host's own guidance says to read mail first, then have a terminal that
  coordinates no other run use `run-use`, since it unbinds any others the terminal holds.
- `bindRun` calls `unbindOtherRunsForCoordinator` first, so one terminal can take over only ONE
  run. `run-create` does not unbind, which is how one terminal ends up holding several. There is
  no multi-run transfer through 1.4.269.
- The public request accepts `id`, `from` and `takeoverLegacy`, with no expected-owner or
  expected-generation guard. The plugin therefore re-reads ownership right before cutover, and
  refuses if the recorded run moved to a non-member or the target already holds a run. A change
  between that read and the target's own run-use is a host gap that the plugin cannot close.
- A plugin process never runs run-use for another terminal: no `--from` impersonation, no
  `--takeover-legacy`, no database edits. Only the target terminal runs it, in its own first turn.
- The public run projection carries no internal session/pane identity. The plugin never edits
  Orca's databases.

The case that motivated this: the firstview coordinator (Codex) owned three runs. Read-only, on
2026-11-21: `run_fa86f5358d7c` had an open dispatch (`ctx_1a6c433738fb`; a second open one,
`ctx_80f862596c8f`, settled during the session) and all 18 coordinator messages handled. That
makes it live. `run_de7215df7d10` had no open dispatch, 12/12 messages handled and no pending gates,
but retained worker terminals, so Orca does not retire it. `run_929d4363280a` had no open dispatch,
107/107 messages handled, no pending gates, and its coordinator terminal is dead. The classifier
reads them as one live and two settled, so Handover now proceeds and moves only `run_fa86f5358d7c`.

The generated plugin `agent.launch` API returns only `terminalId` and always describes a CLI
terminal. Handover therefore uses the supported CLI launch receipt, respecting the user's surface
choice. The public focus route is `terminal switch --terminal <handle>`; `chat` offers rename,
not focus. A structured target is preserved and registered but the original stays current with an
explicit error. The core tests cover structured receipt handling; **live structured navigation is
unsupported, not a verified success**.

The host follow-up still needed for full coordinator transfer: an idempotent handover transaction
with expected source/target identities and ownership generation, atomic transfer of every
specified run (not one per terminal) without unbinding unrelated runs, and a readable transfer
receipt. A supported structured-chat reveal/focus route is also needed.

## Discovery sources

Codex's documented USER discovery is `$HOME/.agents/skills`, with symlink support. It is independent
of the selected account's `CODEX_HOME`. See [Build skills](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills).
In non-Git coordinator folders, Codex checks the current directory for project instructions;
parent `AGENTS.md` alone is insufficient. See [AGENTS.md discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

Claude uses the selected profile's skill directory, and keeps its existing hooks. See
[Claude skills](https://code.claude.com/docs/en/skills) and
[Claude instructions](https://code.claude.com/docs/en/memory). Local host inspection confirmed
`shared/skills/installation/skill-install-providers.js` uses `CLAUDE_CONFIG_DIR` for Claude while
Codex uses the canonical skill root; `codex-home-paths-HIjrJCtV.js` separately handles account homes.
No Codex hook enforcement or account-credential migration is claimed.

## Validation and preview

Run `scripts/dev.sh check`: generated API types, TypeScript, plugin tests and script tests. The
handover tests exercise both provider directions, quota-exhausted stored context, verified delivery,
launch refusal, unknown replies, restart/retry without duplicate launch, selection races, late run
acquisition, pending-ask preservation, session registration and hierarchy. They also cover:
settled-only runs (allowed, nothing moved); one live run (run-use in the prompt, completion only
after the rebinding is observed); adoption not observed (warn and Retry, no completion, Retry
completes after the move); two live runs (refusal names both); read errors and incomplete pages
(fail closed); a recorded run moving away; a target already holding a run; and the lost `adopting`
journal write.
Installation tests cover selected/explicit/default Claude profiles, Codex USER roots, installed
release repair, foreign/dangling links, existing instructions and development-copy isolation.

Run `node scripts/coordinator-preview.mjs` for a disposable local preview, optionally with
`ORCA_FLOW_PREVIEW_PORT`. The actual menu was inspected in Orca's browser at **380 × 780**, with
screenshots for both provider directions, progress, error/retry and the existing session dropdown.
Preview artifacts and the detailed execution report are supplied separately to the lead.

No real coordinator was handed over, resumed, closed or prompted. No production plugin or global
configuration was installed/changed. Follow-up live probes on 2026-11-20 used disposable folder
workspaces and the user's default terminal surface for both providers. Claude returned its launch
receipt in 1.4 seconds, before its first turn ended; after a deliberate 20-second registration delay,
selection committed at 24.5 seconds and the receiver returned `BOOT_OK` without another prompt.
Codex returned its receipt in 12.4 seconds, committed at 36.6 seconds after the same delay, and also
returned `BOOT_OK`. Both receipts had `prompt.outcome: handed-to-terminal`; session identity and
`terminal switch` were verified against the launched targets. These timings do not require waiting
for a turn-completed event before registration or cutover.

An initial Codex probe was blocked by its CLI update menu: after 60.5 seconds the host returned
`ok: true` with a terminal outcome but `prompt.outcome: not-delivered`. The plugin correctly refused
cutover. A separate disposable attempt skipped that one-time prompt with Escape; no installation,
account setting or surface preference changed. Invalid-provider launch returned the actual
`ok: false, error: {code: invalid_argument, message: ...}` envelope. Structured navigation remains
unverified and blocked, as described above. The live bootstrap
fixtures explicitly prohibited routing/dispatch and used synthetic scope/context; they validate
first-turn boot, not production project routing or provider-wide enforcement of instructions.

Host probe of run-use on 2026-11-21 (Orca 1.4.263). It used only disposable resources: three new
shell terminals in this plugin's own worktree. A folder workspace was not used, because the CLI can
add one but has no command to remove it. Terminal A ran `run-create`, giving `run_359fb5504871`
(`coordinator_handle` A, `consumer_generation` 1). Terminal C sent `probe-1` to `run:<id>`, which
stayed unhandled. Terminal B ran `run-use --id run_359fb5504871`, and `run-current` named the run.
`run-list` then showed `coordinator_handle` B with `consumer_generation` 2, and A's `run-current`
returned null. C sent `probe-2`. B's `check --peek` returned both `probe-1` (unread before the move)
and `probe-2`; A's returned nothing. B then handled both messages, and the three terminals were
closed. The run stays listed until Orca's retention retires it, because there is no delete command.
The plugin's own `classifyRun` read the disposable run as live (2 unhandled messages) before
cleanup. The full plugin Handover with a live run (launch, then the target's own run-use) was not
run live; the tests cover it.
