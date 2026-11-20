# Antigravity in Orca Flow

**Supported with fixtures on Orca 1.4.265:** terminal session identification, mixed-provider badges, host status and titles, supervised worker lineage, explicit main-session selection, terminal coordinator startup and exact native-session resume. **Untested live:** Antigravity login, trust prompts, model turns, dispatch, delivery and resume. The CLI was absent on the verification host.

| Surface | Behavior |
| --- | --- |
| Sidebar | The exact Orca agent ID is `antigravity`. A live pane shows Google’s mark beside its role avatar when two known providers are present. A completed turn still counts. A settled dispatch or closed pane drops out. Unknown IDs keep the neutral badge. |
| Status and summaries | Flow uses Orca’s state, conversation name, task title and display name. It skips the Claude monitoring workaround, transcript lookup and cached Claude/Codex summaries for Antigravity. |
| Leads and workers | A requested Antigravity worker uses `orca orchestration worker-start --agent antigravity`. Existing parent-pane and dispatch records determine its lead and coordinator. The installed plugin exposes the Flow skill at `~/.gemini/config/skills/orca-flow`. User-owned skills and symlinks take precedence. Message-format hooks remain Claude-specific. |
| Coordinator terminals | A user can select an independent live terminal in the coordinator folder. A fresh Antigravity launch checks the workspace’s installed agents and supplies the exact coordinator skill and role paths. Automatic selection requires a live, exact binding and recorded messages and tokens for the new native conversation. An empty or unverified launch stays pending. The user can inspect its terminal and explicitly select it after a response. Resume requires the original native ID in the returned terminal. |
| Creation and structured chat | New coordinator creates an empty membership without launching; its first click offers enabled, supported harnesses, including Antigravity, in the anchored provider picker. Antigravity retains the readiness checks above and is not a Handover target. The plugin’s `agent.launch` starts a **terminal**. Structured panes can contribute host-reported presence. Structured coordinator launch, focus, transcript summarization and ownership transfer are outside this integration. |

## Contracts and provenance

- Orca 1.4.265 provides the host ID and executable mapping in its bundled agent identity metadata (`detectCmd: agy`). Its skill installation metadata specifies `.gemini/config/skills`. Google documents the same global directory and workspace discovery. [Agent skills](https://antigravity.google/docs/skills/)
- `orca orchestration worker-start --help` lists Antigravity, opaque model IDs and the target worker server. `orca agent installed --help` describes enabled execution-host CLIs, including custom commands. This inventory establishes availability only. Google documents interactive setup, workspace trust and authentication. [Google CLI setup](https://antigravity.google/docs/cli/tutorial/)
- `orca plugin types .` generates the separate worker contracts in `.orca/types/orca-host/index.d.ts`. `agent.launch` returns a terminal ID. `agent.resume` accepts `antigravity` and a native session ID. `agents.list` and `agent.listSessions` provide native binding and scoped history metadata. The latter excludes Antigravity IDE history. The installed host maps resume to `agy --conversation <id>`. [Google CLI reference](https://antigravity.google/docs/cli/reference/)
- Orca’s separate `agent launch --help` describes the CLI’s terminal/chat surface negotiation. The installed daemon also contains an Antigravity ACP capability handshake and separate Chat sign-in handling. Neither supplies a structured route through the plugin’s terminal launch/focus API.
- The local panel bundle includes Google’s mark at 3× badge resolution. [Original Google artwork](https://antigravity.google/assets/image/antigravity-logo.png)

## Reproducing the checks

Run `scripts/dev.sh check` for host types, TypeScript and both test suites. Run `orca plugin check . --json` to validate the manifest. For rendering, run `node scripts/provider-preview.mjs`, open the printed loopback URL, set the viewport to 360 × 740, and invoke `previewCase('claude-antigravity')` or `previewCase('codex-antigravity')`. Both fixtures render the real panel with an Antigravity worker in its lead’s tree and in Up next. All names and rows are synthetic.
