// The price table Analytics estimates with (docs/analytics-brief.md §7). Pure data and arithmetic.
//
// - Anthropic models only, at Anthropic's first-party API list prices, $ per million tokens. Source:
//   the claude-api reference (Current Models table, shared/models.md and shared/prompt-caching.md),
//   cached 2026-11-03, read 2026-11-23. Cache writes are 1.25× input (5 min) and 2× input (1 h);
//   cache reads are 0.1× input except where the reference names a price (Fable 5.2 / Mythos 5.2
//   $0.20, Fable 5.1 / Mythos 5.1 $0.25, Opus 5.5 $0.20, Sonnet 5.5 $0.10; Fable 5 is four times
//   Fable 5.1's, $1.00).
// - Every other model (Codex/OpenAI, a model id the log did not name, a retired Claude model) has
//   no price: "no estimate", never a guess.
// - An estimate is always "at API list prices": Claude Max and ChatGPT plans are flat subscriptions,
//   so it is never what the user pays and is never called a cost, a charge or a bill.

export type Price = { in: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; out: number }
export type PriceRow = Price & {
  /** Over this many prompt tokens (input + cache read + cache write) the response is priced at `long`. */
  longOver?: number
  long?: Price
  note?: string
}
export type PriceTable = { version: string; dated: string; source: string; models: Record<string, PriceRow> }

/** What every estimate is called, and its tooltip. */
export const ESTIMATE_LABEL = 'Estimated at API list prices'
export const ESTIMATE_TIP = 'at API list prices · not your bill'

/** Input price → the row: writes 1.25× and 2×, reads `read` (default 0.1×). */
const row = (input: number, out: number, read = input / 10, extra: Partial<PriceRow> = {}): PriceRow => ({
  in: input, cacheRead: read, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2, out, ...extra
})

export const PRICES: PriceTable = {
  version: 'v1',
  dated: '2026-11-03',
  source: 'Anthropic API list prices (claude-api reference, cached 2026-11-03)',
  models: {
    'claude-fable-5-2': row(8, 40, 0.2),
    'claude-mythos-5-2': row(8, 40, 0.2),
    'claude-fable-5-1': row(10, 50, 0.25),
    'claude-mythos-5-1': row(10, 50, 0.25),
    'claude-fable-5': row(10, 50, 1),
    'claude-opus-5-5': row(4, 20, 0.2),
    'claude-opus-5': row(5, 25),
    'claude-opus-4-8': row(5, 25),
    'claude-opus-4-7': row(5, 25),
    'claude-opus-4-6': row(5, 25),
    'claude-sonnet-5-5': row(2, 10, 0.1),
    'claude-sonnet-5': row(2, 10),
    'claude-sonnet-4-6': row(3, 15),
    // $0.10 / $0.50 up to 100K prompt tokens, $0.50 / $2.50 above. The reference names no separate
    // cache read price, so the general 0.1× is assumed.
    'claude-haiku-5-5': row(0.1, 0.5, 0.01, { longOver: 100_000, long: row(0.5, 2.5), note: 'cache read price assumed at 0.1× input' }),
    'claude-haiku-4-5': row(1, 5)
  }
}

/**
 * The table's key for a logged model id: "claude-sonnet-4-6-20260101" → "claude-sonnet-4-6",
 * "us.anthropic.claude-opus-5-5" → "claude-opus-5-5", "claude-opus-5-5[1m]" → "claude-opus-5-5".
 * Null when the table has no such model.
 */
export function priceKey(model: string | null | undefined, table: PriceTable = PRICES): string | null {
  if (typeof model !== 'string' || !model) return null
  const id = model.trim().toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '')
    .replace(/@\d{8}$/, '')
    .replace(/-\d{8}$/, '')
  return Object.prototype.hasOwnProperty.call(table.models, id) ? id : null
}

/** The tokens one response used, in the four categories (cache write split by TTL). */
export type TokenFields = { in: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; out: number }

/** The price one response is charged at (its prompt size picks Haiku's tier), or null: no estimate. */
export function priceFor(model: string | null | undefined, u: TokenFields, table: PriceTable = PRICES): Price | null {
  const key = priceKey(model, table)
  if (!key) return null
  const p = table.models[key]
  const prompt = u.in + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h
  return p.long && p.longOver != null && prompt > p.longOver ? p.long : p
}

/** One response's estimate in $ (brief §7), or null when its model has no price. */
export function estimate(model: string | null | undefined, u: TokenFields, table: PriceTable = PRICES): number | null {
  const p = priceFor(model, u, table)
  if (!p) return null
  return (u.in * p.in + u.cacheRead * p.cacheRead + u.cacheWrite5m * p.cacheWrite5m + u.cacheWrite1h * p.cacheWrite1h + u.out * p.out) / 1e6
}
