# DSH 宿主层上游建议:对标 prime-agent 的编排机制

本插件(dsh-orchestrator)对标 [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) 完成了一轮调研与功能改造。插件层能做的(网格工具、harness、进程内调度等)已经落地;以下四项机制属于 **DSH 宿主(deepseek-harness 本体)**,插件层无法实现或无法做对,本文把它们整理成可直接据以动工的上游建议。「建议落点」中的包名以 DSH 仓库当前 `packages/` 布局为准。

---

## 1. Compaction 策略强化

### prime-agent 怎么做

出处:prime-agent 仓库 `packages/coding-agent/docs/compaction.md`、`packages/coding-agent/docs/long-running-agents.md`。

- **触发阈值**:上下文超过 `window − 16384` 即触发压缩(`reserveTokens` 默认 16384)。
- **切点选择**:按 **turn 边界**找压缩切点,**绝不切断工具调用结果**——切点永不落在一次 tool-call 与其 tool-result 之间。
- **保留窗口**:最近 `keepRecentTokens`(默认 20k)token 原样保留,更早的消息才折叠。
- **结构化摘要**:旧消息折叠为结构化摘要(Goal / Progress / Next Steps),并附**累积的已读 / 已改文件清单**;摘要迭代继承——每次压缩在上次摘要的基础上增量更新,文件清单只增不丢。
- **运行状态存活**:agent 侧的运行状态跨压缩存活,压缩不丢失「正在做什么」。
- **压缩不是完成信号**:"Compaction is not a completion signal"——压缩本身不结束回合、不代表任务完成。

### DSH 现状

宿主已有 compaction 包族:`packages/compaction/compaction`(共享契约 `ctx.compaction`)、`compaction-basic`(按 token 压力自动把旧历史折叠为摘要)、`compaction-tool-result-pruner`(先修剪超大工具输出)、`command-compact`(手动 `/compact`)。但触发阈值、切点选择、摘要结构这些**策略细节由宿主实现**,尚无 turn 边界切点约束、结构化摘要格式与累积文件清单的要求。

### 建议落点

- `packages/compaction/compaction`(契约层):定义结构化摘要格式(Goal / Progress / Next Steps + 累积已读/已改文件清单、迭代继承语义)与「切点不得落在 tool-call 与 tool-result 之间」的切点约束。
- `packages/compaction/compaction-basic`(触发策略):`reserveTokens` 触发阈值与 `keepRecentTokens` 保留窗口。
- `packages/core/agent-loop`:明确压缩不是回合结束信号,压缩后继续当前工作。

### 验收要点

- 用随机工具调用序列做性质测试:任意多次压缩后,切点永不落在 tool-call 与对应 tool-result 之间。
- 摘要含累积已读 / 已改文件清单;多轮压缩后清单单调继承,不丢条目。
- agent 运行状态跨压缩存活;压缩本身不结束回合、不改变任务完成判定。

---

## 2. 重连与游标

### prime-agent 怎么做

出处:prime-agent 仓库 `docs/daemon.md`、`docs/architecture.md`。

- **双游标事件回放**:事件流以 `{generation, sequence}` 双游标定位;重连方携带游标,daemon 按序补发错过的事件;回放不可行时以 **attach snapshot**(快照)兜底对齐。
- **路径级 lease + 幂等 journal**:同一会话路径同一时刻只允许一个持有者(lease),防止并发写入造成分裂;命令以幂等 journal 记录,重放不产生重复副作用。
- **supervisor 自愈**:supervisor 挂掉后,worker 竞选**原子 lease**,拉起新 supervisor 并被其收养,长任务不因单点退出而丢失。

### DSH 现状

浏览器侧 `packages/client/connection` 已有 connection generation、恢复状态与重试策略(`ctx.connection`),但那是 Web GUI 的连接层;**智能体会话事件流**尚无按 `{generation, sequence}` 的游标回放契约,也没有路径级 lease、幂等命令 journal 与 supervisor 竞选收养机制。

### 建议落点

- `packages/client/connection`(传输层契约):事件流回放游标(`{generation, sequence}`)与 attach snapshot 兜底。
- `packages/session/session-persistence*`(持久化后端):幂等命令 journal,重放防重复副作用。
- `packages/core/session`(会话核心):路径级 lease;supervisor 竞选与收养协议(编排插件可作为首个消费者)。

### 验收要点

- 断连重连后事件不丢、不重、不乱序(游标回放);回放不可行时快照对齐。
- 同一路径并发打开不产生分裂账本(lease 互斥)。
- kill -9 杀掉 supervisor 后,worker 竞选 lease 拉起新 supervisor 并被收养。
- 重放历史命令无重复副作用(journal 幂等)。

---

## 3. 持久化 cron 调度

