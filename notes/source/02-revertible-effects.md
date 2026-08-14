# 02 · ctx.effect / dispose 后装先卸

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[01 Context 与 Fiber](01-cordis-context-fiber.md) · 下一篇：[03 reactive-coeffects](../source-curriculum.md)（待写）

读的是 DeepSeek Harness 真正跑的那份 Cordis，不是自己再发明一套词。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 文档 | `docs/cordis-primer.md`、`docs/cordis-primer.zh.md`、`docs/cordis-tutorial/02-lifecycle-and-effects.md`、`docs/cordis-api/fiber.md` |
| Vendor 清单 | `vendor/README.md`：`@deepseek-ai/cordis` 4.0.0-rc.7，上游 `cordiverse/cordis` `packages/core`，commit `56b3d4f725681cf4556c1a8695a709cc3b6eed74` |
| 本仓库实际引用 | `vendor/cordis/src/{fiber,context,reflect,utils}.ts` |
| Harness 用法 | `packages/core/agent-loop/src/index.ts`、`packages/core/agent/src/index.ts`（`setFactory`） |
| 上游对照 | `cordiverse/cordis` `packages/core/src/fiber.ts`（`main`） |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§3.1、定理 16、§5.1.1 Algorithm 1、Table 2 |

`vendor/README.md` 第 6 条：`cordis/src/fiber.ts` 相对上游做了可重入处置硬化。下文以 **vendor 这份** 为准；Algorithm 1 是论文对 `ctx.effect` 的伪代码，和当前文件里的函数名、字段名并不逐字相同，文中会分开写。

---

## 厨房：后装的先拔

上一篇把 `ctx` 比成厨房、把 Fiber 比成某一台正在插着的电器。这一篇只谈拆机顺序。

装一台咖啡机，通常按这个顺序动手：

1. 占用插座；
2. 占用台面；
3. 接排水管。

拆走时必须倒过来：先拔管子，再清台面，再还插座。管子还接着就去拔插头，台面上会留下半截湿管子；先还插座、管子还通着，下一台电器会踩到别人的排水。论文把这件事叫做**时间可组合**：拆掉一个部件，痕迹必须按「后装先卸」收回。厨房里的说法就是 **LIFO**（后进先出）。

primer 原话（`docs/cordis-primer.zh.md`）：**注册是可逆的副作用**。提示词片段、工具 schema、适配器、提供方和监听器通过 `ctx.effect()` 或 `ctx.on()` 安装，reload 和 teardown 时会按预期撤销。实践规则补了一句：如果 teardown 顺序有要求，把相关工作放在**同一个** effect 里。

本篇只读这一根钉子：`ctx.effect` 怎么记账、dispose 为什么倒序、异步 disposer 何时会并行、Harness 的 Agent 循环怎样把工厂和活 agent 挂上这根钉子。

---

## `ctx.effect` 不是 Context 类上的方法

`vendor/cordis/src/context.ts` 的 `Context` 类体里没有 `effect()`。类上倒是有一个**静态**符号：

```ts
static readonly effect: unique symbol = symbols.effect
```

那是给 disposer 函数挂诊断树（`EffectMeta`）用的，不是登记 API。

真正的方法在 `Fiber.effect`。接口用模块扩充接到 `Context` 上，再由 `ReflectService` mixin 转发出去。

出处：`vendor/cordis/src/fiber.ts`：

```ts
declare module './context.ts' {
  export interface Context extends Pick<Fiber, 'effect'> {
    fiber: Fiber
  }
}
```

出处：`vendor/cordis/src/reflect.ts` 构造函数：

```ts
this.mixin('fiber', ['runtime', 'effect'])
this.mixin('registry', ['inject', 'plugin'])
this.mixin('events', ['on', 'once', 'parallel', 'emit', 'serial', 'bail', 'waterfall'])
```

所以你写 `ctx.effect(...)`，跑的是 `ctx.fiber.effect(...)`。API 文档也这么说：`docs/cordis-api/fiber.md` 开篇「`ctx.effect()` delegates to it」。没有名为 `ctx.use` 的登记函数（论文 Table 2 / Algorithm 4 的伪代码名，01 篇已经对过）。

