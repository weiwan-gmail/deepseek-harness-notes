# 01 · Cordis 内核：Context 与 Fiber 生命周期

课表：[source-curriculum.md](../source-curriculum.md) · 下一篇：[02 revertible-effects](../source-curriculum.md)（待写）

读的是 DeepSeek Harness 真正跑的那份 Cordis，不是自己再发明一套词。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 文档 | `docs/cordis-primer.md`、`docs/cordis-primer.zh.md`、`docs/architecture.md`、`docs/cordis-tutorial/02-lifecycle-and-effects.md`、`docs/cordis-api/context.md`、`docs/cordis-api/fiber.md` |
| Vendor 清单 | `vendor/README.md`：`@deepseek-ai/cordis` 4.0.0-rc.7，上游 `cordiverse/cordis` `packages/core`，commit `56b3d4f725681cf4556c1a8695a709cc3b6eed74` |
| 上游 Cordis | `cordiverse/cordis` 默认分支是 `main`；`master` 上同路径的 `packages/core/src/context.ts` 也能取到，内容与 `main` 一致 |
| 本仓库实际引用 | `vendor/cordis/src/{context,fiber,registry,reflect,service}.ts`（Harness 有本地补丁，见下文） |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）定义 32、43、44、49 与 Table 2 |

`vendor/README.md` 第 6 条写明：`cordis/src/fiber.ts` 相对上游做了可重入处置硬化（UNLOADING 时拒绝新建效应、子纤程在 `internal/plugin` 发布前就挂上父拥有的 disposer 等）。下面引文以 **vendor 这份** 为准；Table 2 里若干字段名是论文对实现的称呼，和当前文件里的公开字段并不逐字相同，文中会分开写。

---

## 厨房里的两样东西

把一次正在跑的 `dsh` 想成一间可以随时改布局的厨房。

**Context（上下文）是这间厨房本身**：墙上的插座、台面、水槽，以及挂在固定钩子上的工具。钩子有稳定的名字：`ctx.tools`、`ctx.llm`、`ctx.sessions`。谁来做饭，都按名字拿，不按「这把刀是哪家厂出的」去 import。primer 的原话是：上下文是服务的容器；服务占据一个稳定的 `ctx.<name>`，其他插件通过 key 查找，而不是导入具体实现。

**Fiber（纤程）是某台电器此刻的安装实例**：咖啡机已经插上、正在冲，还是还在等电、还是已经拆走。同一份插件代码（电器型号）可以装多次，每一次安装各有一根纤程、各有一份生命周期。教程原话：`ctx.plugin(...)` 返回的是 **fiber，一根已加载插件实例的运行时句柄**。

插件本身只是说明书：函数、带 `apply(ctx)` 的对象，或 `Service` 子类。说明书不会自己占插座。`ctx.plugin(说明书)` 才在当前厨房里装出一根纤程。

拆走咖啡机，台面要恢复（时间可组合，下一篇 `ctx.effect`）。没电就别冲、来电再自动工作（空间可组合，第 03 篇 `inject` / `provide`）。本篇只先认清：**厨房是 Context，这一台正在插着的机器是 Fiber。**

Harness 没有另写一套生命周期。`docs/architecture.md` 说：Cordis 是 dsh 底下的架构；模型适配器、工具表、会话日志、**连 Agent 循环本身**都是插件，挂进同一棵上下文树。所以先读懂 Context / Fiber，后面 20 篇才有地方挂。

---

## Context：一棵可长出子厨房的代理

根上下文在构造函数里一次装齐内置服务，并把自身换成 Proxy，好让 `ctx.tools` 这类属性走服务解析，而不是普通对象字段。

出处：`vendor/cordis/src/context.ts`（与上游 `packages/core/src/context.ts` 同结构；vendor 多了 JSDoc）。

```ts
constructor() {
  this[symbols.isolate] = Object.create(null)
  this[symbols.intercept] = Object.create(null)
  const self = new Proxy(this, ReflectService.handler)
  this.root = self
  this.fiber = new Fiber(self, {}, Object.create(null), null, () => [])
  this.reflect = new ReflectService(self)
  this.registry = new RegistryService(self)
  this.events = new EventsService(self)
  this.logger = new LoggerService(self)
  this.fiber._disposables.clear()
  return self
}
```

要点：

