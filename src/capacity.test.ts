import { assert, test } from 'orca/testing'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { costsOf, ENV_MEMORY, envCost, envPrices, readEnvMemory, rememberEnv, typicalEnv, updateEnvCosts, type EnvMemory, type EnvSample } from './capacity.ts'

const DAY = 24 * 60 * 60 * 1000
const T = Date.parse('2026-11-24T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const sample = (path: string, repo: string, gb: number, daysAgo = 0): EnvSample => ({ path, repo, gb, at: iso(T - daysAgo * DAY) })
const mem = (samples: EnvSample[], legacy: Record<string, number> = {}): EnvMemory => ({ samples, legacy })

test('a project is priced at the median of its recent checkouts: one heavy checkout does not set the price', () => {
  // Three mono checkouts measured earlier ran ~3-4 GB hot; one runs an emulator and two dashboards (19.7 GB).
  const memory = mem([sample('/w/a', 'mono', 3.1, 3), sample('/w/b', 'mono', 3.5, 2), sample('/w/c', 'mono', 4.0, 1)])
  const { envGB } = costsOf([], [{ path: '/w/heavy', repo: 'mono', gb: 19.7 }], memory, T)
  assert.equal(envGB.mono, 3.8, 'median of 3.1, 3.5, 4.0, 19.7')
  // The checkout running now replaces its own earlier sample rather than adding a second one.
  const again = costsOf([], [{ path: '/w/a', repo: 'mono', gb: 3.3 }], memory, T)
  assert.deepEqual(again.memory.samples.filter((s) => s.path === '/w/a').map((s) => s.gb), [3.3])
  assert.equal(again.envGB.mono, 3.5)
})

test('a checkout whose dev servers stopped keeps its sample; a project that started nothing costs 0', () => {
  const memory = mem([sample('/w/a', 'mono', 3.5, 1)])
  const stopped = costsOf([], [{ path: '/w/a', repo: 'mono', gb: 0 }, { path: '/w/flow', repo: 'orca-flow', gb: 0 }], memory, T)
  assert.deepEqual(stopped.envGB, { mono: 3.5, 'orca-flow': 0 })
  assert.deepEqual(stopped.memory.samples.find((s) => s.path === '/w/a'), sample('/w/a', 'mono', 3.5, 1), 'not overwritten, not refreshed')
  // A mono checkout at work with nothing started does not pull the price down either.
  assert.equal(costsOf([], [{ path: '/w/new', repo: 'mono', gb: 0 }], memory, T).envGB.mono, 3.5)
  assert.equal(envCost(stopped.envGB, 'orca-flow'), 0, 'measured, not the fallback')
  assert.equal(envCost(stopped.envGB, 'docs'), 1.5, 'never seen here: the fallback')
  assert.equal(typicalEnv(stopped.envGB), 3.5)
})

test('samples older than 30 days go, and each project keeps its newest 10 running ones', () => {
  assert.deepEqual(ENV_MEMORY, { perRepo: 10, maxAgeDays: 30 })
  const old = mem([sample('/w/old', 'mono', 25, 31), sample('/w/recent', 'mono', 4, 29)])
  const pruned = rememberEnv(old, [], T)
  assert.deepEqual(pruned.samples.map((s) => s.path), ['/w/recent'])
  // 12 running mono checkouts, oldest heaviest: only the newest 10 count.
  const many = mem(Array.from({ length: 12 }, (_, i) => sample(`/w/m${i}`, 'mono', i < 2 ? 2 : 20, 12 - i)))
  const kept = rememberEnv(many, [], T)
  assert.equal(kept.samples.length, 10)
  assert.deepEqual(kept.samples.map((s) => s.path).sort(), Array.from({ length: 10 }, (_, i) => `/w/m${i + 2}`).sort())
  // Checkouts that started nothing are limited apart, so they never push out the running samples.
  const idle = rememberEnv(kept, Array.from({ length: 15 }, (_, i) => ({ path: `/w/z${i}`, repo: 'mono', gb: 0 })), T + 1000)
  assert.equal(idle.samples.filter((s) => s.gb > 0).length, 10)
  assert.equal(idle.samples.filter((s) => s.gb === 0).length, 10)
  assert.equal(envPrices(idle).mono, 20)
  // A project whose last sample expired falls back to the fallback price, like one never seen.
  assert.deepEqual(envPrices(rememberEnv(mem([sample('/w/x', 'shop', 2, 40)]), [], T)), {})
})

test('the old { repo: number } file is read as a fallback price until a checkout of that project is measured', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-'))
  writeFileSync(join(dir, 'env-costs.json'), JSON.stringify({ mono: 19.7, 'orca-flow': 0.1, bounti: 0 }))
  const read = readEnvMemory(dir)
  assert.deepEqual(read, { samples: [], legacy: { mono: 19.7, 'orca-flow': 0.1, bounti: 0 } })
  assert.deepEqual(envPrices(read), { mono: 19.7, 'orca-flow': 0.1, bounti: 0 })
  // A mono checkout measured now: its sample replaces the old number (it is not averaged with it).
  const prices = updateEnvCosts(dir, [{ path: '/w/mono-a', repo: 'mono', gb: 3.5 }, { path: '/w/flow', repo: 'orca-flow', gb: 0 }], T)
  assert.deepEqual(prices, { mono: 3.5, 'orca-flow': 0, bounti: 0 })
  // The new file keeps the prices as top-level numbers, so an older Orca Flow (which keeps only the
  // numeric values) still reads current prices; the samples ride along.
  const file = JSON.parse(readFileSync(join(dir, 'env-costs.json'), 'utf8'))
  const oldReader = Object.fromEntries(Object.entries(file).filter((e) => typeof e[1] === 'number' && (e[1] as number) >= 0))
  assert.deepEqual(oldReader, { mono: 3.5, 'orca-flow': 0, bounti: 0 })
  assert.deepEqual(file.samples, [sample('/w/mono-a', 'mono', 3.5), sample('/w/flow', 'orca-flow', 0)])
  assert.deepEqual(readEnvMemory(dir).samples, file.samples)
  // Later the mono checkout stops: the price stays at its sample, not the old 19.7.
  assert.equal(updateEnvCosts(dir, [{ path: '/w/mono-a', repo: 'mono', gb: 0 }], T + DAY).mono, 3.5)
})

test('a broken or partly broken file reads as what can be trusted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-'))
  assert.deepEqual(readEnvMemory(dir), { samples: [], legacy: {} }, 'missing')
  writeFileSync(join(dir, 'env-costs.json'), '{ not json')
  assert.deepEqual(readEnvMemory(dir), { samples: [], legacy: {} })
  writeFileSync(join(dir, 'env-costs.json'), JSON.stringify({ shop: -1, docs: 'x', samples: [null, { path: '/w/a', repo: 'shop', gb: 2, at: 'never' }, sample('/w/b', 'shop', 2)] }))
  assert.deepEqual(readEnvMemory(dir), { samples: [sample('/w/b', 'shop', 2)], legacy: {} })
})
