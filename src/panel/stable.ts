// A redraw replaces the panel's HTML, so the element under the pointer or the keyboard focus is a new
// node after every refresh. Tooltips and focus follow the same logical element across redraws by
// this key, never by the DOM node.

/** Data attributes that name what an element stands for (a row, a coordinator, a gauge, a button). */
const NAMES = ['status', 'menu', 'coordinator', 'handover', 'open', 'use', 'update', 'pr', 'url', 'fold', 'brief', 'act', 'yes', 'no', 'history', 'sessions', 'lsend', 'lfold', 'ldisplay', 'newCoordinator', 'cockpit', 'unfold', 'tfold', 'trange', 'gopen', 'gfold', 'gadd', 'gdone', 'gmore']

/**
 * The element's logical key: its path up to the nearest named element (above) or id'd container,
 * by tag and position among same-tag siblings, then that name and the container's id. Classes are
 * left out: hover, focus and menus toggle them.
 */
export function stableKey(el: Element): string {
  const parts: string[] = []
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (n.id) { parts.push(`#${n.id}`); break }
    const data = (n as HTMLElement).dataset ?? {}
    const name = NAMES.find((a) => data[a] !== undefined)
    if (name) {
      parts.push(`${n.tagName}[${name}=${data[name]}]`)
      parts.push(`#${n.parentElement?.closest('[id]')?.id ?? ''}`)
      break
    }
    const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n!.tagName) : [n]
    parts.push(`${n.tagName}:${same.indexOf(n)}`)
  }
  return parts.reverse().join('>')
}

/** The element in `root` with this key among those matching `selector`, or null. */
export function findByKey(root: ParentNode, selector: string, key: string): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(selector)) if (stableKey(el) === key) return el
  return null
}