---

## 登记：立刻动手，交出「怎么改回去」

教程最小例子（`docs/cordis-tutorial/02-lifecycle-and-effects.md`）：心跳插件在加载时 `setInterval`，卸载时 `clearInterval`。

```ts
ctx.effect(() => {
  const timer = setInterval(() => console.log('tick'), 200)
  return () => {
    clearInterval(timer)
    console.log('heartbeat cleaned up')
  }
})
```

对照 `Fiber.effect` 的契约（`vendor/cordis/src/fiber.ts`）：

```ts
/**
 * `execute` runs immediately; the disposers it produces are collected and
 * run (in reverse order) either when the returned disposer is called or
 * when the fiber unloads, whichever comes first. Calling the disposer twice
 * is a no-op.
 */
effect(execute: () => Effect, label = 'anonymous'): any {
  this.assertActive()
  if (this.state === FiberState.UNLOADING) {
    throw new CordisError('INACTIVE_EFFECT')
  }
  // ...
}
```

要点：

1. **回调立刻跑**，不是等到某次 tick。正向动作（占插座）发生在 `execute()` 里；返回值才是左逆（拔插头）。
2. **返回值形状**由类型 `Effect` 规定：一个 disposer、一串 disposer（可迭代）、它们的 Promise，或异步可迭代。生成器每 `yield` 一个 disposer，就当场登记。其它形状抛 `TypeError('Invalid effect')`。
3. **返回给你的也是一个 disposer**。你自己调用它，或等纤程卸载，谁先到谁跑；第二次调用是空操作。
4. **`label` 只用于诊断**（`getEffects()` 看到的树，例如 `'ctx.plugin()'`、`'ctx.provide("llm")'`）。缺省是 `'anonymous'`。
5. 纤程已经 `DISPOSED`（`uid === null`）或正在 `UNLOADING`，再登记会抛 `CordisError('INACTIVE_EFFECT')`。第二条是 vendor 补丁：拆除过程中不许再往本次卸载快照外面挂新账。上游 `cordiverse/cordis` 同文件的 `effect()` 只有 `assertActive()`，没有 `UNLOADING` 这一闸。

插件回调本身也走同一套收集：`_reload` → `_execute(this._runner)`。函数插件 `return () => ...`，和显式 `ctx.effect` 是同一类「带着逆的效应」。

---

## 两层栈：一台电器内部，和整台电器

记账不在一个叫 `ctx.dispose` 的字段上（论文 Algorithm 1 那样写）。实现是两层：

**内层**：一次 `effect()` 自己的 `disposables: Disposable[]`。卸载这段时倒序跑：

```ts
const dispose = () => {
  if (disposing) return disposalTask
  disposing = true
  let task!: void | Promise<void>
  for (const disposable of disposables.splice(0).reverse()) {
    if (task) {
      task = task.then(() => runDisposable(disposable))
    } else {
      const result = runDisposable(disposable)
      if (isObject(result) && 'then' in result) {
        task = result as any
      }
    }
  }
  return disposalTask = task
}
```

厨房：这台咖啡机自己接的管子、台面、插座，拆的时候从最后一根管子倒着拔。出现第一个异步 disposer 之后，后面的会 `then` 串起来——**同一段 effect 内部，异步步骤是顺序的**。

**外层**：整根纤程的 `_disposables = new DisposableList<Disposable>()`。`DisposableList.clear()` 先取出再 `reverse()`：

出处：`vendor/cordis/src/utils.ts`

```ts
clear() {
  const values = [...this.map.values()]
  this.map.clear()
  return values.reverse()
}
```

`Fiber._unload` 拿这份倒序列，再 `Promise.all`：

```ts
private async _unload() {
  await Promise.all(this._disposables.clear().map(async (dispose) => {
    try {
      await composeError(async (info) => {
        await Promise.resolve()
        info.error = new Error()
        await runDisposable(dispose)
      }, this._runner.getOuterStack)
    } catch (reason) {
      this.ctx.logger.error(reason)
    }
  }))
  // epoch 仍是 INACTIVE → 惯性结束；否则链式 _reload
}
```

