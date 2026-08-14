# 08 · 工具注册表与 pre/execute/post 流水线

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[07 system-prompt](07-system-prompt.md) · 下一篇：[09 agent-registry](09-agent-registry.md)

读的是 DeepSeek Harness 真正跑的那份工具表和执行流水线，不是自己再发明一套词。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 钉住 | `master` @ `47f943859bef60e4160492346772ded9b24f765a`（`dsh@0.1.0-rc.5`） |
| Harness 文档 | `docs/architecture.md`、`docs/architecture.zh.md`、`docs/tool-execution-pipeline.md`、`docs/tool-execution-pipeline.zh.md`、`docs/subsystems/tools.md`、`docs/subsystems/tools.zh.md` |
| 工具包 | `packages/core/tools/src/index.ts`（**没有**单独的 `pipeline.ts` / `execute.ts`：登记、三段瀑布、守卫都在 `ToolRuntime` 上） |
| 循环调度 | `packages/core/agent-loop/src/tool-calls.ts`（`executeToolCalls`：先记 `tool/call` 再跑） |
| 包 README | `packages/core/tools/{README,README.zh}.md` |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§3.1 可逆效应、§3.2.3 定义 30–31 余效应拦截、§6.1 排放 |

本篇钉子：一次工具调用先写成厨房小票（`session.append('tool/call')`），再过活着的检查员、厨师、装盘——**小票写出去就涂不掉**。登记、限制、守卫、呈现方式都是 02 篇的 `ctx.effect`；策略走 04 篇的三段 waterfall；真正跑工具体之前，循环已经把这次点单记进 06 的只追加账本。

不要把「今日菜单」（07：模型看见哪些 schema）和「这一张已经写下的小票」（本篇：一次调用怎么过流水线）混成一件事。菜单可以随卸插件少一行；小票不能。

---

## 厨房小票：写下、过检、下锅、装盘——不能反写

饭店里，客人点了清蒸鲈鱼，服务员**先把单子写在一张小票上**，夹到出餐轨。之后这张票会过三道手：

1. **检查员**（库存、过敏、是否要问经理）：放行、拒单，或喊一声「问一下」。
2. **硬规矩**（店主写死的：这道菜今晚不做、未成年人不卖酒）：只能否决，不能把别人已经拒的单再放行。
3. **厨师**（可以套计时器、重做、记耗时）：真正下锅。
4. **装盘**（接受、换成另一盘、或者整单作废并写明原因）。

小票已经夹上轨，就不能假装没点过。做砸了再记一笔结果；中途取消，未开做的也要补一张「未下锅」的结果，回放才对得上。

对应到 `dsh`：

| 厨房小票 | Harness |
|---|---|
| 今日菜单（07） | `assemble()` 投影出的 `ToolSchema[]` |
| 把点单写上轨 | `session.append('tool/call', …)`，**执行前** |
| 检查员（可换班、可重排） | `tools/pre-execute` waterfall：`allow` / `deny` / `ask` |
| 店主硬规矩（单调、不能翻案） | `ctx.tools.guard()`，pre 之后、下锅之前 |
| 问经理（一次） | `ask` → `ctx.get('approval')`；没有审批缝就当拒绝 |
| 厨师（可套计时器） | `tools/execute` waterfall，最内层是 `definition.execute()` |
| 装盘 | `tools/post-execute`：`accept` / `block` / 换内容或换值 |
| 出餐铃（活的、可拆走） | `tools/result` emit：冻住的最终结果 |
| 结果入账（拆不走） | `session.append('tool/result', …)` |
| 档口上岗 / 下岗 | `register` / `restrict` / `guard` / `presentAs`，全是 `ctx.effect` |

架构原话（`docs/architecture.zh.md` 核心包表）：`core/tools` 负责「作用域化的工具注册表和带把关的执行流水线」，ctx 键 `ctx.tools`。轮次流程把顺序写成一行：

```text
tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
```

