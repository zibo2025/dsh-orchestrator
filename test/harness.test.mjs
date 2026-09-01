/**
 * Unit tests for the Continual Harness: per-edit hard validation, optimistic
 * concurrency, rollback inverse-replay, the record↔fold round trip for
 * session-local state, overview disclosure caps, and the file-backed global
 * store (atomic write, 0600, audit log, corrupt-file degradation).
 * Run via `npm test`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessStore, foldLocalHarness, harnessOverview, planLocalHarness } from '../lib/harness.js'
import { harnessMeta, harnessRecordsOf } from '../lib/harness-records.js'

const meta = { summary: 'weekly mesh lessons', rationale: 'recurring failures keep resurfacing' }

/** A create edit with per-test overrides. */
const createEdit = (id, overrides = {}) => ({ action: 'create', id, kind: 'memory', title: `t:${id}`, content: `c:${id}`, ...overrides })

/** One session event carrying a harness record, as the durable log would hold it. */
const harnessEvent = (seq, record) => ({ type: 'tool/result', seq, time: 0, data: { message: null, meta: harnessMeta(record) } })

/** A full entry object for overview-level tests that build states directly. */
const entry = (overrides = {}) => ({
  id: 'e',
  kind: 'memory',
  title: 't',
  content: 'c',
  scope: 'local',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
  ...overrides,
})

/** A throwaway HarnessStore directory, removed when the test finishes. */
async function storeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-harness-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

// ── per-edit hard validation ─────────────────────────────────────────────────

test('create hard-validates every edit without aborting its siblings', () => {
  const { refinement } = planLocalHarness([], [
    createEdit('UPPER'),
    createEdit('x'),
    createEdit('a'.repeat(65)),
    createEdit('orientation'),
    createEdit('base_system_prompt'),
    { action: 'create', id: 'no-title', kind: 'memory', content: 'c' },
    { action: 'create', id: 'no-content', kind: 'memory', title: 't' },
    { action: 'create', id: 'no-kind', title: 't', content: 'c' },
    createEdit('bad-kind', { kind: 'note' }),
    createEdit('bad-scope', { scope: 'team' }),
    createEdit('with-route', { route: { provider: 'p' } }),
    createEdit('global-in-local', { scope: 'global' }),
    { action: 'upsert', id: 'weird-action' },
    createEdit('ok-entry'),
  ], meta)
  const byId = new Map(refinement.edits.map((edit) => [edit.id, edit]))
  const rejected = (id, pattern) => {
    const edit = byId.get(id)
    assert.equal(edit.applied, false, `${id} must be rejected`)
    assert.match(edit.error, pattern)
    assert.equal(edit.before, undefined)
    assert.equal(edit.after, undefined)
  }
  rejected('UPPER', /invalid id/)
  rejected('x', /invalid id/)
  rejected('a'.repeat(65), /invalid id/)
  rejected('orientation', /reserved/)
  rejected('base_system_prompt', /reserved/)
  rejected('no-title', /create requires non-empty title/)
  rejected('no-content', /create requires non-empty content/)
  rejected('no-kind', /create requires non-empty kind/)
  rejected('bad-kind', /kind must be one of/)
  rejected('bad-scope', /scope must be "local" or "global"/)
  rejected('with-route', /route is only allowed on "worker" entries/)
  rejected('global-in-local', /targets "global" scope/)
  rejected('weird-action', /unknown action/)
  const ok = byId.get('ok-entry')
  assert.equal(ok.applied, true)
  assert.equal(ok.after.version, 1)
  assert.equal(ok.after.scope, 'local')
  assert.equal(ok.after.createdAt, ok.after.updatedAt)
})

test('create stores a normalized worker route and omits an empty one', () => {
  const { refinement } = planLocalHarness([], [
    createEdit('worker-1', { kind: 'worker', route: { provider: 'p', model: 'm', maxTokens: 2048, effort: 'high', junk: 'x' } }),
    createEdit('worker-2', { kind: 'worker', route: {} }),
  ], meta)
  const [w1, w2] = refinement.edits
  assert.deepEqual(w1.after.route, { provider: 'p', model: 'm', maxTokens: 2048, effort: 'high' })
  assert.equal(w2.after.route, undefined)
})

