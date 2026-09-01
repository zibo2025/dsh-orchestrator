# DSH Web UI 架构侦察报告（worker 模板面板前期调研）

侦察范围：`/Users/zibo/MyFile/GitHub/deepseek-harness`（只读）。目标：为 DSH Web GUI 增加「worker 模板面板」（全局模板 / 会话模板两区），数据源为 dsh-orchestrator 插件的 continual-harness 状态。

---

## 1. 组件槽位机制（packages/client/ui-slots）

**结论：`ui-slots` 是纯注册表核心（无 React/Cordis 运行时依赖）。一个 UI 包通过「`declare module` 合并声明 `SlotMap`/`LocaleNamespaceMap` + 一次 `ctx.slots.register({name, children?, store?, inject?, locale?}, Component)` 调用」贡献组件。声明即占用：父条目的 `children` 表声明子槽位（kind: single/list/keyed/chain；scope: root/session-maybe/session），只有声明者能渲染该槽位。**

关键文件：
- `packages/client/ui-slots/src/index.ts` — `SlotCore.register()`（行 785-894）：load 时校验（未声明的槽位注册抛错、重复声明抛错、kind 约束）；返回 disposer，撤销时级联折叠子槽位。
  ```ts
  export class SlotCore {
    register(options: ErasedOptions, component: unknown): () => void {
      const rec = this.records.get(options.name)
      if (!rec?.spec) throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
      ...
  ```
- `packages/client/ui-slots/README.md` — "One `register({ name, children?, store?, inject?, ...kind }, Component)` call contributes a component into a declared slot..."

### 四份 props 组成（ComposedProps）
组件 props = runtime share（owner props + session 标准件）+ 子渲染 share（`renderSlot`）+ store share + inject 业务面 + locale `t`。session 作用域槽位自动获得 `sessionId`、`useSession`、`useProjection`（`SessionStandardProps`，由 ui-session 合并实现，见 `packages/client/ui-session/src/client/index.ts` 行 104-129）。

### 现有可挂的槽位（对「worker 模板面板」最相关的）
- `conversation.session.header.actions` — **list/session 作用域**。agent-team 面板先例：`packages/experimental/client-ui-agent-team/src/client/mount.ts` 行 66-76：
  ```ts
  ctx.slots.inject('conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions', id: 'agent-team', order: 20, locale: NS,
      inject: () => actions,
    }, TeamAction))
  ```
- `shell.overlay` — list/root 作用域，"additive seat for a frame-wide surface"（`packages/client/ui-layout/src/client/index.ts` 行 86、127）。
- `settings.section` — list/root 作用域（设置弹窗页）（`packages/client/ui-settings/src/client/contract/slots.ts` 行 54）。
- `sidebar.footer.action` — list/root（侧栏脚部动作图标）（`packages/client/ui-sidebar/src/client/contract/slots.ts` 行 46）。
- `tool.call.toolview` — **keyed/session，按 wire 工具名分发**：`packages/client/ui-tool/src/client/contract/slots.ts` 行 26：`'tool.call.toolview': { kind: 'keyed'; scope: 'session'; owner: ToolCallOwnerProps }`，注释明说 key 域开放（"any wire tool name, including a tool your own package registered"）→ **注册 `key: 'agent_harness'` 即可接管聊天流里 agent_harness 工具卡的渲染**。
- 声明全景：`ui-layout/src/client/index.ts`（root→sidebar/conversation/details/shell.overlay）、`ui-conversation/src/client/contract/slots.ts`（conversation.session.header.actions/lineage、conversation.input.dock、conversation.chat.node 等）。

### i18n 与样式
- i18n：`ctx.locale.register(NS, { zh, en })` + 注册时 `locale: NS`，组件 props 获得 typed `t`；词典键类型通过 `declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap {...} }` 合并（例：`ui-subagent/src/client/index.ts` 行 15-20、52）。
- 样式：CSS Modules（`X.module.css`），由客户端打包器（tsdown client 预置 + lightningcss）内联为带 `data-plugin-css` 的 `<style>` 注入（`packages/client/tsdown.client.ts` 的 `dsh-css-modules-inline` 插件）。