文档图（`docs/tool-execution-pipeline.zh.md`）把守卫画在 pre 与 execute 之间，并把 `tool/call` 标成「logged before execution」。本篇按源码走：循环先 `append('tool/call')`，注册表再 `prepare`（pre + 守卫）→ `dispatch`（execute + 工具体）→ `finalize`（post）。

包注释把职责写成一句。出处：`packages/core/tools/src/index.ts`。

```ts
/**
 * Tool registry, model presentation modes, and pre/guard/around/post/result
 * execution pipeline.
 * @module @deepseek-ai/dsh-tools
 */
```

`ToolRuntime` 才是 Cordis Service，`super(ctx, 'tools')`。循环调度走一个内部符号 `TOOL_RUNTIME_SCHEDULER`（`prepare` / `dispatch` / `finalize` / `finish`），**不是**插件扩展点；插件挂的是三段瀑布和 `register` 一类 effect。

---

## 登记就是 effect：上岗写进层，下岗擦掉

`register` / `restrict` / `guard` / `presentAs` 四条入口，最后都走进 `ScopedLayers.effect` → `ctx.effect`。返回值是 exact disposer。卸插件 = 撤回这一行。没有「删除工具」API。

`ToolLayer` 一张层里四样贡献：按名的工具表、匿名限制掩码、匿名守卫、以及最多一个呈现模式。出处：`packages/core/tools/src/index.ts`。

```ts
class ToolLayer implements ScopeLayer {
  readonly tools: NamedEntries<ToolDefinition>
  readonly restrictions = new AnonymousEntries<CompiledToolRestriction>()
  readonly guards = new AnonymousEntries<ToolGuard>()
  mode: ToolPresentationMode | undefined
  // …
}
```

构造 `ScopedLayers` 时，`onChange` 接到 `this.ctx.emit('tools/change')`。登记和撤销都会喊一声（守卫登记把 `notify: false`，因为守卫不改可见集合）。这是 04 篇的 `emit`。

### `register`：把一道菜写进这层的菜单

普通插件上下文 = 全局档口；`agent.ctx` = 只给这个 agent 的专属菜，同名会**遮蔽**全局。同一层内重名抛；`run_code` 这个名字无论哪种 `mode` 都保留，因为任何一个 agent 都可能给自己选 code 呈现。出处同上。

```ts
register(definition: ToolDefinition): () => void {
  // …校验 output / timeoutMs；拒绝保留名 run_code…
  return this.layers.effect(
    this.ctx,
    layer => layer.tools.insert(name, definition),
    { label: 'tools.register()' },
  )
}
```

`ToolRuntime.static inject = ['systemPrompt']`。构造时 `ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))`——07 已经读过：schema 走进今日菜单，走的是这同一张表的可见视图。

### `restrict`：这桌看不见某些全店的菜

必须在有作用域的上下文上调用。筛选器登记时拍快照；多张掩码**取交集**；本层自己登记的工具不受这张滤镜切掉。包 README 写明：这是**实时可见性组合，不是权限边界**。出处同上。

```ts
restrict(filter: ToolRestriction): () => void {
  const scope = scopeOf(this.ctx)
  if (scope === undefined) {
    throw new Error('tools.restrict() requires a scoped context (agent.ctx): …')
  }
  // …空滤镜 / 保留名 / 未知全局名都抛…
  return this.layers.effect(
    this.ctx,
    layer => layer.restrictions.append(compiled),
    { label: 'tools.restrict()' },
  )
}
```

### `guard`：店主硬规矩，只能否决

普通上下文的守卫全局生效；`agent.ctx` 上的只看这个 agent。返回字符串 = 最终拒绝理由；返回 `undefined` = 不管。**没有 allow 结果**，所以后面的瀑布不能把守卫的拒绝再改成放行。出处同上。

```ts
guard(guard: ToolGuard): () => void {
  return this.layers.effect(
    this.ctx,
    layer => layer.guards.append(guard),
    { label: 'tools.guard()', notify: false },
  )
}
```

