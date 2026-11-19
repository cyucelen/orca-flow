# Sidebar provider logos

Logos appear when **at least two distinct known agent providers have live sessions anywhere in
the sidebar**. The set includes coordinator sessions, workstream leads, workers, solo chats and
folder agents, including several providers in one worktree. Folding a group or searching does
not change the threshold. Each displayed agent carries its own mark; Up next uses the same rule.

Presence comes from Orca's per-agent `hasLivePty === true` or `structuredHostOwned === true`,
copied to optional `AgentInfo.live`. Working, monitoring, blocked, waiting and idle (`done`)
turns all count. A settled orchestration dispatch does not count even while its terminal remains
open. Closed/history rows with neither live signal do not count, even when another terminal is
open in their worktree. A follow-up with an open dispatch counts again. Older host snapshots
without positive per-agent evidence omit badges rather than guess from workspace counts.

Only `agentType` identifies a provider: trimmed, case-insensitive exact ids `claude`, `codex`,
`gemini`, `cursor`, `copilot`, `opencode`; `claude-agent-teams` maps to Claude and `opencode2` to
OpenCode. Models, titles, summaries and transcript contents never identify providers. Missing or
unrecognized ids do not increase the threshold; in a mixed sidebar their live rows show a neutral
robot with the accessible name and tooltip “Unknown provider”. Add new supported ids and bundled
marks together in `providers.ts` / `provider-logos.ts`.

Marks are inline SVG with an accessible provider name and the panel's existing hover tooltip.
They add no controls or tab stops; clicks retain the enclosing row's existing session target.
Characters, state rings, focus marks and coordinator membership remain independent of providers.

The tree now walks all descendants in existing sibling order, preserving each `leadPane`.
Previously it emitted roots and immediate children only: a continuation row above a lead hid
that lead's real workers. The walk also handles missing parents, self-parenting and cycles without
dropping rows or recursing forever. Deeper descendants use the existing compact worker column.
This changes neither coordinator-session selection nor assignment to coordinators.

## Assets

Bundled paths are from [Simple Icons](https://github.com/simple-icons/simple-icons), distributed
under [CC0](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md); brand marks
belong to their respective owners. No provider asset is fetched at runtime. Retrieved 2026-11-19:

- Claude: [`claude.svg`](https://github.com/simple-icons/simple-icons/blob/develop/icons/claude.svg), rendered in `#D97757`.
- Codex: the OpenAI mark, [`openai.svg` at 13.21.0](https://github.com/simple-icons/simple-icons/blob/13.21.0/icons/openai.svg).
- Gemini: [`googlegemini.svg`](https://github.com/simple-icons/simple-icons/blob/develop/icons/googlegemini.svg).
- Cursor: [`cursor.svg`](https://github.com/simple-icons/simple-icons/blob/develop/icons/cursor.svg).
- GitHub Copilot: [`githubcopilot.svg`](https://github.com/simple-icons/simple-icons/blob/develop/icons/githubcopilot.svg).
- OpenCode: [`opencode.svg`](https://github.com/simple-icons/simple-icons/blob/develop/icons/opencode.svg).

The other marks inherit the foreground for both themes. SVG path data is bundled, not interpolated
from agent metadata. The unknown robot is drawn locally.

## Verification

`scripts/dev.sh check` runs generated host types, TypeScript, plugin tests and script tests.
`src/providers.test.ts` covers zero/single/mixed providers, same-worktree mixing, coordinator and
folder rows, search/folding, native chats, waiting/idle/monitoring, settled/closed/resumed sessions,
unknown inputs, focus targets, deep Codex descendants, and malformed parent graphs.

`node scripts/provider-preview.mjs` serves the real panel HTML/CSS/JS against synthetic snapshots
and a stub host bridge. It bundles with esbuild into ignored `.orca/provider-preview` and prints
a localhost URL. Open it using Orca's browser CLI; `previewCase('single' | 'mixed' | 'closed')`
changes the fixture, and `previewCalls` records click requests. This checks rendering and browser
events without installing the plugin, starting its worker, reading sessions or changing host state.
It does not prove the installed plugin renders the new code; delivery is a separate step.