### 「新增一个面板」最小清单
1. `src/index.ts`：宿主半空 `export function apply(): void {}`。
2. `src/client/index.ts`：浏览器半 — `export const inject = ['slots', 'locale', ...]` + `export function apply(ctx)`：注册词典 + `ctx.slots.inject(<slot>, () => ctx.slots.register({name, id, order, locale: NS, inject}, Component))`。
3. `src/client/locales.ts`：`en/zh` 词典 + `declare module ... LocaleNamespaceMap` 合并。
4. `src/client/Panel.tsx` + `Panel.module.css`。
5. `package.json`：`exports["./client"]` → `./lib/client.js`；`dsh: { client: { inject: [...依赖的客户端包], platform: "web" } }`。
6. `tsdown.config.ts`：`clientBundle(id, [...])`（monorepo 内）。
7. 组合点：`packages/bundle/web-app/cordis.patch.yml` 加一行 roster（见 §2）。

---

## 2. 组合方式（ui-* 包如何进到运行中的应用）

**结论：组合点是宿主 Loader 的 patch 层。`packages/bundle/web-app/cordis.patch.yml` 的 `dsh.client` 浏览器 roster 里每个 `ui-*` 行同时是宿主行 + 浏览器行；`packages/client/modules`（node 半）扫描 Loader 条目对应 package.json 的 `dsh.client` 声明，把 `exports["./client"]` 指向的 bundle 组成 `window.__DSH_BOOT__` 图，经 `/plugins/??<ids>/client.js&rev=...` combo URL 下发。浏览器端 `packages/client/web/src/boot.ts`（AppWebEntry）读 `__DSH_BOOT__`、构造模块系统、用 Loader 激活全部条目、`ctx.uiRenderer.mount(container)`。**

关键文件：
- `packages/bundle/web-app/cordis.patch.yml` 行 146-153：
  ```yaml
  # ── browser plugin roster (dsh.client rows; node halves are layer-2 hosts) ──
  - id: modules
    name: '@deepseek-ai/dsh-client-modules'
  ```
  及 `ui-subagent` 行 250-251、`ui-goal` 行 267-269。注释（行 41-42）："`dsh.client` rows are the browser roster the modules node half scans into window.__DSH_BOOT__"。
- `packages/client/modules/src/index.ts` — `ClientModuleRegistry`（行 533+）：`static inject = ['webServer', 'loader']`；扫描机制：订阅 `internal/plugin`，按 Loader 条目名增量 reconcile；`resolveMeta` 读 package.json 的 `dsh.client`（platform 必须为 `web`）+ `exports["./client"]`（行 738-773）；`bootInjections` 产出 `window.__DSH_BOOT__` 注入（行 489-524）；bundle 服务路由 `/plugins`（行 586）。
- `packages/client/web/src/boot.ts` — `AppWebEntry.run()`：`__ModuleLoader__.create({boot: win.__DSH_BOOT__, staticModules: getStaticModules(), ...})` → `ctx.plugin(Loader)` → 每条 roster 行 `loader.create({name})` → `uiRenderer.mount`。
- `apps/web` — Vite 壳：`apps/web/src/main.ts` 仅 `new AppWebEntry(el).run()`；构建产物 `dist/` 由 `dsh-web-app`（web-runtime 行）静态兜底服务。
- 静态种子表：`packages/client/web/src/platform.ts` 行 8-13 `PLATFORM_MODULES = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives']`——这些是每个客户端 bundle 的隐式 externals；其他客户端包面（如 `@deepseek-ai/dsh-client-locale/client`）须在 `dsh.client.external` 里声明（打包保持 external，运行时由模块表 require 解析）。

