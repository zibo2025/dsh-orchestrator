/**
 * dsh-orchestrator — native full-mesh agent orchestration for DeepSeek Harness.
 *
 * One plugin instance serves one mounted composition. The master (root) agent
 * joins the preset at mount; every worker created through `agent_spawn` binds
 * to the same standing composition (`agentPresets.composeFrom`), so the mesh
 * tools below and the `agent/request` waterfall cover the master and every
 * worker alike.
 *
 * Communication rides the harness's own agent inbox: a message to a running
 * agent queues for its next turn, a message to an idle/waiting agent wakes it,
 * and a message to one of the caller's own settled workers cold-resumes it
 * from its persisted session (`ctx.subagents.followup`, the continuable
 * continuation path). No file mailbox, no prompt convention. Every delivered
 * message carries the harness's coordinator attribution
 * (`CoordinatorMessageSource`, relay form) plus the `[orchestrator-mesh]` text
 * frame that identifies the sender in the receiver's transcript.
 *
 * `agent_trace` reads any mesh agent's transcript — the caller itself, the
 * mesh root, or any worker below it: the live session's in-memory snapshot
 * when the target is online, the persisted log when it has settled. Reading
 * never wakes or activates the target.
 *
 * Per-worker model comes from `SubagentStartRequest.agentOptions`
 * (`resolveChildAgentOptions`: the requested value wins, the parent's route is
 * the fallback). Reasoning effort has no AgentOptions field, so it is applied
 * per request through the `agent/request` waterfall against the spawn-time
 * assignment table.
 *
 * Mesh membership is the spawner tree rooted at the caller's root — the
 * `agents` registry is process-global, so agents of unrelated sessions are
 * never listed, messaged, or broadcast to. The assignment table is
 * write-through cached: entries lost to a host restart are recovered from the
 * durable `parentSession` chain plus the spawn records each spawner's log
 * carries, so rosters, labels, routes, and effort survive restarts wherever
 * session persistence is mounted.
 *
 * @module dsh-orchestrator
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { CoordinatorMessageSource, SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { SessionId, type AgentCancelCause } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { readPersistedEvents, readPersistedParent, type PersistenceReader } from './persistence-read.ts'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { frameMeshMessage } from './mesh-frame.ts'
import { assignmentOf, meshRosterRows, type MeshAssignment } from './mesh-lineage.ts'
import { meshSpawnMeta, meshSpawnRecordsOf } from './spawn-meta.ts'
import { MeshScheduler } from './schedule.ts'
import { clip } from './text.ts'
import { foldLocalHarness, harnessOverview, HarnessStore, planLocalHarness, type HarnessEdit, type HarnessEntry, type HarnessRefinement, type HarnessRoute } from './harness.ts'
import { harnessMeta, type HarnessRecord } from './harness-records.ts'

export const name = 'orchestrator'
export const inject = ['tools', 'agents', 'subagents', 'systemPrompt', 'sessions', 'llm']

export const Config = z.object({
  /** The `ctx.subagents` provider whose continuable backend establishes workers. */
  provider: z.string().default('spawn'),
  /** Absolute delegation-depth cap for workers spawned through `agent_spawn`. */
  maxDepth: z.number().step(1).min(0).default(2),
  /**
   * Optional override for the mesh-orientation prompt section this plugin
   * registers (order 180). It may reference `{{mesh_self}}` and
   * `{{mesh_master}}`. Omit to keep the built-in orchestration protocol.
   */
  orientation: z.string(),
  /** Max session events rendered per `agent_trace` read. */
  traceMaxEvents: z.number().step(1).min(1).max(1000).default(80),
  /** Per content block / tool-arguments character cap in `agent_trace` output. */
  traceMaxCharsPerBlock: z.number().min(100).max(20000).default(2000),
  /** Whole rendered `agent_trace` character cap; the newest tail survives. */
  traceMaxTotalChars: z.number().min(1000).max(100000).default(20000),
  /**
   * Directory for global harness state (worker templates, mesh memories,
   * prompt notes). Defaults to `$DSH_HOME/orchestrator`, or `~/.dsh/orchestrator`
   * when `DSH_HOME` is unset.
   */
  harnessDir: z.string(),
})

/** Built-in mesh-orientation prompt section text. */
export const DEFAULT_ORIENTATION = [
  'You are in orchestration-mesh mode: {{mesh_self}} is your own agent id and {{mesh_master}} is the mesh root (master).',
  'Coordination tools: agent_spawn creates a worker (optionally with its own provider/model/maxTokens/effort, or from a harness worker template), agent_send messages any live mesh agent — and revives one of your own settled workers from its persisted session — agent_broadcast reaches every live mesh agent at once, agent_list shows the roster with per-agent token usage (settled workers included), agent_trace reads any mesh agent\'s transcript — including settled workers — without waking it, agent_harness manages durable mesh lessons / worker templates / prompt notes, agent_schedule arranges timed wake-up messages, agent_send with steer:true interjects at a running agent\'s nearest step boundary (e.g. ask for a progress report and let it continue), and agent_interrupt cancels a running agent\'s current turn while keeping its queued messages.',
  'Protocol:',
  '1. Decompose the task into workers before spawning; spawn independent workers in parallel rather than sequentially.',
  '2. A worker reports back by sending a message to its spawner with agent_send — never leave the master guessing, and never wait to be asked.',
  '3. Mesh messages are turn-based: a message becomes the receiver\'s next turn, so ask for what you need and expect the answer as a later message.',
  '4. The master aggregates worker results and owns the user-facing conclusion; workers do the hands-on work.',
  '5. Verify before finalizing: run an independent check over worker output, re-inject bounded failure output for one retry, and never re-run the same failing check when the workspace has not changed.',
  '6. After any context compaction, recover worker ids and mesh state by re-running agent_list (and agent_harness list) instead of guessing.',
  'Durable mesh state (worker templates, lessons, prompt notes) is summarized here: {{mesh_harness}}',
].join('\n')

/** The initial-prompt suffix every worker receives, so it knows the mesh it joined. */
function workerBrief(spawnerId: string, label: string, effort?: string): string {
  const lines = [
    '',
    '[orchestrator-mesh] You are a worker agent in an orchestration mesh.',
    `Your display label is "${label}". The agent that spawned you has id ${spawnerId} — reply to it with agent_send when your task is done or when you need input.`,
    'You can message ANY live mesh agent with agent_send (see agent_list for ids), and every message addressed to you arrives as your next turn.',
    'When your task is finished, send a final summary message to your spawner. Do not wait to be asked.',
    'Write large outputs to files in the shared workspace and send pointers, not contents; keep your final summary message concise (target under 2000 characters).',
  ]
  if (effort !== undefined) {
    lines.push(`Your reasoning effort is "${effort}".`)
  }
  return lines.join('\n')
}

