/**
 * Browser-safe harness folding. The host's `harness-records.ts` narrowing and
 * batch-fold are pure, so this module value-imports them (inlined into the
 * client bundle; their only imports are type-only and erased by the packer)
 * and re-implements the ~15-line state replay `harness.ts` keeps next to its
 * node:fs store — that file is host-only and must never enter the bundle.
 * The same treatment covers `spawn-meta.ts`: its batch fold rebuilds the
 * workers this session spawned, straight out of agent_spawn tool/result meta.
 *
 * Event-window types are re-declared locally (structural, untrusted-JSON
 * posture): the wire entries reach the browser exactly as the session
 * controller's journal snapshot shaped them, and everything crossing this
 * boundary is narrowed again by harness-records/spawn-meta before it touches
 * domain types.
 */
import { harnessRecordsOf, narrowHarnessState } from '../harness-records.ts'
import { meshSpawnRecordsOf } from '../spawn-meta.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { HarnessState } from '../harness.ts'
import type { MeshSpawnRecord } from '../spawn-meta.ts'

/** One wire-shaped session event (fields read structurally, never trusted). */
export interface WireSessionEvent {
  readonly seq: number
  readonly type: string
  readonly data?: unknown
}

/** One event-window entry retaining its coarse transport discriminator. */
export interface EventWindowEntry {
  readonly type: 'event' | 'chunks' | string
  readonly event: unknown
}

/** Snapshot of the contiguous event window held by a session binding. */
export interface EventWindowSnapshot {
  readonly entries: readonly EventWindowEntry[]
  readonly hasMore: boolean
}

/** Observable event-window source exposed by one session binding. */
export interface EventWindowSource {
  getSnapshot(): EventWindowSnapshot
  subscribe(listener: () => void): () => void
}

/** The window shown before a session binding resolves (stable reference). */
export const EMPTY_EVENT_WINDOW: EventWindowSnapshot = { entries: [], hasMore: false }

/** Keep only the `'event'` entries, cast once to the wire event shape. */
function wireEventsOf(window: EventWindowSnapshot): readonly SessionEvent[] {
  return window.entries
    .filter((entry): entry is { readonly type: 'event'; readonly event: unknown } => entry.type === 'event')
    .map(entry => entry.event) as unknown as readonly SessionEvent[]
}

/**
 * Fold the session-local harness state out of the browser event window:
 * keep the `'event'` entries, batch-fold every agent_harness record
 * (seq-ordered by harnessRecordsOf), and replay each refinement's applied
 * edits in order — the exact foldLocalHarness algorithm, minus the host
 * module. `chunks` entries only pack assistant chunk deltas and never carry
 * tool/result meta, so dropping them loses nothing.
 * @param window - the session's current event window snapshot.
 * @returns the folded local harness state (empty when no records exist).
 */
export function localHarnessStateOf(window: EventWindowSnapshot): HarnessState {
  const state: HarnessState = { schema: 1, entries: {}, refinements: [] }
  for (const record of harnessRecordsOf(wireEventsOf(window))) {
    for (const edit of record.refinement.edits) {
      if (!edit.applied) continue
      if (edit.action === 'delete') delete state.entries[edit.id]
      else if (edit.after !== undefined) state.entries[edit.id] = edit.after
    }
    state.refinements.push(record.refinement)
  }
  return state
}

/** One worker this session spawned, display-ready. */
export interface MeshMember {
  readonly childId: string
  readonly label?: string
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
  readonly effort?: string
  /** Seq of the latest agent_spawn tool/result for this child. */
  readonly seq: number
}

/**
 * Fold the mesh members out of the browser event window: meshSpawnRecordsOf
 * keeps only successful agent_spawn results (its `mesh: 'agent-spawn'` +
 * non-empty childId marker), dedupes by childId with the latest record
 * winning, and this wrapper surfaces spawn order (ascending seq).
 * @param window - the session's current event window snapshot.
 * @returns the spawned workers in spawn order (empty before the first spawn).
 */
export function meshMembersOf(window: EventWindowSnapshot): readonly MeshMember[] {
  const records: [string, MeshSpawnRecord][] = [...meshSpawnRecordsOf(wireEventsOf(window))]
  return records
    .sort(([, left], [, right]) => left.seq - right.seq)
    .map(([childId, record]) => ({
      childId,
      ...(record.label !== undefined ? { label: record.label } : {}),
      ...(record.provider !== undefined ? { provider: record.provider } : {}),
      ...(record.model !== undefined ? { model: record.model } : {}),
      ...(record.maxTokens !== undefined ? { maxTokens: record.maxTokens } : {}),
      ...(record.effort !== undefined ? { effort: record.effort } : {}),
      seq: record.seq,
    }))
}

/**
 * Narrow the fetched global harness state JSON (the host route serves
 * HarnessStore.globalState()). Fail-stop like the store itself: a malformed
 * payload degrades to undefined so the panel shows its fallback notice.
 * @param json - parsed response body.
 * @returns the validated state, or undefined when the shape is untrustworthy.
 */
export function globalHarnessStateOf(json: unknown): HarnessState | undefined {
  return narrowHarnessState(json)
}
