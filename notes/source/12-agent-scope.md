# 12 · 每个 agent 一根子纤程

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[11 llm-streaming](11-llm-streaming.md) · 下一篇：[13 fs-subprocess-sandbox](13-fs-subprocess-sandbox.md)

读的是 DeepSeek Harness 真正跑的那份「每位厨师自己的小厨房」，不是自己再发明一套作用域。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 钉住 | `master` @ `47f943859bef60e4160492346772ded9b24f765a`（`dsh@0.1.0-rc.5`；与 11 相同，已重核 HEAD） |
| Harness 文档 | `docs/architecture.md`、`docs/architecture.zh.md`（「将注册项限定到单个 agent」）、`docs/subsystems/core.md`、`docs/subsystems/core.zh.md`、`docs/subsystems/scope.md`、`docs/subsystems/scope.zh.md` |
| 作用域库 | `packages/core/scope/src/{index,store,invariant,scoped-events.generated}.ts`（**没有** `isolate.ts` / `intercept.ts`） |
| 活厨师拿小厨房 | `packages/core/agent-loop/src/agent.ts`（`ReactLoopAgent` 构造：`createScope` → `agent.ctx`） |
| 创建 / 拆除 | `packages/core/agent-loop/src/index.ts`（`prepare`：先布置子纤程，卸时只拆这一根） |
| 工牌字段 | `packages/core/agent/src/{index,runtime-types,dispatch}.ts`（`ctx.agent` DX、`scopeTarget(agent, agent)`） |
| 感知作用域的注册表 | `packages/core/tools/src/index.ts`、`packages/core/system-prompt/src/index.ts`（`ScopedLayers`；本篇只记它们怎样跟小厨房同生共死） |
| 包 README | `packages/core/scope/{README,README.zh}.md`、`packages/core/agent/{README,README.zh}.md`、`packages/core/agent-loop/{README,README.zh}.md` |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§3.1 可逆效应、定义 32 Fiber、Table 2 的 `ctx.isolate`；**没有** `ScopeKey` / `createScope` 对象 |

本篇钉子：每位还在岗的厨师，后厨给他**单独一档工位**。刀、对讲机、只给他用的调料，下班全带走；店里的总灶、水电、前台名册还在。09 读的是工牌和主厨席；01 读的是通用 `isolate` / `intercept` 影子表。本篇只读这一档工位怎么长出来、`agent.ctx` 和 `ctx.agent` 谁说了算、拆一位厨师为什么只卸他那根子纤程。

不要把「给某个会话换一套同名电器」（preset 的 Cordis `isolate` realm）和「给这位厨师一档工位」（`createScope`）混成一件事。文件系统、子进程、沙箱留给 13。

---

## 厨房：每人一档工位，店还在

饭店后厨是公共的：总灶、水、电、冷库。每位上岗的厨师另外领**自己那一档工位**。

- **工位是临时隔间，不是另开一家店。** 水电还是店里的插座；只是这一档上放的刀、耳机、便签，下班带走。
- **刀和收音机跟工位走。** 在这一档上登记的工具、提示词片段、监听器，只这一位看得到。工位拆掉，它们按后装先卸收回。总灶上别人登记的刀还在。
- **工牌上写着「我的小厨房」。** 服务员拿工牌点单，从牌上走进这一档。普通插件站在店中央，工牌字段是空的。
- **拆一位，店不停业。** 这位的刀收走、对讲机关掉；隔壁档、总灶、前台名册都还在。把整间后厨拆掉，才是卸循环插件（09 的活灶名册）。

对应到 `dsh`：

