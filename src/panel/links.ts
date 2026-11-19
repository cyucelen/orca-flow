// A row's PR chip and Linear label open their page outside Orca. They sit inside the row's button,
// so the panel's click handler asks this first and, when it names a page, opens it and stops there:
// the row's own click (focusing its session) does not run.

/** The parts of a DOM element this reads: `closest`, and a found element's data attributes. */
type Target = { closest(selector: string): { dataset: Record<string, string | undefined> } | null }

/** The page a click on `target` opens: the PR chip's (`data-pr`) or the Linear label's (`data-url`); null for anything else. */
export function externalLink(target: Target | null): string | null {
  const link = target?.closest('[data-pr],[data-url]')
  return link?.dataset.pr || link?.dataset.url || null
}
