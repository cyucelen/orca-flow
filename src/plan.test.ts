import { assert, test } from 'orca/testing'
import { checkPlan, overlaps, ownershipNote, parsePlan, planSlug, startable, waves, type Plan } from './plan.ts'

const task = (id: string, files: string[], deps: string[] = [], extra: Record<string, unknown> = {}) => ({ id, title: `do ${id}`, spec: `spec ${id}`, files, deps, ...extra })
const plan = (tasks: unknown[]): Plan => {
  const { plan: p, errors } = parsePlan({ title: 'T', tasks })
  assert.deepEqual(errors, [])
  return p as Plan
}

test('parse: missing fields are named per task; kind defaults to normal; old class names still read', () => {
  const { errors, plan: p } = parsePlan({ tasks: [{ id: 'a', title: 'x', spec: 's', files: [] }, { id: 'b', spec: 's', specFile: 'f', files: ['x'], class: 'huge' }] })
  assert.ok(errors.some((e) => /task "a": names no "files"/.test(e)))
  assert.ok(errors.some((e) => /task "b": needs a "title"/.test(e)))
  assert.ok(errors.some((e) => /task "b": needs exactly one of "spec" or "specFile"/.test(e)))
  assert.ok(errors.some((e) => /task "b": "class" is simple, normal or hard, not "huge"/.test(e)))
  assert.equal(p?.tasks[0].kind, 'normal')
  const kinds = parsePlan({ tasks: ['simple', 'hard', 'trivial', 'standard', 'complex'].map((k, i) => ({ id: `t${i}`, title: 't', spec: 's', files: [`f${i}`], ...(i < 2 ? { kind: k } : { class: k }) })) })
  assert.deepEqual(kinds.errors, [])
  assert.deepEqual(kinds.plan?.tasks.map((t) => t.kind), ['simple', 'hard', 'simple', 'normal', 'hard'])
  assert.ok(parsePlan({ tasks: [{ id: 'a', title: 't', spec: 's', files: ['x'], kind: 'trivial2' }] }).errors.some((e) => /"kind" is simple, normal or hard/.test(e)))
  assert.deepEqual(parsePlan({ tasks: [] }).errors, ['the plan has no "tasks" list'])
})

test('ownership: same path, directory prefix and glob match overlap; siblings do not', () => {
  assert.equal(overlaps('src/x.ts', './src/x.ts'), true)
  assert.equal(overlaps('src/panel/', 'src/panel/a.ts'), true)
  assert.equal(overlaps('src/panel', 'src/panel/a.ts'), true)
  assert.equal(overlaps('src/panel/', 'src/panelx.ts'), false)
  assert.equal(overlaps('src/a.ts', 'src/b.ts'), false)
  assert.equal(overlaps('src/*.ts', 'src/x.ts'), true)
  assert.equal(overlaps('src/*.ts', 'src/panel/a.ts'), false)
  assert.equal(overlaps('src/**/*.ts', 'src/panel/a.ts'), true)
  assert.equal(overlaps('**/*.test.mjs', 'test/'), true, 'a ** glob can match inside any directory')
  assert.equal(overlaps('src/', 'src/panel/*.ts'), true, 'the glob lies inside the directory')
  assert.equal(overlaps('src/*.{ts,mjs}', 'src/a.mjs'), true)
  assert.equal(overlaps('src/*.ts', 'src/*.css'), true, 'two globs: conservative')
  assert.equal(overlaps('src/panel/*.ts', 'test/*.mjs'), false)
})

test('check: two tasks owning the same file must be chained', () => {
  const r = checkPlan(plan([task('a', ['src/x.ts']), task('b', ['src/', 'package-lock.json'])]))
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /tasks "a" and "b" both own src\/x\.ts \/ src\/ and neither waits for the other: chain them \(deps\) or merge them/)
  assert.equal(checkPlan(plan([task('a', ['src/x.ts']), task('b', ['src/'], ['a'])])).ok, true, 'b waits for a')
  const viaMiddle = checkPlan(plan([task('a', ['src/x.ts']), task('m', ['docs/'], ['a']), task('b', ['src/'], ['m'])]))
  assert.equal(viaMiddle.ok, true, 'waiting through another task counts')
  const lock = checkPlan(plan([task('a', ['package-lock.json', 'src/a.ts']), task('b', ['package-lock.json', 'src/b.ts'])]))
  assert.match(lock.errors[0], /both own package-lock\.json/, 'a shared lockfile is a file like any other')
})