1. 根纤程的 `runtime` 是 `null`，`uid` 为 `0`，状态直接是 `ACTIVE`。它不是某个插件，只是整棵树的树根。
2. `reflect` / `registry` / `events` / `logger` 是内置服务。`ReflectService` 再把一批方法 mixin 到 `ctx` 上，所以你写 `ctx.plugin`、`ctx.effect`、`ctx.on`，实际分别落到 `registry`、`fiber`、`events`。
3. 每个上下文都带着两张**原型链上的影子表**：`[symbols.isolate]`（服务名 → 隔离标签）和 `[symbols.intercept]`（服务名 → 拦截配置）。子上下文用 `Object.create(父表)` 往上叠一层，**不改父亲**。

`extend` / `isolate` / `intercept` 都是「长出一间子厨房，父厨房不动」。文档：`docs/cordis-api/context.md`。

```ts
extend(meta = {}): this {
  const self = Object.create(getTraceable(this, this))
  for (const prop of Reflect.ownKeys(meta)) {
    Object.defineProperty(self, prop, Reflect.getOwnPropertyDescriptor(meta, prop)!)
  }
  // ...
  return self
}

isolate(name: string, label?: symbol) {
  const shadow = Object.create(this[symbols.isolate])
  shadow[name] = label ?? Symbol(name)
  return this.extend({ [symbols.isolate]: shadow })
}

intercept(name: string, config: any) {
  const intercept = Object.create(this[symbols.intercept])
  intercept[name] = config
  return this.extend({ [symbols.intercept]: intercept })
}
```

厨房类比：

- **`extend`**：在同一间厨房里多贴一张工作单（例如「这张单属于哪根纤程」）。`new Fiber` 时就是 `parent.extend({ fiber: this })`，子插件看到的 `ctx.fiber` 是自己，不是父亲。
- **`isolate(name, label?)`**：给某个服务名换一个独立回路。默认 `label` 是一枚新的 `Symbol(name)`。之后在这间子厨房里 `provide` / `get` 这个名字，走新标签，不影响父厨房里的同名服务。两次 `isolate` 传入**同一个** `label`，两间子厨房共用一条回路。
- **`intercept(name, config)`**：不换电器，只在这间子厨房的插座上贴一张配置条。子树里启动的插件，会把这张条合并进该服务的解析配置（祖先在前，见 `Service[symbols.resolveConfig]`）。父亲不受影响。

Harness 为什么在乎 isolate：`docs/architecture.md` 写「给一个会话另一套能力」时，agent preset 里的服务行需要一个 `isolate` realm。`packages/boot/app-boot/README.md` 补充：`cordis:group` 和 `cordis:include` 并列注册，好让一次组合把**同一个 isolate realm** 同时交给提供方和它的消费者。这就是论文定义 28–29 的「同一逻辑依赖、不同部件看到不同绑定」，实现上是符号标签，不是另起一个进程。

解析时标签怎么用，在 `vendor/cordis/src/reflect.ts`：`provide` 把实现存进 `this.store[key]`，`key` 来自当前上下文的 isolate 标签；`_getImpl` 用同一套标签取回。Proxy 的 get trap 还会沿纤程父链往上走，直到 isolate 标签对不上就停——子回路看不到父回路的同名服务。

```ts
_getImpl(name: string, strict = true) {
  const key = this.ctx[symbols.isolate][name]
  const impl = key && this.store[key]
  if (!impl) return
  if (strict && impl.fiber.state !== FiberState.ACTIVE) return
  return impl
}
```

`strict === true`（默认）时，提供方纤程必须是 `ACTIVE`，否则当作还没提供。这已经碰到下一篇和 03 篇的边界：服务的可见性跟着纤程状态走。

---

## Fiber：一台电器的生命周期

`FiberState` 是数字枚举，注释写在 `vendor/cordis/src/fiber.ts`。教程 `docs/cordis-tutorial/02-lifecycle-and-effects.md` 画的是同一条路：

```
PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED
                 ↘ FAILED
```

| 状态 | 源码注释的含义 | 厨房 |
|---|---|---|
| `PENDING` | 已声明，但所需服务还没齐 | 咖啡机已搬进厨房，插座还没电 |
| `LOADING` | 插件回调正在跑 | 正在接线、正在接水管 |
| `ACTIVE` | 已加载，正在对外提供 | 开始出咖啡；别人可以来拿 |
| `FAILED` | 回调或配置校验抛错 | 接线失败，这台机器不能用 |
| `UNLOADING` | disposer 正在跑 | 正在拆管、拔插头（后装的先拆） |
| `DISPOSED` | 纤程已摘掉，不能再启动 | 机器抬走了；`uid` 被置成 `null` |

