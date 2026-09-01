/**
 * Unit tests for durable agent_spawn records: the presentation-meta writer and
 * the batch fold that feeds host-side lineage recovery. Run via `npm test`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { meshSpawnMeta, meshSpawnRecordsOf } from '../lib/spawn-meta.js'

test('meshSpawnMeta stays total on malformed pairs and degrades to a rejected sentinel', () => {
  const good = meshSpawnMeta({ label: 'w', provider: 'p', model: 'm', maxTokens: 512, effort: 'high' }, { childId: 'c1' })
  assert.deepEqual(good, { mesh: 'agent-spawn', childId: 'c1', label: 'w', provider: 'p', model: 'm', maxTokens: 512, effort: 'high' })
  const bad = meshSpawnMeta(undefined, {})
  assert.equal(bad.childId, '')
  const emptyArgs = meshSpawnMeta({}, { childId: 'c2' })
  assert.deepEqual(emptyArgs, { mesh: 'agent-spawn', childId: 'c2' })
})

test('meshSpawnRecordsOf folds tool/result metas and skips everything else', () => {
  const events = [
    { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
    { type: 'tool/result', seq: 2, time: 0, data: { message: null, meta: { mesh: 'agent-spawn', childId: 'c1', label: 'w1' } } },
    { type: 'tool/result', seq: 3, time: 0, data: { message: null, meta: { mesh: 'other', childId: 'x' } } },
    { type: 'tool/result', seq: 4, time: 0, data: { message: null, meta: { mesh: 'agent-spawn', childId: '', label: 'rejected' } } },
    { type: 'user/message', seq: 5, time: 0, data: { content: [], source: { kind: 'user' } } },
  ]
  assert.deepEqual([...meshSpawnRecordsOf(events).entries()], [['c1', { label: 'w1', seq: 2 }]])
  assert.equal(meshSpawnRecordsOf([]).size, 0)
})

test('meshSpawnRecordsOf lets a later record for the same child win', () => {
  const events = [
    { type: 'tool/result', seq: 2, time: 0, data: { message: null, meta: { mesh: 'agent-spawn', childId: 'c1', label: 'first' } } },
    { type: 'tool/result', seq: 6, time: 0, data: { message: null, meta: { mesh: 'agent-spawn', childId: 'c1', label: 'second' } } },
  ]
  assert.deepEqual([...meshSpawnRecordsOf(events).entries()], [['c1', { label: 'second', seq: 6 }]])
})

test('meshSpawnRecordsOf keeps the full spawn route for recovery', () => {
  const events = [
    { type: 'tool/result', seq: 9, time: 0, data: { message: null, meta: meshSpawnMeta({ label: 'w', provider: 'p', model: 'm', maxTokens: 1024, effort: 'max' }, { childId: 'c9' }) } },
  ]
  assert.deepEqual([...meshSpawnRecordsOf(events).entries()], [
    ['c9', { label: 'w', provider: 'p', model: 'm', maxTokens: 1024, effort: 'max', seq: 9 }],
  ])
})
