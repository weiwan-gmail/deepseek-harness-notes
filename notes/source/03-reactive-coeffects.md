# 03 · inject / provide / refresh / committed

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[02 revertible-effects](02-revertible-effects.md) · 下一篇：[04 events](04-events.md)

读的是 DeepSeek Harness 真正跑的那份 Cordis，不是自己再发明一套词。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 文档 | `docs/cordis-primer.md`、`docs/cordis-primer.zh.md`、`docs/cordis-tutorial/03-services.md`、`docs/cordis-tutorial/03-services.zh.md`、`docs/cordis-api/fiber.md`、`docs/cordis-api/context.md` |
| Vendor 清单 | `vendor/README.md`：`@deepseek-ai/cordis` 4.0.0-rc.7，上游 `cordiverse/cordis` `packages/core`，commit `56b3d4f725681cf4556c1a8695a709cc3b6eed74` |
| 本仓库实际引用 | `vendor/cordis/src/{fiber,registry,reflect,service,context}.ts` |
| Harness 用法 | `packages/core/agent-loop/src/index.ts`（`static inject`、`ctx.inject(['sessionPersistence'], …)`） |
| 上游对照 | `cordiverse/cordis` `packages/core/src/fiber.ts`（`main`：同样是 `_store` / `_refresh` / epoch，**没有** `fiber.committed`） |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§3.2 定义 22–26、§5.1 Table 2 / Algorithm 2–6 |

01 篇已经记下：Table 2 的 `fiber.committed` / `fiber.target` / `ctx.use` **不是**当前 vendor 文件的公开字段。本篇跟真实名字走：`fiber.inject`、`ctx.provide`、`_refresh`、epoch、`fiber.store` / `_store`、`reflect.notify`。

---

## 厨房：没电就别冲，来电再醒

上一篇谈拆机顺序（时间可组合）。这一篇谈水电（空间可组合）。

咖啡机要冲一杯，需要两样东西同时在：**电**和**水**。说明书上写着「本机依赖电源、进水」。厨房按这份清单接线，而不是按「先装哪台电器」的文件顺序。

- 没电：不要硬冲。机器停在台面上等，既不冒烟，也不假装出了一杯。
- 来电：清单齐了，自动醒，开始冲。
- 冲到一半停电：停冲、按上一篇的顺序拆掉自己接的管子；电回来再按当时那一套水电重新接。
- 换了一路新电源（还叫「电」，但是另一台发电机）：旧路先拆干净，再按新 uid 重接——不是整间厨房断电重启。

primer 原话（`docs/cordis-primer.zh.md`）：**通过 `inject` 声明服务依赖。** 插件声明所需的服务后，会等待这些服务就绪才启动；加载顺序通过服务依赖表达，而非手动编排启动序列。

教程补了一句（`docs/cordis-tutorial/03-services.zh.md`）：`inject` 并非一次性的启动检查。提供方被卸载或热替换，每个依赖插件也会随之卸载，并在服务恢复后再次加载。

厨房里的说法：插座上有没有电，要一直盯着，不是开机时看一眼。本篇钉子就是这四件事：谁声明需要什么（`inject`）、谁往插座上供电（`provide`）、电一变怎样叫醒电器（`notify` / `_refresh`）、冲的时候盯的是当时那份水电还是现表（`fiber.store`，论文叫 committed 视图）。

---

## `inject`：说明书上写需要什么

依赖声明有三条入口，最后都变成纤程上的一张表 `fiber.inject`（服务名 → 可选的 intercept 配置，没有配置就是 `null`）。

1. **插件元数据。** 函数 / 对象 / 类上的 `inject`。出处：`vendor/cordis/src/registry.ts` 的 `Plugin.Base` 与 `Inject.resolve`。

