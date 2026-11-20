import { join } from 'node:path'

// The installed-agent inventory is execution-host specific. Installation alone says nothing about login.
export async function requireAntigravity(dir: string, run: (args: string[]) => Promise<any>): Promise<void> {
  const installed = await run(['agent', 'installed', '--worktree', `path:${dir}`]).catch(() => null)
  if (!Array.isArray(installed?.agents) || !installed.agents.some((agent: { id?: string } | null) => agent?.id === 'antigravity')) {
    throw new Error('Orca could not verify an enabled Antigravity CLI for this workspace. Check Orca Settings → Agents.')
  }
}

export async function launchAntigravityCoordinator(
  workspaceId: string, workspacePath: string, plugin: string | null,
  run: Parameters<typeof requireAntigravity>[1],
  launch: (input: { workspaceId: string; agent: string; prompt: string }) => Promise<{ terminalId: string }>
): Promise<{ terminalId: string }> {
  await requireAntigravity(workspacePath, run)
  if (!plugin) throw new Error('The Orca Flow coordinator skill could not be located.')
  const skill = join(plugin, 'skills', 'orca-flow')
  const prompt = `Your role: coordinator. Read ${join(skill, 'SKILL.md')} and ${join(skill, 'roles/coordinator.md')}. Read coordinator.json and CLAUDE.md here, and ../CLAUDE.md for shared project notes. Follow your coordinator role.`
  return launch({ workspaceId, agent: 'antigravity', prompt })
}

type History = { sessionId: string; workspaceId: string | null; agent: string; messageCount: number; totalTokens: number }

/** An empty terminal or first-run login can have an Orca pane. Require evidence of actual model activity
 * in the newly launched provider conversation before automatically making it the main conversation. */
export function antigravityTurnRecorded(history: readonly History[], workspaceId: string, nativeId: string | undefined): boolean {
  if (!nativeId) return false
  const matches = history.filter((s) => s.agent === 'antigravity' && s.workspaceId === workspaceId && s.sessionId === nativeId)
  return matches.length === 1 && matches[0].messageCount > 0 && matches[0].totalTokens > 0
}
