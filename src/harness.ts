/**
 * Continual Harness (prime-agent style, reduced): a persistent, rollback-able
 * store of mesh lessons (`memory`), worker templates (`worker`), and prompt
 * notes (`prompt`) that feeds agent_spawn template derivation and systemPrompt
 * overview injection. Two scopes share one vocabulary:
 *
 * - local (default): the refinement travels as an `agent_harness` tool/result
 *   presentationMeta record inside the session log, so session-local state is
 *   rebuilt by replaying the log (foldLocalHarness) — no files anywhere.
 * - global (explicit): a JSON state file plus an append-only refinements
 *   audit, owned by HarnessStore with atomic writes.
 *
 * Everything except HarnessStore is pure: validation, optimistic-concurrency
 * planning, inverse computation for rollback, log folding, and the
 * progressive-disclosure overview never touch I/O, so each concern stays
 * unit-testable without a context or a filesystem.
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { harnessRecordsOf, narrowHarnessState, type HarnessRecord } from './harness-records.ts'
import { clip } from './text.ts'

// The data shapes below are type aliases (not interfaces) with exactly the
// frozen contract members: they ride inside presentationMeta, so every level
// must structurally satisfy JsonValue's index signature — interfaces never do.

/** What a harness entry teaches: a lesson, a worker template, or a prompt note. */
export type HarnessKind = 'memory' | 'worker' | 'prompt'

/** Where an entry lives: the session log (local) or the shared JSON store (global). */
export type HarnessScope = 'local' | 'global'

/** Spawn-time route a `worker` template carries into agent_spawn. */
export type HarnessRoute = {
  provider?: string
  model?: string
  maxTokens?: number
  effort?: string
}

/** One stored harness entry. Immutable except through refinements; `version` drives optimistic concurrency. */
export type HarnessEntry = {
  id: string
  kind: HarnessKind
  title: string
  content: string
  scope: HarnessScope
  route?: HarnessRoute
  createdAt: string
  updatedAt: string
  version: number
}

/** One intended change; validated hard per edit inside a refinement. */
export type HarnessEdit = {
  action: 'create' | 'update' | 'delete'
  id?: string
  kind?: HarnessKind
  title?: string
  content?: string
  scope?: HarnessScope
  route?: HarnessRoute
  baseVersion?: number
}

/** The outcome of one edit: applied with before/after snapshots, or rejected with why. */
export type AppliedHarnessEdit = {
  action: HarnessEdit['action']
  id: string
  applied: boolean
  error?: string
  before?: HarnessEntry
  after?: HarnessEntry
}

/** One committed batch of edits — the unit of audit and rollback. */
export type HarnessRefinement = {
  id: string
  trigger: 'manual' | 'rollback'
  summary: string
  rationale: string
  expectedOutcome?: string
  scope: HarnessScope
  edits: AppliedHarnessEdit[]
  rollbackOf?: string
  createdAt: string
}

/** The whole harness state of one scope. */
export interface HarnessState {
  schema: 1
  entries: Record<string, HarnessEntry>
  refinements: HarnessRefinement[]
}

/** Legal entry ids: lowercase slug, 2–64 chars, starting alphanumeric. */
const HARNESS_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/

/**
 * Reserved ids: the harness's own immutable base (the orientation section and
 * the base system prompt) can never become an entry, so a refinement cannot
 * shadow the instructions every agent already carries.
 */
const HARNESS_RESERVED_IDS = new Set(['orientation', 'base_system_prompt'])

/** Overview disclosure caps: at most six entries per kind, each clipped. */
const OVERVIEW_MAX_PER_KIND = 6
const OVERVIEW_LINE_CHARS = 180

/** Stable kind order for the overview (lesson first, template, then note). */
const KIND_ORDER: readonly HarnessKind[] = ['memory', 'worker', 'prompt']

