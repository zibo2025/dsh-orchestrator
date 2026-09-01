/**
 * Durable agent_harness records: the presentation meta the `agent_harness`
 * tool stamps onto its tool results, and the batch fold that reads those
 * records back out of a session log — the exact replay pattern spawn-meta
 * established for agent_spawn. Everything here consumes and produces
 * persisted facts: a session-local harness refinement planned by
 * planLocalHarness survives host restarts and log replay because its whole
 * effect travels in the tool/result meta, folded back into state without
 * rerunning any validation.
 *
 * This module also owns the defensive narrowing vocabulary every harness
 * reader shares (routes, entries, applied edits, refinements, whole states),
 * because untrusted JSON — session events, the global state file — must
 * never reach the domain types unchecked, and a malformed shape must degrade
 * (fold skips it, store falls back to empty) rather than throw.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AppliedHarnessEdit, HarnessEntry, HarnessRefinement, HarnessRoute, HarnessState } from './harness.ts'

/** Meta discriminator agent_harness's presentationMeta stamps onto tool results. */
const HARNESS_META_MESH = 'agent-harness'

/** Non-empty string, or absent — the only strings persisted harness data carries. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function harnessKindOf(value: unknown): HarnessEntry['kind'] | undefined {
  return value === 'memory' || value === 'worker' || value === 'prompt' ? value : undefined
}

function harnessScopeOf(value: unknown): HarnessEntry['scope'] | undefined {
  return value === 'local' || value === 'global' ? value : undefined
}

function harnessActionOf(value: unknown): AppliedHarnessEdit['action'] | undefined {
  return value === 'create' || value === 'update' || value === 'delete' ? value : undefined
}

function harnessTriggerOf(value: unknown): HarnessRefinement['trigger'] | undefined {
  return value === 'manual' || value === 'rollback' ? value : undefined
}

/**
 * One replayed harness refinement plus the seq of the `tool/result` event it
 * was folded from. A type alias (not interface) so it structurally satisfies
 * JsonValue's index signature — the record rides inside presentationMeta.
 */
export type HarnessRecord = {
  /** Replay-payload format version; readers reject any other value. */
  v: 1
  /**
   * Seq of the source `tool/result` event. The planner stamps 0 (no durable
   * event exists yet); harnessRecordsOf re-stamps the real seq on fold.
   */
  seq: number
  /** The applied refinement, whose `edits` carry before/after snapshots. */
  refinement: HarnessRefinement
}

/** The presentation meta one completed agent_harness call stamps onto its tool/result. */
export type HarnessMeta = {
  mesh: typeof HARNESS_META_MESH
  harness: HarnessRecord
}

/**
 * Build the durable meta for one completed agent_harness call. Called by the
 * tool's `presentationMeta` with the record planLocalHarness returned — the
 * trusted planned value — so it is total by construction and never throws.
 */
export function harnessMeta(record: HarnessRecord): HarnessMeta {
  return { mesh: HARNESS_META_MESH, harness: record }
}

/** Narrow one route shape down to its persistable fields, dropping anything else. */
function narrowRoute(value: unknown): HarnessRoute | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const route: HarnessRoute = {}
  const provider = str(raw.provider)
  if (provider !== undefined) route.provider = provider
  const model = str(raw.model)
  if (model !== undefined) route.model = model
  if (typeof raw.maxTokens === 'number' && Number.isFinite(raw.maxTokens)) route.maxTokens = raw.maxTokens
  const effort = str(raw.effort)
  if (effort !== undefined) route.effort = effort
  return Object.keys(route).length > 0 ? route : undefined
}

/**
 * Narrow one harness entry out of untrusted JSON. Total: any malformed field
 * yields undefined so callers degrade instead of throwing.
 */
export function narrowHarnessEntry(value: unknown): HarnessEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = str(raw.id)
  const title = str(raw.title)
  const content = str(raw.content)
  const createdAt = str(raw.createdAt)
  const updatedAt = str(raw.updatedAt)
  const kind = harnessKindOf(raw.kind)
  const scope = harnessScopeOf(raw.scope)
  if (id === undefined || kind === undefined || title === undefined || content === undefined || scope === undefined
    || createdAt === undefined || updatedAt === undefined) return undefined
  if (typeof raw.version !== 'number' || !Number.isFinite(raw.version) || raw.version < 1) return undefined
  const route = narrowRoute(raw.route)
  const entry: HarnessEntry = {
    id,
    kind,
    title,
    content,
    scope,
    ...(route !== undefined ? { route } : {}),
    createdAt,
    updatedAt,
    version: raw.version,
  }
  return entry
}

