import { lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Explicit launch instructions also cover user overrides and hosts with different discovery rules. */
export function coordinatorPrompt(skill: string): string {
  return `Your role: coordinator. You own project routing, capacity and workstream order; delegate implementation to leads. You are not a lead or a dispatched worker.
Read ${join(skill, 'SKILL.md')} and ${join(skill, 'roles/coordinator.md')} now, then follow that coordinator role.
Read coordinator.json in this workspace for your name, owned projects and scope (empty repos means all projects). If your scope is not set yet, record the user's scope in coordinator.json (repos: owned project names; about: one sentence). Read local AGENTS.md and CLAUDE.md, and ../CLAUDE.md for the user's shared project notes. Preserve existing workstream lead/worker parentage and pending decisions. Start new conversation means a fresh conversation, not permission to discard project scope or take another coordinator's work.`
}

/** Create only absent instructions, including in existing non-git coordinator folders. */
export function bootstrapCoordinator(dir: string, skill = join(homedir(), '.agents/skills/orca-flow')): string[] {
  const done: string[] = []
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const path = join(dir, file)
    try { lstatSync(path); continue } catch (e) { if ((e as { code?: string }).code !== 'ENOENT') throw e }
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, `# Coordinator\n\n${coordinatorPrompt(skill)}\n`, { flag: 'wx' })
    done.push(`wrote ${path}`)
  }
  return done
}