/** A fresh, empty harness state. */
function emptyHarnessState(): HarnessState {
  return { schema: 1, entries: {}, refinements: [] }
}

/**
 * Fresh refinement id: `ref-<epochms>-<6 hex>` — time-ordered for readable
 * audit logs, collision-safe across processes and restarts.
 */
function newRefinementId(): string {
  return `ref-${Date.now()}-${randomBytes(3).toString('hex')}`
}

function harnessKindOf(value: unknown): HarnessKind | undefined {
  return value === 'memory' || value === 'worker' || value === 'prompt' ? value : undefined
}

function harnessScopeOf(value: unknown): HarnessScope | undefined {
  return value === 'local' || value === 'global' ? value : undefined
}

function harnessActionOf(value: unknown): HarnessEdit['action'] | undefined {
  return value === 'create' || value === 'update' || value === 'delete' ? value : undefined
}

/**
 * Keep only the persistable route fields. An all-empty route ({}) normalizes
 * to undefined so entries never carry a meaningless empty object.
 */
function normalizeRoute(route: unknown): HarnessRoute | undefined {
  if (typeof route !== 'object' || route === null) return undefined
  const raw = route as Record<string, unknown>
  const clean: HarnessRoute = {}
  if (typeof raw.provider === 'string' && raw.provider !== '') clean.provider = raw.provider
  if (typeof raw.model === 'string' && raw.model !== '') clean.model = raw.model
  if (typeof raw.maxTokens === 'number' && Number.isFinite(raw.maxTokens)) clean.maxTokens = raw.maxTokens
  if (typeof raw.effort === 'string' && raw.effort !== '') clean.effort = raw.effort
  return Object.keys(clean).length > 0 ? clean : undefined
}

/**
 * Validate and apply ONE edit against the working entry table, returning the
 * applied result (never throwing — a rejected edit records why and lets its
 * siblings proceed). `entries` is the caller's working copy, so a refinement
 * that ends up invalid can simply be discarded.
 */
