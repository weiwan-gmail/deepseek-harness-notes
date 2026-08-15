# 20 · Web / client 接到 session/event

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[19 compaction-context](19-compaction-context.md) · 下一篇：主干完结

读的是 DeepSeek Harness 真正跑的那套「浏览器怎样接到会话事件」的缝，不是自己再发明一套 SPA。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 钉住 | `master` @ `47f943859bef60e4160492346772ded9b24f765a`（`dsh@0.1.0-rc.5`；与 19 相同，已重核 HEAD） |
| 家族说明 | `packages/client/README.zh.md`（浏览器半侧）；宿主半侧是 `packages/host/` |
| 启动 | `packages/client/web`（`AppWebEntry`；`window.__DSH_BOOT__`） |
| 线路 | `packages/client/connection`（`ctx.connection`） |
| Remote | `packages/api/{remotes,gateway}`（Host `ctx.typertGateway`；Client `ctx.remote`） |
| 对象层 | `packages/client/runtime`（`SessionRuntime`、`ConversationNodeAssembler`） |
| 对话面 | `packages/client/ui-conversation`（Chat Definitions） |
| 文档 | `docs/subsystems/client-modules.md`（`ctx.clientModules`）；架构笔记 `2026-07-19-gui-web-client-architecture.md` |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§3.1 效应、§6.1 排放；**没有** web GUI / mux / `$on` 对象 |

本篇钉子：06 已经把只追加小票钉死。17 读过保险柜。19 读过传菜口怎样换投影。这里不把那三条再讲一遍。这里只读：**浏览器这间餐厅怎样接到厨房的铃**，以及 **客人看见的折页怎样从事件窗口折出来**。

slug 叫 `web-client`，容易踩进 `packages/web`。那是模型用的搜索 / 抓取缝（`ctx.web`），本课不读。本课是 GUI：`packages/client` + `packages/api`。

## 厨房：餐厅落地窗，不是点菜单夹子

厨房里那本点菜单夹（`ctx.sessions`）客人碰不到。餐厅有一扇落地窗，窗上映的是投影，不是夹子本身。

- **落地窗是浏览器半侧。** `packages/client` 是 dsh web GUI 的浏览器半边；灶台半边是 `packages/host`。两端各跑一棵 cordis 树。窗上没有模型看得见的菜谱。
- **开张分两班。** `AppWebEntry` 先读主机推来的花名册 `window.__DSH_BOOT__`，预拉 `immediately` 行，再挂 Loader。全部 ACTIVE 才一次翻面；半开的餐厅不营业。
- **服务员端两种托盘。** 问了再等的盘子是 unary：HTTP POST `/api`。厨房往外喊的铃是单向的：两条只下行 WebSocket，`/api/events.mux` 与 `/api/events.host`。客人不得在铃上回话；回话走盘子。
- **门卫看 Host 头。** 回环或已声明的 `trustedHosts` 才放行。`dsh web --host 0.0.0.0` 在认证层出现之前有意不受支持。普通 GET 那两条铃的路径回 426，**没有** SSE 回退。
- **领班折页给客人。** 会话由 Host 创建（`session.create`）。`ConversationNodeAssembler` 把事件折成稳定的 `{kind, id}` 节点。压缩检查点在窗上是一枚折叠标记；写给模型看的带框载荷不渲染。

| 厨房 | Harness |
|---|---|
| 餐厅落地窗 | `packages/client`（浏览器半侧） |
| 后厨灶台 | `packages/host`（`ctx.webServer` 等） |
| 开张两班 | `AppWebEntry.run()`；花名册 `window.__DSH_BOOT__` |
| 插件花名册缝 | `ctx.clientModules`（`packages/client/modules`） |
| 服务员 | `ctx.connection` |
| 问了再等的盘子 | unary HTTP POST `/api`；Client 走 `connection.rpc.call` |
| 单向厨房铃 | `MUX_EVENTS_PATH` `/api/events.mux`；`HOST_EVENTS_PATH` `/api/events.host` |
| Host 头门卫 | `isTrustedApiRequest`（`api-request-trust.ts`） |
| 前台 BFF | `packages/api/remotes`（**无**服务键；配置 `ctx.typert`，消费 `ctx.remote`） |
| 传菜闸门 | Host `ctx.typertGateway`；Client `ctx.remote` |
| 领班 | `SessionRuntime` + `ConversationNodeAssembler` |
| 客人折页 | `packages/client/ui-conversation` Chat Definitions |
| 搜网页的另一工位 | `packages/web` 的 `ctx.web`（**不是**本课） |