教程把这句写在明处：disposers **开始**的顺序是登记的反序，但多个**异步** disposer 会**并行**。若拆除步骤必须一个接一个，就放进**同一个** effect，让内层那条 `then` 链来保证。跨 effect 的并行，不是论文定理 16 的「整段严格串行 LIFO」。

嵌套怎么接上：`effect()` 先把 wrapper 推进纤程的 `_disposables`（vendor：在 `execute()` 跑插件代码**之前**就挂上，重入卸载才等得到这次 setup），再跑 `execute()`。内层若再 `ctx.effect` / `ctx.on` / `ctx.plugin` / `ctx.provide`，它们的 wrapper 也先落到纤程列表上；外层 `collect` 会把这个 disposer **从纤程列表删掉**、收进自己的 `disposables` 数组，并挂到 `EffectMeta.children`。于是外层卸载时，内层按 yield/return 的反序走，而不是和兄弟姐妹一起 `Promise.all`。这就是 primer 说的「相关工作放同一个 effect」。

`runDisposable` 还会查一张 `effectInertia` WeakMap：公开 disposer 是单次射击，但外层 / 纤程卸载若发现清理已经在飞，就加入那一次，而不是再跑一遍。这也是 vendor 补丁；论文 Algorithm 1 只有 `armed` 翻成 false 后直接 return。

---

## 惯性：拆到一半，目标又变了

01 篇已经见过 `epoch` 和 `inertia`。跟 effect 叠在一起看：

- 依赖齐了，epoch 从 `'__INACTIVE__'` 变成 `':' + uid + ...` → `LOADING`，`inertia = this._reload()`，跑插件回调，回调里的 `ctx.effect` 往 `_disposables` 记账。
- 依赖没了，或加载中途 epoch 又变 → `UNLOADING`，`inertia = this._unload()`，倒序（并可能并行）跑已登记的 wrapper。
- `_setEpoch` 若发现 `this.inertia` 已经在飞，**只改 epoch、不另开一次装卸**。飞完的那次 `_unload` / `_reload` 再看目标，必要时链式切到另一边。这就是论文说的惯性：一次装卸一旦开始，先跑完。

vendor 额外规定：`UNLOADING` 时 `effect()` 直接抛错，避免拆除过程中新账逃出本次 `clear()` 快照。`PENDING` / `LOADING` 仍允许登记——所以 `internal/plugin` 的同步监听器可以在激活前就往孩子身上挂 effect；孩子若一直没激活就被父卸掉，`fiber.dispose` 会显式 `_unload` 把这些预激活的账清掉。

根纤程没有这套装卸：`dispose` 被设成 `restart()`。

---

## Harness：工厂先摘牌，再关灶台上的壶

Agent 循环是一个 `Service`。构造函数里连续挂两笔账（`packages/core/agent-loop/src/index.ts`）：

```ts
this.ownership = new FactoryOwnership(ctx.fiber)
this.runtime = { ctx }
ctx.effect(() => () => this.ownership.dispose(), 'agentLoop.transactions()')
ctx.effect(() => ctx.agents.setFactory(this), 'agentLoop.setFactory()')
```

厨房顺序：

1. **`agentLoop.transactions()`**：先在这根纤程上挂一块「活 agent 名册」。正向动作几乎是空的（`() => () => ...`，立刻交出逆）；逆是 `FactoryOwnership.dispose()`——不再接单、`abort('agent loop is not active')`、并行等待所有活 agent 的 teardown 和启动中的任务。
2. **`agentLoop.setFactory()`**：再去 `ctx.agents` 登记自己是工厂。`setFactory` 自己又包了一层 `ctx.effect`（`packages/core/agent/src/index.ts`），标签 `'agents.setFactory()'`：槽位里写入工厂，dispose 时 `this.factory = undefined`。它把**那一个** disposer 原样返回。注释写明：身份必须是 Cordis 的那一个函数，复合 effect 才能按 yield 位置嵌套拆除；包一层包装函数，卸载时就会变成和兄弟姐妹并行的 sibling，工厂摘牌会跟仍在排干的 turn 抢跑。