```ts
export type Inject<M = Dict> = (keyof M)[] | { [K in keyof M]?: M[K] }

export function resolve(inject: Inject | null | undefined, result: Dict = Object.create(null)) {
  if (!inject) return result
  if (Array.isArray(inject)) {
    for (const name of inject) {
      result[name] = null
    }
  } else if (Reflect.has(inject, symbols.checkProto)) {
    Object.assign(result, resolve(Object.getPrototypeOf(inject)))
    for (const name of Object.keys(inject)) {
      result[name] = inject[name] ?? null
    }
  } else {
    for (const name of Object.keys(inject)) {
      result[name] = inject[name] ?? null
    }
  }
  return result
}
```

数组只点名；对象还可以给某个服务叠 intercept。带 `symbols.checkProto` 的那一枝是 class `@Inject` 往原型链上叠的静态表。

`ctx.plugin` 建纤程时把这份表交进去：`new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, …)`。

2. **`ctx.inject(deps, callback)`。** 不是另一套运行时，只是 `plugin` 的糖：

```ts
inject(inject: Inject, callback: Plugin.Function<void>) {
  return this.plugin({ inject, apply: callback, name: callback.name })
}
```

`reflect.ts` 把 `registry` 的 `inject` / `plugin` mixin 到 `ctx` 上，所以你写 `ctx.inject(...)`，跑的是上面这一行。没有名为 `ctx.use` 的登记函数（论文 Table 2 / Algorithm 4 的伪代码名，01 篇已经对过）。

3. **类上的 `@Inject` 装饰器。** 写在类上就往静态 `inject` 表里加一行；写在方法上则在 init 时再 `ctx.inject` 一次，等服务齐了才调用该方法。本篇不展开装饰器，只记住：它最后还是同一张 `fiber.inject`。

纤程构造之后并不立刻跑插件回调。`runtime` 分支先 `emit('internal/plugin')`（loader 可能在这条通知里改 `inject`），再：

```ts
if (this.uid !== null && parent.fiber.state !== FiberState.UNLOADING) {
  for (const name of Object.keys(this.inject)) {
    this._checkImpl(name)
  }
  this._refresh()
}
```

缺任何一项，`_refresh` 把 epoch 设成哨兵 `'__INACTIVE__'`，状态停在 `PENDING`。教程原话：消费方保持 PENDING，不输出、不崩溃、也不只跑一部分。`cordis.yml` 里谁写在前面无关紧要。

**可选依赖不要写进 `inject`。** 教程的探法是 `ctx.get('greeter')`：没提供就 `undefined`，插件照样 ACTIVE。`get` 的注释写明「Read a service from the store without the inject requirement」。硬性依赖才进清单；清单里的名字，Proxy 会强制你只能在已提交的视图里读（下文）。

Harness 里最直的一份清单，是 Agent 循环这个 `Service`（`packages/core/agent-loop/src/index.ts`）：

```ts
export class AgentLoop extends Service implements AgentFactory {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']
```

厨房：这台总机要五路水电——活 agent 名册、会话日志、模型适配器、工具表、系统提示词。少一路就不 ACTIVE，也不会去接单。`Service` 子类的静态 `inject` 就是 `plugin.inject`，`Inject.resolve` 看到的是同一份数组。

配置里要 `resumeSessionId` 的 agent，还另开一根子纤程等持久化服务，02 篇已经见过形状：

```ts
ctx.effect(() => {
  const fiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
    void this.resumeWith(ctx, childCtx.sessionPersistence, { ... })
  })
  return fiber.dispose
}, `agentLoop.resume(${id})`)
```

这不是循环自己的 `static inject`。循环可以在没有持久化插件时先启动；resume 那一段单独声明 `sessionPersistence`，服务出现再跑，服务消失整段拆掉。硬性依赖和可选探测（上面 `ctx.get('sessionPersistence')` 分叉 restore / create）是两件不同的事。

---

## `provide`：往插座上接电

声明需要什么，还得有人供电。供电本身是一笔可逆效应：插上是正向，拔掉是逆，02 篇的账本接得上。

