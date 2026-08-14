# 04 · emit / waterfall / serial / parallel

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[03 reactive-coeffects](03-reactive-coeffects.md) · 下一篇：[05 boot-profiles-bundles](05-boot-profiles-bundles.md)

读的是 DeepSeek Harness 真正跑的那份 Cordis，不是自己再发明一套词。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 文档 | `docs/cordis-primer.md`、`docs/cordis-primer.zh.md`、`docs/architecture.md`、`docs/architecture.zh.md`、`docs/cordis-tutorial/04-events.md`、`docs/cordis-tutorial/04-events.zh.md`、`docs/cordis-api/events.md` |
| Vendor 清单 | `vendor/README.md`：`@deepseek-ai/cordis` 4.0.0-rc.7，上游 `cordiverse/cordis` `packages/core`，commit `56b3d4f725681cf4556c1a8695a709cc3b6eed74` |
| 本仓库实际引用 | `vendor/cordis/src/{events,context}.ts` |
| Harness 用法 | `packages/core/agent-loop/src/agent.ts`、`packages/core/agent/src/{dispatch,runtime-types}.ts`、`packages/core/tools/src/index.ts` |
| 上游对照 | `cordiverse/cordis` `packages/core/src/events.ts`（`main`：五种模式相同；主路径叫 `_resolve`，公开 `dispatch` 标了 `@deprecated`） |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§1.1、定理 40 附近关于「监听器表 / 中间件链」 |

primer 的分发表只列了四种模式；vendor 的 `DispatchMode` **还有第五种 `bail`**。本篇五种都读。产品事件的 `@mode` 写在声明上，生成目录拿它跟分发调用点交叉校验。

---

## 厨房对讲机：喊一声，还是递托盘

上一篇谈水电（空间可组合）。这一篇谈厨房里怎么说话。

插件之间很少直接 `import` 对方。它们共用一间厨房，靠对讲机喊名字。primer 原话（`docs/cordis-primer.zh.md`）：**类型化事件用于通信。** 服务通过 TypeScript 声明合并注册事件名，然后以 `emit`、`waterfall`、`parallel` 或 `serial` 方式分发，分别对应监听者观察、包装、并行扇出或按序执行。

五种喊法不是口味问题，是**这份事件的公开约定**。换一种分发，监听器能不能返回值、要不要互相等待、能不能半路否决，全变了。

| 模式 | 厨房 | 等不等回音 | 有没有返回值 |
|---|---|---|---|
| `emit` | 对讲机喊一声，所有人听见；不等回音，也不收纸条 | 否 | 否 |
| `parallel` | 同时喊几个人去干活，灯要等**所有人**做完才关 | 是 | 否 |
| `serial` | 一个一个问，等每个人答完；第一个给出正经答案的人说了算，后面不用再问 | 是 | 是（第一个 bail 值） |
| `bail` | 和 serial 同一条问法，但不 await——同步版 | 否 | 是（第一个 bail 值） |
| `waterfall` | 托盘必须每个厨师递给下一个；不递就是否决，最里面那份默认菜谱就不做了 | 否（方法本身不等；返回值常常是 Promise，调用方自己 await） | 是（最外层的返回值） |

「正经答案」在源码里叫 bail 值：不是 `null`、不是 `false`、不是 `undefined`。出处：`vendor/cordis/src/events.ts`。

```ts
export function isBailed(value: any) {
  return value !== null && value !== false && value !== undefined
}

export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'
```

挂一只新听筒（`ctx.on`）是上一篇的那种可逆效应：拆走这台电器，听筒一起摘掉。教程原话（`docs/cordis-tutorial/04-events.zh.md`）：因为 `ctx.on()` 属于 effect，监听器会随插件一同消失，绝不需要手动维护 `removeListener`。

本篇钉子就是这件事：五种分发怎么跑、`on` 怎样记在纤程上、Harness 的 `agent/pre-step` / `agent/turn-stopping` / `tools/*` 怎样挂在这根钉子上。

---

## 事件总线挂在 `ctx.events`，方法混进 `ctx`

根上下文构造时就把事件服务装上。出处：`vendor/cordis/src/context.ts`。

```ts
/** The event bus. Its methods are also mixed onto `ctx` (`ctx.on`, `ctx.emit`, ...). */
events: EventsService

// constructor 里：
this.events = new EventsService(self)
```

