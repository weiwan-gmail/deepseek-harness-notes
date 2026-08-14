# 09 · Agent 接口、工厂、活注册表

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[08 tools-pipeline](08-tools-pipeline.md) · 下一篇：[10 agent-loop](10-agent-loop.md)

读的是 DeepSeek Harness 真正跑的那份 Agent 前台，不是自己再发明一套词。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 钉住 | `master` @ `47f943859bef60e4160492346772ded9b24f765a`（`dsh@0.1.0-rc.5`） |
| Harness 文档 | `docs/architecture.md`、`docs/architecture.zh.md`、`docs/subsystems/core.md`、`docs/subsystems/core.zh.md`、`docs/agent-lifecycle.md`、`docs/agent-lifecycle.zh.md` |
| Agent 包 | `packages/core/agent/src/{index,runtime-types,types,dispatch}.ts`（**没有**单独的 `registry.ts`：活注册表就是 `index.ts` 里的 `AgentRegistry`） |
| 循环工厂 | `packages/core/agent-loop/src/index.ts`（`AgentLoop implements AgentFactory`；`setFactory` 与 `FactoryOwnership`） |
| 包 README | `packages/core/agent/{README,README.zh}.md` |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§3.1 可逆效应、§3.2 反应式余效应 |

本篇钉子：厨房里有一个**主厨席**。谁此刻占着工厂槽，谁才能雇厨师、开火；卸掉循环插件，席位清空，已经在灶上的活也一并停。UI、钩子、编排器面向 `ctx.agents` 和 `Agent` 工牌编程，不 `import` 具体循环包。登记、摘牌、生命周期都是 02 篇的 `ctx.effect`；循环要等水电齐了才上岗，是 03 篇的 `inject`。

不要把「前台名册」（本篇：现在谁在岗、谁能开灶）和「这一轮怎么炒」（10：turn / step / inbox 驱动器）混成一件事。本篇只读工牌、席位、名册和活对讲机的名字。

---

## 厨房：主厨席只有一个位子

饭店前台挂着一张**在岗厨师名册**。客人、服务员、稽核员都只认工牌，不问今晚主厨毕业于哪所学校。后厨另有一个**主厨席**：同一时刻只能坐一个人。谁坐着，谁就能雇厨师、给工牌、把名字写上名册。

- 主厨到岗：在席位上坐下（`setFactory`）。没人坐席，前台接「雇一位」会听到「还没装循环插件」。
- 雇厨师：先在后厨把工位布置好（未发布的 `setup`），再写入名册、敲开业铃。布置砸了，名册上不会出现半成品。
- 工牌：每位在岗厨师一块（`Agent`）。上面有工号、自己的小厨房（`agent.ctx`）、自己的账本（`session`）。服务员拿这块牌点单，不拿学校文凭。
- 炒着的锅：主厨自己另有一本活灶名册（`FactoryOwnership`）。炒到一半把主厨解雇，席位先空，再把所有还在烧的壶关掉。
- 对讲机：`agent/*` 是现在这一位还在岗时的喊话；账本上的 `turn/*` / `step/*` 是 06 篇那种写出去就涂不掉的小票。卸插件，对讲机没人听；小票还在。

对应到 `dsh`：

| 厨房 | Harness |
|---|---|
| 前台名册 | `ctx.agents`（`AgentRegistry`） |
| 工牌 | `Agent` 接口（每位插件面向的 handle） |
| 主厨席 | `AgentFactory` 槽；`setFactory` 写入，dispose 清空 |
| 今晚这位主厨 | `AgentLoop implements AgentFactory`（`ctx.agentLoop`） |
| 雇厨师 / 请回旧厨师 | `ctx.agents.create` / `ctx.agents.resume` → 工厂的 `createAgent` / `resume` |
| 已经在岗、尚未敲铃 | `enter` 写入 store，不 `announce` |
| 开业铃 | `announce` → `agent/created`，随后 `agent/session-start` |
| 活灶名册 | `FactoryOwnership`：卸循环时 abort，并等待所有活 agent 排干 |
| 工牌上的小厨房 | `agent.ctx`：只给这一位的工具 / 提示词 / 监听器，dispose 全撤 |
| 「我站在哪一档」 | `ctx.agent`：DX 访问器，不是解析作用域的权威 |