根纤程跳过这条路：构造时直接 `ACTIVE`，`dispose` 被设成 `restart()`。

状态怎么变，看 `_setEpoch` / `_reload` / `_unload`，而不是另有一张外部调度表。

- 每个需要的服务对上一个实现，就拼出一截 epoch 字符串（`':' + impl.fiber.uid`）。缺任何一个，epoch 是哨兵 `'__INACTIVE__'`。
- epoch 从 INACTIVE 变成「有值」→ 进入 `LOADING`，`inertia = this._reload()`。
- epoch 从「有值」变成 INACTIVE，或加载中途 epoch 又变了 → 进入 `UNLOADING`，`inertia = this._unload()`。
- `_reload` 跑插件回调；成功且 epoch 没变，落到 `ACTIVE`（`_getState`：`uid !== null` 且没有 `_error` 且 epoch 不是 INACTIVE）。失败则记下 `_error`，epoch 打回 INACTIVE，表现为 `FAILED`。
- `_unload` 清空 `_disposables`（每个 disposer 包一层），然后若 epoch 又活了就链式 `_reload`。这就是论文说的**惯性**：一次装卸一旦开始，先跑完，再看目标是不是已经变了。

公开字段（`docs/cordis-api/fiber.md` / 源码）：

| 字段 | 含义 |
|---|---|
| `uid` | 注册表里的唯一编号；根是 `0`；处置后是 `null` |
| `ctx` | 这根纤程自己的上下文（父上下文 `extend({ fiber: this })`） |
| `config` / `_config` | 校验后的配置 / 原始配置（vendor 在每次激活前才 `internal/config` 再解析） |
| `state` | 上表；变化时发 `internal/status` |
| `dispose` | 卸这根纤程，等清理结束 |
| `store` | 加载期间所需服务实现的快照；未加载时是 `undefined` |
| `inertia` | 正在飞的加载/卸载 Promise；空闲是 `undefined` |
| `inject` | 已解析的依赖表（服务名 → 可选的 intercept 配置） |
| `runtime` | 同一插件回调共享的 `Plugin.Runtime`；根是 `null` |

`assertActive()` 只看 `uid !== null`。vendor 补丁额外规定：`state === UNLOADING` 时 `effect()` 直接抛 `CordisError('INACTIVE_EFFECT')`，避免拆除过程中再登记逃出本次卸载快照。

---

## 插件怎样变成一根纤程

三种合法形状，见 `vendor/cordis/src/registry.ts` 的 `Plugin`：

1. **函数**：`(ctx, config) => ...`，函数本身就是回调。
2. **类**：`new (ctx, config)`，若是构造器则实例化后再跑 `[symbols.init]`。
3. **对象**：必须有 `apply(ctx, config)`。`resolve()` 取的是 `plugin.apply`。

可选元数据：`name`、`Config`（standard-schema）、`inject`、`provide`、`intercept`。

`ctx.plugin` 被 mixin 成 `RegistryService.plugin`：

```ts
plugin(plugin: Plugin, config?: any, getOuterStack = buildOuterStack()) {
  const callback = this.resolve(plugin)
  if (!callback) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin)
  this.ctx.fiber.assertActive()

  let runtime = this._internal.get(callback)
  if (!runtime) {
    let name = plugin.name
    if (name === 'apply') name = undefined
    runtime = { name, callback, fibers: new DisposableList(), Config: plugin.Config }
    this._internal.set(callback, runtime)
  }

  const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack)
  const wrapped = Object.create(fiber) as Fiber & PromiseLike<Fiber>
  wrapped.then = (onFulfilled, onRejected) => fiber.await().then(onFulfilled, onRejected)
  return wrapped
}
```

读这一段时记住四件事：

1. **身份是回调函数**，不是文件路径。同一函数多次 `plugin()`，共用一份 `Plugin.Runtime`，但每调用一次仍 `new Fiber`——多根纤程、一份说明书。
2. **当前纤程必须还活着**（`assertActive`）。父都拆了，不能再往下挂孩子。
3. **返回值既是 Fiber 又像 Promise**：`await ctx.plugin(...)` 等于 `fiber.await()`，等 `inertia` 走完；启动失败会把 `_error` 再抛出来。
4. **`ctx.inject(deps, callback)` 只是语法糖**：`this.plugin({ inject, apply: callback, name: callback.name })`。依赖不齐就停在 `PENDING`，齐了再 `LOADING`。这是 03 篇的入口，本篇只看到「插件可以声明 inject」。