所以插件写 `ctx.emit(...)`、`ctx.waterfall(...)`，实际落到 `EventsService`。01 篇已经说过：`ReflectService` 把一批方法 mixin 到 `ctx` 上。

每种模式都先走同一个入口 `dispatch`：剥掉可选的 `thisArg` 和事件名，按上下文过滤器挑出监听器，再按模式去跑。出处：`vendor/cordis/src/events.ts`。

```ts
dispatch(type: string, args: any[]) {
  const thisArg = typeof args[0] === 'object' || typeof args[0] === 'function' ? args.shift() : null
  const name: string = args.shift()
  if (!name.startsWith('internal/')) {
    this.emit('internal/dispatch', type, name, args, thisArg)
  }
  const filter = thisArg?.[Context.filter]
  return (this._hooks[name] || [])
    .filter(hook => hook.global || !filter || filter.call(thisArg, hook.ctx))
    .map(hook => hook.callback.bind(thisArg))
}
```

厨房读法：

1. 第一个参数如果是对象或函数，当作「在哪一站喊」的 `thisArg`（也用来做过滤）；否则从事件名开始。
2. 名字不是 `internal/` 开头时，先再 `emit('internal/dispatch', …)`——诊断钩子，避免内部事件递归炸总线。
3. 监听器默认要过 `Context.filter`。登记时写 `{ global: true }` 才全厨房都能听见，不管你站在哪一间子厨房喊。

上游 `main` 的同文件把这段拆成私有 `_resolve`，公开 `dispatch` 标了 `@deprecated`。vendor 这份把 `dispatch` 留成主路径：Harness 的 fused dispatcher 会直接调用它（见下文 `agentEvents`）。五种模式的语义两边一样。

---

## 五种分发：源码怎么跑

出处都是 `vendor/cordis/src/events.ts`。JSDoc 是 vendor 本地补丁（`vendor/README.md` 第 7 条，只加注释）；函数体是运行时。

### `emit`：喊一声就走

```ts
emit(...args: any[]) {
  this.dispatch('emit', args).map(cb => cb(...args))
}
```

同步、按登记顺序调用，**不等**返回的 Promise，也**不收集**返回值。`Array.map` 有一个后果：某个监听器同步抛错，后面的听筒这轮就听不到了。Harness 给 agent 通知另写了一层包容，下面会引。

### `parallel`：同时干活，一起等完

```ts
async parallel(...args: any[]) {
  const results = await Promise.allSettled(this.dispatch('emit', args).map(async cb => cb(...args)))
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (errors.length) throw new AggregateError(errors.map(error => error.reason))
}
```

所有监听器一起跑，`Promise.allSettled` 等全部落地；有人拒绝就把原因收成 `AggregateError` 抛出。文件里的字面事实：这里调用的是 `dispatch('emit', args)`，所以 `internal/dispatch` 看到的 type 是 `'emit'` 而不是 `'parallel'`。上游 `_resolve('emit', args)` 同样如此。诊断钩子若按 type 区分这两种模式，会把它们看成同一种。

产品事件里 `@mode parallel` 的代表是 `session/flush`（持久化与遥测一起冲刷）。会话包自己用 `Promise.allSettled` 实现「等所有人」，注释写明不要直接 `ctx.parallel('session/flush', …)`。细节留给 06 篇。

### `serial` / `bail`：一个一个问，第一个正经答案说了算

```ts
async serial(...args: any[]) {
  for (const cb of this.dispatch('serial', args)) {
    const result = await cb(...args)
    if (isBailed(result)) return result
  }
}

bail(...args: any[]) {
  for (const cb of this.dispatch('bail', args)) {
    const result = cb(...args)
    if (isBailed(result)) return result
  }
}
```

primer 表没写 `bail`；教程把它标成 serial 的同步版。总线内部用 `bail` 拦 `internal/listener`（见下一节 `on`）。Harness 产品事件表里，本篇对照过的 `@mode serial` 是 `agent/turn-stopping`；没有看到标 `@mode bail` 的产品事件。

### `waterfall`：托盘必须递给下一个