| 厨房 | Harness |
|---|---|
| 店里的总灶 / 水电 | 循环插件那根纤程上的 `ctx.tools`、`ctx.llm`、`ctx.sessions`…… Cordis 服务本身是上下文全局的 |
| 这一档工位 | `createScope(loopCtx, agent)` 铸出的子纤程 + 带标签上下文 |
| 工位上的刀 / 便签 | 经 `agent.ctx` 登记的工具、提示词、`ctx.on` 监听器 |
| 工牌上的小厨房 | `agent.ctx`（`Scope.ctx` 再 `extend({ agent: this })`） |
| 「我站在哪一档」 | `ctx.agent`：DX 访问器，不是选层权威 |
| 真正认档 | `scopeOf(ctx)`：读 `dsh.scope` 标签；核心包选层用它 |
| 下班只收这一档 | `machine.scope.dispose()` → 子纤程 LIFO 卸载（02） |
| 店还在 | 循环纤程、根服务、其他活 agent 的工位都不动 |
| 换一套同名电器（另一件事） | preset 行上的 Cordis `isolate` realm（01）；**不是**铸工位的 API |

架构原话（`docs/architecture.zh.md` 新行为表）把两件事写成两行：「让某个会话拥有不同的能力集合」→ 组装 agent preset，服务行需要 `isolate` realm；「将注册项限定到单个 agent」→ 使用该 agent 的 `agent.ctx`。能力图把 `core/scope` 标成**库，无 ctx 键**。

包注释把职责写成一句。出处：`packages/core/scope/src/index.ts`。

```ts
/**
 * Scoped-context primitive: mint a Cordis context that tags registrations with
 * an opaque identity and build routing-only event carriers for that identity.
 * @module @deepseek-ai/dsh-scope
 */
```

`dsh-scope` **不是** Cordis Service，没有 `ctx.scope`。循环在构造每位活厨师时调用 `createScope`；工具表和提示词板用 `scopeOf` / `ScopedLayers` 感知那枚标签。

---

## 没有 `isolate.ts`，创建时也不调用 `ctx.isolate`

课表写「读 `packages/core/scope/`（index、isolate、intercept）」。真实目录里 **`packages/core/scope/src/isolate.ts` 和 `intercept.ts` 都是 404**。现文件是：

| 文件 | 干什么 |
|---|---|
| `index.ts` | `createScope` / `scopeOf` / `scopeTarget` / `bindScopeParent` |
| `store.ts` | `ScopedLayers`：全局层 + 按键的精确层；`effect()` 把可见性和所有权焊到同一个 `ctx` |
| `invariant.ts` + `scoped-events.generated.ts` | 开发期断言：带作用域事件必须带载体 |

01 已经读过 Cordis 通用的 `ctx.isolate` / `ctx.intercept`：给某个**服务名**换回路或贴配置条，子上下文 `Object.create` 父亲的影子表，**不改父亲**。那是换插座上的电器回路。

本篇铸工位走的是另一条路。出处：`packages/core/scope/src/index.ts`。

```ts
function scope(): void {}

export function createScope(ctx: Context, key: ScopeKey, options?: CreateScopeOptions): Scope {
  if (options?.parent !== undefined) bindScopeParent(key, options.parent)
  const fiber = ctx.plugin(scope)
  const scoped: Context = fiber.ctx.extend({ [kScope]: key })
  let disposing: Promise<void> | undefined
  return {
    ctx: scoped,
    rawDispose: fiber.dispose,
    dispose: () => (disposing ??= quiesceFiber(fiber)),
  }
}
```

厨房规则：

1. **空说明书装出一根子纤程。** `scope` 是什么都不做的插件函数。`ctx.plugin(scope)` 就是 01 的「按说明书再装一台电器」——这里电器是空的，要的是那根**子纤程**和它自带的 `fiber.ctx`。
2. **标签写在 `extend` 上，不写 isolate 表。** `kScope = Symbol('dsh.scope')`。派生上下文继承这枚键；再套一层 `createScope` 会遮蔽成最近的那枚。层级关系若存在，在**键的父指针**里（`bindScopeParent`），不在 Cordis isolate 影子表里。
3. **`rawDispose` 必须是 Cordis 那一个函数本身。** 复合 effect 按 yield 位置嵌套拆除；包一层包装，工位 teardown 就会变成和兄弟姐妹并行的 sibling。02 已经在工厂槽上读过这件事。
4. **`dispose()` 是幂等完全停稳。** 竞态调用等同一次 `quiesceFiber`：先 `fiber.dispose()`，再等到 `fiber.inertia` 排干。即便有人先把 `rawDispose` 领走了，这条公共边界仍能跟完异步卸载。

