/**
 * Durable agent_spawn records: the presentation meta `agent_spawn` stamps onto
 * its tool results, and the batch fold that reads those records back out of a
 * spawner's session log. Everything here consumes and produces persisted
 * facts — tool/result events carry the meta in the durable log — so host-side
 * lineage recovery can rebuild the assignment table (label, route, effort)
 * from any spawner's history, across host restarts.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Meta discriminator agent_spawn's presentationMeta stamps onto tool results. */
const SPAWN_META_MESH = 'agent-spawn'

/** Fields presentationMeta may carry, beyond the marker and childId. A type
 * alias (not interface) so it structurally satisfies JsonValue's index signature. */
export type SpawnMeta = {
  mesh: typeof SPAWN_META_MESH
  childId: string
  label?: string
  provider?: string
  model?: string
  maxTokens?: number
  effort?: string
}

/** Spawn-time configuration of one worker, as recorded by its spawner's log. */
export interface MeshSpawnRecord {
  label?: string
  provider?: string
  model?: string
  maxTokens?: number
  effort?: string
  /** Seq of the `tool/result` event the record was folded from. */
  seq: number
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Build the durable meta for one completed agent_spawn call. Called by the
 * tool's `presentationMeta` with registry-validated args and value; total and
 * defensive — a malformed pair degrades to an empty-childId sentinel that the
 * fold rejects, never a throw.
 */
export function meshSpawnMeta(args: unknown, value: unknown): SpawnMeta {
  const childId = str((value as { childId?: unknown } | null)?.childId) ?? ''
  const a = (args ?? {}) as Record<string, unknown>
  const meta: SpawnMeta = { mesh: SPAWN_META_MESH, childId }
  const label = str(a.label)
  if (label !== undefined) meta.label = label
  const provider = str(a.provider)
  if (provider !== undefined) meta.provider = provider
  const model = str(a.model)
  if (model !== undefined) meta.model = model
  if (typeof a.maxTokens === 'number' && Number.isFinite(a.maxTokens)) meta.maxTokens = a.maxTokens
  const effort = str(a.effort)
  if (effort !== undefined) meta.effort = effort
  return meta
}

/** Narrow one `tool/result` meta down to an agent_spawn record carrier. */
function spawnMetaOf(meta: unknown): SpawnMeta | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const candidate = meta as Record<string, unknown>
  if (candidate.mesh !== SPAWN_META_MESH || typeof candidate.childId !== 'string' || candidate.childId === '') return undefined
  return {
    mesh: SPAWN_META_MESH,
    childId: candidate.childId,
    ...Object.fromEntries(['label', 'provider', 'model', 'effort']
      .filter(key => str(candidate[key]) !== undefined)
      .map(key => [key, candidate[key] as string])),
    ...(typeof candidate.maxTokens === 'number' && Number.isFinite(candidate.maxTokens)
      ? { maxTokens: candidate.maxTokens }
      : {}),
  }
}

/** Extract the spawn record a tool/result meta contributes, if any. */
function spawnRecordOf(meta: unknown, seq: number): { childId: string; record: MeshSpawnRecord } | undefined {
  const parsed = spawnMetaOf(meta)
  if (parsed === undefined) return undefined
  const record: MeshSpawnRecord = { seq }
  if (parsed.label !== undefined) record.label = parsed.label
  if (parsed.provider !== undefined) record.provider = parsed.provider
  if (parsed.model !== undefined) record.model = parsed.model
  if (parsed.maxTokens !== undefined) record.maxTokens = parsed.maxTokens
  if (parsed.effort !== undefined) record.effort = parsed.effort
  return { childId: parsed.childId, record }
}

/**
 * Batch-fold every agent_spawn record out of one session's event log. Scanning
 * each spawner's log (live store first, then persistence) rebuilds the
 * assignment table a host restart lost.
 * @param events - one session's durable events, in any iterable order.
 * @returns childId → its spawn record; later records win.
 */
export function meshSpawnRecordsOf(events: readonly SessionEvent[]): ReadonlyMap<string, MeshSpawnRecord> {
  const records = new Map<string, MeshSpawnRecord>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const spawn = spawnRecordOf(event.data.meta, event.seq)
    if (spawn !== undefined) records.set(spawn.childId, spawn.record)
  }
  return records
}