**新增 UI 包要动的组合点（monorepo 内）**：① `packages/bundle/web-app/cordis.patch.yml` 插一行；② 根 `tsconfig.client.json` references 加包（类型聚合）；③ 包内 `tsdown.config.ts` 用 `clientBundle()`；④ `pnpm run build` / `dev:web` 会自动发现（dev-web.ts 按 `dsh.client.platform==='web'` 扫描 `packages/*/*/package.json`）。**apps/web 与 packages/client/web 都不用改。**

---

## 3. 数据通道

**结论：一切客户端数据走「Typert Gateway RPC」（HTTP `/api` + WebSocket `/api/remote.mux`），由 `ctx.remote.<namespace>.<method>` 生成方法调用；会话事件流（含 `tool/result` 的 `data.meta`，即 presentationMeta）以原始 SessionWireEvent 形式完整下发到客户端（RemoteJournalStream），客户端每会话持有 `session.eventSource`（getSnapshot+subscribe 的 HostObservable）——前端可以直接折叠 agent_harness 的 presentationMeta 记录。**

- ui-subagent 数据：`ctx.sessions`（session-controller 客户端适配器）— 子代理目录通过生成 Remote `this.remote.subagents.list(parentSessionId)`（`packages/api/session-controller/src/client/sessions/manager.ts` 行 351-362）；打开/导航 `sessions.openSubagent(...)`。头注释（ui-subagent `src/client/index.ts` 行 29-64）。
- ui-goal 数据：`useProjection('goal')`（宿主算好的会话 projection，随 control frames 更新）+ 写操作走生成 Remote `ctx.remote.goals.edit/pause/resume/clear`（`ui-goal/src/client/index.ts` 行 60-108）。projection key 由宿主 provider 计算（`SessionProjectionMap` 声明合并，`packages/api/session-controller/src/types.ts` 行 25-34）——新增 projection key 是宿主侧工作，较重。
- **presentationMeta 的可见性**：
  - 工具 `output.presentationMeta` 在成功时写入结果 `meta` 字段：`packages/core/tools/src/index.ts` 行 1797-1811（`if (exec.parent === undefined && tool.output.presentationMeta !== undefined) { ... meta = snapshotProjection(...) }`，行 1811 `...meta !== undefined ? { meta } : {}`）。
  - wire 事件类型：`packages/core/session/src/types.ts` 行 275-281：`'tool/result': { turn; step; message; error?; meta?: JsonValue }`，注释确认 "meta … MUST be JSON-serializable … the durable log reproduces the identical card on replay"。
  - session-controller README 明示透传：**"Tool arguments, result content, failures, and `tool/result.data.meta` pass through unchanged; the controller does not resolve a Tool definition, run a presenter, or attach UI data."**
  - 客户端每会话事件窗：`packages/api/session-controller/src/client/sessions/session.ts` 行 125 `readonly eventSource = new MutableSessionEventSource()`（`contract/events.ts` 行 95+：`getSnapshot(): SessionEventWindow` + `subscribe`，窗口条目 `{type:'event', event: SessionWireEvent}` / `{type:'chunks', ...}`）。ui-goal 已用 `sessions.binding(sessionId)?.session.projections.faceOf(...)` 访问同源对象（`binding().session` 即 ClientSession）。
  - 聊天内的工具卡已按 `block.meta` 渲染（`ui-tool/src/client/tool/models/web-card-model.ts` 行 61 等）。
- 转发宿主事件：`ctx.remote.$on(key, listener)`（allowlist：`packages/api/remotes/src/remote-events.ts` 的 `API_REMOTE_FORWARDED_EVENTS`）——ui-settings-plugins 用它监听 `settings/document-updated` 等（`ui-settings-plugins/src/client/index.ts` 行 78-90）。

**⇒ 会话模板（local scope）可以在前端直接折叠**：遍历 `session.eventSource.getSnapshot()` 里的 `tool/result` 事件，取 `data.meta.mesh === 'agent-harness'` 的 `meta.harness` 记录重放（与宿主侧 `foldLocalHarness` 同算法，见 dsh-orchestrator `src/harness-records.ts` 行 232-241 `harnessRecordsOf`）。