function applyHarnessEdit(entries: Record<string, HarnessEntry>, edit: HarnessEdit, target: HarnessScope, now: string): AppliedHarnessEdit {
  const id = typeof edit.id === 'string' ? edit.id : ''
  const reject = (error: string): AppliedHarnessEdit => ({ action: edit.action, id, applied: false, error })
  const action = harnessActionOf(edit.action)
  if (action === undefined) return reject(`unknown action ${JSON.stringify(edit.action)}`)
  // Reserved ids are refused before the slug pattern — `base_system_prompt`
  // contains an underscore, so pattern-first would shadow the reserved
  // rejection with a generic slug error for half the blacklist.
  if (HARNESS_RESERVED_IDS.has(id)) return reject(`id ${JSON.stringify(id)} is reserved (immutable harness base)`)
  if (!HARNESS_ID_PATTERN.test(id)) return reject(`invalid id ${JSON.stringify(id)}: must match ${HARNESS_ID_PATTERN}`)
  // Scope is validated for every action so a routed-to-the-wrong-store edit
  // is rejected by name instead of silently landing in the other scope.
  if (edit.scope !== undefined && harnessScopeOf(edit.scope) === undefined) return reject('scope must be "local" or "global"')
  if (edit.scope !== undefined && edit.scope !== target) {
    return reject(`edit targets ${JSON.stringify(edit.scope)} scope, but this refinement applies ${JSON.stringify(target)}-scope edits`)
  }
  if (action === 'create') {
    if (edit.kind === undefined) return reject('create requires non-empty kind')
    const kind = harnessKindOf(edit.kind)
    if (kind === undefined) return reject('kind must be one of "memory" | "worker" | "prompt"')
    if (edit.title === undefined || edit.title === '') return reject('create requires non-empty title')
    if (edit.content === undefined || edit.content === '') return reject('create requires non-empty content')
    if (edit.route !== undefined && kind !== 'worker') return reject('route is only allowed on "worker" entries')
    if (entries[id] !== undefined) return reject(`entry ${JSON.stringify(id)} already exists`)
    const route = edit.route !== undefined ? normalizeRoute(edit.route) : undefined
    const entry: HarnessEntry = {
      id,
      kind,
      title: edit.title,
      content: edit.content,
      scope: target,
      ...(route !== undefined ? { route } : {}),
      createdAt: now,
      updatedAt: now,
      version: 1,
    }
    entries[id] = entry
    return { action, id, applied: true, after: entry }
  }
  if (action === 'update') {
    if (typeof edit.baseVersion !== 'number' || !Number.isFinite(edit.baseVersion)) return reject('update requires a finite baseVersion')
    const current = entries[id]
    if (current === undefined) return reject(`entry ${JSON.stringify(id)} does not exist`)
    if (current.version !== edit.baseVersion) return reject('entry changed during refinement planning')
    if (edit.title !== undefined && (typeof edit.title !== 'string' || edit.title === '')) return reject('title must be a non-empty string')
    if (edit.content !== undefined && (typeof edit.content !== 'string' || edit.content === '')) return reject('content must be a non-empty string')
    if (edit.route !== undefined && current.kind !== 'worker') return reject('route is only allowed on "worker" entries')
    const route = edit.route !== undefined ? normalizeRoute(edit.route) : current.route
    const after: HarnessEntry = {
      id: current.id,
      kind: current.kind,
      title: edit.title ?? current.title,
      content: edit.content ?? current.content,
      scope: current.scope,
      ...(route !== undefined ? { route } : {}),
      createdAt: current.createdAt,
      updatedAt: now,
      version: current.version + 1,
    }
    entries[id] = after
    return { action, id, applied: true, before: current, after }
  }
  // delete
  if (typeof edit.baseVersion !== 'number' || !Number.isFinite(edit.baseVersion)) return reject('delete requires a finite baseVersion')
  const current = entries[id]
  if (current === undefined) return reject(`entry ${JSON.stringify(id)} does not exist`)
  if (current.version !== edit.baseVersion) return reject('entry changed during refinement planning')
  delete entries[id]
  return { action, id, applied: true, before: current }
}

/**
 * Validate meta, hard-validate every edit, and — only when at least one edit
 * applied — commit the working copy into a new state plus its refinement.
 * Throws before any mutation is observable when the refinement is invalid:
 * a missing summary/rationale, or a batch where every edit was rejected
 * (an all-rejected refinement has nothing to audit or roll back).
 */
function planRefinement(
  state: HarnessState,
  edits: HarnessEdit[],
  scope: HarnessScope,
  trigger: HarnessRefinement['trigger'],
  meta: { summary: string; rationale: string; expectedOutcome?: string },
  rollbackOf?: string,
): { refinement: HarnessRefinement; state: HarnessState } {
  if (typeof meta.summary !== 'string' || meta.summary === '') throw new Error('harness refinement meta requires a non-empty summary')
  if (typeof meta.rationale !== 'string' || meta.rationale === '') throw new Error('harness refinement meta requires a non-empty rationale')
  if (!Array.isArray(edits)) throw new Error('harness edits must be an array')
  const now = new Date().toISOString()
  const entries: Record<string, HarnessEntry> = { ...state.entries }
  const applied = edits.map((edit) => applyHarnessEdit(entries, edit, scope, now))
  if (!applied.some((edit) => edit.applied)) {
    throw new Error(`harness refinement applied no edits: ${applied.map((edit) => `${edit.id === '' ? '(no id)' : edit.id}: ${edit.error ?? 'unknown failure'}`).join('; ')}`)
  }
  const expectedOutcome = typeof meta.expectedOutcome === 'string' && meta.expectedOutcome !== '' ? meta.expectedOutcome : undefined
  const refinement: HarnessRefinement = {
    id: newRefinementId(),
    trigger,
    summary: meta.summary,
    rationale: meta.rationale,
    ...(expectedOutcome !== undefined ? { expectedOutcome } : {}),
    scope,
    edits: applied,
    ...(rollbackOf !== undefined ? { rollbackOf } : {}),
    createdAt: now,
  }
  return { refinement, state: { schema: 1, entries, refinements: [...state.refinements, refinement] } }
}