```ts
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
```

求值顺序：先全局层，再沿作用域链从远到近。第一个给出理由的人说了算。

### `presentAs`：这桌看哪种点单方式

遮蔽部署级 `mode` 配置（`native` / `code` / `both`）。只能在 scoped 上下文上声明，同一 scope 第二次声明抛。code 类模式还会给这个 scope 自己挂 `tools:code-only` 和 `tools:sdk` 两段提示词。`schemas(agent)` 仍报告能力全集；只有组装结果里的工具列表按呈现方式收束。出处同上。

```ts
presentAs(mode: ToolPresentationMode): () => void {
  const ctx = this.ctx
  if (scopeOf(ctx) === undefined) {
    throw new Error('tools.presentAs() requires a scoped context (agent.ctx): …')
  }
  const dispose = ctx.effect(function* (this: ToolRuntime) {
    yield this.layers.effect(
      ctx,
      (layer) => {
        if (layer.mode !== undefined) { /* 冲突则抛 */ }
        layer.mode = mode
        return () => { layer.mode = undefined }
      },
      { label: 'tools.presentAs()' },
    )
    if (mode !== 'native') {
      yield ctx.systemPrompt.section(this.collapseSection())
      yield ctx.systemPrompt.section(this.sdkSection())
    }
  }.bind(this), 'tools.presentAs()')
  return dispose
}
```

外层 `ctx.effect` 是 02 篇的分组写法：呈现方式和配套提示词段同一笔账，拆走一起收回。

---

## 三段瀑布：检查员、厨师、装盘

三个执行期事件都在 `interface Events` 里标 `@mode waterfall`。作用域过滤：`thisArg` 是 `scopeTarget(this, exec.agent)`，agent 作用域里挂的听筒只听见这个 agent 的调用。出处：`packages/core/tools/src/index.ts`。

```ts
'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
'tools/execute'(this: Scoped<ToolRuntime>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
```

这是 04 篇的托盘：必须 `next()` 才委托下去；不递就是否决，连最内层默认行为也不跑。

### `tools/pre-execute`：放行、拒单、或问一声

最内层默认 `{ kind: 'allow' }`。`ask` 在挂了 `ctx.approval` 时走一次审批；没挂、没有 agent、或审批说 no，都退化成 `deny`。**有意不准改写 `exec.arguments`**：参数此时已经记进小票、也已经拿去画 pending 卡片，改了就会和日志、UI 对不上。出处：`prepareExecution`。

```ts
const gate = await this.ctx.waterfall(
  carrier, 'tools/pre-execute', exec,
  () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
)
```

`PreToolDecision` 只有三种：`allow` / `deny` + 理由 / `ask`。pre 若拒绝，工具体跳过，但结果仍会走进 post（文档图：`denied --> post`）。

pre 放行之后才跑单调守卫。守卫给出理由，同样走 `post-result`，不进厨师那一站。

```ts
const denialReason = decision.kind === 'allow'
  ? this.guardReason(exec)
  : decision.reason
```

### `tools/execute`：环绕下锅

最内层默认是 `dispatchToolBody`：按可见定义找到 `execute()`，把调用方原始 `AbortSignal` 和包装层替换过的 signal **再融合一次**，然后跑工具体。包装层（超时、重试、指标）只能改 `exec.signal`，改不了 callId / name / arguments / token。出处：`dispatchScheduledExecution`。

```ts
const result = await this.ctx.waterfall(
  carrier, 'tools/execute', mutableExec,
  () => this.dispatchToolBody(mutableExec),
)
```

定义上的 `timeoutMs` 只是声明；注册表自己不掐表。要强制截止，得挂 `@deepseek-ai/dsh-tool-call-timeout-policy` 这种 `tools/execute` 包装层——包 README 写明了。本篇不展开那个插件。

### `tools/post-execute`：装盘或整单作废