真正写入实现的是 `ReflectService.provide`（mixin 成 `ctx.provide`）。出处：`vendor/cordis/src/reflect.ts`：

```ts
provide(name: string, value?: any, check?: () => boolean) {
  return this.ctx.fiber.effect(() => {
    // props[name] 必须是 service，不能是已有的 accessor
    this.ctx.root[symbols.isolate][name] ??= Symbol(name)
    const key = this.ctx[symbols.isolate][name]
    const impl: Impl = { name, value, fiber: this.ctx.fiber, check }
    if (this.store[key]) {
      throw new Error(`service "${name}" has been registered at <${this.store[key].fiber.name}>`)
    }
    this.store[key] = impl
    this.ctx.fiber.store![name] = impl
    if (this.ctx.fiber.state === FiberState.ACTIVE) {
      this.notify([name])
    }
    return async () => {
      delete this.store[key]
      const fibers = this.notify([name])
      await Promise.allSettled(fibers.map(fiber => fiber.await()))
      // ensure self access before dependencies cleanup
      delete this.ctx.fiber.store![name]
    }
  }, `ctx.provide(${JSON.stringify(name)})`)
}
```

要点：

1. **登记进 `reflect.store`，键是 isolate 标签**（默认 `Symbol(name)`），不是裸字符串。同一隔离域里同名服务只能有一个提供方，否则抛错。这就是论文「同一 key 不能提供两次」。
2. **可见性跟着提供方纤程的状态走。** `_getImpl` 默认 `strict = true`：提供方不是 `ACTIVE`，当作还没提供。LOADING 期间已经写入 `store`，但依赖方 `_checkImpl` 看不到。提供方落到 ACTIVE 时，`Fiber._updateState` 再 `notify` 一次自己名下的服务。
3. **只有提供方已经 ACTIVE，这次 `provide` 才当场 `notify`。** 插件回调跑在 LOADING 里：`super(ctx, name)` 当时多半还不是 ACTIVE，依赖方要等状态跨过那条线才醒。
4. **拔插头时先叫醒喝这路电的人，等他们拆完，再从自己的快照里删。** `await fiber.await()` 对应论文 L-Unload 守卫里「等被通知的依赖方」。实现把这道守卫放在 **provide 的 disposer 里面**，不是 `_unload` 开头的统一前缀；纤程顶层多个 disposer 仍可能 `Promise.all`（02 篇）。
5. **`ctx.set` 只改 `impl.value`，不 `notify`。** 换值但不换提供方纤程，依赖方不会因此重载。论文 Algorithm 2 的 `set` 伪代码是「写入并 notify」；当前文件里承担「写入并叫醒邻居」的是 `provide` / 状态跨越 ACTIVE，不是 `ctx.set`。

`Service` 子类不手写 `ctx.provide`。构造函数（`vendor/cordis/src/service.ts`）：

```ts
constructor(protected ctx: Context, name: string) {
  name ??= this.constructor['provide'] as string
  // ...
  self.ctx.reflect.provide(name, self, this[symbols.check])
  return self
}
```

`Plugin.Base.provide`（`string | string[]`）是给 `Service` / loader 看的元数据，**不是**运行时的第二张提供表。AgentLoop 走的是 `super(ctx, 'agentLoop')`，对外提供的名字是 `'agentLoop'`。可选的 `[Service.check]` 是可用性谓词：`_checkImpl` 会 `impl.check.call(...)`，返回假就当这路电还没来。

教程最小例子：`GreeterService` 的 `super(ctx, 'greeter')` 就是往名为 `greeter` 的插座上接电；卸载这根纤程，注册作为 effect 被撤掉。

---

## `notify` / `_refresh` / epoch：电一变，对照清单重算

叫醒邻居的函数也在 `reflect.ts`：

