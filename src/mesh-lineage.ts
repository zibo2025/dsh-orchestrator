/**
 * Durable mesh lineage: the pure merging vocabulary that rebuilds the spawn
 * tree and its roster rows from the durable descendant catalog plus the
 * assignment cache. The host half (index.ts) owns all I/O — the live session
 * store, session persistence, and `ctx.subagents` enumeration — so everything
 * here is structure-only and unit-testable without a context.
 *
 * Recovery rides two durable sources the mesh already writes today: the
 * `parentSession` chain every session header carries, and the `agent_spawn`
 * spawn records (spawn-meta.ts) folded out of each spawner's `tool/result`
 * events. Together they rebuild label, route (provider / model / maxTokens),
 * and reasoning effort for workers whose in-memory assignment was lost to a
 * host restart.
 */
import type { MeshSpawnRecord } from './spawn-meta.ts'

/** Spawn-time assignment recorded per worker id (live cache or recovered). */
export interface MeshAssignment {
  label?: string
  effort?: string
  provider?: string
  model?: string
  maxTokens?: number
  spawnedBy: string
}

/**
 * Structural slice of the harness `SubagentDescendantListEntry` this module
 * consumes, so tests and the merge stay decoupled from the runtime type.
 */
export interface MeshDescendantEntry {
  kind: 'child' | 'diagnostic'
  id: string
  parentId?: string
  label?: string
}

/** One `agent_list` roster row. */
export interface MeshRosterRow {
  agentId: string
  label?: string
  status: string
  parent?: string
  provider?: string
  model?: string
  maxTokens?: number
  effort?: string
  master: boolean
  self: boolean
}

/** Build one assignment out of a recovered spawn record and its spawner. */
export function assignmentOf(record: MeshSpawnRecord, spawnedBy: string): MeshAssignment {
  const assignment: MeshAssignment = { spawnedBy }
  if (record.label !== undefined) assignment.label = record.label
  if (record.provider !== undefined) assignment.provider = record.provider
  if (record.model !== undefined) assignment.model = record.model
  if (record.maxTokens !== undefined) assignment.maxTokens = record.maxTokens
  if (record.effort !== undefined) assignment.effort = record.effort
  return assignment
}

/**
 * Merge the durable descendant catalog, the mesh root, and the assignment
 * cache into roster rows. `status` comes from the live registry callback and
 * falls back to `"settled"` for agents that left it — settled workers stay
 * listed (and the caller's own stay revivable through `agent_send`).
 * @param input.callerId - the requesting agent's id (marks the `self` row).
 * @param input.root - the durable mesh root (marks the `master` row).
 * @param input.descendants - durable catalog entries; only `child` rows count.
 * @param input.assignments - the live-or-recovered assignment cache.
 * @param input.liveStatusOf - live agent status, or undefined when not live.
 * @returns rows headed by the master, then descendants in catalog order.
 */
export function meshRosterRows(input: {
  callerId: string
  root: string
  descendants: readonly MeshDescendantEntry[]
  assignments: ReadonlyMap<string, MeshAssignment | undefined>
  liveStatusOf: (id: string) => string | undefined
}): MeshRosterRow[] {
  const rows: MeshRosterRow[] = []
  const seen = new Set<string>()
  const assignmentOfRow = (id: string): MeshAssignment | undefined => input.assignments.get(id) ?? undefined
  const pushRow = (id: string, parentId: string | undefined, catalogLabel: string | undefined, master: boolean): void => {
    if (seen.has(id)) return
    seen.add(id)
    const assignment = assignmentOfRow(id)
    const label = assignment?.label ?? catalogLabel
    const parent = assignment?.spawnedBy ?? parentId
    rows.push({
      agentId: id,
      ...(label !== undefined ? { label } : {}),
      status: input.liveStatusOf(id) ?? 'settled',
      ...(parent !== undefined ? { parent } : {}),
      ...(assignment?.provider !== undefined ? { provider: assignment.provider } : {}),
      ...(assignment?.model !== undefined ? { model: assignment.model } : {}),
      ...(assignment?.maxTokens !== undefined ? { maxTokens: assignment.maxTokens } : {}),
      ...(assignment?.effort !== undefined ? { effort: assignment.effort } : {}),
      master,
      self: id === input.callerId,
    })
  }
  pushRow(input.root, undefined, undefined, true)
  for (const entry of input.descendants) {
    if (entry.kind !== 'child') continue
    pushRow(entry.id, entry.parentId, entry.label, false)
  }
  return rows
}