最内层默认 `{ kind: 'accept' }`。抛错的工具也会以 error 形态走进这道瀑布。`accept` 可以换 `content` **或**换 `value`（不能同时换）；换值会按当前可见定义的 output 再校验、再呈现。`block` 把反馈变成无值失败，并丢掉工具主体 `deferContext` 攒下的上下文，只公开阻止决定自己附上的上下文。出处：`postExecute`。

```ts
const decision = await this.ctx.waterfall(
  scopeTarget(this, exec.agent), 'tools/post-execute', exec, result,
  () => Promise.resolve<PostToolDecision>({ kind: 'accept' }),
)
```

之后才是定义自有的同步 `finalizeContent`（只能换 content），再 `tools/result` emit。`tools/result` 是活通知，监听器失败被包住；名字相近的 `tool/result` 是循环随后追加的持久会话事件。两套账，06 已经划过界。

---

## 先写小票，再过流水线

循环调度在 `packages/core/agent-loop/src/tool-calls.ts`。`executeToolCalls` 不直接 `ctx.tools.execute()`，而是走内部 scheduler，好让**策略按模型顺序**、只有分发／主体可以重叠。

关键顺序在 `startCall`：先 `appendToolCall`，再 `prepare`（pre + 守卫）。小票已经在账上，检查员这才开工。

```ts
const startCall = async (index: number): Promise<void> => {
  const call = group[index]!
  callSeqs[index] = appendToolCall(session, turn, step, call.block)
  started++
  const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)
  // dispatch / post-result / final-result …
}
```

```ts
function appendToolCall(session: Session, turn: number, step: number, block: ToolCallBlock): number {
  const event = session.append('tool/call', { turn, step, callId: block.id, name: block.name, arguments: block.arguments })
  return event.seq
}
```

`tool/result` 用 `sourceEventSeqs: [callSeq]` 链回这张小票。中止时，还没 `startCall` 的调用走 `appendSkippedToolCall`：照样先记 call，再记一条 `ABORTED_BEFORE_DISPATCH` 的结果，回放才合法。调度器自己崩了则**保留已经记下的 `tool/call`，不编造结果**——文件头注释写的就是这句。

并发分类不走事件：`executionMode()` 读可见定义上的 `isConcurrencySafe(args)`，只有恰好 `true` 才进并行池；未知、隐藏、抛错一律独占屏障。连续的 `parallel` 进有界滚动池；碰到 `exclusive` 就当屏障。这是调度，不是门禁。

`code` 呈现下，模型直呼非 `run_code` 的可见工具，会在**策略流水线之前**收成 `UNKNOWN_TOOL`（带「请从 `run_code` 程序里调用」的路线），pre / 审批 / 守卫都看不见这次调用。带 `parent` token 的 SDK 子分发不受这条塌缩。本篇不读 Code Mode 的 SDK 生成——那是同一张表的另一种菜单投影，07 已经碰到 `wireSchemas`。

---

## 论文拦截（定义 30–31）对不上这条流水线

定义 30–31 说的是**余效应拦截**：给某个依赖 key 叠元数据 `𝜈`，下次 `get(k)` 时提供方看到的是 `𝑑(𝑘) ⊕ 𝜄(𝑘)`，提供方自己按元数据决定这次调用允不允许。Cordis 的真名字是 `ctx.intercept(key, metadata)`，改的是上下文上的 `@@intercept` 表。论文 §6.3 的例子是文件系统依赖带着「能读哪些路径」的元数据，**拦在依赖被取用的那一次**，而且「不影响依赖是否满足，所以装上、改、拆都不必 reload」。

本篇的工具策略**不是**这条机制：

