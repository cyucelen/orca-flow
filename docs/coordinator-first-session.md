# Choosing a coordinator's first provider

Creating a coordinator writes its folder, instructions and an explicitly empty session record.
It does not launch an agent or open a second modal. The first row click checks enabled host
harnesses through `orca agent installed`. With multiple usable harnesses it opens an anchored
picker; picking a logo or name immediately launches that exact harness with the existing
coordinator role/skill bootstrap. One usable harness can start directly. No usable harness or
unknown discovery gives actionable feedback and Retry without a launch.

The server only enters this flow when there are no registered current/previous members, no pending
launch and no eligible existing session. Live/current, sleeping/resumable, manual history choice,
existing candidates and pending launches keep their previous precedence. The selected ID is checked
against fresh host availability before launch; an unavailable choice never falls back to a new
sole/default provider. Creation, normal entry, keyboard shortcuts and explicit fresh/restart share
the guard. Shortcuts outside the panel return the choice-needed message instead of launching.
The normal exclusive session-change lock and exact-terminal adoption protect repeated clicks.

## Host capability boundary

Discovery on Orca 1.4.265 uses both the installed host implementation and its generated plugin API:

- `agent installed` lists enabled detected CLIs, including custom launch commands. This is not a
  list of conversations or a promise that every CLI supports the coordinator lifecycle.
- Plugin `agent.launch` accepts the host TUI IDs, returns a terminal ID, and submits the supplied
  bootstrap prompt when ready. This change preserves that existing normal coordinator launch path.
- A coordinator must also have the host's session-ID tracking/resume contract to preserve Sleep.
  `agent.resume` has a `RESUMABLE_TUI_AGENTS` enum **and** a `pluginResumeKey` refinement. The picker
  intersects host availability with this refined contract in `src/coordinator-providers.ts`.
- Pi and Prime Agent appear in the enum but their resume key is null: they require a transcript
  file, and the plugin's session-ID API rejects them. They are excluded. Launch-only/custom unknown
  harness IDs and modes without this resume contract are excluded as well; availability alone does
  not advertise them as usable coordinator providers.
- This host reports Claude, Codex and Hermes installed/enabled. Hermes has `launchCmd: hermes --tui`
  and `promptInjectionMode: hermes-query`; its root-session hooks expose `session_id` and its plugin
  resume key is `session_id`. The existing exact terminal/pane/provider binding and saved native
  resume ID support it without a provider-specific adapter. Its picker button uses the reported
  display name because no Hermes mark ships here.

Evidence paths relative to the installed host's `out/shared/`:
`plugins/workers/plugin-host-api-workspace-methods.js`,
`plugins/workers/plugin-host-api-workspace-create.js`,
`plugins/workers/plugin-agent-resume-key.js`,
`agent-launch/catalog/tui-agent-config.js`,
`agent-session/lifecycle/agent-session-resume.js`, and
`agent-hook-listener/pane-provider-session.js`.

The picker inventory is `CoordinatorProvider = { id: string; name: string }`, exposed as optional
`Snapshot.coordinatorProviders` (`null` means unknown). `sidebar.openCoordinator` accepts optional
`provider`; its `WakeOutcome` can return `kind: provider` and `providers` before any launch.
New supported host contracts require updating the capability allowlist. The picker itself adds no
provider adapters or hook parity claims. The combined Antigravity integration supplies its mark and
adds workspace readiness and original-native-conversation guards;
see [Antigravity support](antigravity.md). **Handover remains
Claude/Codex-only**, independent of first-session choices.

## Verification

`./scripts/dev.sh check` covers discovery, zero/unknown/one/many providers, exact Claude/Codex/Hermes
choice, stale choice, no implicit default through shortcuts, creating empty membership and
instructions, duplicate clicks, Hermes binding/resume identity, and precedence of live, sleeping,
historical, eligible and pending sessions.

The bundled isolated preview includes a never-started coordinator and configurable provider
inventory. Its fake bridge records exact launch choices; `previewNeverStarted()` isolates the
new coordinator and `previewFirstProviders(...)` sets zero/one/many/unknown availability. Browser
checks exercise normal row clicks and creation at 380px, without installing the plugin or launching
real coordinator sessions. Live Hermes startup was not performed; its compatibility evidence is
host contract inspection plus exact binding tests, not a live provider-enforcement claim.