后装先卸：纤程卸载时先跑 `setFactory` 的逆（摘牌，外面再 `create` 会听到「no agent factory registered」），再跑 `ownership.dispose()`（把已经烧着的壶关掉）。先关灶再摘牌，会留下一个还能接单、但灶已经拆了的窗口。

配置里要 `resumeSessionId` 的 agent，还多一笔：

```ts
ctx.effect(() => {
  const fiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
    void this.resumeWith(ctx, childCtx.sessionPersistence, { ... })
  })
  return fiber.dispose
}, `agentLoop.resume(${id})`)
```

`ctx.inject` 是 `ctx.plugin` 的糖（01 篇）。孩子纤程的 `dispose` 本身就是父亲的一个 effect（标签 `'ctx.plugin()'`）。这里再包一层，是把「等持久化服务出现再 resume」整段收进循环纤程的账本；卸循环时，这笔 resume 子纤程跟着拆。

单个 agent 的生命周期挂在**调用方**纤程上，不是只挂在工厂上。`prepare()` 在任何资源出现之前就登记：

```ts
unfollowOwner = ownerCtx.effect(() => () => {
  if (disposing !== undefined) return
  abort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
  return dispose(true)
}, `agentLoop.lifecycle(${id})`)
```

调用方纤程一卸，这台电器的插头先拔：取消 setup、停 machine、退注册表、拆 scope。`FactoryOwnership.track(dispose)` 是工厂名册上的第二本账，和 Cordis 的 LIFO 栈并列，不是论文里的累加器字段。

---

## 对照论文：可逆效应、定理 16、Algorithm 1

不另证定理。只把论文里**已经写出来的**对象，对到上面读过的代码。

**可逆效应（§3.1）。** 每次改环境，都带一份左逆；运行时记账。左逆是单侧的：论文要求 \(g \circ f\)，不要求 \(f \circ g\)。实现不检查逆是否真能恢复原状——§5.1.1 / §6.1 把这件事标成组件作者的义务，不是运行时核验。`ctx.effect(() => { 占插座; return () => 还插座 })` 就是这个形状。Table 2：\(\mathrm{effect}_\Gamma(e)\) 对到 `ctx.effect(callback)`；累加器 \(g\) 对到 `fiber.dispose`。当前文件里没有名叫 `accumulator` 的字段，也没有可赋值的 `ctx.dispose`。

**定理 16（LIFO）。** \(e_1,\ldots,e_n\) 从 \((\gamma_0, \mathrm{id}_\Gamma)\) 依次应用，再按反序撤回：每一次撤回都遇到自己当初动手时的状态，中间态满足可靠性不变式。证明依赖的是「逆碰到自己造出来的状态」，不依赖独立交换。这正对应**同一段 effect 内部**那条 `disposables.reverse()`，以及嵌套 effect 被 `collect` 收进父数组之后的倒序。跨顶层 effect 的 `Promise.all` **不是**定理 16 的假设；教程已经把并行写进文档。独立效应（§3.1.3）才讨论「逆碰到别人改过的状态」——那是卸掉一棵树上的一个孩子、旁边兄弟还在时的问题，本篇不展开。

**Algorithm 1（§5.1.1）。** 论文伪代码把 `ctx.effect` 画成：

1. `execute(callback, guard)` 把 callback 当迭代器跑，每步 `inverse ← value ∘ inverse`（新的逆**前置**，所以 LIFO）；
2. `armed` 为真才继续；`dispose` 把 `armed` 翻成 false，等 `execute` 结束再 `recover()`；
3. `ctx.dispose ← dispose ∘ ctx.dispose`（孩子的逆本身是父亲的一笔效应）。

和 vendor `Fiber.effect` 对得上的部分：立刻执行、收集逆、单次射击、嵌套进父亲的账本、异步迭代在 epoch 变了之后停。

对不上、不要把伪代码当逐行注释的部分：