包 README 写明：作用域用来路由**受信任的同进程插件**；它们不是沙箱，也不是权限边界。仅仅通过带标签的上下文去调一个普通 Cordis 服务，那个服务**仍是上下文全局的**——`agent.ctx.sessions` 还是店里那一本会话店。只有自己按 `scopeOf()` 归档的注册表，才会把刀放到这一档上。

`ReactLoopAgent` 铸工位时**不传** `options.parent`，也**不**调用 `ctx.isolate` / `ctx.intercept`。preset 后来在未发布的 `setup(agentCtx)` 里用 `bindScopeParent(agentKey, standing.key)` 把这位接到常驻挂载上；常驻挂载自己另铸一枚键 `{ agentPreset: id }`。那是「站台共用一套刀」，不是本篇的铸工位。preset 行上的 `isolate` realm 是 01 那套换回路，用来避免两个会话把同名服务写进根表——`mount.ts` 会扫描泄漏到根 realm 的服务名并拒绝。本篇不走进 preset 包。

---

## 活厨师怎样领到 `agent.ctx`

循环在 `prepare()` 里 `new ReactLoopAgent(loopCtx, id, options, session)`。`loopCtx` 是工厂自己的运行时上下文（`this.runtime.ctx`），**不是**调用方的 `ownerCtx`。工位挂在循环纤程下面，好让解析范围跟着铸工位的插件走——交出 `Scope.ctx`，也就交出循环注入过的水电。

出处：`packages/core/agent-loop/src/agent.ts`。

```ts
constructor(
  private loopCtx: Context,
  public readonly id: SessionId,
  public readonly options: AgentOptions,
  public readonly session: Session,
) {
  this.dispatch = agentEvents(loopCtx, this)
  // …
  this.scope = createScope(loopCtx, this)
  this.ctx = this.scope.ctx.extend({ agent: this })
  this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
}
```

三件焊在一起的事：

- **作用域键就是这位 `Agent` 对象。** `ScopeKey = object`，按身份比较。循环用活句柄自己当键；`dsh-scope` 从不打开这个对象看字段。
- **`this.ctx` 是工位上下文再盖一层自有属性。** `extend({ agent: this })` 让这一档上读 `ctx.agent` 得到自己。自有属性先于 Context Proxy 解析，所以不会掉进注册表装的默认访问器。
- **热路径分发器在构造时建一次。** `agentEvents(loopCtx, this)` 把主体和 `scopeTarget(agent, agent)` 载体焊死。之后每一步 `emit` / `waterfall` 不再分配载体。

`Agent` 接口把这块小厨房写成工牌字段。出处：`packages/core/agent/src/runtime-types.ts`。

```ts
/** Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. */
readonly ctx: Context
```

卸掉之后纤程进入非活动：再经 `agent.ctx` 登记，Cordis 抛 `INACTIVE_EFFECT`。不是产品另写的「已 dispose」第三状态。

未发布的 `setup(agentCtx)` 拿到的就是这块尚未敲铃的小厨房。工厂在两个 id 都还没进名册时 `await setup?.(prepared.agent.ctx)`；布置砸了，`prepared.dispose()` 把子纤程一并回滚。09 已经写过「Setup composes, it never drives」；本篇补一句：setup 登记的刀，所有权已经挂在这一根子纤程上。

---

## `ctx.agent` 不是 `agent.ctx`

两个容易混的名字，09 点过名，本篇把解析钉死。