```ts
notify(names: string[], filter = (ctx: Context, name: string) => ctx[symbols.isolate][name] === this.ctx[symbols.isolate][name]) {
  const fibers: Fiber[] = []
  for (const runtime of this.ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      let hasUpdate = false
      for (const name of names) {
        if (!(name in fiber.inject)) continue
        if (!filter(fiber.ctx, name)) continue
        hasUpdate = true
        fiber._checkImpl(name)
      }
      if (!hasUpdate) continue
      fiber._refresh()
      fibers.push(fiber)
    }
  }
  // 再 emit('internal/service', name, value) —— 事件是 04 篇
  return fibers
}
```

只惊动 **inject 里点过这个名字、且 isolate 标签对得上** 的纤程。另一间用 `isolate` 隔开的子厨房，同名插座不共用这一路电（01 篇）。

被点到的纤程做两步。出处：`vendor/cordis/src/fiber.ts`。

**`_checkImpl`**：按当前上下文去 `reflect._getImpl(name, true)`。没有实现、提供方未 ACTIVE、或 `check()` 为假，就从 **`_store` 里删掉**；否则写入 `_store[name] = impl`。

**`_refresh`**：对照 `inject` 的每一个名字拼 epoch：

```ts
_refresh() {
  let epoch: string | boolean = false
  epoch = ''
  for (const name of Object.keys(this.inject)) {
    const impl = this._store[name]
    if (!impl) {
      epoch = INACTIVE
      break
    }
    epoch += ':' + impl.fiber.uid
  }
  this._setEpoch(epoch)
}
```

- 缺任何一项 → `'__INACTIVE__'`（论文 target = ⊥）。
- 齐了 → `':' + uid1 + ':' + uid2 + …`。里面有提供方的 **uid**，所以「还叫 llm、已经换了一根纤程」和「llm 消失」一样会改 epoch。

**`_setEpoch`**：epoch 没变就返回（厨房：满足性没变，也还是同一批发电机 → 没事）。变了且没有飞行中的 `inertia`：

- 旧值是 INACTIVE、新值不是 → `LOADING`，`inertia = this._reload()`（来电，开始冲）。
- 其余变化 → `UNLOADING`，`inertia = this._unload()`（停电，或换了一路电：先拆再看）。拆完若 epoch 又不是 INACTIVE，链式 `_reload`。

有 `inertia` 时只改 epoch、不另开一次装卸——02 篇的惯性。源码里**没有**名为 `activating` / `deactivating` / `neutral` 的枚举；这三种分类是论文定义 26 的说法，实现压缩进「epoch 相不相等、旧值是不是 INACTIVE」。

提供方自己跨越 ACTIVE 时也会 notify。`_updateState` 写明：只在 **ACTIVE ↔ 非 ACTIVE** 之间才扫自己名下的 `reflect.store` 项。进入 `UNLOADING` 的那一刻，提供方已经「停服」（`_getImpl` 的 strict 检查），依赖方先看到不满足并开始拆，而 `Impl` 对象往往还在——论文 Algorithm 2–3 那句「提供只在 ACTIVE 时算数」。

---

## 已提交视图：冲的时候盯当时那份水电

论文 Table 2 把已提交视图 \(\omega\) 写成 `fiber.committed`，把 target 写成 `fiber.target`。当前 `vendor/cordis/src/fiber.ts` **没有这两个公开字段**。承担同一件事的是：

| 论文 | 当前文件 |
|---|---|
| target（此刻该看见谁；⊥ = 不齐） | `_runner.epoch`：`'__INACTIVE__'` 或 `':' + uid…` |
| committed \(\omega\)（激活时钉住的那份） | 公开字段 `fiber.store`；加载一开始 `this.store = { ...this._store }` |
| 还在变的工作表 | 私有 `_store`，由 `_checkImpl` 改 |

`_reload` 第一件事就是拍快照：

