/**
 * Timed wake-up messages for mesh agents — the engine behind the
 * `agent_schedule` tool. A schedule is one-shot (`delayMs` / `atMs`) or
 * repeating (`everyMs`), and delivery rides the injected `deliver` callback
 * (the same path agent_send takes). In-process only: cross-restart
 * persistence belongs to the host layer.
 *
 * Scheduling follows the prime-agent chained-timer semantics: each schedule
 * holds at most one pending timeout, and the next tick is armed only after
 * the current delivery has settled. Missed ticks therefore coalesce instead
 * of piling up; a target that is not online skips that tick while the chain
 * runs on (the interval slides forward — no catch-up burst); cancel and
 * dispose never leave a timer behind. Every timeout is `unref()`ed, so no
 * schedule can keep the process alive on its own.
 */
import { randomBytes } from 'node:crypto'

/** The schedule a caller files: one wake-up message and exactly one trigger. */
export interface MeshScheduleSpec {
  /** Display label of the sender, framed into the delivered message. */
  label?: string
  /** The agent the schedule's message appears to come from. */
  senderId: string
  /** The mesh agent the wake-up message is delivered to. */
  agentId: string
  /** The message text delivered on every tick. */
  message: string
  /** One-shot: fire once, this many milliseconds from now. */
  delayMs?: number
  /** One-shot: fire once at this epoch-millisecond timestamp. */
  atMs?: number
  /** Repeating: fire every this many milliseconds, starting one interval from now. */
  everyMs?: number
}

/** A schedule as `list()` reports it. `nextFireAt` is epoch milliseconds. */
export interface MeshScheduleRow {
  id: string
  label?: string
  senderId: string
  agentId: string
  message: string
  everyMs?: number
  nextFireAt?: number
  firedCount: number
  skippedCount: number
  lastError?: string
}

/** Constructor options: the delivery sink plus test seams (clock, interval floor). */
export interface MeshSchedulerOptions {
  /**
   * Attempt one delivery. `delivered: false` skips this tick; `error` names
   * the reason (surfaced as the row's lastError).
   */
  deliver: (spec: { scheduleId: string; spec: MeshScheduleSpec }) => { delivered: boolean; error?: string }
  /** Lower bound for `everyMs`; defaults to 1000. */
  minEveryMs?: number
  /** Clock override for tests; defaults to Date.now. */
  now?: () => number
}

/** The default lower bound on a repeating schedule's interval. */
const DEFAULT_MIN_EVERY_MS = 1000

/** setTimeout delays are signed 32-bit: arm at most this far ahead, then re-check. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

/** The trigger fields whose exactly-one presence selects the schedule kind. */
const TRIGGER_FIELDS = ['delayMs', 'atMs', 'everyMs'] as const

/** Base36 alphabet for schedule ids. */
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Random schedule id: `sch-` + base36 noise. */
function freshScheduleId(): string {
  let id = ''
  for (const byte of randomBytes(12)) id += BASE36[byte % 36]
  return `sch-${id}`
}

/**
 * Pure computation of a schedule's first fire time (epoch ms). Exactly one
 * trigger field must be set — `MeshScheduler.schedule` enforces that before
 * calling, so the fallback branch is unreachable through it.
 */
export function firstFireAtMs(trigger: { delayMs?: number; atMs?: number; everyMs?: number }, nowMs: number): number {
  if (trigger.atMs !== undefined) return trigger.atMs
  if (trigger.delayMs !== undefined) return nowMs + trigger.delayMs
  return nowMs + trigger.everyMs!
}

/** Internal live state of one filed schedule. */
interface MeshScheduleEntry {
  readonly id: string
  readonly spec: MeshScheduleSpec
  nextFireAt: number | undefined
  firedCount: number
  skippedCount: number
  lastError: string | undefined
  timer: ReturnType<typeof setTimeout> | null
}

/** Project an entry to its reportable row, omitting absent optional fields. */
function rowOf(entry: MeshScheduleEntry): MeshScheduleRow {
  const row: MeshScheduleRow = {
    id: entry.id,
    senderId: entry.spec.senderId,
    agentId: entry.spec.agentId,
    message: entry.spec.message,
    firedCount: entry.firedCount,
    skippedCount: entry.skippedCount,
  }
  if (entry.spec.label !== undefined) row.label = entry.spec.label
  if (entry.spec.everyMs !== undefined) row.everyMs = entry.spec.everyMs
  if (entry.nextFireAt !== undefined) row.nextFireAt = entry.nextFireAt
  if (entry.lastError !== undefined) row.lastError = entry.lastError
  return row
}

/** Chained-timer scheduler for mesh wake-up messages. */
export class MeshScheduler {
  private readonly deliver: MeshSchedulerOptions['deliver']
  private readonly minEveryMs: number
  private readonly now: () => number
  private readonly entries = new Map<string, MeshScheduleEntry>()
  private disposed = false

  constructor(options: MeshSchedulerOptions) {
    if (typeof options?.deliver !== 'function') {
      throw new Error('MeshScheduler requires a deliver function')
    }
    this.deliver = options.deliver
    this.minEveryMs = options.minEveryMs ?? DEFAULT_MIN_EVERY_MS
    this.now = options.now ?? Date.now
  }