| 论文 / Cordis | 本包里的真名字 | 是否同一件事 |
|---|---|---|
| 可逆效应（02，`ctx.effect`） | `register` / `restrict` / `guard` / `presentAs` → `layers.effect` | 对得上：上岗写层，下岗 `undo()` |
| 反应式余效应（03，`inject`） | `ToolRuntime.static inject = ['systemPrompt']` | 对得上：没有菜单板，工具服务不启动 |
| 余效应拦截（定义 30–31，`ctx.intercept`） | **源码里这条流水线没有调用 `ctx.intercept`** | **对不上** |
| 事件瀑布（04，`ctx.waterfall`） | `tools/pre-execute` / `tools/execute` / `tools/post-execute` | 工程约定；论文没有点名 waterfall |
| 排放（06，§6.1） | `session.append('tool/call' \| 'tool/result')` | 对得上：小票写出去收不回 |

不要把 `tools/pre-execute` 说成 `intercept`。拦截改的是「取用 `ctx.fs` 时带什么元数据」；工具门禁改的是「这一张已经写下的小票，还在岗的听筒怎么递托盘」。听筒本身仍是 `ctx.on` → `fiber.effect`，卸插件就摘掉——那是 04，不是定义 31。

审批、沙箱、超时都是往这三段瀑布（或 `guard` 表）上挂插件，不是去改 `ReactLoopAgent.step`，也不是给 `ctx.tools` 这个服务 key 叠 intercept 元数据。权限类的硬边界，文档把文件系统先读后编辑放在 `tool-fs` 的 `fs/*` 事件下，那是 13 / 14 的缝，本篇不读。

---

## 可以记住的几句

1. **小票先入账，再过检下锅。** `executeToolCalls` 在 `prepare` 之前 `session.append('tool/call')`。写出去是 06 的排放；活策略是还在岗的瀑布和守卫。
2. **`register` / `restrict` / `guard` / `presentAs` 都返回 `ctx.effect` disposer。** 没有删除 API。限制是可见性，不是权限；守卫单调，只能否决。
3. **三段瀑布：pre（allow/deny/ask）→ 守卫 → execute（环绕工具体）→ post（accept/block/换内容或换值）。** 必须 `next()`。pre 不准改 arguments。
4. **`tools/result` 是活的 emit；`tool/result` 是只追加日志。** 前者卸插件就没人听；后者回放还在。
5. **定义 30–31 的 intercept 对不上。** 工具门禁不是 `ctx.intercept`，是事件瀑布加 effect 登记的守卫表。
6. **循环文件不为每条策略开 if。** 超时、审批、钩子挂在瀑布上；并发分类读定义上的 `isConcurrencySafe`，只有 `true` 才并行。

---

## 下一篇读什么

**09 · agent-registry**（Agent 接口、工厂、活注册表）。

本篇已经看到一次 `tool/call` 怎样走过注册表。下一篇读发出这些调用的那个活对象：`Agent` 接口怎么声明、工厂怎么挂上 `ctx.effect`、活注册表怎样按作用域找到「现在这一位」。先不要跳进 turn / step / inbox。

---

## 拉取记录

成功（默认分支是 `master`，不是 `main`；钉住 `47f943859bef60e4160492346772ded9b24f765a`）：

- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/tools/src/index.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/tools/src/{types,presentation,invariant,schema,code-mode}.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/tools/{README,README.zh,package.json}`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/tool-execution-pipeline.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/tool-execution-pipeline.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/tools.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/tools.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/architecture.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/agent-loop/src/tool-calls.ts`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/core/tools`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/core/tools/src`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/docs`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/docs/subsystems`

404：

- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/main/packages/core/tools/src/index.ts`（仓库默认分支是 `master`）
- 不存在 `packages/core/tools/src/pipeline.ts`、`packages/core/tools/src/execute.ts`（流水线在 `index.ts` 的 `ToolRuntime` 上）
- 不存在 `packages/core/agent-loop/src/executeToolCalls.ts`（函数在 `tool-calls.ts`）
- 不存在 `docs/tools-pipeline.md`（文档名是 `docs/tool-execution-pipeline.md`，另有 `.zh.md`）

`docs/tool-execution-pipeline.md` 与 `.zh.md` 均存在。测试文件 `packages/core/tools/tests/` 与 Code Mode 子分发细节本篇未展开。