```ts
private async _reload() {
  this.store = { ...this._store }
  const oldEpoch = this._runner.epoch
  try {
    await Promise.resolve()
    if (this._runner.epoch === oldEpoch) {
      this.config = this._resolveConfig(this._config)
      await this._execute(this._runner)
      this._error = undefined
    }
  } catch (reason) {
    this.ctx.logger.error(reason)
    this._error = reason
    this._runner.epoch = INACTIVE
  }
  // epoch 仍是当初那份 → 惯性结束、落到 ACTIVE；否则链式 _unload
}
```

卸载跑完所有 disposer 之后才 `this.store = undefined`。所以拆自己的时候，插件回调里读到的 `ctx.llm` 仍是**激活时那份 Impl**，不是现表上可能已经空了的槽。这就是论文定理 63 说的「读视图不读现表」；实现字段叫 `store`，不叫 `committed`。

Proxy 的 get trap（`reflect.ts`）沿纤程父链走的正是这份快照：

```ts
let fiber = (ctx[symbols.shadow] as Context ?? ctx).fiber
while (true) {
  const impl = fiber.store?.[prop]
  if (impl) return getTraceable(ctx, impl.value)
  if (prop in fiber.inject) {
    error.message = `cannot get required service "${prop}" in inactive context`
    throw error
  }
  if (!fiber.runtime) throw error
  if (fiber.parent[symbols.isolate][prop] !== key) throw error
  fiber = fiber.parent.fiber
}
```

厨房读法：

- 自己的 `store` 里有这个名字 → 用激活时钉住的那台机器。
- 自己 `inject` 里点过、但还没 commit（PENDING / 已经卸完）→ 抛「inactive context」，不要去现表上偷电。
- 自己没声明、祖先 isolate 标签还对得上 → 继续往父厨房找。
- 标签已经对不上，或走到根还没有 → 抛当初那句 `cannot get property "${prop}" without inject`。

这和裸 `ctx.get` 不同：`get` 查 `reflect.store`，不要求你写过 `inject`，也没有这份快照语义。强制规格 \(d\) 的是 Proxy，不是 `get`。

API 文档把 `fiber.store` 写成：「Snapshot of required service implementations while loaded; `undefined` otherwise.」（`docs/cordis-api/fiber.md`）——就是 committed 视图的公开名字。

---

## 对照论文：反应式余效应、notify、committed

不另证定理。只把论文里**已经写出来的**对象，对到上面读过的代码。

**余效应规格（定义 25）。** \(\mathfrak{D}_\Sigma = \mathsf{Set}(K)\)：部件向环境声明的依赖集合。实现是 `plugin.inject` / `static inject` / `fiber.inject`。满足谓词 \(\sigma\models d\) 就是 `_refresh` 能拼出非 INACTIVE 的 epoch。规格只表达「这些 key 在不在」；可选依赖、版本约束不在这份语言里——教程用 `ctx.get` 做工程旁路，论文 §8 自己把更丰富的规格标成未来工作。