```ts
waterfall(...args: any[]) {
  const cbs = this.dispatch('waterfall', args)
  const inner = args.pop()
  const next = () => {
    const cb = cbs.shift() ?? inner
    return cb(...args)
  }
  args.push(next)
  return next()
}
```

最后一项参数是最内层的 `next`——通常是「机器自己本来会做的那一步」。监听器按登记顺序从外往里包：调用 `next()` 才把托盘递给下一位（最后递给这份默认行为）；**不调用就直接返回 = 否决**。primer（`docs/cordis-primer.zh.md`）：`ctx.waterfall` 是环绕中间件；只做标注或观察的监听器必须委托；策略监听器在拥有决策权时可以不调用 `next()`。

教程补了一句纪律：日志监听器若忘记 `next()`，会悄无声息地吞掉所有下游的默认行为。这是仓库常设规则，不是口味。

方法本身是同步的：它只返回最外层监听器的返回值。监听器若返回 Promise，调用方自己 `await`。所以 primer 表写「是否 await？否」，而 agent-loop 里仍然写 `await this.dispatch.waterfall(...)`——等的是 Promise，不是 waterfall 函数自己去 await 每一位厨师。

`prepend: true` 把听筒插到队伍最前面，成为更外层的包装。只在必须先于普通登记时使用。

---

## `ctx.on`：挂听筒是一笔 effect

出处：`vendor/cordis/src/events.ts`。

```ts
on(name: string | symbol, listener: (...args: any) => any, options?: boolean | EventOptions) {
  if (typeof options !== 'object') {
    options = { prepend: options }
  }

  this.ctx.fiber.assertActive()
  listener = this.ctx.reflect.bind(listener)
  const result = this.bail(this.ctx, 'internal/listener', name, listener, options)
  if (result) return result

  const hooks = this._hooks[name] ||= []
  const label = `ctx.on(${typeof name === 'string' ? JSON.stringify(name) : name.toString()})`
  return this.register(label, hooks, listener, options)
}

register(label: string, hooks: Hook[], callback: any, options: EventOptions): () => void {
  const method = options.prepend ? 'unshift' : 'push'
  return this.ctx.fiber.effect(() => {
    hooks[method]({ ctx: this.ctx, callback, ...options })
    return () => this.unregister(hooks, callback)
  }, label)
}
```

顺序：

1. 纤程必须还活着（`assertActive`）。已经在拆的插件不能再挂新听筒——02 篇的 UNLOADING 拒绝新建效应。
2. `reflect.bind` 把监听器绑到当前上下文，后面读 `ctx.tools` 仍然走这间子厨房。
3. 先 `bail('internal/listener')`。有人给出正经返回值，就**代替**普通登记。框架自己用这一钩把 `internal/update` 的监听器收到纤程私有列表里。
4. 否则 `fiber.effect`：正向把 `{ ctx, callback, …options }` 推进 `_hooks[name]`；逆是 `unregister`。卸插件 = 按 LIFO 跑 disposer = 听筒从名单上消失。

`once` 只是 `on` 的糖：第一次被叫到就先 `dispose()` 再转发给原监听器。

boolean 的第三个参数是 `{ prepend }` 的缩写。完整选项还有 `{ global: true }`：不过滤，全厨房都能听见。

这就是时间可组合在事件上的落点：听筒不是「写在某个全局 EventEmitter 上、拆插件时靠人记得摘」。它是这根纤程的一笔效应。

---

## Harness：轮次里三种喊法

`docs/architecture.md` 把扩展点按域切开：会话事件是只追加的持久事实；`agent/*` 携带活着的 Agent；`tools/*` / `fs/*` 是能力缝上的策略。和 Cordis 总线不是同一件事——06 篇才读会话日志。本篇只看**活扩展点**怎么分发。

架构原文（中文页同一段）：

> `agent/pre-step`、`agent/request`、`llm/stream` 和三个 `tools/*` 事件是 waterfall（瀑布式事件），其监听器必须调用 `next()` 才能委托下去；`agent/turn-stopping` 是 serial 事件，没有 `next()`。

循环里真正喊的人是 `ReactLoopAgent`。它不每次 `ctx.waterfall`，而是构造时做一次 fused dispatcher，热路径不再分配。出处：`packages/core/agent-loop/src/agent.ts`。

```ts
this.dispatch = agentEvents(loopCtx, this)
```