---

## 4. client-plugin 机制（第三方插件能否贡献 GUI 面板）

**结论：能，无需进 monorepo。机制完全按 package.json 元数据驱动：任何被 Loader 激活的条目，其包 manifest 声明 `dsh.client.platform='web'` + `exports['./client']`，client-modules 就把它的浏览器 bundle 纳入 roster。先例：`packages/experimental/agent-team-web-profile`（一个只有 cordis.patch.yml 的 profile 包，`pnpm dsh plugin --profile web add ./...` 装配）插入一行挂载 `@deepseek-ai/dsh-experimental-client-ui-agent-team` 浏览器插件。**

- 先例装配：`agent-team-web-profile/README.md`（行 30-37）：
  ```sh
  pnpm dsh plugin --profile web add ./packages/experimental/agent-team-profile
  pnpm dsh plugin --profile web add ./packages/experimental/agent-team-web-profile
  ```
- 其 `cordis.patch.yml` 全文：`- insert: [- id: ui-agent-team, name: '@deepseek-ai/dsh-experimental-client-ui-agent-team']`。
- 浏览器插件注册面板：`client-ui-agent-team/src/client/mount.ts`（见 §1 摘录）——第三方客户端包自带 `dsh.client` 声明（其 package.json `dsh.client.inject` 含它依赖的客户端包），Remote 通过 `ctx.remote.$mount(agentTeamsRemote)` 挂载**自己包生成的 `/remote` 产物**（`src/client/index.ts` 行 3、12-14）。
- client-modules 的解析对第三方中立：`locatePkgJson` 用 Loader 的 ESM 解析（`internal.resolveSync`）定位包根再读 manifest（`packages/client/modules/src/index.ts` 行 786-821）——通过 `~/.dsh/profiles/web/package.json` 的 `link:` 依赖同样成立。
- **本机现状**：`~/.dsh/profiles/web/package.json` 已有 `"dsh-orchestrator": "link:/Users/zibo/MyFile/gitee/dsh-orchestrator"` 且 bundles 含 `dsh-orchestrator`；dsh-orchestrator 的 `cordis.patch.yml` 已插入 `- id: orchestrator, name: dsh-orchestrator` 行。**只要给 dsh-orchestrator 的 package.json 加 `dsh.client` 声明 + 产出 `lib/client.js`，现有 `orchestrator` 行立刻同时成为浏览器 roster 行**（web-app patch 行 41-42 注释明说这种双面性；client-modules 按包 manifest 而非行形状判定）。
- 客户端 bundle 契约（第三方需自建）：CJS + banner/footer（`packages/client/tsdown.client.ts` `clientConfig`）：
  ```
  banner: `window.__ModuleLoader__.load({ id: "<pkg>", factory: (require) => {`
  footer: 'return module.exports; } });'
  intro:   'var module = { exports: {} }; var exports = module.exports;'
  ```
  外部依赖规则：`deps.neverBundle = isRequested`（baseline + `dsh.client.external`），其余内联；纯度门禁禁止未声明的跨插件值导入。第三方用 tsdown/rolldown 复刻该 banner 即可（monorepo 的 `clientBundle()` 预置不是硬依赖，只是最方便）。

---

## 5. 服务端 API（宿主路由 / Remote）

**结论：两条路。A) 类型化 Remote：宿主 Service 继承 `TypertRemoteService`、方法标 `@Remote('name')`，经生成 `/remote` 产物挂到 Gateway `/api`（客户端 `ctx.remote.$mount()` 或由 api-remotes 装配）。B) 裸 HTTP 路由：任何宿主插件可 `ctx.webServer.register({kind:'exact'|'prefix', path, handler})`（webServer 服务），client-modules 自己就用它服务 `/plugins`。ui-settings-plugins 的数据接口是 settings-controller Remote + `ctx.settingsScope` 镜像。**

- Gateway：`packages/api/gateway/README.md` — "registers a trusted-host interceptor on Connection's shared `/api` FetchHandler"；业务 Service `extend TypertRemoteService`，方法 `@Remote`/`@RemoteScope`；WebSocket `/api/remote.mux`。
- 最小 Remote 先例：`packages/host/plugin-inventory/src/index.ts` 行 45-65：
  ```ts
  export class PluginInventoryGateway extends TypertRemoteService {
    static inject = ['loader']
    constructor(ctx: Context) { super(ctx, 'pluginInventory') }
    @Remote('list')
    ...
  ```
- 裸路由 API：`packages/host/webserver/src/index.ts` 行 165-202（`register(route: WebRoute)`、`registerUpgrade`、`registerFallback`；重复路径抛错）。SSE 也可（client-hmr 行 176-189 注册 `/plugins/events`）。
- ui-settings-plugins 数据：`ctx.settingsScope.bind({namespace})`（settings-controller Remote 提供的镜像，`ui-settings-plugins/src/client/index.ts` 行 57、68-74）+ `ctx.remote.$on` 失效通知。
- **对 worker 模板面板**：dsh-orchestrator 已是宿主插件，读全局 harness JSON（`~/.dsh/orchestrator/harness_state.json`，`src/harness.ts` 行 310-321 HarnessStore）最省事的是 B 方案——注册一个 exact 路由（如 `/plugins/orchestrator/harness.json`）只读输出 globalState()（loopback 绑定 + client-modules 无鉴权先例）；要类型化/带失效推送则走 A（生成 remote 产物较重，agent-team 有先例可抄）。

---

## 6. 构建与热更（让 3080 GUI 看到变化）

**结论：改 monorepo `packages/client/*` → 跑 `pnpm run dev:web`（= `tsx scripts/dev-web.ts --poll`，根 package.json 行 157）：三段增量（tsc -b tsconfig.client.json 出 lib/types → tsdown 出 lib/index.js+lib/client.js → vite build 重写 apps/web/dist）。宿主 webserver 的 client-hmr 行每 500ms stat-poll 它服务的每个 client bundle，文件变化即 `clientModules.rebuilt(id)` → SSE `rebuilt` 帧 → 浏览器半 HMR 原地换 fiber（不刷新页面）。前提：先跑过一次 `pnpm run build`；`dev:web` 不可与 `build` 并行。**

- `scripts/dev-web.ts` 头注释："the host webserver stat-polls the bundles it serves and broadcasts `rebuilt` frames itself (`dsh web`), so any process that rewrites `lib/client.js` files triggers reloads"。注意 dev-web.ts 只扫 DSH repo 的 `packages/*/*/package.json`——**第三方 dsh-orchestrator 不在其 watch 集，但 client-hmr 的 stat-poll 覆盖图中每个 roster 行的 bundle 路径**（`packages/client/hmr/src/index.ts` 行 109-156，watch 集来自 `ctx.clientModules.graph().entries`），所以只要 dsh-orchestrator 自己的构建 watch 重写 `lib/client.js`，GUI 即热更。宿主行（src/）改动则需重启 `dsh web`（宿主插件由 tsx 直接跑 src，无宿主 HMR）。
- 浏览器 HMR 语义：`packages/client/hmr/src/client/index.ts` — rebuilt → invalidate → prefetch → 换 fiber 级联，"shell changes still mean a page reload"。
- 当前 GUI：`pnpm dsh web` = `node --import tsx/esm apps/cli/src/bin.ts web`（根 package.json 行 153），从 checkout 启动、读 `~/.dsh/profiles/web`。

---

## 7. 推荐实现路径（worker 模板面板）

### 放在哪
- **dsh-orchestrator 单包双面**（不进 DSH monorepo）：
  1. `package.json` 增加：
     ```json
     "exports": { ..., "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" } },
     "dsh": { "bundle": {...保留...}, "client": {
       "inject": ["@deepseek-ai/dsh-api-session-controller", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-ui-session"],
       "platform": "web"
     } }
     ```
     （inject 数组即 cordis 客户端 fiber 的服务等待，参考 `ui-subagent/package.json` 行 32-43。）
  2. 新建 `src/client/index.ts`（浏览器半 apply）、`src/client/HarnessPanel.tsx` + `.module.css`、`src/client/locales.ts`。宿主半 `src/index.ts` 不动。
  3. 新建 `src/client/harness-fold.ts`：把宿主 `harness-records.ts` 的纯折叠逻辑（`harnessRecordsOf`/`replayRefinement`）以浏览器安全形式复用（该文件是纯函数、无 node 依赖，可直接 import 或复制）。
  4. 构建脚本：加 tsdown（或 rolldown）配置产出 `lib/client.js`，复刻 §4 的 banner/footer/intro，externals = react/cordis/ui-slots/ui-primitives/client-store + `dsh.client.external`。
- 现有 `cordis.patch.yml` 的 `orchestrator` 行无需改动（自动成为双面行）；`~/.dsh/profiles/web` 已链接，无需重新装配。

### 面板挂点（两选一，推荐 a）
- **a. `conversation.session.header.actions`**（list/session）：会话头加「模板」按钮弹出面板——agent-team 同款先例，天然有 sessionId，可折叠会话模板。注册形如 `ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'harness-templates', order: 30, locale: 'harness', inject }, HarnessAction))`。
- b. `shell.overlay` 或 `settings.section`（root 作用域、无会话依赖）——若希望无会话也能看全局模板。

### 数据怎么流
- **会话模板（local）**：纯前端折叠——`ctx.sessions.binding(sessionId)?.session.eventSource`（HostObservable）→ snapshot 遍历 `tool/result` 事件，过滤 `data.meta?.mesh === 'agent-harness'`，按 seq 重放 `meta.harness.refinement.edits`（与宿主 `foldLocalHarness` 同构）。用 `ctx.slots` 的 hooks/inject 面或 `useSyncExternalStore` 直接订阅。注意事件窗 hasMore 时旧页未载入（v1 可接受，或提示“更早记录未加载”）。
- **全局模板（global）**：宿主半在 dsh-orchestrator `apply` 里注册只读路由：
  ```ts
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/plugins/orchestrator/harness.json',
    handler: (_req, res) => { res.writeHead(200, {'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(harnessStore.globalState())) },
  }), 'orchestrator: harness state route')
  ```
  （需 `inject: ['webServer', ...]` 或 `ctx.inject(['webServer'], ...)`；webserver 行仅在 web 组合存在——TUI 下缺席时跳过注册。）客户端 `fetch('/plugins/orchestrator/harness.json')`。写操作 v1 不做（让 agent 走 agent_harness 工具），或后续升级为 Typert Remote。
- **可选增强**：注册 `key: 'agent_harness'` 的 `tool.call.toolview`（keyed 槽），把聊天流里的 agent_harness 工具卡渲染为精简的 harness 变更摘要（数据就在 `block.meta`）。

### 热更闭环
- dsh-orchestrator 加 `"watch": "tsc -b --watch + 客户端 bundle watch"`：重写 `lib/client.js` → 宿主 client-hmr stat-poll（500ms）捕获 → SSE rebuilt → 浏览器换 fiber。宿主半改动（如新增 webServer 路由）需重启 `dsh web`。

### 风险与注意
- 客户端 bundle 纯度门禁：除 baseline externals 与 `dsh.client.external` 声明的 `@deepseek-ai/*` 外，值导入一律 build error（tsdown.client.ts `dsh-client-bundle-purity`）——第三方自建打包须遵守同一规则，运行时模块表才能解析。
- `lib/client.js` 缺失时 client-modules 启动即抛（"run `pnpm run build` before launch"）；第三方包必须保证发布/开发时都产出该文件。
- 同一包多 Loader 源会抛 "resolves from multiple active Loader sources"（compose 冲突防护）。
- 会话事件窗 `chunks` 打包条目只覆盖 assistant chunk 增量，`tool/result` 始终是单事件（`type:'event'`），折叠逻辑不受影响。