| 写法 | 是什么 | 不是什么 |
|---|---|---|
| **`agent.ctx`** | 这位厨师的小厨房。经它做的 `ctx.effect` / `ctx.on` / `tools.register` 归这根子纤程 | 不是全店前台，也不是选层函数 |
| **`ctx.agent`** | 「我现在站在哪一档」。普通插件上下文是 `undefined`；从 `Agent.ctx` 派生的上下文继承这枚自有属性 | 不是作用域解析器。核心包选层读 `scopeOf()` |
| **`ctx.agents`** | 全店前台名册（09） | 不是小厨房 |

注册表构造里给每个上下文装默认值。出处：`packages/core/agent/src/index.ts`。

```ts
// The `ctx.agent` DX accessor: default `undefined` on every context, so a
// plain plugin context reads cleanly instead of hitting the Cordis
// unknown-property throw. Each Agent.ctx shadows it with an own property
// (own properties resolve before the context proxy is consulted), so the
// accessor body never needs to resolve a scope itself.
ctx.accessor('agent', { get: () => undefined })
```

模块扩充把注释写进类型：刻意再套一层 `dsh-scope` 时，上下文可能带着**更近的**作用域标签，却仍保留外层的 `ctx.agent`。所以「我是哪位厨师」（DX）和「登记记在哪一层」（`scopeOf`）可以分开。循环自己的提示词变量读 `context.agent?.options.provider`，那是 DX；工具表归档读 `scopeOf(this.ctx)`。

还有第三根容易搅进来的线：`ctx.agents.currentInitiator()` 是进程内因果归因（谁启动了这条异步链）。父 agent 雇子 agent 时，setup 里 initiator 是父亲，`agentCtx.agent` 是孩子。本篇不把发起方做成主线。

---

## 刀挂在哪一档：同一 `ctx` 既是可见性也是所有权

感知作用域的注册表（工具、提示词）不另做「记在 A、所有权在 B」。`ScopedLayers.effect(ctx, action, { label })` 从这一个上下文同时推出两件事：`scopeOf(ctx)` 决定记进全局层还是这枚键的精确层；`ctx.effect` 决定卸哪根纤程时撤销。

出处：`packages/core/scope/src/store.ts`。

```ts
effect(ctx: Context, action: (layer: L) => () => void, options: { label: string; notify?: boolean }): () => void {
  const scope = scopeOf(ctx)
  const dispose = ctx.effect(function* (this: ScopedLayers<L>) {
    // …按 scope 取或建 layer，action(layer) 立刻插入并交出 undo…
    yield () => {
      undo()
      if (scope !== undefined && layer.isEmpty()) this.scoped.delete(scope)
      if (notify) this.onChange()
    }
    if (notify) this.onChange()
  }.bind(this), options.label)
  return dispose
}
```

`tools.register` 把调用时的 `this.ctx` 交进去。在店中央登记 → 全局层，每位厨师都看得到；在 `agent.ctx` 上登记 → 精确层，只这一位（加上沿父链接下来的祖先层）。近者遮蔽远者：`merge()` 先铺全局，再按 `scopeChainOf` 从最远祖先走到自己。`peek()` 故意不看链——限制、守卫是**自己的**贡献，不能悄悄继承祖先的。

经 `agent.ctx.on(...)` 挂的监听器，所有权同样是这根子纤程：01/02 的 `ctx.on` 本身就是一笔 effect。喊人时却**不能**指望「我从 `agent.ctx` 发出去就会自动筛」。09 已经写过：在 `agent.ctx` 上登记的是 **effect** 的作用域；分发必须把载体当作 `this` 传进去。`dispatch.ts` 的 `agentCarrier(agent)` 就是 `scopeTarget(agent, agent)`。无标签监听器全局放行；有标签的只在标签 === 键、或标签是键的祖先时放行。事件沿父链**向上**流，从不向下——常驻 preset 挂载听得见它底下每位厨师，一位厨师听不见另一位。

---

## 拆一位：只卸这一根子纤程