`agentEvents`（`packages/core/agent/src/dispatch.ts`）做三件事：把 `agent` 注入 payload，用 scope carrier 当 `thisArg`（过滤才不会串台），并把三种模式收到一个对象上。`emit` **不走** `ctx.emit`：Cordis 的 `Array.map` 一抛就饿死后面的听筒，agent 通知又不许否决生命周期，所以它自己取出 `ctx.events.dispatch('emit', args)` 的回调，逐个 try/catch，返回的 Promise 拒绝只打日志。

```ts
emit(name, payload) {
  const args: unknown[] = [carrier, name, fused(payload)]
  const callbacks = ctx.events.dispatch('emit', args)
  for (const callback of callbacks) {
    try {
      const returned: unknown = callback(...args)
      void Promise.resolve(returned).catch((error: unknown) => {
        ctx.logger.warn(`agent event "${name}" listener rejected: ${String(error)}`)
      })
    } catch (error: unknown) {
      ctx.logger.warn(`agent event "${name}" listener threw: ${String(error)}`)
    }
  }
}
```

`serial` / `waterfall` 则直接转到混进 `ctx` 的那两个方法，同样带上 carrier。

### `agent/pre-step`：托盘上是「这一步让模型看见什么」

声明（`packages/core/agent/src/runtime-types.ts`，`@mode waterfall`）：监听器可以拒绝拟议步骤，或替换进入步骤的消息；调用 `next()` 保留当前消息。

循环把默认行为放进最内层 `next`：把领取到的消息（外加运行时上下文）标成 `enter`。出处：`packages/core/agent-loop/src/agent.ts`。

```ts
const decision = await this.dispatch.waterfall(
  'agent/pre-step', { messages: claimed, ...position, signal },
  (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
    kind: 'enter',
    messages: context === undefined ? claimed : [...claimed, context],
  }),
)
```

压缩、计划模式、hooks 都可以在这里改写或否决。架构补了一句：首次领取被拒绝、或被改写为空，仍会关闭一个不含步骤的持久轮次——日志记下「试过」，模型一步没花。

同文件里另外两处 waterfall：`agent/request` 的最内层是种子模型配置（可被插件整份换成另一条线路）；`agent/request-error` 的最内层返回 `undefined`，表示这次失败到此为止，监听器可以不调用 `next()`、直接 `{ kind: 'retry' }` 把托盘截下来。

### `agent/turn-stopping`：一个一个问，没有托盘

声明同一文件，`@mode serial`，签名里**没有** `next`。注释写：轮次即将关闭；监听器若反对，就 `agent.steer(...)` 往 inbox 再塞东西；机器再读 inbox——有新的转向就再跑一步，没有才关轮次。**数据决定结果，所以监听器顺序改不了结局。**

```ts
if (turnEnds && this.inbox.nextStep.length === 0) {
  await this.dispatch.serial('agent/turn-stopping', { turn, signal })
  signal.throwIfAborted()
}
if (turnEnds && this.inbox.nextStep.length === 0) break
```

serial 仍按登记顺序 await。监听器返回 `void` / `undefined` 不算 bail，后面的人继续被问到。有人同步抛错，后面就问不到了——这和 emit 的 map 是同一类「同步失败会打断队伍」的事实。hooks 包听这个事件，用来在关轮次前再插一句。

### `tools/*`：能力缝上的三段瀑布

三个执行期事件都在 `packages/core/tools/src/index.ts` 的 `interface Events` 里标 `@mode waterfall`。架构把它们画在 `tool/call*` 和 `tool/result*` 之间：先记再跑，策略走瀑布，不写进循环文件。

| 事件 | 最内层默认（`next` 不截的话） |
|---|---|
| `tools/pre-execute` | `{ kind: 'allow' }` |
| `tools/execute` | 真正跑工具体 `dispatchToolBody` |
| `tools/post-execute` | `{ kind: 'accept' }` |

```ts
const gate = await this.ctx.waterfall(
  carrier, 'tools/pre-execute', exec,
  () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
)
```

```ts
const result = await this.ctx.waterfall(
  carrier, 'tools/execute', mutableExec,
  () => this.dispatchToolBody(mutableExec),
)
```

