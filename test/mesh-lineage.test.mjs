/**
 * Unit tests for durable mesh lineage: the roster merge and assignment
 * building blocks (mesh-lineage.ts). Run via `npm test`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assignmentOf, meshRosterRows } from '../lib/mesh-lineage.js'

const root = 'sess-root'
const caller = 'sess-worker-a'
const settled = 'sess-worker-b'

const descendants = [
  { kind: 'child', id: caller, parentId: root, depth: 1, label: 'catalog-a', mode: 'continuable' },
  { kind: 'child', id: settled, parentId: root, depth: 1, label: 'catalog-b', mode: 'continuable' },
  { kind: 'diagnostic', id: 'sess-corrupt', reason: 'corrupt', parentId: root, depth: 1 },
]

const assignments = new Map([
  [caller, { label: 'live-a', effort: 'high', provider: 'p1', model: 'm1', maxTokens: 2048, spawnedBy: root }],
  [settled, undefined],
])

function rows(overrides = {}) {
  return meshRosterRows({
    callerId: caller,
    root,
    descendants,
    assignments,
    liveStatusOf: (id) => (id === caller ? 'idle' : undefined),
    ...overrides,
  })
}

test('meshRosterRows heads the roster with the master row', () => {
  const roster = rows()
  assert.equal(roster.length, 3)
  assert.deepEqual(roster[0], { agentId: root, status: 'settled', master: true, self: false })
})

test('live agents keep their registry status; absent agents report settled', () => {
  const [master, live, gone] = rows()
  assert.equal(master.status, 'settled')
  assert.equal(live.status, 'idle')
  assert.equal(gone.status, 'settled')
  assert.equal(gone.agentId, settled)
})

test('assignment fields override the catalog; catalog label survives without one', () => {
  const [, live, gone] = rows()
  assert.equal(live.label, 'live-a')
  assert.equal(live.parent, root)
  assert.equal(live.effort, 'high')
  assert.equal(live.provider, 'p1')
  assert.equal(live.model, 'm1')
  assert.equal(live.maxTokens, 2048)
  assert.equal(gone.label, 'catalog-b')
  assert.equal(gone.parent, root)
  assert.equal(gone.effort, undefined)
})

test('self marks the calling agent; diagnostics never surface', () => {
  const roster = rows()
  assert.deepEqual(roster.map((row) => row.self), [false, true, false])
  assert.equal(roster.some((row) => row.agentId === 'sess-corrupt'), false)
})

test('an empty degraded catalog still serves the master row', () => {
  const roster = rows({ descendants: [] })
  assert.deepEqual(roster, [{ agentId: root, status: 'settled', master: true, self: false }])
})

test('assignmentOf carries every spawn-record field onto the spawner', () => {
  assert.deepEqual(
    assignmentOf({ label: 'w', provider: 'p', model: 'm', maxTokens: 512, effort: 'max', seq: 7 }, root),
    { label: 'w', provider: 'p', model: 'm', maxTokens: 512, effort: 'max', spawnedBy: root },
  )
  assert.deepEqual(assignmentOf({ seq: 1 }, 'spawner'), { spawnedBy: 'spawner' })
})