test('create refuses an id that already exists in the folded state', () => {
  const first = planLocalHarness([], [createEdit('entry-x')], meta)
  const second = planLocalHarness([harnessEvent(2, first.record)], [createEdit('entry-x'), createEdit('entry-y')], meta)
  const dup = second.refinement.edits.find((edit) => edit.id === 'entry-x')
  assert.equal(dup.applied, false)
  assert.match(dup.error, /already exists/)
  assert.equal(second.refinement.edits.find((edit) => edit.id === 'entry-y').applied, true)
})

test('update validates baseVersion, applies fields, and bumps the version', () => {
  const first = planLocalHarness([], [createEdit('entry-x')], meta)
  const e1 = [harnessEvent(2, first.record)]
  const second = planLocalHarness(e1, [
    { action: 'update', id: 'entry-x' },
    { action: 'update', id: 'entry-x', baseVersion: 99, title: 'nope' },
    { action: 'update', id: 'missing-entry', baseVersion: 1 },
    { action: 'update', id: 'entry-x', baseVersion: 1, title: '' },
    { action: 'update', id: 'entry-x', baseVersion: 1, route: { provider: 'p' } },
    { action: 'update', id: 'entry-x', baseVersion: 1, title: 't2', content: 'c2' },
  ], meta)
  const [noBase, stale, gone, emptyTitle, routeOnMemory, ok] = second.refinement.edits
  assert.match(noBase.error, /update requires a finite baseVersion/)
  assert.equal(stale.error, 'entry changed during refinement planning')
  assert.match(gone.error, /does not exist/)
  assert.match(emptyTitle.error, /title must be a non-empty string/)
  assert.match(routeOnMemory.error, /route is only allowed on "worker" entries/)
  assert.equal(ok.applied, true)
  assert.equal(ok.after.version, 2)
  assert.equal(ok.after.title, 't2')
  assert.equal(ok.after.content, 'c2')
  assert.equal(ok.after.createdAt, ok.before.createdAt)
  assert.ok(ok.after.updatedAt >= ok.before.updatedAt)
  const folded = foldLocalHarness([...e1, harnessEvent(3, second.record)])
  assert.deepEqual(folded.entries['entry-x'], ok.after)
})

test('delete validates baseVersion and snapshots the removed entry', () => {
  const first = planLocalHarness([], [createEdit('entry-x')], meta)
  const e1 = [harnessEvent(2, first.record)]
  const second = planLocalHarness(e1, [
    { action: 'delete', id: 'entry-x' },
    { action: 'delete', id: 'entry-x', baseVersion: 99 },
    { action: 'delete', id: 'missing-entry', baseVersion: 1 },
    { action: 'delete', id: 'entry-x', baseVersion: 1 },
  ], meta)
  const [noBase, stale, gone, ok] = second.refinement.edits
  assert.match(noBase.error, /delete requires a finite baseVersion/)
  assert.equal(stale.error, 'entry changed during refinement planning')
  assert.match(gone.error, /does not exist/)
  assert.equal(ok.applied, true)
  assert.deepEqual(ok.before, first.refinement.edits[0].after)
  assert.equal(ok.after, undefined)
  const folded = foldLocalHarness([...e1, harnessEvent(3, second.record)])
  assert.deepEqual(folded.entries, {})
  assert.equal(folded.refinements.length, 2)
})

// ── refinement-level validity ────────────────────────────────────────────────

test('a refinement that applies nothing is invalid and leaves the store untouched', async () => {
  const { dir, done } = await storeDir()
  try {
    const store = new HarnessStore(dir)
    assert.throws(() => store.applyGlobal([createEdit('UPPER'), createEdit('x')], meta), /applied no edits/)
    assert.deepEqual(store.globalState(), { schema: 1, entries: {}, refinements: [] })
    assert.equal(readdirSync(dir).length, 0)
    assert.throws(() => planLocalHarness([], [createEdit('entry-x')], { rationale: 'r' }), /non-empty summary/)
    assert.throws(() => planLocalHarness([], [createEdit('entry-x')], { summary: 's' }), /non-empty rationale/)
    assert.throws(() => store.applyGlobal([createEdit('entry-x')], { summary: 's' }), /non-empty rationale/)
  } finally {
    done()
  }
})

test('applyGlobal rejects local-scoped edits; the local planner rejects global-scoped ones', async () => {
  const { dir, done } = await storeDir()
  try {
    const store = new HarnessStore(dir)
    const refinement = store.applyGlobal([createEdit('local-in-global', { scope: 'local' }), createEdit('g1')], meta)
    const bad = refinement.edits.find((edit) => edit.id === 'local-in-global')
    assert.equal(bad.applied, false)
    assert.match(bad.error, /targets "local" scope/)
    assert.equal(store.globalState().entries.g1.scope, 'global')
  } finally {
    done()
  }
})