```ts
const decision = await this.ctx.waterfall(
  scopeTarget(this, exec.agent), 'tools/post-execute', exec, result,
  () => Promise.resolve<PostToolDecision>({ kind: 'accept' }),
)
```

这里的 `carrier` 是 `scopeTarget(this, exec.agent)`：和 agent 事件一样，用 `thisArg` 做过滤，agent 作用域里挂的听筒只听见这个 agent 的调用。`tools/change`、`tools/result` 则是 `@mode emit`：工具表变了、最终结果冻住了，喊一声就走。

审批、超时、hooks 都是往这三段瀑布上挂听筒，不是去改 `ReactLoopAgent.step`。primer 的实践规则：拦截和策略优先使用事件；直接能力调用优先使用服务方法。

---

## 和论文对得上的两句话（对不上的不硬编）

论文**没有**把 `emit` / `waterfall` / `serial` / `parallel` / `bail` 写成形式对象。五种模式是 Cordis 运行时的工程约定，Table 2 对不上这五个名字。

对得上的是登记本身。

§1.1 把时间可组合说成：拆掉一个部件时，它对共享环境做的修改必须完整、安全地收回。这要求跟踪部件做的每一种资源分配、**事件登记**和状态改写。`ctx.on` → `fiber.effect` 就是这句话的实现：听筒进 `_hooks`，卸纤程时 `unregister`。

定理 40 附近（论文把「路由登记或事件监听器」当作代表）：一个 key 的值若是**可独立增删的表**，两次登记交换顺序，表对每个测试的回答仍一样，撤其中一个另一个还在——交换律成立。一个 key 的值若是**有序链**，则不成立：插在另一段中间件前面的人看到的是不同的请求，撤其中一个会打扰另一个。厨房读法：挂听筒进名单（`emit` / `parallel` 那种「在不在表里」）接近前一种；waterfall 的托盘顺序接近后一种。不要把这句话升级成「论文证明了 waterfall」——论文谈的是效应在某个 key 上交不交换，没有点名 `ctx.waterfall`。

不要把 Cordis 总线和会话日志混成一件事。`turn/start` 那种只追加、跨重启还在、不能用 `dispose` 撤回的事实，更接近论文 §6.1 的 emission（排放）。那是 06 篇的钉子。本篇的事件卸插件就消失。

---

## 可以带走的四件事

1. 事件名是 TypeScript 声明合并出来的；分发模式是这份事件的公开约定，不是调用方临时选的口味。primer 表四种，vendor 实际五种（多一个同步 `bail`）。
2. `ctx.on` 走 `fiber.effect`。卸插件 = 摘听筒。不要自己维护 `removeListener`。
3. waterfall 是环绕中间件：必须 `next()` 才把托盘递下去；不递就是否决，连最内层默认行为也不跑。只观察的人忘了 `next()`，等于把整间厨房的默认菜谱吞了。
4. Harness 把决策放在瀑布上（`agent/pre-step`、`agent/request`、三段 `tools/*`），把「轮次要不要关」放在没有 `next()` 的 serial（`agent/turn-stopping`），把通知放在 emit。循环文件不用为每条策略开一个 if。

---

## 下一篇读什么

**05 · boot-profiles-bundles**（启动、profile、bundle、patch）。

本篇已经看到：插件靠事件拦截循环，而不改循环。下一篇读这些插件是怎样被叠成一棵会跑的树——profile 列出 bundle，bundle 是可被上层 patch 的配置行。先不要跳到会话日志。

---

## 拉取记录

成功：

- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-primer.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-primer.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/architecture.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/architecture.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-tutorial/04-events.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-tutorial/04-events.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-api/events.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/event-producer-consumer.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/vendor/README.md`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/vendor/cordis/src`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/vendor/cordis/src/{events,context}.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/agent-loop/src/{index,agent,tool-calls}.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/agent/src/{dispatch,runtime-types,index,types}.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/tools/src/index.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/session/src/index.ts`（只核过 `session/flush` 的 `@mode parallel`）
- `https://raw.githubusercontent.com/cordiverse/cordis/main/packages/core/src/events.ts`

404：本篇列出的路径均返回 200，没有需要标「文件不存在」的项。primer 分发表省略 `bail` 不是 404，是文档比 `DispatchMode` 少写一种。