**通知分类（定义 26）。** \(\mathrm{notify}_d(\sigma,\sigma')\) 分成 activating / deactivating / neutral。实现没有这三个标识符。`reflect.notify` 是「去改邻居的 `_store` 并 `_refresh`」；三分法落在 `_setEpoch`：

| 论文 | 当前 vendor |
|---|---|
| activating（刚才不齐，现在齐） | 旧 epoch 是 INACTIVE、新值不是 → `_reload` |
| deactivating（刚才齐，现在不齐） | 新 epoch 是 INACTIVE → `_unload` |
| 提供方换了人、名字还在（定义 26 会叫 neutral，因为满足性没变） | epoch 字符串含 uid，仍走 `_unload`，卸完再链式 `_reload` |
| 真·neutral（同一批 uid） | `_setEpoch` 开头直接 return |

不要把论文的 `notify_d` 和源码方法 `notify()` 当成同一个函数。前者是分类；后者是广播。

**set 是可逆效应（定义 23）。** \(\mathrm{set}(k,v)\) 的类型是效应：写入，逆是删掉。实现是 `ctx.provide` 包在 `fiber.effect` 里，标签 `'ctx.provide("llm")'`。论文 Algorithm 2 写 `ctx.set`；02 篇已经对过：登记服务的公开 API 是 `provide`。`ctx.set` 在当前文件里是「提供方改自己的 `impl.value`」，不广播。

**Algorithm 4 的 `ctx.use`。** 实现是 `ctx.plugin` / `ctx.inject`：子纤程的 dispose 本身是父亲的一笔 effect（标签 `'ctx.plugin()'`）。

**Algorithm 5 / 6。** reload 先快照再跑回调、unload 后丢掉 `store`、Proxy 沿 `fiber.store` 走、声明了但未 commit 就抛 inactive——这些对得上。对不上、不要当逐行注释的：

| 论文 | 当前 vendor |
|---|---|
| `fiber.committed` / `fiber.target` | **没有**；`fiber.store` + `_runner.epoch` |
| `ctx.use` | `ctx.plugin` / `ctx.inject` |
| unload 开头统一 `await` 所有依赖方 | 守卫在 **provide disposer** 里；`_unload` 对顶层 wrapper `Promise.all` |
| `set` 写入并 notify | `provide` / ACTIVE 跨越才 notify；`ctx.set` 不 notify |
| 部件级 guard 看 `fiber.target` | 异步迭代器看 `runner.epoch !== oldEpoch`（02 篇） |

上游 `cordiverse/cordis` `packages/core/src/fiber.ts`（`main`）同样是 `_store` / `_refresh` / epoch，同样没有 `committed`。vendor 补丁主要在可重入处置（02 篇），不是另发明一套余效应 API。

---

## 本篇读完应该能回答的三句话

1. `inject` 是说明书上的硬性依赖（`fiber.inject`）；不齐就 `PENDING`。`ctx.inject` 只是 `ctx.plugin` 的糖。可选能力用 `ctx.get`，不要写进清单。
2. `provide` 是往 isolate 标签对应的插座上接电，本身是一笔 `ctx.effect`；只有提供方 `ACTIVE` 时依赖方才看得到。电一变，`notify` → `_checkImpl` → `_refresh` → 必要时 `_reload` / `_unload`。
3. 冲咖啡盯的是激活时拍下的 `fiber.store`，不是正在改的 `_store`。论文的 `fiber.committed` / `fiber.target` / `ctx.use` 在当前文件里分别叫 `store`、epoch、`plugin`。

---

## 下一篇读什么

**04 · events**（`emit` / `waterfall` / `serial` / `parallel`）。

本篇已经看到：`notify` 末尾会 `emit('internal/service', …)`；状态变化会 `emit('internal/status')`。下一篇专门读事件总线四种分发、`ctx.on` 怎样也是一笔 effect，以及 Harness 的 `agent/pre-step`、`agent/request` 怎样挂在这根钉子上。先不要跳到启动 profile。

---

## 拉取记录

成功：

- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-primer.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-primer.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-tutorial/03-services.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-tutorial/03-services.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-api/fiber.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-api/context.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/vendor/README.md`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/vendor/cordis/src`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/vendor/cordis/src/{fiber,context,registry,reflect,service}.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/agent-loop/src/index.ts`
- `https://raw.githubusercontent.com/cordiverse/cordis/main/packages/core/src/fiber.ts`

404：

- `docs/cordis-api/reflect.md`（没有单独的 Reflect API 页；`provide` / `get` / `notify` 写在 `context.md` 与源码 JSDoc 里）

论文 Table 2 的 `fiber.committed` / `fiber.target` / `ctx.use`，以及定义 26 的 `activating` / `deactivating` / `neutral` 标识符，**不是**当前 vendor 文件的公开名字，上文已按实文件名对照。