栈的依赖方向写在 `packages/api/README.zh.md`：`remotes → gateway → connection → webserver`。Connection 与 WebServer 今天仍住在 `packages/client/connection` 与 `packages/host/webserver`，README 说以后可以只搬家。

## 真正的代码路径

### 开张：`packages/client/web`

`AppWebEntry` 是壳的产品。`run()` 第一句解析花名册：

```ts
this.manifest = parseBootManifest((globalThis as DshWindow).__DSH_BOOT__)
```

模块侧：建 `ClientModuleSystem`，并行预取 `immediately` 行，只登记 factory。插件侧：挂 vendored Loader，把模块系统注入 `loader.internal`，为图上每一行加 loader 配置项，外加壳自己的伪配置项 `@deepseek-ai/dsh-client-app-shell`。`loader.await()` 之后扫一遍，每个 fiber 都得是 ACTIVE，才把 `settled` 翻成 true，`AppRoot` 一次切到真 UI。花名册由主机图决定；壳不作组合决策。README 原话：入口外壳负责启动浏览器插件树；这里没有任何内容进入模型请求。

`ctx.clientModules`（`docs/subsystems/client-modules.md`）是这张花名册在 Node 半侧的缝：扫描 `dsh.client`、组成 `window.__DSH_BOOT__`、在 `/plugins/<id>/client.js` 供 bundle、用 `tapIndex` 把图打进首页。浏览器半侧是 `ctx.modules`，不在本课展开。

### 服务员：`packages/client/connection`

浏览器 apply 提供 `ctx.connection`（`ConnectionHandle`）：共享 `IApiClient`、当前页是否回环、按 generation 生效的 `hostDescription`、以及一次性的 `start(sinks)`。真正泵流的是包内部的 `ConnectionController`：两条流都打开且 `host.describe` 成功才算这一代握手完成；断了指数退避重连（500ms 倍增到 10s）。sink 抛错只记日志，不拖死泵。

路径常量在 `src/api-path.ts`：

```ts
export const API_PATH = '/api'
export const MUX_EVENTS_PATH = `${API_PATH}/events.mux`
export const HOST_EVENTS_PATH = `${API_PATH}/events.host`
```

`WebApiClient` 用 fetch 发 unary／respond；mux／host 各开一条只下行 WebSocket。`WebSocketDownlinks` 收到客户端业务消息会以 1008 `downlink only` 关掉。Host 半侧在 `webServer` 上挂唯一 `/api` prefix；已注册的 Typert interceptor 先认领 Remote endpoint，未认领再回退 API Proxy。

信任栅栏在 `src/api-request-trust.ts`。每个 `/api` 请求——有没有浏览器标记都一样——`Host` 必须是回环，或匹配 `trustedHosts`。HTTP 失败在 RPC 分发前纯 403；upgrade 失败在开流前拒握手。README 原话：`dsh web --host 0.0.0.0` 在远程访问具备认证层之前有意不受支持。这道栅栏是可达性策略，不是认证。

普通 GET 那两条事件路径回 426，不保留 SSE 回退：

```ts
if (request.method === 'GET' && (pathname === MUX_EVENTS_PATH || pathname === HOST_EVENTS_PATH)) {
  return new Response('upgrade required', {
    status: 426,
    headers: { connection: 'Upgrade', upgrade: 'websocket' },
  })
}
```

`toFetchHandler` 的 SSE 编解码只服务进程内同构载体。会话增量**不是** SSE。

### 闸门：`packages/api`

`remotes` 是本应用的 BFF：Host 入口管 Agent/Session 身份策略；Client 入口 `ctx.remote.$mount()` 挂贡献。**没有**自己的 ctx 服务键。转发名单 `API_REMOTE_FORWARDED_EVENTS`（`src/remote-events.ts`）是 `$on` 的合法键集：原样转发，无投影、无脱敏、无改名。

`gateway` 两侧共用 Typert 一元 RPC。Host `TypertGatewayService` 的 ctx 键是 `typertGateway`。Client `ClientRemoteService` 的键是 `remote`。每次调用校验参数，经 `ctx.connection.rpc.call('/api', endpoint, { args }, signal)` 发出。README 原话：该包只分发一元方法。增量会话数据通过同一个 Connection 上独立的具名流协议传输。

`ctx.remote.$on(event, listener)` 把订阅记在发起调用的 fiber 上，随 fiber 消失——这就是 02 的 `ctx.effect`。`$dispatch` 是载体：runtime 在 host 流上看到 `host/remote-event` 才交进来。无人订阅就丢。没有载荷投影，没有 Scope 化订阅，重连也不重放。

