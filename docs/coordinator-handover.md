# Coordinator handover: supported subset and host gaps

This change is **not a complete implementation of active-run coordinator handover**. The installed
Orca 1.4.265 host does not expose the ownership transaction required by the request. The menu fails
closed for coordinators with owned runs, including historical members, instead of treating a new
tab as success. Leads' and unrelated runs remain unchanged; no pending question is consumed,
answered, deleted or readdressed by the plugin.

## Supported behavior

- Compact target provider choice in the existing coordinator menu, with inline progress and errors.
  The avatar/provider-logo/name order and one-step session dropdown remain intact.
- A Claude ↔ Codex terminal handover in the same workspace when no member owns a run. It verifies
  `agent launch` receipt, `prompt.outcome` (`journaled` or `handed-to-terminal`), exact provider,
  workspace, session identity and absence of dispatch/parent provenance before changing current.
- Stored transcript recovery through `agent read --limit 100`. The source is never resumed,
  prompted or asked to summarize. Read failure prevents launch. Orca's bounded history reports
  truncation; its `limited` flag is kept with the snapshot. Original transcripts are never modified.
- Context files contain scope, goals/cards, workstreams, pending decisions and source history.
  The prompt labels transcript/tool/summary content untrusted reference, points to authoritative
  coordinator and host state, and explicitly loads the coordinator role and skill.
- A durable `.orca-flow-handover.json` records the exact prompt, launch phase, returned operation
  ID, target and error. A retry uses `--retry-launch` only for the same recorded launch. Missing
  replay identity after an ambiguous launch blocks automatic relaunch. A successfully delivered
  target is adopted without launching again. The record survives worker restarts.
- A changed current selection is preserved. New source/target runs discovered before completion
  block selection. Verified targets become coordinator members, including after later failure;
  they are not reclassified as workstream leads. Original source asks stay with their source.
- Missing per-folder `AGENTS.md` and `CLAUDE.md` are seeded for new/existing coordinators, with a
  stable installed skill path. Existing instructions, overrides and other plugins' links stay
  untouched. Launch prompts supply the current skill path as a discovery backstop.

The development preview only serves the real panel bundle with synthetic data and a fake bridge.
It does not load another plugin worker, install links, alter account settings or touch coordinators.

## Why run transfer is blocked

Read-only discovery on 2026-11-20 used `orca agent launch --help`, `agent read --help`,
`orchestration run-use --help`, `run-list --help`, generated plugin API types, and installed host
implementation under `/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out`.
Installed build: `1.4.265-3534932c2d0ee3305df97c9689ea23efa207abdd-arm64`.

Evidence in `main/chunks/orcad-retained-source-CIgRydIS.js`:

- The `orchestration.runUse` handler calls `bindRun`, which calls
  `unbindOtherRunsForCoordinator` before binding the named run. A terminal cannot keep several
  existing coordinator routes through repeated `run-use` calls.
- The public request accepts `id`, `from`, and `takeoverLegacy`; it has no expected-source
  identity/generation or expected-target-runs guard. A read/check followed by `run-use` is not an
  atomic handover and can unbind a concurrently acquired unrelated target run.
- Legacy takeover requires attestation from the live target coordinator terminal and preserves
  workers through native mailbox migration. A plugin process cannot impersonate that terminal.
- The public run projection removes internal session/pane identity. The plugin cannot reconstruct
  stronger ownership authority from that projection, and never edits Orca's databases.

The generated plugin `agent.launch` API returns only `terminalId` and always describes a CLI
terminal. Handover therefore uses the supported CLI launch receipt, respecting the user's surface
choice. The public focus route is `terminal switch --terminal <handle>`; `chat` offers rename,
not focus. A structured target is preserved and registered but the original stays current with an
explicit error. The core tests cover structured receipt handling; **live structured navigation
and run transfer are unsupported, not verified successes**.

The host follow-up needs an idempotent handover transaction with expected source/target session
identities and ownership generation, atomic transfer of every specified run without unbinding
unrelated runs, preserved dispatch/lead parentage, durable pending-ask/report routing, and a
readable transfer receipt. It also needs a supported structured-chat reveal/focus route. Only then
can the plugin replace these refusal boundaries with completed handover.

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
acquisition, owned-run refusal, pending-ask preservation, session registration and hierarchy.
Installation tests cover selected/explicit/default Claude profiles, Codex USER roots, installed
release repair, foreign/dangling links, existing instructions and development-copy isolation.

Run `node scripts/coordinator-preview.mjs` for a disposable local preview, optionally with
`ORCA_FLOW_PREVIEW_PORT`. The actual menu was inspected in Orca's browser at **380 × 780**, with
screenshots for both provider directions, progress, error/retry and the existing session dropdown.
Preview artifacts and the detailed execution report are supplied separately to the lead.

No real coordinator was handed over, resumed, closed or prompted. No production plugin or global
configuration was installed/changed. Live provider startup and native run/mail ownership were not
tested through disposable real agents; receipt/ownership scenarios use isolated fixtures.