架构原话（`docs/architecture.zh.md` 核心包表）：`core/agent` 负责「`Agent` 接口、活跃 agent 注册表和 `agent/*` 事件」，ctx 键 `ctx.agents`；`core/agent-loop` 是「实现该接口的默认驱动器」，ctx 键 `ctx.agentLoop`。能力图把 `ctx.agents` 标成 **core** 服务，不是可替换 seam：拥有实时句柄、创建／恢复工厂缝，以及进程本地的发起方传播。循环可以换；前台接口不换。

包注释把职责写成一句。出处：`packages/core/agent/src/index.ts`。

```ts
/**
 * Agent service: live registry, factory delegation, and process-local
 * initiator scope. Concrete creation and driving belong to the loop.
 * @module @deepseek-ai/dsh-agent
 */
```

`AgentRegistry` 才是 Cordis Service，`super(ctx, 'agents')`。循环是另一份 Service（`super(ctx, 'agentLoop')`），实现同一个工厂接口之后，把自己坐进前台那把椅子。

---

## 没有单独的 `registry.ts`

课表写「读 `packages/core/agent` 的 index、types、registry」。真实目录里**没有** `registry.ts`。活注册表、工厂槽、发起方作用域全在 `index.ts` 的 `AgentRegistry` 上。

`types.ts` 也很瘦：只给只追加账本扩一条持久词汇 `agent/inbox/spliced`，外加 `InboxTarget = 'next-turn' | 'next-step'`。公开的 `Agent` 接口、以及 Cordis `Events` 上那些活的 `agent/*`，都在 **`runtime-types.ts`**。包 README 和 `docs/subsystems/core.zh.md` 把句柄出处写成 `types.ts`，跟当前文件对不上——下文按实文件走。

`dispatch.ts` 不是第二张名册，是把「主体 agent」和「作用域载体」焊死的分发器：`agentEvents(ctx, agent)` 发事件时自己注入 `payload.agent`，调用方填错人也改不掉。

---

## `ctx.agents`：前台，不是具体循环