### 领班：`packages/client/runtime`

`SessionRuntime` 拥有会话对象、列表与 scope，以及事件窗口与历史分页。客户端会话一律由 Host 创建：一次 `session.create` 同时产生 Session、agent 和 cwd。客户端不持有实体化之前的会话状态。

runtime apply 是流的唯一消费方。它把 mux／host 信封交给 Session／Workspace，再把通用 `host/remote-event` 交给 `ctx.remote.$dispatch`：

```ts
if (frame.type === 'host/remote-event') ctx.remote.$dispatch(frame.event, frame.args)
```

`Session.handleMuxEnvelope` 里，`session/event` 走 `acceptLiveEvent`。窗口是连续后缀：`open()` 拉尾页（`PAGE_MESSAGES = 50`），`loadOlder()` 按 `beforeSeq` 往前 prepend，连续性不对就 fail-soft 丢掉这一页。重连 `resync` 清空窗口再 open，不沿用断线前那次历史请求。

每个 `Session` 把窗口交给 `ConversationNodeAssembler`。插件注册 Definition，把单条事件映射为稳定 `{kind, id}`，在唯一 start 处建 State，折叠关联 update，再为已注册视图目标物化节点。实时 append 每个 Definition 只求值一次；完整替换只用于 open、resync 和 gap repair。

### 客人折页：`packages/client/ui-conversation`

Chat 业务行是注册表贡献，不是封闭联合。`registerConversationNodes` 挂上 user／assistant／tool／command／compaction／retry／turn-tail 等 Definition。`messageDefinition` 只收 `isAppendSurfaceEvent` 的 `user/message`，并且排除压缩检查点；仅供模型使用的 replacement 副本不进 Chat。

压缩检查点由 `compactionDefinition` 认领：无 `sourceCommandId` 的 replacement `user/message`（`plugin === 'compact'`）加上 `compaction/start|summary|end`。`CompactionItem.tsx` 文件头写明：被盖住的对话仍留在标记上方，标记只报告模型从哪一截开始看不见；**framed checkpoint payload is written for the model and is not rendered**。展开读的是窗口里那条 `compaction/summary`；summary 落在已加载窗口之外，行仍在，只是不能展开。

## 对回论文

`$on` 是挂在纤程上的效应（02）：登记 listener，卸插件收回。这是 acquisition。

`host/remote-event` 帧里的内容已经是 Host 侧的排放。06 钉过：写进会话日志就越过可逆边界。浏览器这边只是把已经发出去的铃再响一遍给落地窗听。重连不重放 `$on` 订阅，也说明这不是把 Host 事件收进一条可逆的 Cordis 总线。

一元 RPC 的请求／响应是这次问菜的来回，不是论文里的 Sigma，也不是定理 73 的静止状态。两条下行流是产品选的载体形状（HTTP POST + 双 WebSocket），论文没有 mux／host、没有 `__DSH_BOOT__`、没有 Chat Node。

不要把 GUI 接到 session/event 说成 Cordis 时空组合。这是产品。

## 文档对不上的地方

- 课表直觉里的 `packages/core/client`、`packages/web/client`、根上的 `docs/client.md`：404。真 GUI 在 `packages/client/`，宿主在 `packages/host/`。
- slug `web-client` 容易让人去翻 `packages/web` 或 `ctx.web`。那是搜索／抓取能力缝，词汇在 `docs/subsystems/web.md`，不是浏览器 GUI。
- 不要把 `ctx.web` 当成 GUI 键。GUI 线路键是 `ctx.connection` / `ctx.remote` / `ctx.sessions`（客户端对象层）/ `ctx.clientModules` / `ctx.webServer`。
- 会话增量不是 SSE。那两条 `/api/events.*` 路径普通 GET 回 426；SSE 只出现在进程内同构载体和开发期 HMR。把 SSE 当成 session stream 会对不上。
- `packages/api/connection`、`packages/api/webserver` 今天不存在。README 写的是以后可以搬家，不是现在的路径。
- remotes **没有** `ctx.remotes`。名单在 `API_REMOTE_FORWARDED_EVENTS`，消费走 `ctx.remote.$on`。

## 主干完结

本篇已经看到落地窗怎样接到厨房铃：unary 盘子走 POST `/api`，增量事件走两条只下行 WebSocket，领班把 `session/event` 折成 Chat 节点，压缩检查点是一枚折叠标记而不是模型那张带框载荷。

主干 01–20 到此写完。课表里的非主干——`acp`、`e2b`、`lsp`、`workflow`、`examples`、`test-support`——是产品周边或测试支架，留给以后。不要从这里跳进那些包。