// ── the global store ─────────────────────────────────────────────────────────

test('HarnessStore persists state atomically with 0600 and appends the audit log', async () => {
  const { dir, done } = await storeDir()
  try {
    const store = new HarnessStore(dir)
    const created = store.applyGlobal([createEdit('lesson-1')], meta)
    const updated = store.applyGlobal([{ action: 'update', id: 'lesson-1', baseVersion: 1, title: 't2' }], meta)
    // a fresh instance reads the same state back from disk
    assert.deepEqual(new HarnessStore(dir).globalState(), {
      schema: 1,
      entries: { 'lesson-1': updated.edits[0].after },
      refinements: [created, updated],
    })
    assert.equal(statSync(join(dir, 'harness_state.json')).mode & 0o777, 0o600)
    assert.equal(statSync(join(dir, 'refinements.jsonl')).mode & 0o777, 0o600)
    const lines = readFileSync(join(dir, 'refinements.jsonl'), 'utf8').trim().split('\n')
    assert.deepEqual(lines.map((line) => JSON.parse(line).id), [created.id, updated.id])
    // atomic write leaves no temp files behind
    assert.deepEqual(readdirSync(dir).sort(), ['harness_state.json', 'refinements.jsonl'])
  } finally {
    done()
  }
})

test('globalState degrades missing or corrupt state files to empty without throwing', async () => {
  const { dir, done } = await storeDir()
  try {
    assert.deepEqual(new HarnessStore(join(dir, 'never-created')).globalState(), { schema: 1, entries: {}, refinements: [] })
    const store = new HarnessStore(dir)
    store.applyGlobal([createEdit('entry-x')], meta)
    const statePath = join(dir, 'harness_state.json')
    const empty = { schema: 1, entries: {}, refinements: [] }
    writeFileSync(statePath, '{ not json')
    assert.deepEqual(store.globalState(), empty)
    writeFileSync(statePath, JSON.stringify({ schema: 2, entries: {}, refinements: [] }))
    assert.deepEqual(store.globalState(), empty)
    writeFileSync(statePath, JSON.stringify({ schema: 1, entries: { 'entry-x': { id: 'other' } }, refinements: [] }))
    assert.deepEqual(store.globalState(), empty)
    writeFileSync(statePath, JSON.stringify({ schema: 1, entries: {}, refinements: [{ id: 'ref-1' }] }))
    assert.deepEqual(store.globalState(), empty)
    // degradation is not corruption: the next apply starts over cleanly
    const refinement = store.applyGlobal([createEdit('fresh')], meta)
    assert.equal(store.globalState().entries.fresh.version, 1)
    assert.equal(store.globalState().refinements.length, 1)
    assert.equal(refinement.id, store.globalState().refinements[0].id)
  } finally {
    done()
  }
})

// ── rollback ─────────────────────────────────────────────────────────────────

test('rollback reverse-replays a create as a delete', async () => {
  const { dir, done } = await storeDir()
  try {
    const store = new HarnessStore(dir)
    const created = store.applyGlobal([createEdit('entry-x')], meta)
    const rollback = store.rollbackGlobal(created.id)
    assert.equal(rollback.trigger, 'rollback')
    assert.equal(rollback.rollbackOf, created.id)
    assert.equal(rollback.scope, 'global')
    assert.equal(rollback.edits[0].action, 'delete')
    assert.deepEqual(store.globalState().entries, {})
    assert.deepEqual(store.globalState().refinements.map((refinement) => refinement.id), [created.id, rollback.id])
    assert.ok(!Number.isNaN(Date.parse(rollback.createdAt)))
  } finally {
    done()
  }
})

test('rollback restores the before snapshot of an update', async () => {
  const { dir, done } = await storeDir()
  try {
    const store = new HarnessStore(dir)
    store.applyGlobal([createEdit('entry-x', { title: 't1', content: 'c1' })], meta)
    const updated = store.applyGlobal([{ action: 'update', id: 'entry-x', baseVersion: 1, title: 't2', content: 'c2' }], meta)
    store.rollbackGlobal(updated.id)
    const restored = store.globalState().entries['entry-x']
    assert.equal(restored.title, 't1')
    assert.equal(restored.content, 'c1')
    assert.equal(restored.version, 3)
  } finally {
    done()
  }
})