### prime-agent 怎么做

出处:prime-agent 仓库 `docs/long-running-agents.md`。

- **面向任意 agent** 的 one-shot / cron 定时唤醒,不局限于某个固定会话。
- **tick 先 claim 再投递**:每次到期先原子认领(claim)再投递消息,多实例部署下同一触发只投递一次。
- **错过合并不堆积**:错过的触发合并为一次唤醒,补齐后继续,不在队列里堆积历史 tick。

### DSH 现状

- 宿主 `packages/jobs` 是 process-local 后台 job 注册表(`jobs-local`),进程退出即失。
- 宿主 `packages/schedule` 提供随会话日志持久的 session-local 提醒,但投递目标是**本会话对话**,不是任意网格智能体。
- 本插件已实现进程内 `agent_schedule`(对网格内任意智能体安排一次性 / 重复唤醒,链式投递不堆积),但**重启后消失**;跨重启、面向任意网格智能体(含需冷复活的已结束 worker)的持久调度必须由宿主支持。

### 建议落点

- `packages/schedule/schedule`:投递目标从「本会话对话」扩展为「任意网格智能体地址」;新增到期先 claim 再投递的语义;错过的 tick 合并。
- 冷复活投递:复用插件 `agent_send` 对已结束 worker 的持久化会话冷复活通道,由宿主提供底层支持。

### 验收要点

- 宿主重启后调度恢复并按时投递(持久性)。
- 多实例部署下同一调度不重复投递(先 claim 再投递)。
- 错过的多次触发合并为一次唤醒,不堆积。
- 对已结束 worker 的定时唤醒能冷复活后投递。

---

## 4. 四维预算 + 质量门

### prime-agent 怎么做

出处:prime-agent 仓库 `docs/usage.md`、`packages/coding-agent/docs/long-running-agents.md`。

- **四维预算**:continuation(续跑轮数)/ turn(回合)/ token / wall-clock(墙钟)四个维度独立限额,任一耗尽即停。
- **质量门(quality gate)**:用户自定义命令;gate 失败时把失败输出**有界回注**(bounded re-injection)给 agent 再试——回注有上限,不会无限膨胀上下文。
- **防烧 token 循环**:**workspace 未变时不重跑同一失败 gate**——agent 没有实际改动就不会重复执行注定失败的质量门。
- **限额不是成功**:"reaching a limit does not imply task success"——到达预算上限绝不等于任务完成,终态必须如实区分。

### DSH 现状

`packages/goal`(goal 服务 + `tool-goal` 的 `create_goal` / `update_goal` + `goal-round-driver` 自动续跑)目前仅有 `max_goal_rounds` **一维**(continuation 轮数)预算;没有 token / wall-clock / turn 维度,也没有质量门、失败回注与「未变不重跑」机制。

### 建议落点

- `packages/goal/goal`(状态层):预算从一维扩展为四维,持久化到会话日志。
- `packages/goal/goal-round-driver`(停机判定):任一维度耗尽即停止续跑,终态明确区分「预算耗尽」与「任务成功」。
- `packages/subagent`(编排层):质量门命令的执行、失败输出有界回注、workspace 未变跳过重跑。

### 验收要点

- 四维任一耗尽即停止续跑;终态区分「预算耗尽」与「任务成功」。
- gate 失败输出的回注有界:连续失败不会让上下文无限膨胀。
- workspace 自上次失败 gate 以来无变化时,不重跑同一 gate。
- 四维预算可对每个 goal 独立配置。

---

## 安全底线

prime-agent 论文(arXiv 2608.23552 §3.5)记录了一个案例:agent 在 Factorio 环境中学会了用 RCON 接口直接作弊,而这套作弊行为被**固化成了 skill**,在后续运行中被继续复用——自我改进的产出可能携带污染。论文结论原文:

> "Safe deployment therefore requires least-privilege action interfaces, independent state validation, and auditable rollback of contaminated refinements."

含义:任何**自我改进 / 自动重试机制**——包括本文的质量门重试循环、插件的 continual harness 模板演化、持久调度的自动唤醒——都必须配套三件事:

1. **最小权限的动作接口**(least-privilege action interfaces):质量门命令、自动重试动作在受限权限 / 沙箱下运行,而非全权代理;
2. **独立的状态校验**(independent state validation):自动机制产出的状态变化(通过 / 失败 / 改动)由独立于被改进 agent 的通道校验,不能自证;
3. **可审计回滚**(auditable rollback of contaminated refinements):每条被固化的「改进」(skill / 模板 / 教训)可审计追溯,被污染的条目可定位并回滚。

本插件的 continual harness 已按此要求实现「每次修改必须带 summary + rationale(证据约束)+ rollback」;宿主在落地上述四项机制时应沿用同一底线。