/** JSON-schema node for one harness entry, reused across agent_harness outputs. */
const HARNESS_ENTRY_SCHEMA: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    title: { type: 'string', required: true },
    content: { type: 'string', required: true },
    scope: { type: 'string', required: true },
    route: {
      type: 'object',
      additionalProperties: false,
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
        maxTokens: { type: 'number' },
        effort: { type: 'string' },
      },
    },
    createdAt: { type: 'string', required: true },
    updatedAt: { type: 'string', required: true },
    version: { type: 'number', required: true },
  },
}

/** JSON-schema node for one refinement, reused by refinement and record outputs. */
const HARNESS_REFINEMENT_SCHEMA: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    trigger: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    rationale: { type: 'string', required: true },
    expectedOutcome: { type: 'string' },
    scope: { type: 'string', required: true },
    edits: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          id: { type: 'string', required: true },
          applied: { type: 'boolean', required: true },
          error: { type: 'string' },
          before: HARNESS_ENTRY_SCHEMA,
          after: HARNESS_ENTRY_SCHEMA,
        },
      },
    },
    rollbackOf: { type: 'string' },
    createdAt: { type: 'string', required: true },
  },
}

// ── agent_trace helpers ──────────────────────────────────────────────────────

/** Render one content block into trace lines; unknown block types are skipped. */
function traceBlockLines(block: ContentBlock, cap: number): string[] {
  switch (block.type) {
    case 'text':
      return block.text.trim() === '' ? [] : [clip(block.text.trim(), cap)]
    case 'reasoning':
      return [clip(`[reasoning] ${block.text}`, cap)]
    case 'tool-call':
      return [`→ tool-call ${block.name}(${clip(block.arguments, cap)})`]
    case 'tool-result': {
      const inner = block.content.flatMap(candidate => traceBlockLines(candidate, cap))
      return [`→ tool-result ${block.toolCallId}${block.isError === true ? ' [error]' : ''}: ${clip(inner.join(' | '), cap)}`]
    }
    default:
      return []
  }
}

function traceContentLines(content: readonly ContentBlock[], cap: number): string[] {
  return content.flatMap(block => traceBlockLines(block, cap))
}

/** Collect tool/call `callId → name` pairs so results can name their tool. */
function callNamesOf(events: readonly SessionEvent[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/call') names.set(event.data.callId, event.data.name)
  }
  return names
}

/** Render one session event into trace lines; skipped event types yield none. */
function traceEventLines(event: SessionEvent, names: Map<string, string>, cap: number): string[] {
  switch (event.type) {
    case 'turn/start':
      return [`\n== turn ${event.data.turn} ==`]
    case 'user/message':
      return traceContentLines(event.data.content, cap).map(line => `[user] ${line}`)
    case 'assistant/message':
      return traceContentLines(event.data.message.content, cap).map(line => `[assistant] ${line}`)
    case 'tool/result': {
      const { message, error } = event.data
      const block = message.content[0]
      const head = error === undefined ? '' : ` [error ${error.name}/${error.code}]`
      const label = names.get(block.toolCallId) ?? `tool ${block.toolCallId}`
      const inner = traceContentLines(block.content, cap)
      if (inner.length === 0) return [`[tool] ${label} → (no text output)${head}`]
      return [`[tool] ${label} → ${inner[0]}${head}`, ...inner.slice(1)]
    }
    default:
      return []
  }
}

