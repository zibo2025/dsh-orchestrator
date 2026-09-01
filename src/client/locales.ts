/**
 * Copy for the browser-half mesh panel: one namespace registered with the
 * locale service at plugin load (`locale: NS` on the slot registration),
 * two balanced dictionaries (zh/en) whose key union is {@link HarnessKey}.
 */

/** Namespace this plugin owns in the locale dictionary registry. */
export const NS = 'mesh' as const

/** Dictionary key union of the `mesh` namespace. */
export type HarnessKey =
  | 'view.mesh'
  | 'header.tagline'
  | 'section.features'
  | 'section.members'
  | 'section.templates'
  | 'docs.meta'
  | 'member.spawned'
  | 'members.footnoteBefore'
  | 'members.footnoteAfter'
  | 'members.empty'
  | 'localSection'
  | 'globalSection'
  | 'badge.global'
  | 'olderNotLoaded'
  | 'refreshGlobal'
  | 'copyId'
  | 'copyIdTitle'
  | 'copied'
  | 'copyFailed'
  | 'empty.title'
  | 'empty.hint'
  | 'empty.docs'
  | 'loading'
  | 'loadFailed'
  | 'kind.worker'
  | 'kind.memory'
  | 'kind.prompt'
  | 'tool.agent_spawn'
  | 'tool.agent_send'
  | 'tool.agent_broadcast'
  | 'tool.agent_interrupt'
  | 'tool.agent_list'
  | 'tool.agent_trace'
  | 'tool.agent_harness'
  | 'tool.agent_schedule'
  | 'protocol.title'
  | 'protocol.turns'
  | 'protocol.report'
  | 'protocol.lead'

/** Translate function of the `mesh` namespace (the framework `t` seat). */
export type TranslateHarness = (key: HarnessKey, params?: Record<string, unknown>) => string

/** Dictionary shape: every key of the namespace, no extras. */
export type HarnessDict = Record<HarnessKey, string>

/** Simplified Chinese dictionary (default alongside en). */
export const zh: HarnessDict = {
  'view.mesh': '网格',
  'header.tagline': '多智能体编排:主智能体分解分派,worker 执行,任意成员互通',
  'section.features': '功能说明',
  'section.members': '网格成员',
  'section.templates': '模板',
  'docs.meta': '8 个工具 · 3 条协议要点',
  'member.spawned': '已派生',
  'members.footnoteBefore': '实时状态以',
  'members.footnoteAfter': '为准',
  'members.empty': '本会话还没有派生记录',
  localSection: '会话模板',
  globalSection: '全局模板',
  'badge.global': '全局',
  olderNotLoaded: '有更早记录未加载',
  refreshGlobal: '刷新全局模板',
  copyId: '复制 id',
  'copyIdTitle': '点击复制 id',
  copied: '已复制',
  copyFailed: '复制失败',
  'empty.title': '暂无模板',
  'empty.hint': '会话内派生的 worker 可经 agent_harness 持久化为模板',
  'empty.docs': '查看功能说明',
  loading: '加载中…',
  loadFailed: '全局模板加载失败',
  'kind.worker': 'worker',
  'kind.memory': 'memory',
  'kind.prompt': 'prompt',
  'tool.agent_spawn': '派生 worker,可指定模型/思考强度/模板',
  'tool.agent_send': '成员互发消息,steer 可运行中插话',
  'tool.agent_broadcast': '全体在线成员广播',
  'tool.agent_interrupt': '中止某成员当前回合(队列保留)',
  'tool.agent_list': '网格花名册与每成员 token 用量',
  'tool.agent_trace': '只读查看任意成员轨迹',
  'tool.agent_harness': '持久化模板/教训/注记,带审计与回滚',
  'tool.agent_schedule': '一次性或重复定时唤醒',
  'protocol.title': '协议要点',
  'protocol.turns': '消息为下一回合(steer / interrupt 例外)',
  'protocol.report': 'worker 完成即回报派生者',
  'protocol.lead': '主智能体汇总并对外负责',
}

/** English dictionary. */
export const en: HarnessDict = {
  'view.mesh': 'Mesh',
  'header.tagline': 'Multi-agent orchestration: the lead decomposes and delegates, workers execute, every member can reach every other',
  'section.features': 'What it does',
  'section.members': 'Mesh members',
  'section.templates': 'Templates',
  'docs.meta': '8 tools · 3 protocol notes',
  'member.spawned': 'spawned',
  'members.footnoteBefore': 'Live status is authoritative via',
  'members.footnoteAfter': '',
  'members.empty': 'No spawns recorded in this session yet',
  localSection: 'Session templates',
  globalSection: 'Global templates',
  'badge.global': 'global',
  olderNotLoaded: 'Earlier records are not loaded',
  refreshGlobal: 'Refresh global templates',
  copyId: 'Copy id',
  'copyIdTitle': 'Click to copy id',
  copied: 'Copied',
  copyFailed: 'Copy failed',
  'empty.title': 'No templates yet',
  'empty.hint': 'Workers spawned in a session can be persisted as templates via agent_harness',
  'empty.docs': 'View what it does',
  loading: 'Loading…',
  loadFailed: 'Failed to load global templates',
  'kind.worker': 'worker',
  'kind.memory': 'memory',
  'kind.prompt': 'prompt',
  'tool.agent_spawn': 'Spawn a worker with an optional model, reasoning effort, or template',
  'tool.agent_send': 'Send any member a message; steering interjects mid-turn',
  'tool.agent_broadcast': 'Broadcast to every live member at once',
  'tool.agent_interrupt': "Cancel one member's current turn (queued messages kept)",
  'tool.agent_list': 'Mesh roster with per-member token usage',
  'tool.agent_trace': "Read any member's transcript without waking it",
  'tool.agent_harness': 'Durable templates, lessons, and notes with audit and rollback',
  'tool.agent_schedule': 'One-shot or repeating timed wake-ups',
  'protocol.title': 'Protocol in brief',
  'protocol.turns': 'A message becomes the receiver\'s next turn (steer and interrupt excepted)',
  'protocol.report': 'A worker reports back to its spawner the moment it finishes',
  'protocol.lead': 'The lead agent aggregates worker results and owns the user-facing conclusion',
}