/**
 * Compute the edits that undo one refinement: applied edits in reverse order,
 * each turned into its mirror image (create→delete, update→restore before,
 * delete→recreate). `baseVersion` binds each inverse to the version the
 * original left behind, so a rollback over drifted state fails loudly
 * instead of clobbering newer edits.
 */
function invertRefinement(refinement: HarnessRefinement): HarnessEdit[] {
  const edits: HarnessEdit[] = []
  for (const edit of [...refinement.edits].reverse()) {
    if (!edit.applied) continue
    if (edit.action === 'create' && edit.after !== undefined) {
      edits.push({ action: 'delete', id: edit.id, baseVersion: edit.after.version })
    } else if (edit.action === 'update' && edit.before !== undefined && edit.after !== undefined) {
      edits.push({
        action: 'update',
        id: edit.id,
        title: edit.before.title,
        content: edit.before.content,
        ...(edit.before.route !== undefined ? { route: edit.before.route } : {}),
        baseVersion: edit.after.version,
      })
    } else if (edit.action === 'delete' && edit.before !== undefined) {
      edits.push({
        action: 'create',
        id: edit.id,
        kind: edit.before.kind,
        title: edit.before.title,
        content: edit.before.content,
        scope: edit.before.scope,
        ...(edit.before.route !== undefined ? { route: edit.before.route } : {}),
      })
    }
  }
  return edits
}

/**
 * The file-backed global harness. State lives in
 * `<globalDir>/harness_state.json` (atomically replaced via temp+rename,
 * mode 0600); every committed refinement is also appended to
 * `<globalDir>/refinements.jsonl` as an append-only audit. Reads validate and
 * degrade: a missing or corrupt state file folds to an empty state and never
 * throws, because a harness the agent cannot read must not take the tool down.
 */
export class HarnessStore {
  private readonly statePath: string
  private readonly auditPath: string

  constructor(private readonly globalDir: string) {
    this.statePath = join(globalDir, 'harness_state.json')
    this.auditPath = join(globalDir, 'refinements.jsonl')
  }

  /** Read and validate the global state; missing or corrupt files degrade to empty. */
  globalState(): HarnessState {
    let raw: string
    try {
      raw = readFileSync(this.statePath, 'utf8')
    } catch {
      return emptyHarnessState() // missing or unreadable file: nothing stored yet
    }
    try {
      return narrowHarnessState(JSON.parse(raw)) ?? emptyHarnessState()
    } catch {
      return emptyHarnessState() // unparsable JSON: corrupt, treated as empty
    }
  }

  /**
   * Validate and commit edits to the global store as one manual refinement.
   * The state file is written first (atomically), then the audit line is
   * appended: the state file is the source of truth, the audit is advisory
   * history — a crash between the two loses a log line, never state.
   */
  applyGlobal(edits: HarnessEdit[], meta: { summary: string; rationale: string; expectedOutcome?: string }): HarnessRefinement {
    const planned = planRefinement(this.globalState(), edits, 'global', 'manual', meta)
    this.persist(planned.state, planned.refinement)
    return planned.refinement
  }

  /**
   * Reverse-replay one stored refinement as a new refinement
   * (trigger `'rollback'`, `rollbackOf` bound to the original id). Unknown ids
   * throw; so does a rollback whose inverse edits all fail (drifted state).
   */
  rollbackGlobal(refinementId: string): HarnessRefinement {
    const state = this.globalState()
    const original = state.refinements.find((refinement) => refinement.id === refinementId)
    if (original === undefined) throw new Error(`unknown harness refinement ${JSON.stringify(refinementId)}`)
    const planned = planRefinement(
      state,
      invertRefinement(original),
      'global',
      'rollback',
      { summary: `rollback of ${original.id}`, rationale: `reverse-replays the applied edits of refinement ${original.id}` },
      original.id,
    )
    this.persist(planned.state, planned.refinement)
    return planned.refinement
  }