`prepare()` 在任何资源出现之前，就把一笔记名 effect 挂到**调用方**纤程上：`ownerCtx.effect(..., 'agentLoop.lifecycle(${id})')`。同时把同一份 memoized `dispose` 交给工厂的 `FactoryOwnership`。三路 fuse 取消：调用方 `signal`、主人纤程卸载、工厂 teardown。09 读过这本所有权账；本篇读拆除顺序。

出处：`packages/core/agent-loop/src/index.ts` 的 `dispose` 闭包。

```ts
if (machine !== undefined) {
  machine.cancel({ kind: 'disposed' })
  await machine.whenIdle()
  await machine.scope.dispose()
}
// finally: detachAgent?.(); detachSession?.(); untrack(); …
```

包 README 把顺序写成：停止并排空 → 撤销作用域 → detach agent → detach 会话。源码一致。

厨房里发生的事：

1. **先关火。** `cancel({ kind: 'disposed' })` 清 inbox（除非另说）、abort 进行中的活动。然后 `whenIdle()` 等到催菜员坐下。还在烧的那锅不能连工位一起掀。
2. **再收这一档的刀。** `scope.dispose()` → 子纤程按 02 的 LIFO 卸掉经 `agent.ctx` 挂上的工具、提示词、监听器。循环纤程还在，根上的 `ctx.tools` 服务还在，隔壁厨师的精确层还在。
3. **最后从两本活名册拿掉工牌和账本投影。** `detachAgent` / `detachSession` 是 `enter` 返回的闭包，由 `prepare` 自己握着——会话店不是感知作用域的注册表，调用 `agent.ctx.sessions.enter` 并不会自动把这条名册记到子纤程的 effect 栈上。
4. **店还在。** 其他活 agent、主厨席、翻译席都不动。把循环插件卸掉，才走 09 那条「先摘牌再 abort 所有活灶」。

`handle.dispose()`、主人纤程卸载、工厂 teardown，都到达**同一份** memoized 完全停稳。旁观 `ctx.agents.get(id)` 拿到的裸工牌拆不了灶。

名册上的 `agent/disposed` 表示人已经离开前台；循环在驱动器停稳后才发。此时作用域撤销和会话剥离可能还在进行——包 README 写过，本篇与它对得上。

---

## 对回 01–02 与论文：只在对得上的地方连

| 机制 | 本包里的真名字 | 是否同一件事 |
|---|---|---|
| 01 的 Fiber（子插件实例） | `ctx.plugin(scope)` 铸出的那根空说明书纤程 | **对得上**：每位活 agent 一根子纤程，父是循环纤程 |
| 02 的 `ctx.effect` / LIFO | 经 `agent.ctx` 的登记；`ScopedLayers.effect`；`scope.dispose()` → `fiber.dispose()` | **对得上**：刀挂上就记账，拆工位倒序收回 |
| 01 的 `ctx.isolate` / `[symbols.isolate]` | **铸工位路径没有调用**。preset 行用 isolate realm 换同名服务的回路 | **对不上本篇主线**。架构表里那是「换一套能力」，不是「限定到单个 agent」 |
| 01 / 03 的 `ctx.intercept` | 铸工位路径没有调用 | **对不上** |
| 04 的事件筛选 | `scopeTarget` 载体当 `thisArg` | **对得上工程约定**：活对讲机按工位放行；不是 intercept 元数据 |
| 论文 Fiber / 可逆效应栈 | 子纤程 + effect 栈 | **对得上形状**。Table 2 的 `ctx.isolate` 对的是 Cordis 服务回路，不是 `dsh.scope` 标签 |
| 论文演算里的 realm | 本篇的 `ScopeKey` / 父链 | **对不上形式对象**。包 README 自己说键与具体含义无关；演算本章不引入 realm（01 已记） |

不要把 `createScope` 说成 `ctx.isolate('tools')`。前者给厨师一档工位（标签 + 子纤程所有权）；后者给某个服务名另开一条回路。也不要把 `ctx.agent` 说成 `scopeOf()`：一个是 DX 工牌，一个是选层权威。

