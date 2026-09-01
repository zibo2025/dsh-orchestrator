/**
 * Unit tests for the `agent_schedule` engine: MeshScheduler chained timers
 * (real timers, minEveryMs lowered to 10ms, 20–60ms windows, fake counting
 * deliver) plus the shared frameMeshMessage wire format. Every assertion
 * sleeps well past its window before checking, so timings stay race-free.
 * Run via `npm test`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { MeshScheduler, firstFireAtMs } from '../lib/schedule.js'
import { frameMeshMessage, MESH_MESSAGE_PREFIX } from '../lib/mesh-frame.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Counting fake deliver: records every payload; resultFor(nth) picks the outcome. */
function makeDeliver() {
  const state = {
    calls: [],
    resultFor: () => ({ delivered: true }),
  }
  return {
    state,
    deliver: (payload) => {
      state.calls.push(payload)
      return state.resultFor(state.calls.length)
    },
  }
}

/** A scheduler under test: lowered minEveryMs so 20–60ms windows are legal. */
function makeScheduler(deliver) {
  return new MeshScheduler({ deliver, minEveryMs: 10 })
}

test('schedule() validates its spec before arming anything', async (t) => {
  const { state, deliver } = makeDeliver()
  const scheduler = makeScheduler(deliver)
  const base = { senderId: 'sender-1', agentId: 'agent-1', message: 'wake up' }

  await t.test('senderId / agentId / message are required', () => {
    assert.throws(() => scheduler.schedule({ ...base, senderId: undefined }), /senderId/)
    assert.throws(() => scheduler.schedule({ ...base, agentId: '' }), /agentId/)
    assert.throws(() => scheduler.schedule({ ...base, message: undefined }), /message/)
  })
  await t.test('exactly one of delayMs / atMs / everyMs must be provided', () => {
    assert.throws(() => scheduler.schedule({ ...base }), /exactly one/)
    assert.throws(() => scheduler.schedule({ ...base, delayMs: 30, atMs: Date.now() + 30 }), /exactly one/)
    assert.throws(() => scheduler.schedule({ ...base, delayMs: 30, everyMs: 30 }), /exactly one/)
    assert.throws(() => scheduler.schedule({ ...base, delayMs: 30, atMs: Date.now() + 30, everyMs: 30 }), /exactly one/)
  })
  await t.test('delayMs / atMs must point at the future', () => {
    assert.throws(() => scheduler.schedule({ ...base, delayMs: 0 }), /future/)
    assert.throws(() => scheduler.schedule({ ...base, delayMs: -5 }), /future/)
    assert.throws(() => scheduler.schedule({ ...base, atMs: Date.now() - 1000 }), /future/)
    assert.throws(() => scheduler.schedule({ ...base, atMs: Date.now() }), /future/)
  })
  await t.test('everyMs must reach minEveryMs (default 1000)', () => {
    assert.throws(() => new MeshScheduler({ deliver }).schedule({ ...base, everyMs: 999 }), /everyMs/)
    assert.throws(() => scheduler.schedule({ ...base, everyMs: 9 }), /everyMs/)
    const row = scheduler.schedule({ ...base, everyMs: 10 }) // the boundary itself is legal
    assert.equal(row.everyMs, 10)
    scheduler.cancel(row.id)
  })
  scheduler.dispose()
  assert.equal(state.calls.length, 0, 'a rejected spec never delivers')
})