test('rollback rebuilds a deleted entry from its before snapshot', async () => {
  const { dir, done } = await storeDir()
  try {
    const store = new HarnessStore(dir)
    store.applyGlobal([createEdit('entry-x', { kind: 'worker', route: { provider: 'p' } })], meta)
    const deleted = store.applyGlobal([{ action: 'delete', id: 'entry-x', baseVersion: 1 }], meta)
    store.rollbackGlobal(deleted.id)
    const rebuilt = store.globalState().entries['entry-x']
    assert.equal(rebuilt.kind, 'worker')
    assert.equal(rebuilt.title, 't:entry-x')
    assert.deepEqual(rebuilt.route, { provider: 'p' })
    assert.equal(rebuilt.version, 1)
  } finally {
    done()
  }
})

test('rollback reverses every applied edit of a multi-edit refinement', async () => {
  const { dir, done } = await storeDir()
  try {
    const store = new HarnessStore(dir)
    const created = store.applyGlobal([createEdit('entry-a'), createEdit('entry-b')], meta)
    store.rollbackGlobal(created.id)
    assert.deepEqual(store.globalState().entries, {})
    assert.equal(store.globalState().refinements.length, 2)
  } finally {
    done()
  }
})

test('rollback refuses unknown ids and drifted versions', async () => {
  const { dir, done } = await storeDir()
  try {
    const store = new HarnessStore(dir)
    assert.throws(() => store.rollbackGlobal('ref-nope'), /unknown harness refinement/)
    const created = store.applyGlobal([createEdit('entry-x')], meta)
    store.applyGlobal([{ action: 'update', id: 'entry-x', baseVersion: 1, title: 't2' }], meta)
    // rolling back the create now hits a stale baseVersion: state drifted
    assert.throws(() => store.rollbackGlobal(created.id), /entry changed during refinement planning/)
    const state = store.globalState()
    assert.equal(state.entries['entry-x'].version, 2)
    assert.equal(state.refinements.length, 2)
  } finally {
    done()
  }
})

// ── records ↔ fold round trip ────────────────────────────────────────────────

test('planned records fold back into exactly the planned state', () => {
  const richMeta = { summary: 's', rationale: 'r', expectedOutcome: 'fewer retries' }
  const p1 = planLocalHarness([], [
    createEdit('entry-x'),
    createEdit('worker-1', { kind: 'worker', route: { provider: 'p', model: 'm', maxTokens: 512, effort: 'high' } }),
  ], richMeta)
  assert.equal(p1.record.v, 1)
  assert.equal(p1.record.seq, 0)
  assert.equal(p1.record.refinement, p1.refinement)
  assert.equal(p1.refinement.trigger, 'manual')
  assert.equal(p1.refinement.scope, 'local')
  assert.equal(p1.refinement.expectedOutcome, 'fewer retries')
  assert.equal(p1.refinement.rollbackOf, undefined)
  assert.match(p1.refinement.id, /^ref-\d+-[0-9a-f]{6}$/)
  assert.ok(!Number.isNaN(Date.parse(p1.refinement.createdAt)))

  const e1 = [harnessEvent(2, p1.record)]
  const p2 = planLocalHarness(e1, [{ action: 'update', id: 'entry-x', baseVersion: 1, title: 't2' }], richMeta)
  const e2 = [...e1, harnessEvent(3, p2.record)]
  const p3 = planLocalHarness(e2, [{ action: 'delete', id: 'worker-1', baseVersion: 1 }], richMeta)
  // deliberately shuffled: the fold must replay in seq order regardless
  const shuffled = [harnessEvent(4, p3.record), e1[0], e2[1]]
  const folded = foldLocalHarness(shuffled)
  assert.deepEqual(folded.refinements, [p1.refinement, p2.refinement, p3.refinement])
  assert.deepEqual(folded.entries['entry-x'], p2.refinement.edits[0].after)
  assert.equal(folded.entries['worker-1'], undefined)
  // folding mid-history yields the mid-history state
  assert.deepEqual(foldLocalHarness(e1).entries['worker-1'].route, { provider: 'p', model: 'm', maxTokens: 512, effort: 'high' })
  assert.deepEqual(foldLocalHarness([]), { schema: 1, entries: {}, refinements: [] })
})