test('check: missing deps, self deps, cycles and duplicate ids are errors', () => {
  assert.match(checkPlan(plan([task('a', ['a'], ['zz'])])).errors.join('\n'), /"a" depends on "zz", which is not in the plan/)
  const cyc = checkPlan(plan([task('a', ['a'], ['c']), task('b', ['b'], ['a']), task('c', ['c'], ['b'])]))
  assert.equal(cyc.ok, false)
  assert.match(cyc.errors.join('\n'), /dependency cycle: (a|b|c) → .* → \1/)
  assert.deepEqual(cyc.waves, [])
  assert.match(checkPlan(plan([task('a', ['a']), task('a', ['b'])])).errors.join('\n'), /"a" is used twice/)
})

test('check: more than 8 tasks is an error; over-splitting is a warning', () => {
  const nine = Array.from({ length: 9 }, (_, i) => task(`t${i}`, [`f${i}`]))
  assert.match(checkPlan(plan(nine)).errors.join('\n'), /9 tasks: at most 8/)
  const trivial = checkPlan(plan([task('a', ['a.ts'], [], { kind: 'simple' }), task('b', ['b.ts'], [], { class: 'trivial' })]))
  assert.equal(trivial.ok, true)
  assert.match(trivial.warnings.join('\n'), /every task is simple/)
  const inside = checkPlan(plan([task('big', ['src/panel/']), task('tiny', ['src/panel/a.ts'], ['big'], { kind: 'simple' })]))
  assert.equal(inside.ok, true)
  assert.match(inside.warnings.join('\n'), /simple task "tiny" only touches files "big" owns: merge it into "big"/)
})

test('waves are topological layers', () => {
  const r = checkPlan(plan([task('a', ['a']), task('b', ['b']), task('c', ['c'], ['a', 'b']), task('d', ['d'], ['c'])]))
  assert.deepEqual(r.waves, [['a', 'b'], ['c'], ['d']])
  assert.equal(waves([{ id: 'x', deps: ['x'] }]), null)
})

test('startable: deps done, queued only, every ready task, nothing else limits it', () => {
  const p = plan([task('a', ['a']), task('b', ['b']), task('c', ['c']), task('d', ['d'], ['a'])])
  assert.deepEqual(startable(p, {}), ['a', 'b', 'c'])
  assert.deepEqual(startable(p, { a: 'running' }), ['b', 'c'])
  assert.deepEqual(startable(p, { a: 'done', b: 'running' }), ['c', 'd'])
  assert.deepEqual(startable(p, { a: 'failed' }), ['b', 'c'], 'a failed dependency holds d back')
  assert.deepEqual(startable(p, { a: 'running', b: 'running', c: 'running' }), [])
  assert.deepEqual(startable(p, { a: 'failed-start' }), ['a', 'b', 'c'], 'a failed start can be started again')
  assert.deepEqual(startable(p, { a: 'unknown' }), ['b', 'c'], 'a start whose outcome is unknown is never started again')
  assert.deepEqual(startable(p, { a: 'missing' }), ['b', 'c'], 'a task with no Orca task is not started')
})

test('slug and ownership note', () => {
  assert.equal(planSlug('Model routing: dispatch & plans!'), 'model-routing-dispatch-plans')
  const p = plan([task('a', ['src/a.ts']), task('b', ['src/b.ts'])])
  assert.match(ownershipNote(p, 'a'), /Files you own \(edit only these\): src\/a\.ts\.\nOther tasks own: src\/b\.ts \(b\)/)
})