test('one-shot schedules fire once, then rest until cancelled', async (t) => {
  await t.test('delayMs delivers once and never again', async () => {
    const { state, deliver } = makeDeliver()
    const scheduler = makeScheduler(deliver)
    const spec = { label: 'waker', senderId: 's1', agentId: 'a1', message: 'tick', delayMs: 25 }
    const t0 = Date.now()
    const row = scheduler.schedule(spec)
    assert.equal(row.firedCount, 0)
    assert.ok(row.nextFireAt > t0, 'armed for the future')
    await sleep(90)
    assert.equal(state.calls.length, 1)
    assert.equal(state.calls[0].scheduleId, row.id)
    assert.equal(state.calls[0].spec, spec)
    assert.deepEqual(scheduler.list(), [{
      id: row.id,
      label: 'waker',
      senderId: 's1',
      agentId: 'a1',
      message: 'tick',
      firedCount: 1,
      skippedCount: 0,
    }])
    await sleep(70)
    assert.equal(state.calls.length, 1, 'a one-shot does not fire twice')
    assert.equal(scheduler.cancel(row.id), true)
    assert.equal(scheduler.cancel(row.id), false)
    assert.deepEqual(scheduler.list(), [])
    scheduler.dispose()
  })

  await t.test('atMs delivers once at the appointed epoch', async () => {
    const { state, deliver } = makeDeliver()
    const scheduler = makeScheduler(deliver)
    const at = Date.now() + 30
    const row = scheduler.schedule({ senderId: 's2', agentId: 'a2', message: 'once', atMs: at })
    assert.equal(row.nextFireAt, at)
    await sleep(95)
    assert.equal(state.calls.length, 1)
    assert.equal(scheduler.list()[0].firedCount, 1)
    scheduler.dispose()
  })

  await t.test('an offline one-shot skips, records why, and stays listed', async () => {
    const { state, deliver } = makeDeliver()
    state.resultFor = () => ({ delivered: false })
    const scheduler = makeScheduler(deliver)
    const row = scheduler.schedule({ senderId: 's3', agentId: 'ghost', message: 'ping', delayMs: 20 })
    await sleep(70)
    assert.equal(state.calls.length, 1)
    const [resting] = scheduler.list()
    assert.equal(resting.id, row.id)
    assert.equal(resting.firedCount, 0)
    assert.equal(resting.skippedCount, 1)
    assert.equal(resting.lastError, 'target offline')
    assert.equal(resting.nextFireAt, undefined)
    await sleep(60)
    assert.equal(state.calls.length, 1, 'a skipped one-shot does not retry')
    assert.equal(scheduler.cancel(row.id), true)
    scheduler.dispose()
  })
})

test('repeating schedules chain their ticks until cancelled', async (t) => {
  await t.test('everyMs keeps firing and stays armed', async () => {
    const { state, deliver } = makeDeliver()
    const scheduler = makeScheduler(deliver)
    const row = scheduler.schedule({ senderId: 's', agentId: 'a', message: 'beat', everyMs: 20 })
    assert.equal(row.everyMs, 20)
    assert.ok(row.nextFireAt > Date.now())
    await sleep(130)
    const [live] = scheduler.list()
    assert.ok(live.firedCount >= 3, `expected >= 3 fires, saw ${live.firedCount}`)
    assert.ok(live.firedCount <= 6, `expected <= 6 fires, saw ${live.firedCount}`)
    assert.equal(live.skippedCount, 0)
    assert.ok(live.nextFireAt > Date.now(), 'the chain re-arms after every delivery')
    assert.equal(scheduler.cancel(row.id), true)
    const atCancel = state.calls.length
    await sleep(80)
    assert.equal(state.calls.length, atCancel, 'a cancelled repeat delivers nothing further')
    scheduler.dispose()
  })

  await t.test('cancel before the first fire prevents every delivery', async () => {
    const { state, deliver } = makeDeliver()
    const scheduler = makeScheduler(deliver)
    const row = scheduler.schedule({ senderId: 's', agentId: 'a', message: 'never', everyMs: 20 })
    assert.equal(scheduler.cancel(row.id), true)
    await sleep(70)
    assert.equal(state.calls.length, 0)
    scheduler.dispose()
  })
})

test('an offline target skips ticks but the chain runs on', async () => {
  const { state, deliver } = makeDeliver()
  const scheduler = makeScheduler(deliver)
  scheduler.schedule({ senderId: 's', agentId: 'ghost', message: 'anyone?', everyMs: 20 })
  state.resultFor = () => ({ delivered: false, error: 'mesh says no' })
  await sleep(75)
  const [skipping] = scheduler.list()
  assert.ok(skipping.skippedCount >= 2, `expected >= 2 skips, saw ${skipping.skippedCount}`)
  assert.equal(skipping.firedCount, 0)
  assert.equal(skipping.lastError, 'mesh says no')
  assert.ok(skipping.nextFireAt > Date.now(), 'a skipped tick re-arms')
  state.resultFor = () => ({ delivered: true }) // the target comes back online
  await sleep(70)
  const [recovered] = scheduler.list()
  assert.ok(recovered.firedCount >= 1, 'the chain kept running and delivers again')
  assert.equal(recovered.lastError, undefined, 'a successful delivery clears the error')
  scheduler.dispose()
})