`Fiber` 构造函数（有 `runtime` 的分支）把「挂孩子」本身做成父亲的一个 effect，标签是 `'ctx.plugin()'`：

```ts
this.uid = parent.registry.counter
this.ctx = this.context = parent.extend({ fiber: this })
// inject 里带了配置的，先叠一层 intercept
this.dispose = parent.fiber.effect(() => {
  const remove = runtime.fibers.push(this)
  return async () => {
    this.uid = null
    emitPluginDisposed(this.context, this)
    // 从 runtime.fibers 摘掉；若再无兄弟，删除 runtime
    this._setEpoch(INACTIVE)
    if (!this.inertia) { /* PENDING 上也可能已有 effect，显式 _unload */ }
    while (this.inertia) await this.inertia
  }
}, 'ctx.plugin()')

this.context.emit('internal/plugin', this)
if (this.uid !== null && parent.fiber.state !== FiberState.UNLOADING) {
  for (const name of Object.keys(this.inject)) this._checkImpl(name)
  this._refresh()
}
```

顺序是 vendor 特意排过的：先让父亲拥有完整的 disposer，再 `emit('internal/plugin')`。同步监听器如果立刻 `dispose` 父或子，所有权已经在。发布之后才 `_checkImpl` + `_refresh`，因为 loader 可能在这条通知里改 `inject`。

插件回调何时真正执行：`_reload` → `_execute(this._runner)`。`_runner.execute` 是：

- 构造器：`new runtime.callback(this.ctx, this.config)`，跑 `initHooks`，再跑 `[symbols.init]`；
- 否则：`runtime.callback(this.ctx, this.config)`（函数插件或 `apply`）。

回调的返回值按 `Effect` 收集：一个 disposer、一串 disposer、或它们的 Promise / async iterable。这些 disposer 记在这根纤程的 `_disposables` 上，卸载时后装先卸——细节留给 02。

教程里的最小例子（`docs/cordis-tutorial/02-lifecycle-and-effects.md`）：`ctx.plugin(heartbeat)` 从代码挂一个函数插件，返回的 fiber 可以稍后 `await fiber.dispose()`；YAML loader 对配置里每一行做的是同一件事。

---

## 对照论文：Γ 与纤程元组

不另证定理。只把论文里**已经写出来的**对象，对到上面读过的字段。出处：定义 32、43、44、49，以及 §5.1 的 Table 2。

**上下文类型（定义 32）。**

\[\Gamma_\infty := \mu\Gamma.\; \Gamma \times (\Gamma \to \Gamma) \times \Sigma\]

三个投影：当前上下文状态（递归）、本层效应的累加器（怎么改回去）、余效应上下文 \(\Sigma\)（依赖信息）。Table 2 第一行：\(\Gamma_\infty\) 就是运行时的 `ctx`。树状层级来自「父上下文聚合子层效应」：每挂一个插件，父亲多记一个 effect，卸父亲就级联卸孩子。实现上，这个累加器不是一个名叫 `accumulator` 的字段，而是纤程的 `_disposables` 加 `fiber.dispose`。

**部件（定义 43）。** 部件是三元组 \((d, p, e)\)：

- \(d\)：余效应规格，声明需要环境给什么 → 实现是 `plugin.inject` / `fiber.inject`；
- \(p\)：提供，声明可能写出哪些 key → 实现是 `plugin.provide`（`Service` 构造时 `ctx.reflect.provide`）；
- \(e\)：带着逆的效应函数 → 实现是插件回调（函数 / `apply` / 类的 init），不是一个叫 `fiber.apply` 的公开字段。

**纤程（定义 44）。** 一篇说明书的一次实例化是元组 \(\langle d, p, e, \pi, \sigma, \tau, \theta \rangle\)：