模块扩充把键挂上 Context。出处：`packages/core/agent/src/index.ts`。

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: AgentRegistry
    /**
     * The agent association installed as an own property on `Agent.ctx`, or
     * `undefined` on a plain context.
     */
    agent?: Agent
  }
}
```

两个容易混的名字：

- **`ctx.agents`**：全店前台。查名册、雇人、换主厨。
- **`ctx.agent`**：我现在站在哪一位的工位上。普通插件上下文读到 `undefined`（构造时 `ctx.accessor('agent', { get: () => undefined })`，免得 Cordis 对未知属性抛错）。每个 `Agent.ctx` 用自有属性盖住它。注释写明：这是 DX，不是作用域解析器；核心包选层用 `scopeOf()`，不读这个字段。

`AgentRegistry` 构造里还做了三件和 02–03 对得上的事：

1. **`ctx.inject(['typert'], …)`**：等类型协议服务出现，再登记 `agent` 查找（`sessionId → this.get(sessionId)`）。没有 typert，查找缝不装；来了再装。这是 03。
2. **`ctx.accessor('agent', …)`**：给每个上下文一个干净的默认值。
3. **`ctx.effect(function* { yield disposeInitiators; yield closeInitiators }, 'agents.initiatorLifecycle()')`**：发起方作用域本身也是一笔可逆效应。卸服务时先拒新边界、排干已返回的 Promise，再禁用底层 `AsyncLocalStorage`。

发起方（`currentInitiator` / `withInitiator` / `withoutInitiator`）只做**同进程因果归因**。环境里有一位，既不是还活着的证明，也不是授权。跨进程、worker、HTTP、持久化，仍要显式带 `Agent`。本篇不把发起方做成第二条主线。

---

## `Agent` 接口：每位厨师的工牌

每个插件（UI、钩子、编排器）面向这块牌编程，**零循环依赖**，所以循环可以换。出处：`packages/core/agent/src/runtime-types.ts`。

```ts
/** Public live-agent handle. */
export interface Agent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session
  readonly inbox: Inbox
  readonly status: AgentStatus
  readonly ctx: Context
  cancel(cause: AgentCancelCause, options?: CancelOptions): void
  whenIdle(): Promise<void>
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
  followup(message: UserMessage): void
  steer(message: UserMessage): void
  inject(message: UserMessage): void
}
```

几条本篇要钉死、下一篇才展开的钉子：

- **`id` 与 `session.id` 是同一个身份。** 注册表 `enter` 会检查，对不上就抛。
- **`session` 是只追加账本**（06）。模型可见的事实走那边；本篇的活事件不替代它。
- **`ctx` 是这位厨师的小厨房。** 通过它登记的工具、提示词、监听器只对这一位生效，dispose 全撤，撤完再登记会被拒。作用域怎么建是 12 的题。
- **`status` 只有 `idle` | `running`。** 卸掉不是第三种可观察状态：dispose 把人从名册拿掉并发 `agent/disposed`。`running` 说的是驱动器整段还在排干，**不能**证明某个 turn 仍开着。
- **`followup` / `steer` / `inject` 是 `send` 的固定预设**：点下一轮并叫醒、点下一步并叫醒、塞下一步上下文但**不**叫醒。inbox 怎么被领取、turn 怎么打开，留给 10。

`AgentHandle` 比裸工牌多一项能力。出处同上文件的邻居 `index.ts`。

```ts
export interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}
```

注释把 `dispose` 标成 **CAPABILITY**：消费方之中，只有持有 handle 的人能拆这位。`ctx.agents.get(id)` 仍返回裸 `Agent`——旁观名册的人拆不了灶。配置启动的 agent 由循环纤程拥有，根本不发 handle。

---

## 工厂槽：谁坐主厨席谁开灶

创建接口刻意放在 `dsh-agent`，好让 ACP 桥、UI 只依赖前台。出处：`packages/core/agent/src/index.ts`。

```ts
export interface AgentFactory {
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
}
```

工厂必须把事务和活生命周期挂到**调用方**的 `ownerCtx` 上，不能从工厂自己的注册上下文猜所有权。调用方纤程一卸，这位厨师跟着拆——即便主厨还坐着。

### `setFactory` 就是一笔 `ctx.effect`

```ts
setFactory(factory: AgentFactory): () => void {
  const dispose = this.ctx.effect(() => {
    if (this.factory !== undefined) throw new Error('an agent factory is already registered')
    const target = (factory as AgentFactory & { [symbols.original]?: AgentFactory })[symbols.original] ?? factory
    this.factory = { target }
    return () => { this.factory = undefined }
  }, 'agents.setFactory()')
  return dispose
}
```

厨房规则：

- 席位已被占：抛 `an agent factory is already registered`。没有「热替换主厨」API。
- 卸循环：dispose 把 `this.factory` 置 `undefined`。再 `create` 会听到 `no agent factory registered (load an agent-loop plugin)`。
- 返回值必须是 Cordis 那一个 disposer 函数本身。复合 effect 按 yield 位置嵌套拆除；包一层包装，卸载时就会变成和兄弟姐妹并行的 sibling——主厨摘牌会跟还在排干的灶抢跑。02 篇已经在循环构造函数上读过这件事。

槽位包在 `FactorySlot = { target }` 里，避免 Cordis 在调用方上下文还没确定时就去 trace 工厂字段。`create` / `resume` 再用 `getTraceable(ownerCtx, target)` 把这一次调用绑回调用方。

### `AgentLoop` 来坐这把椅子

出处：`packages/core/agent-loop/src/index.ts`。

```ts
export class AgentLoop extends Service implements AgentFactory {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']
  // …
  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentLoop')
    // …
    this.ownership = new FactoryOwnership(ctx.fiber)
    this.runtime = { ctx }
    ctx.effect(() => () => this.ownership.dispose(), 'agentLoop.transactions()')
    ctx.effect(() => ctx.agents.setFactory(this), 'agentLoop.setFactory()')
```

这是 03 的说明书：没有前台、没有会话店、没有模型、没有工具、没有提示词板，循环插件停在 `PENDING`，不假装能炒菜。水电齐了才执行构造函数，把两笔账挂上自己的纤程：

1. **先** `agentLoop.transactions()`：挂活灶名册。正向几乎是空的，逆是 `FactoryOwnership.dispose()`——不再接单、`abort('agent loop is not active')`、并行等待所有活 agent 的 teardown 和启动中的任务。
2. **后** `agentLoop.setFactory()`：去前台坐下。

后装先卸（02）：纤程卸载时先摘牌（外面再雇人会失败），再关所有还在烧的壶。先关灶再摘牌，会留下一个还能接单、但灶已经拆了的窗口。

`FactoryOwnership.track(dispose)` 是工厂自己的第二本账，和 Cordis 的 LIFO 栈并列，不是论文里的累加器字段。单个 agent 的生命周期另外挂在**调用方**纤程上：`prepare()` 在任何资源出现之前就 `ownerCtx.effect(..., 'agentLoop.lifecycle(${id})')`。三路 fuse 取消：调用方 `signal`、主人纤程卸载、工厂 teardown。

配置路径的 `AgentLoop.create(id, options, meta)` 返回裸 `Agent`，由循环纤程拥有。程序路径走 `createAgent` / `resume`，返回 `AgentHandle`。前台的 `ctx.agents.create` / `resume` 只做一件事：把 `this.ctx` 当作 `ownerCtx` 转给当前坐席的人。

`setup(agentCtx)` 在两个 id 都尚未写入名册时组装小厨房。抛错、commit 抛错、主人中途 dispose，事务回滚，名册上不出现半成品。注释写：**Setup composes, it never drives**——布置工位，不点火。点火是创建 resolve 之后的事，也是 10 的事。

---

## 活注册表：现在在岗的厨师

内部一张 `Map<SessionId, AgentEntry>`。条目记下 agent、运行时主人（`owner: Agent | undefined`，与持久会话谱系无关）、作用域载体，以及 announced / announcing / detachRequested。查法都从这张表读：

| 方法 | 做什么 |
|---|---|
| `get(id)` | 活的就返回工牌，否则 `undefined` |
| `list()` | 按登记顺序的新鲜数组 |
| `roots()` | `owner === undefined` 的顶层；带谱系的恢复会话仍可能是运行时根 |
| `isOwnedBy(id, owner)` | 这一条是不是通过这位父 agent 的作用域上下文雇来的 |

写入分两条路。普通插件：`register(agent)` = `enter` + `announce`，包在 `'agents.register()'` 这笔 effect 里，调用纤程一卸就撤。异步工厂要**先布置再敲铃**，走拆开的两个原语。出处：`packages/core/agent/src/index.ts`。

```ts
enter(agent: Agent, owner: Agent | undefined): () => void {
  const id = agent.id
  if (id !== agent.session.id) {
    throw new Error(`agent id "${id}" does not match session id "${agent.session.id}"`)
  }
  if (this.store.has(id)) throw new Error(`agent "${id}" is already registered`)
  // …写入 AgentEntry，announced: false…
  return detach
}
```

`enter` 是权威冲突边界：两个 create 可以同时在后厨准备，但只有一个能进名册。失败方回滚自己的私有作用域／会话／驱动器。返回的 detach 是单次射击：宣布过程中有人要求拆走，会等到 `announce` 的同步分发结束再拆，好让每个 `agent/created` 监听器都看见同一条稳定条目。陈旧 detach 对不上后来同 id 的新条目，删不掉别人。

`announce` 恰好一次。先把 `announcing` / `announced` 翻成 true，再 `emit` `agent/created`。同步监听器抛错会否决发布、回滚；返回的 Promise 拒绝只记日志，不否决——那已经过了同步边界。从未 announce 过就 detach 的插入，**不**发 `agent/disposed`：外面从来没见过开业，不能发明一条关闭边。

循环的 `publish` 把会话和 agent 的 enter / announce 排成固定顺序（先 session 再 agent），然后才发不可否决的 `agent/session-start`。本篇只记「铃在名册之后」；驱动器何时真正跑第一步，是 10。

---

## `agent/*` 事件：活的对讲机，不是账本

架构把事件域分成三块（`docs/architecture.zh.md`）：会话事件是持久事实；**Agent 事件携带活跃 `Agent`**，用来观察或拦截进行中的工作；能力事件挂到 `fs/*`、`tools/*` 这类缝上。轮次、步骤、模型 token 流是账本上的 `session/event`，**没有**镜像成 `agent/*`。

活词汇声明在 `runtime-types.ts` 的 `Events` 扩充上。本篇只记名字和分发模式（04），不走进 turn 机器：

| 事件 | 模式 | 本篇要记住的 |
|---|---|---|
| `agent/created` | emit | 布置完成、两条名册都有人了。同步失败否决发布 |
| `agent/session-start` | emit | 紧随其后、不可否决；第一个受支持的启动注入点。用 `agent.inject()` 塞模型可见上下文 |
| `agent/disposed` | emit | 这一位已经离开名册。循环在驱动器停稳后发；会话剥离和 scope 撤销可能还在进行 |
| `agent/status` | emit | `idle` ⇄ `running` |
| `agent/inbox/inserted` · `claimed` · `discarded` | emit | 逐条、最小载荷的活通知；补账本上的 `agent/inbox/spliced`，不另做生命周期封套 |
| `agent/pre-step` | waterfall | 拒绝拟进入的步骤，或替换将进入的消息 |
| `agent/request` | waterfall | 替换冻结的调用配置；不能改消息 |
| `agent/request-error` | waterfall | 模型请求失败后的恢复；拥有恢复权的人返回 `{ kind: 'retry' }` 且不 `next()` |
| `agent/turn-stopping` | serial | 本可完成的轮次关闭前；没有 `next()`，数据说了算 |
| `agent/error` | emit | 步骤或轮次出错，即便没法在账本里给这次失败一个位置 |

`agent/created` 与 `agent/disposed` 的分发**不**走普通 `ctx.emit`：注册表自己 `events.dispatch('emit')`，逐个收容同步抛错和 Promise 拒绝，避免一个监听器饿死后面的人。`dispatch.ts` 的 `agentEvents(…).emit` 对其他通知做同样的事。作用域筛选靠载体 `scopeTarget(agent, agent)`：在 `agent.ctx` 上登记的是 **effect** 的作用域；喊人时必须把载体当作 `this` 传进去，否则筛选对不上。

`types.ts` 那条 `agent/inbox/spliced` 是 **SessionEventMap** 里的持久投影，不是 Cordis `Events` 上的活通知。一个是账本，一个是对讲机。

循环另有一条 `agent-loop/config-start-failed`（声明式配置启动失败）。那是 `dsh-agent-loop` 的事件，不是前台词汇。

---

## 对回 02–03：effect 挂槽，inject 等水电

| 02 / 03 的机制 | 本包里的真名字 | 是否同一件事 |
|---|---|---|
| 可逆效应（`ctx.effect`） | `setFactory`、`register`、`agents.initiatorLifecycle()`、`agentLoop.transactions()`、`agentLoop.setFactory()`、`agentLoop.lifecycle(id)` | 对得上：上岗写账，下岗按 LIFO 撤 |
| 反应式余效应（`inject`） | `AgentLoop.static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']`；`AgentRegistry` 里 `ctx.inject(['typert'], …)`；配置 resume 的 `ctx.inject(['sessionPersistence'], …)` | 对得上：水电不齐，循环不上岗；typert / 持久化来了再接线 |
| `ctx.provide` | 启动器可 `provide('configuredAgentIdentities', …)` 钉死配置 agent 的会话身份 | 对得上，但是启动器的缝，不是本篇主线 |
| 余效应拦截（`ctx.intercept`） | **本篇读过的工厂 / 名册路径没有调用 `intercept`** | **对不上** |
| 事件（04） | `agent/*` 的 emit / waterfall / serial | 工程约定；活对讲机，不是 intercept 元数据 |

不要把 `agent/pre-step` 说成 `inject`。`Agent.inject(message)` 是往 inbox 塞一条不叫醒的上下文；Cordis 的 `ctx.inject` 是纤程等水电。两个词碰巧都叫 inject，厨房里完全不是一档事。

运行时仍然不检查逆是否真把厨房恢复原状——02 已经写过，那是组件作者的义务。

---

## 可以记住的几句

1. **主厨席只有一个位子。** `setFactory` 是 `ctx.effect`：坐下、摘牌清空槽。没人坐席，`create` / `resume` 拒绝。第二位主厨直接抛错。
2. **工牌在 `dsh-agent`，炒菜在 `dsh-agent-loop`。** 插件面向 `Agent` 和 `ctx.agents` 编程；`AgentLoop implements AgentFactory`，可替换。
3. **名册是活的 Map，不是账本。** `get` / `list` / `roots` 看现在谁在岗。`enter` 先写入不敲铃，`announce` 才 `agent/created`。布置失败不发布。
4. **两本所有权账。** 调用方纤程挂 `agentLoop.lifecycle(id)`；工厂挂 `FactoryOwnership`。卸循环：先摘牌，再 abort 并排干所有活灶。`get()` 拿到的裸工牌拆不了灶，要 `AgentHandle.dispose`。
5. **`agent/*` 是对讲机，`session/event` 是小票。** 生命周期和拦截走前者；turn / step / chunk 走后者。卸插件对讲机没人听，小票还在。
6. **`ctx.agent` ≠ `ctx.agents`。** 前者是「我站在哪一档」的 DX；后者是全店前台。真正选层用 `scopeOf()`。

---

## 下一篇读什么

**10 · agent-loop**（turn / step / inbox / 驱动器）。

本篇已经看到谁能开灶、名册上有谁、工牌长什么样。下一篇读循环怎样认领 inbox、打开 turn、跑 step。先不要跳进 LLM 流式或每个 agent 一根子纤程。

---

## 拉取记录

成功（默认分支是 `master`，不是 `main`；钉住 `47f943859bef60e4160492346772ded9b24f765a`）：

- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent/src/{index,types,runtime-types,dispatch,inbox}.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent/{README,README.zh,package.json}`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/index.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/docs/{architecture,architecture.zh,agent-lifecycle,agent-lifecycle.zh,capability-seams,capability-seams.zh}.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/{core,core.zh}.md`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/core/agent`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/core/agent/src`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/core/agent-loop/src`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/docs`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/docs/subsystems`

404 / 不存在：

- **不存在** `packages/core/agent/src/registry.ts`（活注册表是 `index.ts` 的 `AgentRegistry` 类）
- 包 README 与 `docs/subsystems/core.zh.md` 把 `Agent` 句柄出处写成 `packages/core/agent/src/types.ts`；当前文件里公开句柄和活 `agent/*` 事件在 `runtime-types.ts`，`types.ts` 只有持久的 `agent/inbox/spliced`

`docs/architecture.md`、`docs/subsystems/core.md` 及其 `.zh.md` 均存在。turn / step / inbox 驱动细节、`ReactLoopAgent`、每个 agent 一根子纤程，本篇未展开。