| 论文 Algorithm 1 | 当前 vendor 源码 |
|---|---|
| 累加器是可赋值的 `ctx.dispose`（函数合成 \(f \circ g\)） | `Fiber._disposables`（`DisposableList`）；`fiber.dispose` 是卸整根纤程 |
| `armed` | 嵌套 effect 用 `runner.epoch: boolean`；另有 `disposing` / `disposalTask` |
| callback 一律当迭代器 | `_execute` 接受函数 / 可迭代 / Promise / 异步可迭代四种 |
| 每步前看 `guard()` | 同步迭代器跑完才停；异步迭代器才在 `next()` 前看 `runner.epoch !== oldEpoch` |
| 逆严格合成、顺序执行 | 一段 effect 内部可 `then` 串行；纤程 `_unload` 对顶层 wrapper `Promise.all` |
| 先 `execute` 再把 dispose 接到父亲 | vendor：**先** `push(wrapper)` **再** `execute()`，重入卸载等得到 setup |
| （未写）UNLOADING 仍可登记 | vendor：`UNLOADING` 抛 `INACTIVE_EFFECT` |
| （未写）公开 dispose 与所有者汇合 | vendor：`effectInertia` WeakMap，外层可 join 已在飞的清理 |
| 组件级 guard 看 `fiber.target` | **当前文件没有** `fiber.target`；用 `_runner.epoch === '__INACTIVE__'` |

组件实例化也是一笔 effect：`this.dispose = parent.fiber.effect(() => { ... return async () => { uid = null; ... _setEpoch(INACTIVE); while (inertia) await inertia } }, 'ctx.plugin()')`。论文说「其它改上下文的操作都归结为 `ctx.effect`」——`provide` / `mixin` / `on` / `plugin` 在源码里确实都走进 `fiber.effect`。`ctx.set` 是 Algorithm 2 的伪代码名；实现登记服务用的是 `ctx.provide`（03 篇）。

不要把 Algorithm 1 当成 `vendor/cordis/src/fiber.ts` 的行号对照。vendor 日志已经列出可重入处置、UNLOADING 拒登记等论文伪代码没写全的缝。

---

## 本篇读完应该能回答的三句话

1. `ctx.effect(execute, label?)` 是 `Fiber.effect` 的 mixin：`execute` 立刻跑，交出 disposer；纤程卸载或你先调用，都按登记的反序撤。
2. 后装先卸有两层：一段 effect 内部倒序（异步则 `then` 串行）；纤程顶层 `_disposables.clear().reverse()` 之后 `Promise.all`，多个异步 disposer 会并行——顺序有要求就放进同一个 effect。
3. Agent 循环把「活 agent 名册」和「工厂槽位」做成两笔 effect；后装的 `setFactory` 先摘牌，先装的 `ownership.dispose` 再关壶。运行时不检查逆是否真把厨房恢复原状。

---

## 下一篇读什么

**03 · reactive-coeffects**（`inject` / `provide` / `refresh` / committed）。

本篇已经看到：`provide` 本身是一笔 `ctx.fiber.effect`，卸掉就从 store 里删并 `notify`。下一篇专门读依赖声明怎样把纤程停在 `PENDING`、服务出现/消失怎样改 epoch、以及论文 Table 2 的 `fiber.committed` / `fiber.target` 在当前文件里分别由什么承担。先不要跳到事件总线。

---

## 拉取记录

成功：

- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-primer.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-primer.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-tutorial/02-lifecycle-and-effects.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-api/fiber.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-api/context.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/vendor/README.md`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/vendor/cordis/src`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/vendor/cordis/src/{fiber,context,reflect,utils}.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/agent-loop/src/index.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/agent/src/index.ts`
- `https://raw.githubusercontent.com/cordiverse/cordis/main/packages/core/src/fiber.ts`

未 404 的请求里，没有需要标「文件不存在」的项。论文 Algorithm 1 的 `armed` / 可赋值 `ctx.dispose` / `fiber.target`，以及 Table 2 的 `ctx.use` / `ctx.set`（作为登记 API）**不是**当前 vendor 文件的公开名字，上文已按实文件名对照。