  /** Atomically replace the state file, then append the audit line. */
  private persist(state: HarnessState, refinement: HarnessRefinement): void {
    mkdirSync(this.globalDir, { recursive: true })
    const tmp = `${this.statePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.statePath)
    appendFileSync(this.auditPath, JSON.stringify(refinement) + '\n', { mode: 0o600 })
  }
}

/** Replay one refinement's applied edits onto a mutable state under construction. */
function replayRefinement(state: HarnessState, refinement: HarnessRefinement): void {
  for (const edit of refinement.edits) {
    if (!edit.applied) continue
    if (edit.action === 'delete') delete state.entries[edit.id]
    else if (edit.after !== undefined) state.entries[edit.id] = edit.after
  }
  state.refinements.push(refinement)
}

/**
 * Fold the session-local harness state out of one session's durable events:
 * every agent_harness record in the log replays its applied edits in
 * application order. Records were validated before they were written, so the
 * fold trusts them and never re-runs edit validation.
 * @param events - one session's durable events, in any iterable order.
 */
export function foldLocalHarness(events: readonly SessionEvent[]): HarnessState {
  const state = emptyHarnessState()
  for (const record of harnessRecordsOf(events)) replayRefinement(state, record.refinement)
  return state
}

/**
 * Plan a session-local refinement: fold the current local state from the
 * events, validate and apply the edits against it, and hand back both the
 * refinement and the durable record the caller must stamp onto its
 * agent_harness tool result — the record IS the storage for local scope.
 */
export function planLocalHarness(events: readonly SessionEvent[], edits: HarnessEdit[], meta: { summary: string; rationale: string; expectedOutcome?: string; trigger?: 'manual' | 'rollback'; rollbackOf?: string }): { refinement: HarnessRefinement; record: HarnessRecord } {
  const planned = planRefinement(foldLocalHarness(events), edits, 'local', meta.trigger ?? 'manual', meta, meta.rollbackOf)
  return { refinement: planned.refinement, record: { v: 1, seq: 0, refinement: planned.refinement } }
}

/**
 * Render the harness overview injected into systemPrompt variables:
 * progressive disclosure, not a dump — at most six entries per kind (local
 * and global merged, sorted by id, local first on a tie), each line clipped
 * via text.ts, closing with the pointer to the full listing.
 */
export function harnessOverview(local: HarnessState, global: HarnessState): string {
  const lines: string[] = []
  for (const kind of KIND_ORDER) {
    const rows = [...Object.values(local.entries), ...Object.values(global.entries)]
      .filter((entry) => entry.kind === kind)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.scope === b.scope ? 0 : a.scope === 'local' ? -1 : 1))
    if (rows.length === 0) continue
    const localCount = rows.filter((entry) => entry.scope === 'local').length
    lines.push(`${kind} (local ${localCount}, global ${rows.length - localCount}${rows.length > OVERVIEW_MAX_PER_KIND ? `, showing first ${OVERVIEW_MAX_PER_KIND}` : ''}):`)
    for (const entry of rows.slice(0, OVERVIEW_MAX_PER_KIND)) {
      const body = clip(`${entry.title} — ${entry.content}`.replace(/\s+/g, ' ').trim(), OVERVIEW_LINE_CHARS)
      lines.push(`- [${entry.scope}] ${entry.id} v${entry.version}: ${body}`)
    }
  }
  if (lines.length === 0) lines.push('harness: no entries yet')
  lines.push('full entries: agent_harness list')
  return lines.join('\n')
}