export function apply(ctx: Context, config: {
  provider: string
  maxDepth: number
  orientation?: string
  traceMaxEvents: number
  traceMaxCharsPerBlock: number
  traceMaxTotalChars: number
  harnessDir?: string
}) {
  /**
   * Per-mount assignment table: worker id → spawn-time mesh assignment. An
   * `undefined` value is a negative cache entry — recovery ran for that id and
   * found no spawn record — so it is never re-attempted. Entries are populated
   * live by agent_spawn and recovered from spawner logs after host restarts.
   */
  const assignments = new Map<string, MeshAssignment | undefined>()

  /** Spawner sessions already scanned for spawn records; live spawns keep writing through the map directly. */
  const scannedParents = new Set<string>()

  /** Walk the spawner chain to the mesh root (an agent nobody spawned). */
  const rootOf = (id: string): string => {
    const seen = new Set<string>()
    let cursor = id
    for (;;) {
      if (seen.has(cursor)) return cursor // defensive: broken cycle
      seen.add(cursor)
      const assignment = assignments.get(cursor)
      if (assignment === undefined) return cursor
      cursor = assignment.spawnedBy
    }
  }

  /** Is `id` inside the mesh rooted at `root`? */
  const inMesh = (root: string, id: string): boolean => rootOf(id) === root

  /** Read the durable parent of a session id: live store first, then persisted metadata. */
  const durableParentOf = async (id: SessionId, signal: AbortSignal): Promise<SessionId | undefined> => {
    const live = ctx.sessions.get(id)
    if (live !== undefined) return live.header.parentSession
    const persistence = ctx.get('sessionPersistence') as PersistenceReader | undefined
    if (persistence === undefined) return undefined
    try {
      return await readPersistedParent(persistence, id, signal)
    } catch {
      return undefined // unknown/corrupt id, or persistence read failed
    }
  }

  /** Walk the durable parent chain upward to the topmost reachable mesh root. */
  const durableRootOf = async (id: SessionId, signal: AbortSignal): Promise<SessionId> => {
    const seen = new Set<string>()
    let cursor = id
    for (let hops = 0; hops < 64; hops++) {
      if (seen.has(cursor)) return cursor // defensive: broken cycle
      seen.add(cursor)
      const parent = await durableParentOf(cursor, signal)
      if (parent === undefined) return cursor
      cursor = parent
    }
    return cursor // hop cap reached
  }

  /**
   * Scan one spawner session's durable log for agent_spawn records and cache
   * them as assignments. Live store first (the master's log is in memory), then
   * persistence; a spawner that cannot be read simply contributes nothing.
   * Idempotent per parent: one scan serves every later lookup.
   */
  const ensureAssignments = async (parentId: SessionId, signal: AbortSignal): Promise<void> => {
    if (scannedParents.has(parentId)) return
    scannedParents.add(parentId)
    let events: readonly SessionEvent[] | undefined = ctx.sessions.get(parentId)?.events
    if (events === undefined) {
      const persistence = ctx.get('sessionPersistence') as PersistenceReader | undefined
      if (persistence === undefined) return
      try {
        events = await readPersistedEvents(persistence, parentId, signal)
      } catch {
        return // unknown or corrupt id, or persistence read failed
      }
    }
    for (const [childId, record] of meshSpawnRecordsOf(events)) {
      assignments.set(childId, assignmentOf(record, parentId))
    }
  }

  /**
   * Recover one agent's own assignment from its durable parent's log, exactly
   * once: a hit restores label, route, and effort; a miss caches the negative
   * so per-step lookups never retry it.
   */
  const recoverOwn = async (id: SessionId, signal: AbortSignal): Promise<void> => {
    if (assignments.has(id)) return
    const parent = await durableParentOf(id, signal)
    if (parent !== undefined) await ensureAssignments(parent, signal)
    if (!assignments.has(id)) assignments.set(id, undefined)
  }

  /** The durable mesh as one resolved view. */
  interface MeshView {
    root: SessionId
    entries: SubagentDescendantListEntry[]
    /** Enumeration threw (no projection registry or session store): callers fall back to the in-memory tree. */
    degraded: boolean
  }

  /**
   * Resolve the caller's durable mesh: recover the caller's own assignment,
   * walk to the durable root, enumerate the descendant catalog, and recover
   * every listed spawner's records — so labels, routes, and effort survive
   * host restarts wherever persistence is mounted. Enumeration failure
   * degrades instead of throwing: the in-memory tree keeps serving the tools.
   */
  const meshView = async (callerId: SessionId, signal: AbortSignal): Promise<MeshView> => {
    await recoverOwn(callerId, signal)
    const root = await durableRootOf(callerId, signal)
    let entries: SubagentDescendantListEntry[] = []
    let degraded = false
    try {
      entries = await ctx.subagents.listDescendants(root, signal)
      const parents = new Set(entries.flatMap((entry) => (entry.kind === 'child' ? [entry.parentId] : [])))
      for (const parentId of parents) await ensureAssignments(parentId, signal)
    } catch {
      degraded = true
    }
    return { root, entries, degraded }
  }

  /** The durable attribution every mesh delivery carries: a coordinator relaying sender content. */
  const coordinatorSource = (senderId: SessionId): CoordinatorMessageSource => ({
    kind: 'coordinator',
    form: 'relay',
    senderSessionId: senderId,
  })

  /**
   * May the caller address this target inside its mesh? Authorization is the
   * union of the in-memory spawner tree (the same-process fast path) and the
   * durable catalog (membership that survives restarts); a settled direct
   * child of the caller is in the mesh by construction.
   */
  const canAddress = async (callerId: SessionId, targetId: SessionId, signal: AbortSignal): Promise<boolean> => {
    const view = await meshView(callerId, signal)
    const targetParent = await durableParentOf(targetId, signal)
    const durableMembers = new Set(view.entries.flatMap((entry) => (entry.kind === 'child' ? [entry.id] : [])))
    return targetId === view.root
      || durableMembers.has(targetId)
      || inMesh(rootOf(callerId), targetId)
      || targetParent === callerId
  }

  // ── timed wake-ups (agent_schedule) ─────────────────────────────────────────
  // In-process chained timers: the next tick arms only after the current
  // delivery settles, so ticks missed while a target is offline merge into the
  // next one instead of piling up. Durable scheduling belongs to the host —
  // see docs/agents/host-upstream-recommendations.md.
  const scheduler = new MeshScheduler({
    deliver: ({ spec }) => {
      const target = ctx.agents.get(SessionId(spec.agentId))
      if (target === undefined) return { delivered: false, error: 'target offline' }
      target.followup(createUserMessage({
        content: [{
          type: 'text',
          text: frameMeshMessage(spec.senderId, assignments.get(spec.senderId)?.label, spec.message),
        }],
        source: coordinatorSource(SessionId(spec.senderId)),
      }))
      return { delivered: true }
    },
  })
  ctx.effect(() => () => scheduler.dispose())

  // ── continual harness state ─────────────────────────────────────────────────
  // Global harness entries (worker templates, mesh memories, prompt notes)
  // live in one JSON store per installation; session-local entries ride the
  // session log via agent_harness tool-result records, exactly like spawn
  // records. Both are surfaced to every mesh agent through the progressive
  // {{mesh_harness}} overview variable.
  const harnessDir = config.harnessDir
    ?? join(process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : homedir() + '/.dsh', 'orchestrator')
  const harnessStore = new HarnessStore(harnessDir)
  /** The caller's live session events, the source local harness state folds from. */
  const callerEventsOf = (id: SessionId): readonly SessionEvent[] => ctx.sessions.get(id)?.events ?? []
  /** Look up one harness worker template by id: the caller's local state first, then the global store. */
  const harnessTemplateOf = (callerId: SessionId, id: string): HarnessEntry | undefined =>
    foldLocalHarness(callerEventsOf(callerId)).entries[id] ?? harnessStore.globalState().entries[id]

  // ── web panel data route (web compositions only) ────────────────────────────
  // The browser half of this plugin (lib/client.js — the worker-template
  // panel) reads global harness entries from this read-only route. webServer
  // exists only in web compositions, so the binding is optional: non-web
  // profiles (CLI/TUI) simply never register it. The service shape is
  // declared locally because the full types live in a host package this
  // plugin deliberately does not depend on.
  interface WebResponseLike {
    writeHead(status: number, headers: Record<string, string>): void
    end(body?: string): void
  }
  interface WebServerLike {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: unknown, res: WebResponseLike) => void | Promise<void>
    }): () => void
  }
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer') as WebServerLike
    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/orchestrator/harness.json',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(harnessStore.globalState()))
      },
    }))
  })

  // ── per-agent reasoning effort ──────────────────────────────────────────────
  // `agent/request` fires once per model step with the requesting agent in its
  // payload; the scope carrier delivers this listener to the master and to
  // every worker bound to this standing composition. A table miss triggers one
  // durable recovery (the agent's parent log), so effort also applies to a
  // cold-resumed worker whose spawn predates this process. No assignment found
  // → pass the proposal through untouched.
  ctx.on('agent/request', (payload: { agent: Agent; turn: number; step: number; signal: AbortSignal }, next: () => Promise<LlmCallConfig>) => {
    return next().then(async (proposed) => {
      let assignment = assignments.get(payload.agent.id)
      if (assignment === undefined) {
        await recoverOwn(payload.agent.id, payload.signal)
        assignment = assignments.get(payload.agent.id) ?? undefined
      }
      if (assignment?.effort === undefined) return proposed
      return { ...proposed, reasoningEffort: ReasoningEffortId(assignment.effort) }
    })
  })

  // ── prompt variables (workers learn their own identity) ────────────────────
  ctx.systemPrompt.variable('mesh_self', (context) => context.agent?.id)
  ctx.systemPrompt.variable('mesh_master', (context) => (context.agent ? rootOf(context.agent.id) : undefined))
  // Progressive disclosure of harness state: a few lines per kind at most, so
  // durable lessons stay model-visible without flooding the system prompt.
  ctx.systemPrompt.variable('mesh_harness', (context) => {
    if (!context.agent) return undefined
    return harnessOverview(foldLocalHarness(callerEventsOf(context.agent.id)), harnessStore.globalState())
  })

  // ── mesh-orientation section ────────────────────────────────────────────────
  ctx.systemPrompt.section({
    name: 'orchestrator-mesh',
    order: 180,
    text: config.orientation ?? DEFAULT_ORIENTATION,
  })

  // ── agent_spawn ─────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'agent_spawn',
    description:
      'Create a new orchestration worker agent (a continuable background subagent) and assign it an initial task. ' +
      'The worker joins the same orchestration mesh: it can message any live mesh agent with agent_send and every message addressed to it arrives as its next turn. ' +
      'Optionally assign the worker its own LLM provider/model (falls back to the spawner\'s route) and a reasoning effort. ' +
      'Reasoning effort is an adapter-owned identifier — for the DeepSeek adapter the legal values are "off", "high", and "max". ' +
      'Returns the durable agent id; use it with agent_send, agent_list, or agent_broadcast.',
    parameters: {
      label: {
        type: 'string',
        required: true,
        description: 'Short display label for this worker, e.g. "researcher-a". It also names the worker in mesh messages.',
      },
      prompt: {
        type: 'string',
        description: 'The complete, self-contained task for the worker. It does not see the spawner\'s conversation, so include every fact it needs. The mesh briefing is appended automatically. Required unless a template supplies the content.',
      },
      template: {
        type: 'string',
        description: 'Optional harness worker-template id: its content seeds the prompt (an explicit prompt wins) and its route seeds provider/model/maxTokens/effort (explicit arguments win). List templates with agent_harness.',
      },
      provider: {
        type: 'string',
        description: 'Optional LLM provider route for this worker only. Omit to inherit the spawner\'s provider.',
      },
      model: {
        type: 'string',
        description: 'Optional model id for this worker only. Omit to inherit the spawner\'s model.',
      },
      maxTokens: {
        type: 'number',
        description: 'Optional maximum output tokens per model request for this worker only. Omit to inherit the spawner\'s value.',
      },
      effort: {
        type: 'string',
        description: 'Optional reasoning effort for this worker only. Adapter-owned identifier — for the DeepSeek adapter: "off", "high", or "max". Omit to inherit the default behavior.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childId: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `spawned orchestration worker ${value.childId}`,
      }],
      // Durable, replay-safe spawn record: lineage recovery folds this meta
      // back out of the spawner's tool/result events, which is how worker
      // configuration (label, route, effort) survives host restarts.
      presentationMeta: (args, value) => meshSpawnMeta(args, value),
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('agent_spawn requires a calling agent (exec.agent was undefined)')
      // Template seeding: a harness worker template supplies the prompt and
      // route; an explicit argument always wins over the template's value.
      let templateRoute: HarnessRoute | undefined
      let prompt = args.prompt
      if (args.template !== undefined) {
        const entry = harnessTemplateOf(caller.id, args.template)
        if (entry === undefined) {
          throw new Error(`agent_spawn: worker template "${args.template}" not found in your local or global harness; list entries with agent_harness`)
        }
        if (entry.kind !== 'worker') {
          throw new Error(`agent_spawn: template "${args.template}" is a "${entry.kind}" entry; only worker templates can seed a spawn`)
        }
        templateRoute = entry.route
        if (prompt === undefined || prompt === '') prompt = entry.content
      }
      if (prompt === undefined || prompt === '') throw new Error('agent_spawn requires a prompt (or a worker template that supplies one)')
      const provider = args.provider ?? templateRoute?.provider
      const model = args.model ?? templateRoute?.model
      const maxTokens = args.maxTokens ?? templateRoute?.maxTokens
      const effort = args.effort ?? templateRoute?.effort
      const agentOptions: AgentOptions = {}
      if (provider !== undefined) agentOptions.provider = provider
      if (model !== undefined) agentOptions.model = model
      if (maxTokens !== undefined) agentOptions.maxTokens = maxTokens
      // Fail fast on an explicit provider/model typo (from arguments or a
      // worker template), and honor the user-authorized allowlist first:
      // when the host's subagent model-selection setting is enabled, an
      // explicit route must be one of the authorized provider/model pairs —
      // the same gate the built-in delegation tools honor, so the Settings
      // page is the single ceiling for child routes. Inheritance (nothing
      // explicit) stays free: it is the default, not a selection.
      if (provider !== undefined || model !== undefined) {
        const effectiveProvider = provider ?? caller.options.provider
        const effectiveModel = model ?? caller.options.model
        const selection = ctx.get('subagentModelSelection') as {
          current?: () => { enabled: boolean; allowedModels: readonly { provider: string; model: string }[] }
        } | undefined
        const preference = selection?.current?.()
        if (preference?.enabled === true && effectiveProvider !== undefined && effectiveModel !== undefined) {
          const authorized = preference.allowedModels.some(
            (route) => route.provider === effectiveProvider && route.model === effectiveModel,
          )
          if (!authorized) {
            throw new Error(
              `agent_spawn: route "${effectiveProvider}/${effectiveModel}" is not authorized by the subagent model-selection setting `
              + `(allowed: ${preference.allowedModels.map((route) => `${route.provider}/${route.model}`).join(', ')}). `
              + `Adjust the allowlist in Settings → Plugins, or omit the route to inherit the spawner's.`,
            )
          }
        }
        if (effectiveProvider !== undefined && effectiveModel !== undefined) {
          try {
            await ctx.llm.resolveModelInfo(effectiveProvider, effectiveModel, exec.signal)
          } catch (error) {
            let available = ''
            try {
              const models = await ctx.llm.listModels(effectiveProvider)
              if (models.length > 0) available = `; models advertised by provider "${effectiveProvider}": ${models.map((m) => m.id).join(', ')}`
            } catch { /* listing is best-effort; the resolution error below stands on its own */ }
            throw new Error(
              `agent_spawn: route validation failed for provider "${effectiveProvider}" model "${effectiveModel}" `
              + `(${error instanceof Error ? error.message : String(error)})${available}. Fix the route or omit it to inherit the spawner's.`,
            )
          }
        }
      }
      const result = await ctx.subagents.startContinuable({
        provider: config.provider,
        label: args.label,
        request: {
          parent: caller,
          prompt: [{
            type: 'text',
            text: prompt + workerBrief(caller.id, args.label, effort),
          }],
          ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
          maxDepth: config.maxDepth,
        },
        signal: exec.signal,
      })
      assignments.set(result.childId, {
        label: args.label,
        ...(effort !== undefined && effort !== '' ? { effort } : {}),
        ...(agentOptions.provider !== undefined ? { provider: agentOptions.provider } : {}),
        ...(agentOptions.model !== undefined ? { model: agentOptions.model } : {}),
        ...(agentOptions.maxTokens !== undefined ? { maxTokens: agentOptions.maxTokens } : {}),
        spawnedBy: caller.id,
      })
      return result
    },
  }))

  // ── agent_send ──────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'agent_send',
    description:
      'Send a message to any mesh agent (the master or any worker) by agent id. ' +
      'The message becomes the target\'s next turn: if it is working, delivery waits for its current turn to finish; if it is idle, it wakes to process the message. ' +
      'A settled target is revived when it is one of YOUR own workers — delivery cold-resumes it from its persisted session. ' +
      'This call returns no answer from the target — the receiver answers by sending a message back. ' +
      'Delivery fails with delivered: false when the target is a settled worker you did not spawn directly, or is not part of your mesh.',
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: 'The agent id of the target (a childId from agent_spawn, the mesh master id from your mesh-orientation section, or an id from agent_list).',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message content to deliver.',
      },
      steer: {
        type: 'boolean',
        description: 'Deliver as steering instead of queueing: a RUNNING target consumes the message at its nearest step boundary — mid-turn, between model steps, e.g. "report progress, then continue" — and an idle target starts a turn at once. A settled/offline target cannot be steered and falls back to normal next-turn delivery.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          reason: { type: 'string' },
          mode: { type: 'string', description: '"steered" (consumed at the target\'s nearest step boundary) or "queued" (next turn).' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.delivered
          ? `message ${value.mode === 'steered' ? 'steered into' : 'queued as the next turn for'} agent ${_args.agent_id}`
          : `delivery failed: ${value.reason}`,
      }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('agent_send requires a calling agent (exec.agent was undefined)')
      const targetId = SessionId(args.agent_id)
      if (targetId === caller.id) return { delivered: false, reason: 'cannot message yourself' }
      // Authorization is the union of the in-memory spawner tree, the durable
      // catalog, and caller-owned settled children — exactly the cases
      // ctx.subagents.followup authorizes for delivery.
      if (!(await canAddress(caller.id, targetId, exec.signal))) {
        return { delivered: false, reason: 'target is not part of your orchestration mesh' }
      }
      const content: ContentBlock[] = [{
        type: 'text',
        text: frameMeshMessage(caller.id, assignments.get(caller.id)?.label, args.message),
      }]
      const source = coordinatorSource(caller.id)
      const live = ctx.agents.get(targetId)
      // Steering reaches only a live driver: a running target consumes the
      // message at its nearest step boundary (report-and-continue), an idle
      // one starts a turn at once. Settled targets fall through to the
      // next-turn paths below — there is nothing running to steer.
      if (args.steer === true && live !== undefined) {
        live.steer(createUserMessage({ content, source }))
        return { delivered: true, mode: 'steered' }
      }
      const targetParent = await durableParentOf(targetId, exec.signal)
      // Direct children always route through the continuation runtime: it
      // enqueues to a resident child with proper waking accounting and
      // cold-resumes an absent one from its persisted session. A live child
      // whose runtime delivery was rejected still takes the raw inbox send.
      if (targetParent === caller.id) {
        try {
          await ctx.subagents.followup(caller, targetId, content, { source, signal: exec.signal })
          return { delivered: true, mode: 'queued' }
        } catch (error) {
          if (live === undefined) {
            return { delivered: false, reason: `reviving the settled worker failed: ${error instanceof Error ? error.message : String(error)}` }
          }
          live.followup(createUserMessage({ content, source }))
          return { delivered: true, mode: 'queued' }
        }
      }
      if (live === undefined) {
        return { delivered: false, reason: 'target is not online (settled, disposed, or unknown id); only your own settled workers are revived by delivery' }
      }
      live.followup(createUserMessage({ content, source }))
      return { delivered: true, mode: 'queued' }
    },
  }))

  // ── agent_broadcast ─────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'agent_broadcast',
    description:
      'Broadcast a message to every live mesh agent except the caller and the listed exclusions. ' +
      'Each delivery behaves like agent_send: queued for the target\'s next turn, or waking an idle target. ' +
      'Settled workers are not revived by a broadcast — address them individually with agent_send. ' +
      'Use it for announcements, progress updates, or gathering status from every worker at once.',
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: 'The message content to deliver to every mesh agent.',
      },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional agent ids to skip (in addition to the caller, which is always skipped).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deliveries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                agentId: { type: 'string', required: true },
                delivered: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `broadcast delivered to ${value.deliveries.filter((d: { delivered: boolean }) => d.delivered).length} of ${value.deliveries.length} mesh agents`,
      }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('agent_broadcast requires a calling agent (exec.agent was undefined)')
      const view = await meshView(caller.id, exec.signal)
      const excluded = new Set<string>([caller.id, ...(args.exclude ?? [])])
      const durableMembers = new Set(view.entries.flatMap((entry) => (entry.kind === 'child' ? [entry.id] : [])))
      const deliveries: { agentId: string; delivered: boolean }[] = []
      for (const agent of ctx.agents.list()) {
        if (excluded.has(agent.id)) continue
        // Live-only delivery, but membership still unions the in-memory tree
        // with the durable catalog so restart-recovered agents qualify.
        if (!inMesh(rootOf(caller.id), agent.id) && !durableMembers.has(agent.id) && agent.id !== view.root) continue
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: frameMeshMessage(caller.id, assignments.get(caller.id)?.label, args.message) }],
          source: coordinatorSource(caller.id),
        }))
        deliveries.push({ agentId: agent.id, delivered: true })
      }
      return { deliveries }
    },
  }))

  // ── agent_list ──────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'agent_list',
    description:
      'List every agent in your orchestation mesh with its id, status, label, parent, spawn-time route (provider/model/maxTokens/effort when set), and whether it is the mesh master. ' +
      'The roster comes from the durable session catalog plus the live registry: settled workers stay listed with status "settled" (revivable with agent_send when you spawned them), and labels/routes are recovered from persisted spawn records after a host restart. ' +
      'Use the ids for agent_send, agent_broadcast exclusions, or follow-ups.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agents: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                agentId: { type: 'string', required: true },
                label: { type: 'string' },
                status: { type: 'string', required: true },
                parent: { type: 'string' },
                provider: { type: 'string' },
                model: { type: 'string' },
                maxTokens: { type: 'number' },
                effort: { type: 'string' },
                inputTokens: { type: 'number' },
                outputTokens: { type: 'number' },
                master: { type: 'boolean', required: true },
                self: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `mesh has ${value.agents.length} agent(s): ` + value.agents.map((a: { agentId: string; label?: string; status: string }) => `${a.agentId}${a.label ? ` (${a.label})` : ''}[${a.status}]`).join(', '),
      }],
    },
    async execute(_args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('agent_list requires a calling agent (exec.agent was undefined)')
      const view = await meshView(caller.id, exec.signal)
      const liveStatusOf = (id: string): string | undefined => ctx.agents.get(SessionId(id))?.status
      const rows = meshRosterRows({
        callerId: caller.id,
        root: view.root,
        descendants: view.entries,
        assignments,
        liveStatusOf,
      })
      // Live agents the durable catalog missed (a degraded enumeration, or an
      // in-memory spawn tree above the durable root) still belong in the roster.
      const listed = new Set(rows.map((row) => row.agentId))
      for (const agent of ctx.agents.list()) {
        if (listed.has(agent.id) || !inMesh(rootOf(caller.id), agent.id)) continue
        const assignment = assignments.get(agent.id) ?? undefined
        rows.push({
          agentId: agent.id,
          ...(assignment?.label !== undefined ? { label: assignment.label } : {}),
          status: agent.status,
          ...(assignment !== undefined ? { parent: assignment.spawnedBy } : {}),
          ...(assignment?.provider !== undefined ? { provider: assignment.provider } : {}),
          ...(assignment?.model !== undefined ? { model: assignment.model } : {}),
          ...(assignment?.maxTokens !== undefined ? { maxTokens: assignment.maxTokens } : {}),
          ...(assignment?.effort !== undefined ? { effort: assignment.effort } : {}),
          master: agent.id === view.root,
          self: agent.id === caller.id,
        })
      }
      // Usage attribution: sum assistant/message usage over each member's
      // session events (live snapshot first, persisted log otherwise), so the
      // roster shows what every mesh agent costs.
      const usageOf = async (id: string): Promise<{ inputTokens: number; outputTokens: number } | undefined> => {
        let events: readonly SessionEvent[] | undefined = ctx.sessions.get(SessionId(id))?.events
        if (events === undefined) {
          const persistence = ctx.get('sessionPersistence') as PersistenceReader | undefined
          if (persistence === undefined) return undefined
          try {
            events = await readPersistedEvents(persistence, SessionId(id), exec.signal)
          } catch {
            return undefined
          }
        }
        let inputTokens = 0
        let outputTokens = 0
        let seen = false
        for (const event of events) {
          if (event.type !== 'assistant/message') continue
          const usage = event.data.usage
          if (usage === undefined) continue
          inputTokens += usage.inputTokens
          outputTokens += usage.outputTokens
          seen = true
        }
        return seen ? { inputTokens, outputTokens } : undefined
      }
      const enriched = await Promise.all(rows.map(async (row) => {
        const usage = await usageOf(row.agentId)
        return usage === undefined ? row : { ...row, ...usage }
      }))
      return { agents: enriched }
    },
  }))

  // ── agent_trace ─────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'agent_trace',
    description:
      'Read any mesh agent\'s transcript — your own, your mesh root\'s, or any worker below it — rendered as a compact text trace: ' +
      'turn markers, user messages, assistant text and tool calls, and tool results with their tool names. ' +
      'A live agent serves its current in-memory log; a settled worker replays its persisted log — reading never wakes or activates the target. ' +
      'Prefer the worker\'s own agent_send report first; pull the trace when the report is insufficient or the worker settled without reporting. ' +
      'When truncated, page backward with before_seq = the previous read\'s next_before_seq.',
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: 'The agent id to read — your own, your mesh root\'s, or any worker\'s id (from agent_list, a childId from agent_spawn, or the mesh-orientation section).',
      },
      max_events: {
        type: 'number',
        description: 'Optional max session events to render for this read (default from plugin config).',
      },
      before_seq: {
        type: 'number',
        description: 'Optional: render only events with seq smaller than this; page backward from a truncated read.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agentId: { type: 'string', required: true },
          label: { type: 'string' },
          status: { type: 'string', required: true },
          eventCount: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
          nextBeforeSeq: { type: 'number' },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `agent_trace ${value.agentId}${value.label ? ` (${value.label})` : ''} [${value.status}] — ${value.eventCount} events${value.truncated ? `, older events exist (next before_seq ${value.nextBeforeSeq})` : ', complete'}\n\n${value.text}`,
      }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('agent_trace requires a calling agent (exec.agent was undefined)')
      const targetId = SessionId(args.agent_id)
      const maxEvents = Math.min(Math.max(args.max_events ?? config.traceMaxEvents, 1), 1000)

      // Mesh authorization: the caller itself, the durable mesh root, or any
      // session-backed child below that root (durable catalog, so settled
      // workers and workers from a previous host process remain traceable).
      const durableRoot = await durableRootOf(SessionId(caller.id), exec.signal)
      let label: string | undefined
      if (targetId !== caller.id && targetId !== durableRoot) {
        let descendants: SubagentDescendantListEntry[]
        try {
          descendants = await ctx.subagents.listDescendants(durableRoot, exec.signal)
        } catch (error) {
          throw new Error(
            `agent_trace: durable mesh enumeration is unavailable in this deployment `
            + `(${error instanceof Error ? error.message : String(error)}); only you and your mesh root are readable without it`,
          )
        }
        const entry = descendants.find((candidate) => candidate.id === targetId)
        if (entry === undefined || entry.kind !== 'child') {
          throw new Error(`agent_trace: "${args.agent_id}" is neither you nor an agent in your mesh`)
        }
        label = entry.label
      }

      let events: readonly SessionEvent[]
      const attached = ctx.sessions.get(targetId)
      if (attached !== undefined) {
        events = attached.events
      } else {
        // The augmentation types the service as always present, but a
        // deployment may mount no persistence backend; the registry then
        // returns undefined at runtime.
        const persistence = ctx.get('sessionPersistence') as PersistenceReader | undefined
        if (persistence === undefined) {
          throw new Error(`agent_trace: "${args.agent_id}" is not live and no session persistence is mounted; only live agents are readable`)
        }
        events = await readPersistedEvents(persistence, targetId, exec.signal)
      }

      const beforeSeq = args.before_seq
      const filtered = beforeSeq === undefined ? [...events] : events.filter((event) => event.seq < beforeSeq)
      const start = Math.max(0, filtered.length - maxEvents)
      const window = filtered.slice(start)
      const hasMore = start > 0
      const lines = window.flatMap((event) => traceEventLines(event, callNamesOf(events), config.traceMaxCharsPerBlock))
      let text = lines.join('\n')
      if (text.length > config.traceMaxTotalChars) {
        text = `…(earlier lines truncated)…\n${text.slice(text.length - config.traceMaxTotalChars)}`
      }
      const liveAgent = ctx.agents.get(targetId)
      const status = liveAgent === undefined ? 'ready' : liveAgent.status === 'running' ? 'running' : 'idle'
      return {
        agentId: targetId,
        ...(label !== undefined ? { label } : {}),
        status,
        eventCount: window.length,
        truncated: hasMore,
        ...(hasMore && window.length > 0 ? { nextBeforeSeq: window[0].seq } : {}),
        text,
      }
    },
  }))

  // ── agent_schedule ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'agent_schedule',
    description:
      'Arrange a timed wake-up message for yourself or any mesh agent: one-shot (delay_ms from now, or at_ms as an epoch-milliseconds timestamp) or repeating (every_ms, minimum 1000). ' +
      'Each delivery behaves like agent_send: the framed message arrives as the target\'s next turn, waking an idle target. ' +
      'Repeating ticks chain — a tick missed while the target is offline merges into the next one instead of piling up. ' +
      'Schedules are in-process only and do not survive a host restart. Use action "list" to review them and "cancel" to remove one.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'One of "schedule", "list", or "cancel".',
      },
      agent_id: {
        type: 'string',
        description: 'Target agent id for action "schedule" (default: yourself).',
      },
      message: {
        type: 'string',
        description: 'Message text delivered on each tick (action "schedule", required).',
      },
      label: {
        type: 'string',
        description: 'Optional display label shown in agent_schedule list rows.',
      },
      delay_ms: {
        type: 'number',
        description: 'One-shot: deliver once after this many milliseconds.',
      },
      at_ms: {
        type: 'number',
        description: 'One-shot: deliver once at this epoch-milliseconds timestamp (must be in the future).',
      },
      every_ms: {
        type: 'number',
        description: 'Repeating: deliver every this many milliseconds (minimum 1000).',
      },
      schedule_id: {
        type: 'string',
        description: 'The schedule id to remove (action "cancel", required).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          schedule: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              label: { type: 'string' },
              senderId: { type: 'string', required: true },
              agentId: { type: 'string', required: true },
              message: { type: 'string', required: true },
              everyMs: { type: 'number' },
              nextFireAt: { type: 'number' },
              firedCount: { type: 'number', required: true },
              skippedCount: { type: 'number', required: true },
              lastError: { type: 'string' },
            },
          },
          schedules: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string' },
                senderId: { type: 'string', required: true },
                agentId: { type: 'string', required: true },
                message: { type: 'string', required: true },
                everyMs: { type: 'number' },
                nextFireAt: { type: 'number' },
                firedCount: { type: 'number', required: true },
                skippedCount: { type: 'number', required: true },
                lastError: { type: 'string' },
              },
            },
          },
          cancelled: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.schedule !== undefined
          ? `scheduled ${value.schedule.id} → agent ${value.schedule.agentId}`
          : value.schedules !== undefined
            ? `active schedules: ${value.schedules.map((s: { id: string; agentId: string }) => `${s.id}→${s.agentId}`).join(', ') || '(none)'}`
            : `cancel: ${value.cancelled === true ? 'ok' : 'not found'}`,
      }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('agent_schedule requires a calling agent (exec.agent was undefined)')
      if (args.action === 'list') return { schedules: scheduler.list() }
      if (args.action === 'cancel') {
        if (args.schedule_id === undefined) throw new Error('agent_schedule cancel requires schedule_id')
        return { cancelled: scheduler.cancel(args.schedule_id) }
      }
      if (args.action !== 'schedule') throw new Error(`agent_schedule: unknown action "${args.action}"`)
      const message = args.message ?? ''
      if (message === '') throw new Error('agent_schedule schedule requires a non-empty message')
      const targetId = args.agent_id === undefined ? caller.id : SessionId(args.agent_id)
      if (targetId !== caller.id && !(await canAddress(caller.id, targetId, exec.signal))) {
        throw new Error('agent_schedule: target is not part of your orchestration mesh')
      }
      const row = scheduler.schedule({
        ...(args.label !== undefined ? { label: args.label } : {}),
        senderId: caller.id,
        agentId: targetId,
        message,
        ...(args.delay_ms !== undefined ? { delayMs: args.delay_ms } : {}),
        ...(args.at_ms !== undefined ? { atMs: args.at_ms } : {}),
        ...(args.every_ms !== undefined ? { everyMs: args.every_ms } : {}),
      })
      return { schedule: row }
    },
  }))

  // ── agent_harness ───────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'agent_harness',
    description:
      'Manage the continual harness: durable mesh memories, reusable worker templates (spawn with agent_spawn\'s template parameter), and prompt notes — with evidence-backed edits and rollback. ' +
      'Local scope (default) rides the session log; global scope is a cross-session store with an audit history, reserved for stable reusable lessons. ' +
      'Every create/update/delete must carry summary and rationale drawn from real trajectory evidence — prefer NO edit over speculative or one-off notes. ' +
      'Rollback reverse-replays a refinement\'s applied edits as a new audited refinement. The compact overview is always in your system prompt as {{mesh_harness}}.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'One of "list", "create", "update", "delete", or "rollback".',
      },
      scope: {
        type: 'string',
        description: 'Which store: "local" (this session, default) or "global" (cross-session; only stable, reusable lessons belong there).',
      },
      id: {
        type: 'string',
        description: 'Entry id, lowercase slug — required for create/update/delete.',
      },
      kind: {
        type: 'string',
        description: 'Entry kind for create: "memory" (mesh lessons), "worker" (reusable spawn template), or "prompt" (prompt note).',
      },
      title: {
        type: 'string',
        description: 'Short human-readable title.',
      },
      content: {
        type: 'string',
        description: 'Entry body — for worker templates this is the spawn prompt.',
      },
      route_provider: {
        type: 'string',
        description: 'Worker-template route: provider seed for agent_spawn.',
      },
      route_model: {
        type: 'string',
        description: 'Worker-template route: model seed for agent_spawn.',
      },
      route_max_tokens: {
        type: 'number',
        description: 'Worker-template route: maxTokens seed for agent_spawn.',
      },
      route_effort: {
        type: 'string',
        description: 'Worker-template route: effort seed (for the DeepSeek adapter: off/high/max).',
      },
      base_version: {
        type: 'number',
        description: 'Optimistic concurrency: the entry version you last saw; a mismatch rejects the edit with "entry changed during refinement planning".',
      },
      refinement_id: {
        type: 'string',
        description: 'The refinement id to roll back (action "rollback").',
      },
      summary: {
        type: 'string',
        description: 'What this change does — required for create/update/delete.',
      },
      rationale: {
        type: 'string',
        description: 'The trajectory evidence behind this change — required for create/update/delete.',
      },
      expected_outcome: {
        type: 'string',
        description: 'Optional: what should improve when this refinement helps.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: { type: 'array', items: HARNESS_ENTRY_SCHEMA },
          overview: { type: 'string' },
          refinement: HARNESS_REFINEMENT_SCHEMA,
          record: {
            type: 'object',
            additionalProperties: false,
            properties: {
              v: { type: 'number', required: true },
              seq: { type: 'number', required: true },
              refinement: HARNESS_REFINEMENT_SCHEMA,
            },
          },
        },
      },
      render: (_args, value) => {
        const refinement = (value as { refinement?: { id: string; trigger: string; edits: { applied: boolean }[] } }).refinement
        const entries = (value as { entries?: unknown[] }).entries
        return [{
          type: 'text',
          text: refinement !== undefined && refinement !== null
            ? `harness ${refinement.trigger} refinement ${refinement.id}: ${refinement.edits.filter((e) => e.applied).length} edit(s) applied`
            : entries !== undefined && entries !== null
              ? `harness entries: ${entries.length} (full bodies in the structured result)`
              : 'harness: nothing to report',
        }]
      },
      // The record is the durable storage for local-scope refinements: it
      // replays out of this session's log exactly like spawn records do.
      presentationMeta: (_args, value) => {
        const record = (value as { record?: HarnessRecord }).record
        return record !== undefined ? harnessMeta(record) : {}
      },
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('agent_harness requires a calling agent (exec.agent was undefined)')
      const scope = args.scope === 'global' ? 'global' : 'local'
      const callerEvents = (): readonly SessionEvent[] => callerEventsOf(caller.id)
      const meta = args.summary !== undefined && args.rationale !== undefined
        ? {
          summary: args.summary,
          rationale: args.rationale,
          ...(args.expected_outcome !== undefined ? { expectedOutcome: args.expected_outcome } : {}),
        }
        : undefined
      const route: HarnessRoute | undefined = args.route_provider !== undefined || args.route_model !== undefined || args.route_max_tokens !== undefined || args.route_effort !== undefined
        ? {
          ...(args.route_provider !== undefined ? { provider: args.route_provider } : {}),
          ...(args.route_model !== undefined ? { model: args.route_model } : {}),
          ...(args.route_max_tokens !== undefined ? { maxTokens: args.route_max_tokens } : {}),
          ...(args.route_effort !== undefined ? { effort: args.route_effort } : {}),
        }
        : undefined

      if (args.action === 'list') {
        const local = foldLocalHarness(callerEvents())
        const global = harnessStore.globalState()
        const state = scope === 'local' ? local : global
        return { entries: Object.values(state.entries), overview: harnessOverview(local, global) }
      }

      if (args.action === 'rollback') {
        if (args.refinement_id === undefined) throw new Error('agent_harness rollback requires refinement_id')
        if (scope === 'global') return { refinement: harnessStore.rollbackGlobal(args.refinement_id) }
        const state = foldLocalHarness(callerEvents())
        const target = state.refinements.find((refinement) => refinement.id === args.refinement_id)
        if (target === undefined) throw new Error(`agent_harness: refinement "${args.refinement_id}" not found in your local harness history`)
        const inverse: HarnessEdit[] = []
        for (const edit of target.edits.filter((candidate) => candidate.applied).reverse()) {
          if (edit.action === 'create') {
            inverse.push({ action: 'delete', id: edit.id, baseVersion: edit.after?.version })
          } else if (edit.action === 'update') {
            if (edit.before === undefined) continue
            inverse.push({
              action: 'update',
              id: edit.id,
              kind: edit.before.kind,
              title: edit.before.title,
              content: edit.before.content,
              // A before without a route cannot clear an existing route through
              // update semantics — that residue survives this rollback.
              ...(edit.before.route !== undefined ? { route: edit.before.route } : {}),
              baseVersion: edit.after?.version,
            })
          } else {
            if (edit.before === undefined) continue
            inverse.push({
              action: 'create',
              id: edit.before.id,
              kind: edit.before.kind,
              title: edit.before.title,
              content: edit.before.content,
              ...(edit.before.route !== undefined ? { route: edit.before.route } : {}),
              scope: 'local',
            })
          }
        }
        const { refinement, record } = planLocalHarness(callerEvents(), inverse, {
          summary: `rollback of ${args.refinement_id}`,
          rationale: `reverse-replays the applied edits of refinement ${args.refinement_id}`,
          trigger: 'rollback',
          rollbackOf: args.refinement_id,
        })
        return { refinement, record }
      }

      if (args.action !== 'create' && args.action !== 'update' && args.action !== 'delete') {
        throw new Error(`agent_harness: unknown action "${args.action}"`)
      }
      let kind: HarnessEdit['kind']
      if (args.kind === 'memory' || args.kind === 'worker' || args.kind === 'prompt') kind = args.kind
      else if (args.kind !== undefined) throw new Error(`agent_harness: kind must be "memory", "worker", or "prompt" (got "${args.kind}")`)
      if (meta === undefined) throw new Error('agent_harness create/update/delete require summary and rationale — evidence-backed edits only')
      const edit: HarnessEdit = {
        action: args.action,
        ...(args.id !== undefined ? { id: args.id } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.content !== undefined ? { content: args.content } : {}),
        ...(route !== undefined ? { route } : {}),
        ...(args.base_version !== undefined ? { baseVersion: args.base_version } : {}),
      }
      if (scope === 'global') {
        return { refinement: harnessStore.applyGlobal([edit], meta) }
      }
      const { refinement, record } = planLocalHarness(callerEvents(), [edit], meta)
      return { refinement, record }
    },
  }))

  // ── agent_interrupt ─────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'agent_interrupt',
    description:
      'Cancel the current turn of a live mesh agent, keeping its queued messages for later turns. ' +
      'Use it to stop work that has gone off track mid-task; combine with agent_send (optionally steer: true) to redirect the agent afterward. ' +
      'Cancelling an idle agent is a no-op that still reports success.',
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: 'The agent id of the running target (from agent_list, a childId from agent_spawn, or the mesh-orientation section).',
      },
      reason: {
        type: 'string',
        description: 'Optional short cause recorded with the interruption (visible in the target\'s transcript).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          interrupted: { type: 'boolean', required: true },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.interrupted
          ? `interrupt requested for agent ${_args.agent_id} (queued messages kept)`
          : `interrupt not applied: ${value.reason}`,
      }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('agent_interrupt requires a calling agent (exec.agent was undefined)')
      const targetId = SessionId(args.agent_id)
      if (targetId === caller.id) return { interrupted: false, reason: 'cannot interrupt yourself' }
      if (!(await canAddress(caller.id, targetId, exec.signal))) {
        return { interrupted: false, reason: 'target is not part of your orchestration mesh' }
      }
      const live = ctx.agents.get(targetId)
      if (live === undefined) {
        return { interrupted: false, reason: 'target is not online; nothing is running to interrupt' }
      }
      // The cancellation cause keeps the durable record honest: a spawner
      // cancelling its own child is the native 'parent' kind; any other mesh
      // member interrupts through the extensible 'hook' kind with attribution.
      const cause: AgentCancelCause = (await durableParentOf(targetId, exec.signal)) === caller.id
        ? { kind: 'parent' }
        : { kind: 'hook', reason: `orchestrator-mesh: interrupted by ${caller.id}${args.reason !== undefined ? ` — ${args.reason}` : ''}` }
      live.cancel(cause, { keepInbox: true })
      return { interrupted: true }
    },
  }))
}
