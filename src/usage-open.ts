// The stub files of the Usage and Completed goals tabs. Orca opens an editor tab only for a real file inside a workspace, so the
// worker keeps `<workspace>/.orca/orca-flow/usage.orcaflow-usage` (a one-line note; the editor ignores
// its content) next to a `.gitignore` holding `*`, which ignores the stub and the .gitignore itself:
// the user's repo never shows either. The Completed goals tab has its own stub in the same folder. Nothing of the user's is read or changed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const USAGE_FOLDER = '.orca/orca-flow'
export const USAGE_FILE = 'usage.orcaflow-usage'
/** What `editor.open` is given: relative to the workspace. */
export const USAGE_PATH = `${USAGE_FOLDER}/${USAGE_FILE}`
const STUB = 'Orca Flow Usage view. Open this tab to see Analytics; the file holds nothing and is safe to delete.\n'

export const GOALS_FILE = 'goals.orcaflow-goals'
export const GOALS_PATH = `${USAGE_FOLDER}/${GOALS_FILE}`
const GOALS_STUB = 'Orca Flow Completed goals view. Open this tab to search and reopen completed goals; the file holds nothing and is safe to delete.\n'

/** Creates the folder, its `.gitignore` (`*`) and the stub where they are missing; returns the stub's path inside `root`. */
export const ensureUsageStub = (root: string): string => ensureStub(root, USAGE_FILE, STUB)
/** The Completed goals tab's stub: the same folder and `.gitignore`. */
export const ensureGoalsStub = (root: string): string => ensureStub(root, GOALS_FILE, GOALS_STUB)

function ensureStub(root: string, file: string, text: string): string {
  const dir = join(root, USAGE_FOLDER)
  mkdirSync(dir, { recursive: true })
  const ignore = join(dir, '.gitignore')
  // A .gitignore that already ignores everything stays as it is; any other is not ours to overwrite.
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  else if (!readFileSync(ignore, 'utf8').split('\n').some((l) => l.trim() === '*')) writeFileSync(ignore, '*\n')
  const stub = join(dir, file)
  if (!existsSync(stub)) writeFileSync(stub, text)
  return stub
}