  /**
   * File a schedule: validate the spec, arm the first tick, and return the
   * row as `list()` would report it. Throws without arming anything when the
   * spec is malformed. After `dispose()` this always throws.
   */
  schedule(spec: MeshScheduleSpec): MeshScheduleRow {
    if (this.disposed) throw new Error('MeshScheduler.schedule: this scheduler is disposed')
    if (spec === null || typeof spec !== 'object') {
      throw new Error('MeshScheduler.schedule: spec must be an object')
    }
    for (const field of ['senderId', 'agentId', 'message'] as const) {
      if (typeof spec[field] !== 'string' || spec[field] === '') {
        throw new Error(`MeshScheduler.schedule: ${field} is required`)
      }
    }
    const triggers = TRIGGER_FIELDS.filter((field) => spec[field] !== undefined)
    if (triggers.length !== 1) {
      throw new Error(
        `MeshScheduler.schedule: exactly one of delayMs, atMs, everyMs is required `
        + `(got ${triggers.length === 0 ? 'none' : triggers.join(' + ')})`,
      )
    }
    for (const field of triggers) {
      if (!Number.isFinite(spec[field])) {
        throw new Error(`MeshScheduler.schedule: ${field} must be a finite number`)
      }
    }
    const nowMs = this.now()
    if (spec.everyMs !== undefined && spec.everyMs < this.minEveryMs) {
      throw new Error(`MeshScheduler.schedule: everyMs must be >= ${this.minEveryMs}`)
    }
    if (spec.delayMs !== undefined && spec.delayMs <= 0) {
      throw new Error('MeshScheduler.schedule: delayMs must be a positive number of milliseconds (a future moment)')
    }
    if (spec.atMs !== undefined && spec.atMs <= nowMs) {
      throw new Error('MeshScheduler.schedule: atMs must be a future timestamp (epoch ms)')
    }
    let id = freshScheduleId()
    while (this.entries.has(id)) id = freshScheduleId()
    const entry: MeshScheduleEntry = {
      id,
      spec,
      nextFireAt: firstFireAtMs(spec, nowMs),
      firedCount: 0,
      skippedCount: 0,
      lastError: undefined,
      timer: null,
    }
    this.entries.set(id, entry)
    this.arm(entry)
    return rowOf(entry)
  }

  /** Remove a schedule and clear its pending timer; false for unknown ids. */
  cancel(id: string): boolean {
    const entry = this.entries.get(id)
    if (entry === undefined) return false
    this.entries.delete(id)
    this.clearTimer(entry)
    entry.nextFireAt = undefined
    return true
  }

  /** Shallow-copied rows of every filed schedule, in filing order. */
  list(): MeshScheduleRow[] {
    return [...this.entries.values()].map(rowOf)
  }

  /**
   * Clear every timer. Filed rows stay readable via `list()` (with
   * `nextFireAt` cleared) but nothing ever fires again; `schedule()` from now
   * on throws. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries.values()) {
      this.clearTimer(entry)
      entry.nextFireAt = undefined
    }
  }

  /** Arm the single pending timeout for an entry (no-op when cancelled/disposed). */
  private arm(entry: MeshScheduleEntry): void {
    if (this.disposed || entry.nextFireAt === undefined || !this.entries.has(entry.id)) return
    const wait = Math.min(Math.max(entry.nextFireAt - this.now(), 0), MAX_TIMEOUT_MS)
    const timer = setTimeout(() => this.fire(entry), wait)
    timer.unref()
    entry.timer = timer
  }

  /** One tick: deliver, count, then either rest (one-shot) or re-arm (repeat). */
  private fire(entry: MeshScheduleEntry): void {
    entry.timer = null
    if (this.disposed || !this.entries.has(entry.id)) return
    if (entry.nextFireAt === undefined) return
    // A wait beyond MAX_TIMEOUT_MS is chunked: a capped timeout waking early
    // re-arms until the appointed moment arrives.
    if (this.now() < entry.nextFireAt) {
      this.arm(entry)
      return
    }
    let outcome: { delivered: boolean; error?: string }
    try {
      outcome = this.deliver({ scheduleId: entry.id, spec: entry.spec })
    } catch (error) {
      outcome = { delivered: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (outcome.delivered) {
      entry.firedCount += 1
      entry.lastError = undefined
    } else {
      entry.skippedCount += 1
      entry.lastError = typeof outcome.error === 'string' && outcome.error !== '' ? outcome.error : 'target offline'
    }
    if (entry.spec.everyMs === undefined) {
      // One-shot done — delivered or skipped, the row rests until cancel().
      entry.nextFireAt = undefined
      return
    }
    if (this.disposed || !this.entries.has(entry.id)) return // cancelled/disposed during delivery
    entry.nextFireAt = this.now() + entry.spec.everyMs
    this.arm(entry)
  }

  private clearTimer(entry: MeshScheduleEntry): void {
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
  }
}