运行时仍然不检查逆是否真把这一档恢复原状——02 已经写过，那是组件作者的义务。作用域也不是沙箱：13 才读 fs / subprocess / sandbox 缝。

---

## 可以记住的几句

1. **每位活 agent 一根子纤程。** `createScope` = 空插件 `ctx.plugin` + `extend({ [dsh.scope]: agent })`。没有 `packages/core/scope/src/isolate.ts`。
2. **`agent.ctx` 是小厨房，`ctx.agent` 是「我站在哪一档」。** 选层用 `scopeOf()`。普通插件上下文上 `ctx.agent === undefined`。
3. **刀跟工位走。** 经 `agent.ctx` 登记的工具、提示词、监听器，可见性和所有权是同一个 `ctx`；`scope.dispose()` 按 LIFO 收回。总灶上的全局登记还在。
4. **创建时不用 `isolate` / `intercept`。** 那两记是 01 的服务回路 / 配置条。preset 用 isolate 避免同名服务漏到根表；用 `bindScopeParent` 把厨师接到常驻挂载。铸工位本身不干这两件事。
5. **拆一位，店不停业。** 先停催菜员，再卸子纤程，再从名册拿掉。循环纤程和其他厨师的工位留下。
6. **登记筛 effect，喊人筛载体。** 从 `agent.ctx` 发出去不会自动按工位过滤；`agentEvents` 必须把 `scopeTarget(agent, agent)` 当 `this`。

---

## 下一篇读什么

**13 · fs-subprocess-sandbox**（文件系统、子进程、沙箱缝）。

本篇已经看到每位厨师怎样领到自己那一档工位、刀怎样跟工位走、拆一位为什么只收这一档。下一篇读店里那些真正碰到磁盘和进程的插座。先不要跳进审批或子 agent。

---

## 拉取记录

成功（默认分支是 `master`，不是 `main`；钉住 `47f943859bef60e4160492346772ded9b24f765a`；HEAD 与 11 相同）：

- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/packages/core/scope/src/{index,store,invariant,scoped-events.generated}.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/packages/core/scope/{README,README.zh,package.json}`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/{index,agent,runtime-context}.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent/src/{index,runtime-types,dispatch}.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/packages/core/{agent,agent-loop}/README.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/docs/{architecture,architecture.zh,agent-lifecycle,agent-lifecycle.zh}.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/{core,core.zh,scope,scope.zh}.md`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/core/scope`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/core/scope/src`
- 为核对「创建时 isolate」另读了 `packages/preset/agent-presets/src/{index,mount}.ts`、`packages/core/tools/src/index.ts`（`register` / `ScopedLayers`）；preset 细节不在本篇展开

404 / 不存在：

- **`packages/core/scope/src/isolate.ts`**、**`packages/core/scope/src/intercept.ts`**（课表点名的起点；铸工位在 `index.ts` 的 `createScope`）
- `docs/rescope.md` / `docs/rescope.zh.md` **存在**，但讲的是 vendor 包改名成 `@deepseek-ai/*`，与 agent 作用域无关

文档与源码不一致（以源码为准）：

- **课表**把 isolate / intercept 写成 `packages/core/scope/` 下的文件。那是 01 的 Cordis API；本包没有这两个文件。架构中文「新行为」表已经把两件事拆开，与源码一致。
- **`docs/agent-lifecycle.zh.md`** 是轮次时序图，几乎不谈子纤程 / `createScope`。生命周期拆除顺序以 `agent-loop` 包 README 与 `prepare()` 的 `dispose` 为准。
- **包 README** 写循环为每个存活 agent 创建一个作用域，preset 常驻挂载是其父作用域。`ReactLoopAgent` 构造里的 `createScope(loopCtx, this)` **不传** `parent`；父链接是 preset 在 `setup` 里后来 `bindScopeParent` 的，不是铸工位那一行。

文件系统、子进程、沙箱缝，本篇未展开。