test('harnessRecordsOf keeps only well-formed agent-harness metas, ordered by seq', () => {
  const planned = planLocalHarness([], [createEdit('entry-x')], meta)
  const events = [
    { type: 'tool/call', seq: 1, time: 0, data: { callId: 'c1', name: 'agent_harness', arguments: '{}' } },
    { type: 'tool/result', seq: 2, time: 0, data: { message: null, meta: harnessMeta(planned.record) } },
    { type: 'tool/result', seq: 3, time: 0, data: { message: null, meta: { mesh: 'agent-spawn', childId: 'c1' } } },
    { type: 'tool/result', seq: 4, time: 0, data: { message: null, meta: { mesh: 'agent-harness', harness: { v: 2, refinement: planned.refinement } } } },
    { type: 'tool/result', seq: 5, time: 0, data: { message: null, meta: { mesh: 'agent-harness', harness: { v: 1, refinement: { id: 'ref-1' } } } } },
    { type: 'tool/result', seq: 6, time: 0, data: { message: null } },
    { type: 'user/message', seq: 7, time: 0, data: { content: [], source: { kind: 'user' } } },
  ]
  assert.deepEqual(harnessMeta(planned.record), { mesh: 'agent-harness', harness: planned.record })
  const records = harnessRecordsOf(events)
  assert.equal(records.length, 1)
  assert.equal(records[0].seq, 2)
  assert.deepEqual(records[0].refinement, planned.refinement)
  assert.deepEqual(harnessRecordsOf([]), [])
})

// ── overview ─────────────────────────────────────────────────────────────────

test('harnessOverview renders nothing-but-the-guide when both scopes are empty', () => {
  const empty = foldLocalHarness([])
  assert.equal(harnessOverview(empty, empty), 'harness: no entries yet\nfull entries: agent_harness list')
})

test('harnessOverview merges scopes, tags them, and caps each kind at six clipped lines', () => {
  const entries = {}
  for (let i = 0; i < 8; i++) entries[`m-${i}`] = entry({ id: `m-${i}`, scope: 'global', content: 'x'.repeat(500) })
  const local = { schema: 1, entries: { shared: entry({ id: 'shared' }) }, refinements: [] }
  const global = {
    schema: 1,
    entries: {
      ...entries,
      shared: entry({ id: 'shared', scope: 'global' }),
      alpha: entry({ id: 'alpha', scope: 'global' }),
      'w-1': entry({ id: 'w-1', kind: 'worker', scope: 'global', title: 'Coder' }),
    },
    refinements: [],
  }
  const lines = harnessOverview(local, global).split('\n')
  assert.equal(lines.at(-1), 'full entries: agent_harness list')
  assert.equal(lines[0], 'memory (local 1, global 10, showing first 6):')
  const memoryBullets = lines.slice(1, lines.indexOf('worker (local 0, global 1):')).filter((line) => line.startsWith('- '))
  assert.equal(memoryBullets.length, 6)
  assert.deepEqual(memoryBullets.map((bullet) => bullet.replace(/: .*/, '')), [
    '- [global] alpha v1',
    '- [global] m-0 v1',
    '- [global] m-1 v1',
    '- [global] m-2 v1',
    '- [global] m-3 v1',
    '- [global] m-4 v1',
  ])
  for (const bullet of memoryBullets) {
    const body = bullet.slice(bullet.indexOf(': ') + 2)
    assert.ok(body.length <= 180)
    if (bullet.includes(' m-')) assert.ok(body.endsWith('…'))
  }
  assert.ok(lines.includes('worker (local 0, global 1):'))
  assert.ok(lines.includes('- [global] w-1 v1: Coder — c'))
  // prompt kind stays silent with no entries
  assert.ok(!lines.some((line) => line.startsWith('prompt')))
  // id order, local before global on a shared id
  const ordered = harnessOverview(local, { schema: 1, entries: { shared: entry({ id: 'shared', scope: 'global' }), alpha: entry({ id: 'alpha', scope: 'global' }) }, refinements: [] })
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.replace(/: .*/, ''))
  assert.deepEqual(ordered, ['- [global] alpha v1', '- [local] shared v1', '- [global] shared v1'])
})

test('harnessOverview collapses whitespace so every entry stays one line', () => {
  const state = { schema: 1, entries: { 'm-1': entry({ id: 'm-1', title: 'multi\nline', content: 'a\n\nb' }) }, refinements: [] }
  const text = harnessOverview(state, foldLocalHarness([]))
  assert.ok(text.includes('- [local] m-1 v1: multi line — a b'))
  assert.equal(text.split('\n').length, 3)
})