/** Narrow one applied edit; a missing id is kept (failed edits may carry none), anything malformed is dropped. */
function narrowAppliedEdit(value: unknown): AppliedHarnessEdit | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const action = harnessActionOf(raw.action)
  if (action === undefined || typeof raw.id !== 'string' || typeof raw.applied !== 'boolean') return undefined
  const error = str(raw.error)
  const before = narrowHarnessEntry(raw.before)
  const after = narrowHarnessEntry(raw.after)
  const edit: AppliedHarnessEdit = {
    action,
    id: raw.id,
    applied: raw.applied,
    ...(error !== undefined ? { error } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  }
  return edit
}

/**
 * Narrow one refinement out of untrusted JSON. All-or-nothing over its
 * edits: a refinement with any malformed edit is dropped whole, because a
 * partial replay would silently corrupt folded state.
 */
export function narrowHarnessRefinement(value: unknown): HarnessRefinement | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = str(raw.id)
  const summary = str(raw.summary)
  const rationale = str(raw.rationale)
  const createdAt = str(raw.createdAt)
  const trigger = harnessTriggerOf(raw.trigger)
  const scope = harnessScopeOf(raw.scope)
  if (id === undefined || trigger === undefined || summary === undefined || rationale === undefined
    || scope === undefined || createdAt === undefined) return undefined
  if (!Array.isArray(raw.edits)) return undefined
  const edits: AppliedHarnessEdit[] = []
  for (const candidate of raw.edits) {
    const edit = narrowAppliedEdit(candidate)
    if (edit === undefined) return undefined
    edits.push(edit)
  }
  const expectedOutcome = str(raw.expectedOutcome)
  const rollbackOf = str(raw.rollbackOf)
  const refinement: HarnessRefinement = {
    id,
    trigger,
    summary,
    rationale,
    ...(expectedOutcome !== undefined ? { expectedOutcome } : {}),
    scope,
    edits,
    ...(rollbackOf !== undefined ? { rollbackOf } : {}),
    createdAt,
  }
  return refinement
}

/**
 * Narrow a whole harness state out of untrusted JSON (the global
 * harness_state.json). Fail-stop: any malformed entry, key mismatch, or
 * refinement degrades the WHOLE state to nothing, because a partially
 * trusted store is worse than an empty one — the caller can always re-apply.
 */
export function narrowHarnessState(value: unknown): HarnessState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (raw.schema !== 1) return undefined
  if (typeof raw.entries !== 'object' || raw.entries === null || Array.isArray(raw.entries)) return undefined
  const entries: Record<string, HarnessEntry> = {}
  for (const [key, candidate] of Object.entries(raw.entries)) {
    const entry = narrowHarnessEntry(candidate)
    if (entry === undefined || entry.id !== key) return undefined
    entries[key] = entry
  }
  if (!Array.isArray(raw.refinements)) return undefined
  const refinements: HarnessRefinement[] = []
  for (const candidate of raw.refinements) {
    const refinement = narrowHarnessRefinement(candidate)
    if (refinement === undefined) return undefined
    refinements.push(refinement)
  }
  return { schema: 1, entries, refinements }
}

/** Extract the harness record a tool/result meta contributes, if any. */
function harnessRecordOf(meta: unknown, seq: number): HarnessRecord | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const candidate = meta as Record<string, unknown>
  if (candidate.mesh !== HARNESS_META_MESH) return undefined
  const payload = candidate.harness
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  if (record.v !== 1) return undefined
  const refinement = narrowHarnessRefinement(record.refinement)
  if (refinement === undefined) return undefined
  return { v: 1, seq, refinement }
}

/**
 * Batch-fold every agent_harness record out of one session's event log, in
 * application order. Unlike meshSpawnRecordsOf (where a later record for the
 * same child simply wins), harness replay is order-sensitive — create, then
 * update, then delete must fold in that exact sequence — so records are
 * sorted by seq regardless of the iteration order the caller handed over.
 * @param events - one session's durable events, in any iterable order.
 * @returns the refinement records in application order.
 */
export function harnessRecordsOf(events: readonly SessionEvent[]): HarnessRecord[] {
  const records: HarnessRecord[] = []
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const record = harnessRecordOf(event.data.meta, event.seq)
    if (record !== undefined) records.push(record)
  }
  records.sort((a, b) => a.seq - b.seq)
  return records
}