test('dispose() retires every schedule and leaves no live timer', async () => {
  const { state, deliver } = makeDeliver()
  const scheduler = makeScheduler(deliver)
  const one = scheduler.schedule({ senderId: 's', agentId: 'a', message: 'one', delayMs: 20 })
  scheduler.schedule({ senderId: 's', agentId: 'a', message: 'two', everyMs: 20 })
  await sleep(55)
  const fires = state.calls.length
  assert.ok(fires >= 2, `expected both schedules to tick, saw ${fires}`)
  scheduler.dispose()
  assert.deepEqual(scheduler.list().map((row) => row.nextFireAt), [undefined, undefined], 'no pending fire remains')
  await sleep(120)
  assert.equal(state.calls.length, fires, 'nothing delivers after dispose')
  assert.throws(() => scheduler.schedule({ senderId: 's', agentId: 'a', message: 'late', delayMs: 50 }), /disposed/)
  scheduler.dispose() // idempotent
  scheduler.cancel(one.id) // harmless on a disposed scheduler
})

test('list() reports shallow-copied rows in filing order', async (t) => {
  const { deliver } = makeDeliver()
  const scheduler = makeScheduler(deliver)
  const t0 = Date.now()
  const one = scheduler.schedule({ label: 'ticker', senderId: 'master', agentId: 'worker-7', message: 'status?', delayMs: 60 })
  const two = scheduler.schedule({ senderId: 'master', agentId: 'worker-8', message: 'heartbeat', everyMs: 50 })

  await t.test('rows mirror the filed specs', () => {
    assert.match(one.id, /^sch-[0-9a-z]+$/)
    assert.match(two.id, /^sch-[0-9a-z]+$/)
    assert.notEqual(one.id, two.id)
    assert.deepEqual(scheduler.list(), [
      { id: one.id, label: 'ticker', senderId: 'master', agentId: 'worker-7', message: 'status?', nextFireAt: one.nextFireAt, firedCount: 0, skippedCount: 0 },
      { id: two.id, senderId: 'master', agentId: 'worker-8', message: 'heartbeat', everyMs: 50, nextFireAt: two.nextFireAt, firedCount: 0, skippedCount: 0 },
    ])
    assert.ok(one.nextFireAt >= t0 + 59 && one.nextFireAt <= Date.now() + 61, 'one-shot first fire ≈ now + delayMs')
    assert.ok(two.nextFireAt >= t0 + 49 && two.nextFireAt <= Date.now() + 51, 'repeat first fire ≈ now + everyMs')
  })
  await t.test('mutating a returned row cannot touch the scheduler', () => {
    const rows = scheduler.list()
    rows[0].firedCount = 999
    delete rows[1].everyMs
    assert.equal(scheduler.list()[0].firedCount, 0)
    assert.equal(scheduler.list()[1].everyMs, 50)
  })
  scheduler.dispose()
})

test('frameMeshMessage matches the delivered-message frame format', () => {
  assert.equal(MESH_MESSAGE_PREFIX, '[orchestrator-mesh] message from agent ')
  assert.equal(frameMeshMessage('agent-1', 'researcher', 'hi there'), `${MESH_MESSAGE_PREFIX}agent-1 ("researcher"): hi there`)
  assert.equal(frameMeshMessage('agent-1', undefined, 'hi there'), `${MESH_MESSAGE_PREFIX}agent-1: hi there`)
  assert.equal(frameMeshMessage('agent-1', '', 'hi there'), `${MESH_MESSAGE_PREFIX}agent-1: hi there`, 'an empty label is omitted, like frame()')
  assert.equal(frameMeshMessage('session-x', 'schedule', 'wake up'), '[orchestrator-mesh] message from agent session-x ("schedule"): wake up')
})

test('firstFireAtMs computes first fire times purely', () => {
  assert.equal(firstFireAtMs({ atMs: 2000 }, 1000), 2000)
  assert.equal(firstFireAtMs({ delayMs: 100 }, 1000), 1100)
  assert.equal(firstFireAtMs({ everyMs: 50 }, 1000), 1050)
})