| 论文 | Table 2 写的实现名 | 当前 vendor 源码里实际能指到的东西 |
|---|---|---|
| \(d\) | `fiber.inject` | `fiber.inject`（有） |
| \(p\) | the component's `provide` | `Plugin.Base.provide` / `ctx.provide` |
| \(e\) | `fiber.apply` | `_runner.execute` → `runtime.callback`（**没有**公开的 `fiber.apply`） |
| \(\pi\) 父 | `fiber.parent.fiber.uid` | `fiber.parent` 是父 **Context**，再 `.fiber` |
| \(\sigma\) 自己的余效应表 | （由 ACTIVE 纤程的 provide 并起来） | `fiber.store` 是依赖快照；对外提供落在 `reflect.store[isolateLabel]` |
| \(\tau\) 退役 | O-Remove 清掉 uid | `uid = null` 即 `DISPOSED` |
| \(\theta\) 生命周期 | `fiber.state`；LOADING = 𝖱𝖾𝗅𝗈𝖺𝖽𝗂𝗇𝗀；FAILED = 𝖨𝗇𝖺𝖼𝗍𝗂𝗏𝖾(\(\xi\)) | `FiberState` 六态 |
| 累加器 \(g\) | `fiber.dispose` | `dispose` + `_disposables` |
| 已提交视图 \(\omega\) | `fiber.committed` | **当前文件没有这个公开字段**；epoch 字符串 `':' + impl.fiber.uid` 和 `_store` 承担「当时对上了谁」 |
| 目标视图 | `fiber.target`，`⊥` = INACTIVE | **当前文件没有这个公开字段**；`_runner.epoch === '__INACTIVE__'` 就是 ⊥ |
| 惯性 | `fiber.inertia` | `fiber.inertia`（有） |
| 登记 | Table 2 写 `ctx.use` | 实现是 `ctx.plugin`（Algorithm 4 的伪代码名） |

定义 49 把两态模型加细成 𝖨𝗇𝖺𝖼𝗍𝗂𝗏𝖾(\(\zeta\)) / 𝖱𝖾𝗅𝗈𝖺𝖽𝗂𝗇𝗀 / 𝖠𝖼𝗍𝗂𝗏𝖾 / 𝖴𝗇𝗅𝗈𝖺𝖽𝗂𝗇𝗀。运行时用六个枚举值表达同一件事，并多出 `PENDING`（目标还是 ⊥、人还在树上）和 `DISPOSED`（人已经不在 `dom(F)`）。Table 2 自己说：LOADING 对应 𝖱𝖾𝗅𝗈𝖺𝖽𝗂𝗇𝗀，FAILED 对应带着错误结果的 𝖨𝗇𝖺𝖼𝗍𝗂𝗏𝖾。

论文 §4.1 还写：演算本章**不引入 realm**，每个 key 只有一个提供方；isolate 是 §3.2.3 的派生实现，Table 2 把它对到 `ctx.isolate` / `ctx[@@isolate]`。Harness 的 agent preset 用的正是这层工程能力，不是第 4 章演算里多出来的形式对象。

不要把 Algorithm 1–5 当成 `vendor/cordis/src/fiber.ts` 的逐行注释。vendor 日志已经列出可重入处置、惰性配置解析（`internal/config`）等论文伪代码没写全的缝。

---

## 本篇读完应该能回答的三句话

1. `ctx` 是厨房（服务容器 + 两张 isolate/intercept 影子表 + 一根当前纤程）；`ctx.plugin(P)` 是按说明书再装一台电器。
2. 电器的状态机是 `PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED`，失败走 `FAILED`；飞在路上的那一次装卸叫 `inertia`。
3. `isolate` / `intercept` / `extend` 只长子上下文、不改父亲；Harness 用 isolate realm 给单个会话另一套同名服务。

---

## 下一篇读什么

**02 · revertible-effects**（`ctx.effect` / dispose 后装先卸）。

本篇已经看到：挂插件是父亲的一个 effect；`provide`、监听器、子插件最后都要能拆回去。下一篇专门读 `fiber.effect` 接受哪些返回值、disposer 为什么倒序、异步 disposer 为何会并行、以及 vendor 对重入卸载补了哪些缝。先不要跳到 Agent 循环。

---

## 拉取记录

成功：

- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-primer.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-primer.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/architecture.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-tutorial/02-lifecycle-and-effects.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-api/context.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-api/fiber.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/vendor/README.md`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/vendor` 与 `.../vendor/cordis/src`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/vendor/cordis/src/{context,fiber,registry,reflect}.ts`
- `https://api.github.com/repos/cordiverse/cordis/contents/packages/core/src`（`ref=main`）
- `https://raw.githubusercontent.com/cordiverse/cordis/main/packages/core/src/{context,fiber,registry,service}.ts`
- `https://raw.githubusercontent.com/cordiverse/cordis/master/packages/core/src/context.ts`（`master` 存在，与 `main` 同文）

未 404 的请求里，没有需要标「文件不存在」的项。论文 Table 2 的 `fiber.committed` / `fiber.target` / `ctx.use` / `fiber.apply` **不是**当前 vendor 文件的公开 API，上文已按实文件名对照，没有把它们写成源码里的字段。
