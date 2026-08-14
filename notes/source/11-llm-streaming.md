# 11 · ctx.llm 适配器与流式

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[10 agent-loop](10-agent-loop.md) · 下一篇：[12 agent-scope](12-agent-scope.md)

读的是 DeepSeek Harness 真正跑的那份模型缝，不是自己再发明一套「LLM 客户端」。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 钉住 | `master` @ `47f943859bef60e4160492346772ded9b24f765a`（`dsh@0.1.0-rc.5`；与 10 相同，已重核 HEAD） |
| Harness 文档 | `docs/architecture.md`、`docs/architecture.zh.md`（轮次流程里的 `llm/stream`）、`docs/subsystems/llm-streaming.md`、`docs/subsystems/llm-streaming.zh.md`、`docs/subsystems/core.md`、`docs/subsystems/core.zh.md`、`docs/cookbook/adding-an-llm-adapter.md`、`docs/cookbook/adding-an-llm-adapter.zh.md` |
| LLM 服务 | `packages/llm/llm/src/{index,types,assembler,call-config,adapter-failure,message,invariant}.ts`（**没有** `packages/core/llm/`） |
| 循环调用点 | `packages/core/agent-loop/src/agent.ts`（`buildRequest` / `step`：`prepareCall` → `stream` → `assistant/chunk` → `assistant/message`） |
| 请求对账 | `packages/core/agent-loop/src/invariant.ts`（`llm/stream` 上核对冻结请求与账本） |
| 适配器缝举例 | `packages/llm/llm-deepseek`（`deepseek-official`，直接 fetch + SSE）、`packages/llm/llm-pi-ai`（库封装）；**不是**提供方目录 |
| 重试举例 | `packages/llm/llm-retry`（听 `agent/request-error`，**不**包 `llm/stream`） |
| 包 README | `packages/llm/{README,README.zh}.md`、`packages/llm/llm/{README,README.zh}.md` |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§3.1 可逆效应、§3.2 反应式余效应；**没有** StreamChunk / 适配器对象 |

本篇钉子：传菜口站着一位**翻译**。后厨用一种方言喊（Harness 词汇：`GenerateOptions`、`StreamChunk`），餐厅说另一种（提供方 HTTP / SSE）。菜是**一盘一盘**端出来的，不是整桌宴会一次上齐。10 已经读过催菜员怎样开桌、撕单、按道上菜；本篇只读这一道怎样问灶神、chunk 怎样变成 `assistant/message`、取消时谁把壶关掉。

不要把「这一轮怎么炒」（10）和「这一道怎么问模型」（本篇）混成一件事。每位厨师自己的小厨房（`createScope`）留给 12。

---

## 厨房：传菜口的翻译，一盘一盘上

饭店后厨和餐厅中间有一道**传菜口**。厨师喊的是店里的行话；窗口对面的灶神只听供应商的话。翻译站在口上，两边都不改菜单——只换口音，并且**按盘上菜**。

- **窗口只有一个槽。** 店里认 `ctx.llm` 这块牌子，不认某一家供应商的 SDK。谁来当翻译，把工牌挂上槽就行。
- **菜单冻在小票上。** 这一道要问什么、用哪条路由、温度多少，写进请求信封就冻住。翻译只能读，不能改菜名。只有那根「停」的绳子还是活的。
- **一盘 = 一个 chunk。** 文本增量、思考增量、工具调用的半截 JSON，都是盘。每上一盘，账本先记一笔 `assistant/chunk`。整桌拼好，再记一笔 `assistant/message`。
- **翻译可以自己炸，也可以递一张「失败」的收台卡。** 窗口会把这两种都收成同一张终止盘：`finish { kind: 'error' | 'aborted' }`。服务员等的是流结束，不是一个叫 `chat()` 的完整宴会。
- **按停绳。** 催菜员一拉 `abort`，请求上的 `signal` 响。翻译必须把正在烧的那锅停掉；窗口如果发现消费者走了，会帮着把迭代器 `return()` 掉。

对应到 `dsh`：

| 厨房 | Harness |
|---|---|
| 传菜口 / 翻译席 | `ctx.llm`（`LlmRuntime`） |
| 工牌槽 | `registerAdapter(providers, adapter)`：一条提供方路由同一时刻只能挂一位 |
| 翻译必须会的那句 | `LlmAdapter.stream(options)`（**没有** `chat()`） |
| 店里的方言 | `GenerateOptions`、`StreamChunk`、`Message`、`ContentBlock` |
| 餐厅的方言 | 提供方 HTTP / SSE / 库事件（适配器内部） |
| 冻住的菜单 | `deepFreeze` 后的请求；`markAgentLoopRequest` 标明这是循环组装的 |
| 还活着的停绳 | `options.signal`（`AbortSignal`，冻结时故意跳过） |
| 一盘 | 一个 `StreamChunk` |
| 先记账再拼盘 | `session.append('assistant/chunk')`，同时 `BlockAssembler.push` |
| 整道菜 | `createAssistantMessage` → `assistant/message`（`sourceEventSeqs` 指回那些 chunk） |
| 窗口把炸锅收成收台卡 | `adapterStream`：适配器抛错 → 终止 `finish` |
| 这一道问谁 | `prepareCall` 钉死注册，再 `preparedCall.stream(request)` |

架构原话（`docs/architecture.zh.md` 核心包表）：`llm/llm` 负责「消息与流式词汇表，以及适配器 seam」，ctx 键 `ctx.llm`。轮次流程把这一道画成 `agent/request -> llm/stream -> assistant/chunk* -> assistant/message`。能力图把添加模型提供方写成：在 `ctx.llm` 上注册其适配器。

包注释把职责写成一句。出处：`packages/llm/llm/src/index.ts`。

```ts
/**
 * LLM service: adapter registry with a waterfall-interceptable streaming call
 * API. Exports the `LlmRuntime` default, the abstract `LlmAdapter` for
 * provider backends, and `BlockAssembler` for chunk assembly.
 * @module @deepseek-ai/dsh-llm
 */
```

`LlmRuntime` 才是 Cordis Service，`super(ctx, 'llm')`。循环插件 `static inject = ['agents', 'sessions', 'llm', …]`：水电不齐，催菜员不上岗（03）。适配器插件 `inject = ['llm']`，到岗后再 `registerAdapter`。

---

## 没有 `packages/core/llm/`，也没有 `chat()`

课表写「读 `packages/core/llm/`（index、types、adapters、stream）」。真实仓库里 **`packages/core/llm` 是 404**。LLM 能力家族在 `packages/llm/`：抽象服务是 `packages/llm/llm`，产品适配器是旁边的 `llm-deepseek` 和 `llm-pi-ai`。也没有 `openai-compatible` / `anthropic` / `packages/providers` 这些包。

`LlmAdapter` 唯一的抽象方法是 `stream()`。`LlmRuntime` 对外的调用也是 `stream()`。循环热路径上搜不到 `chat`。这一道就是一条异步迭代器，服务员用 `for await` 一盘一盘接。

`docs/subsystems/core.zh.md` 把 `packages/llm` 明确排除在核心六包表之外：对话词汇由 LLM 家族声明，循环只搬运。本篇读的就是那条 seam，不是又一个核心包。

---

## `ctx.llm`：注册表加一次流式调用

模块扩充把键挂上 Context。出处：`packages/llm/llm/src/index.ts`。

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: LlmRuntime
  }
  interface Events {
    'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
  }
}
```

`llm/stream` 是 waterfall（04）：监听器必须 `next()` 才能走到解析后的适配器；也可以自己 `yield` 分片，把灶神短路掉。循环组装的请求带着进程本地的 `markAgentLoopRequest` 身份，并且深度冻结——监听器只读，改字段会抛。手搓的一次性调用没有这个标记。

拓扑变了另有一条无载荷的 `llm/adapters-updated`（emit，定义在 `types.ts`）。观察者故障被包住，不能否决注册表提交。

`registerAdapter` 是 `ctx.effect`（02）：随纤程卸掉；同一提供方路由第二次挂牌抛 `DUPLICATE_ADAPTER`；要么全挂上，要么全不挂。句柄上的 `replace(providers)` 先整体校验再一次同步换槽，中间没有可观察的空档。`replace([])` 合法（还占着席、一条路由都不服务）；**初次**注册不能为空。

提供方目录（`registerConfigurableProviders`）和模型发现（`registerModelDiscovery` / `discoverModels`）是设置页用的名册，不是请求白名单。`listModels()` 是建议清单：适配器可以接未列出的模型 id，消费方不得因为没上榜就拒单。

---

## 适配器槽：翻译只保证会流式

出处：`packages/llm/llm/src/index.ts`。

```ts
export abstract class LlmAdapter {
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
```

其余都有默认实现：`providerInfo` 用路由名当显示名，`providerRetryPolicy` 返回 `undefined`（服务填入 normal 默认），`listModels` 空清单，`resolveModel` 只回 `{ provider, id, name: model }`。cookbook 的最小插件就是：子类、实现 `stream`、`inject = ['llm']`、`apply` 里 `ctx.llm.registerAdapter(['my-provider'], …)`。

`GenerateOptions.provider` 选适配器实例；`model` 交给该适配器，不必在插件启动时把模型 id 登记进生命周期。适配器必须遵守 `options.signal`。提供方 HTTP 请求还要带 `attributionHeaders()`——这是产品约定，不是论文对象。

产品里两条参考实现走同一条槽、不同内部：

- `llm-deepseek`：路由 `deepseek-official`，直接 `fetch` + `eventsource-parser` SSE。`inject = ['llm']`。
- `llm-pi-ai`：`@earendil-works/pi-ai` 动态解析已配置提供方／模型对。不支持 `GenerateOptions.stop` 时抛 `UNSUPPORTED_OPTION`，而不是默默丢掉。

两者都在 `stream()` 里把调用方 `signal` 和自己的消费者 `AbortController` 合成 `AbortSignal.any`，再套空闲 watchdog。这是适配器内部的传输纪律；本篇不把它们读成第二套循环。

---

## 循环实际在等什么：先 `prepareCall`，再一盘一盘 `for await`

10 已经走过 `turn` / `step` / `preStep`。`step()` 里问模型的那一段如下。出处：`packages/core/agent-loop/src/agent.ts`。

```ts
const { request, preparedCall } = await this.buildRequest(
  turn, step, assembly.tools, system, this.session.deriveMessages(), signal,
)
const assembler = new BlockAssembler()
const chunkSeqs: number[] = []
const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
signal.throwIfAborted()
for await (const chunk of stream) {
  signal.throwIfAborted()
  chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
  assembler.push(chunk)
}
```

循环**不等**一个完整的 assistant 对象从适配器返回。它等的是：

1. **`prepareCall` 的 Promise**（在 `buildRequest` 里）。这一步按当前注册解析确切模型、填入适配器默认的 `maxTokens` / `reasoningEffort`、把注册和重试策略钉在一次性句柄上。HMR 换适配器也拆不散「刚才解析的那份能力」和「即将发出的那条流」。句柄只能 `stream` 一次；配置被改过再派发，抛 `INVALID_PREPARED_CALL`。
2. **流本身的每一个 chunk。** `for await` 每拿到一盘，先写入只追加账本，再喂给同一个 `BlockAssembler`。没有第二份对话数组。

`prepareCall` 若因 `NO_ADAPTER` 失败，循环**不**立刻炸：它记下提议配置，回头走 `ctx.llm.stream(request)`。注释写明：middleware 可能替一条未注册路由上菜；真正派发到适配器时仍然要有人挂牌。`agent/request` waterfall 只能换冻结的调用配置（provider / model / 采样），**不能**改消息——10 写过，这里只钉它后面接着 `prepareCall`。

请求信封在派发前冻住。出处：`packages/core/agent-loop/src/agent.ts` 的 `buildRequest`。

```ts
const request = markAgentLoopRequest(deepFreeze({
  ...header.config,
  messages: boundaryMessages,
  ...header.system !== undefined ? { system: header.system } : {},
  ...header.tools !== undefined ? { tools: header.tools } : {},
  sessionId: this.session.id,
  signal,
}))
```

`deepFreeze` 遍历时**故意跳过** `AbortSignal`：停绳必须还能拉。出处：`packages/llm/llm/src/call-config.ts`。循环构建的请求还被放进进程本地 `WeakSet`，`llm/stream` 上的对账插件（`agent-loop-invariant`）只检查带这个标记的信封：必须冻结、必须带活的 `sessionId`、`messages` 必须等于当时的 `deriveMessages()`。06 已经读过牙齿；本篇只说它对的是**这一道派发**。

拿到流句柄，还不等于适配器已经开口。`docs/subsystems/llm-streaming.zh.md` 写：AgentLoop 在外层 waterfall 返回流句柄时观察到一次请求尝试；这个有限边界不能证明惰性终端适配器已构造完成或开始提供方 I/O。真正的 I/O 发生在循环开始 `for await`、瀑布流终端 continuation 去找适配器的时候。

---

## 一盘一盘如何变成 `assistant/message`

原始协议是封闭联合。出处：`packages/llm/llm/src/types.ts`。

```ts
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: unknown }
```

约定（适配器和消费方都依赖）：`usage` 在 `finish` 之前；`finish` 之后不再有任何分片；工具参数全程是原始 JSON 字符串；`index` 把交错的 delta 对回同一个块。`llm-invariant` 在 `llm/stream` 上 `prepend` 一层语法检查：重复 `block-start`、delta 对不上打开的块、成功结束时还敞着块、流尽了却没有 `finish`，都会 `fail`。

`BlockAssembler` 是唯一共享的拼盘算法。循环边记原始分片边 `push`；流结束后读 `blocks()` / `usage` / `finish` / `replayState`。它容忍没有 `block-start`/`block-end` 的纯 delta 协议；已经 `block-end` 关上的 index 再来 stray delta，直接忽略——行为不端的适配器不能把内存撑爆，也不能改写已完成的块。`max-tokens` 结束时会丢掉工具调用块：截断的调用没法安全执行。

成功路径把拼好的块写成一条冻结的 assistant 消息。出处：`packages/core/agent-loop/src/agent.ts`。

```ts
const message = createAssistantMessage({
  content: assembler.blocks(),
  source: {
    provider: request.provider,
    model: request.model,
    ...assembler.replayState !== undefined ? { replayState: assembler.replayState } : {},
  },
})
this.session.append(
  'assistant/message',
  {
    turn, step, message,
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
  },
  { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
)
```

`sourceEventSeqs` 把这条表面消息钉回刚才那些 `assistant/chunk` 的序号：UI 可以按盘播，回放可以按盘重拼。`replayState` 是适配器私有的无损 JSON；`LlmRuntime.forAdapter` 只在历史提供方和目标提供方**此刻由完全同一个适配器实例**拥有时才把它留在后续请求的消息里。换翻译，私房笔记不跟走。

`finish.kind === 'error' | 'aborted'` 时**不**提交这条 assistant 消息。循环把 `failure` 交给 `agent/request-error` waterfall（10 已经钉过时机：发生在同一道尚未写下 `step/end` 的时候）。有人返回 `{ kind: 'retry' }` 且不 `next()`，`step()` 的 `while (true)` `continue`，再 `prepareCall` 一次。没人认领就抛 `LlmError`，由外层 `finally` 写 `step/end`。

窗口自己把适配器抛错收成终止盘。出处：`packages/llm/llm/src/index.ts`。

```ts
stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
  return this.streamWithRegistration(options)
}

private streamWithRegistration(...) {
  return this.ctx.waterfall(
    this, 'llm/stream', options,
    () => this.adapterStream(options, prepared),
  )
}
```

`adapterStream` 把「选适配器 / 建迭代器 / 迭代中抛错」收成一个 `finish { kind: 'error' | 'aborted', failure }`。`signal.aborted` 或 `failure.code === 'ABORTED'` 走 `aborted`，其余走 `error`。**middleware、嵌套调用、清理、消费方自己的错误仍然抛**——那是插件或服务员的事故，不是灶神的收台卡。消费者中途不吃了，`finally` 里若流还没走完，就 `iterator.return()`，让翻译把锅端走。

---

## 取消：拉停绳，不等宴会结束

`Agent.cancel` 对正在跑的相位调用 `phase.abort.abort(cause)`（10 的催菜员相位机）。`buildRequest` 把同一根 `signal` 放进冻结信封。循环在 `for await` 的每一盘前后都 `throwIfAborted()`：翻译若还在慢慢吐盘，服务员自己先离席。

适配器合同要求遵守 `options.signal`。两条产品适配器都把调用方信号和自己的消费者控制器合成一根，空闲超时映射为 `TIMEOUT`，更早的调用方中止保留为 `ABORTED`。测试用的 `MockAdapter` 用 `'hang'` / `'hang-slow'` 模拟「已经上了一盘半、还在等停绳」——那是取消路径的剧本，不是又一种协议。

直接调用 `ctx.llm.stream()` 的人仍然只尝试一次。包装 `llm/stream`、在已经吐出分片之后重试，账本上没有可持久的尝试边界。所以随产品交付的恢复不站在这条瀑布上。

---

## 重试不在 `ctx.llm.stream` 里

`packages/llm/llm/README.zh.md` 写明：本服务不执行重试、缓存或速率限制。提供方注册会**存储**重试策略，但 `llm/stream` 仍是单次尝试。执行器是可选插件 `@deepseek-ai/dsh-llm-retry`：`inject = ['agents']`，监听 `agent/request-error`。它先把 `llm/retry` 写入会话日志，可取消地等待，再追加 `llm/retry-started` 并返回 `{ kind: 'retry' }`。策略来自 `prepareCall` 捕获的 `retryPolicy`，不是服务在流上现场再查一遍。

这是产品调度，不要说成论文里的惯性 Future。

---

## 对回论文与架构图：只在对得上的地方连

| 机制 | 本包里的真名字 | 是否同一件事 |
|---|---|---|
| 03 的 `provide` / `inject` | `LlmRuntime` 挂 `ctx.llm`；`AgentLoop.static inject` 含 `'llm'`；适配器 `inject = ['llm']` | **对得上**：水电不齐，循环不上岗；翻译席不在，适配器插件也激活不了 |
| 02 的 `ctx.effect` | `registerAdapter` / `registerConfigurableProviders` / `registerModelDiscovery` | **对得上**：挂牌是可逆效应，卸纤程摘牌 |
| 04 的 waterfall | `llm/stream`；循环侧的 `agent/request`、`agent/request-error` | **对得上**：活扩展点。前者包每一次流；后两者是催菜员的请求边界 |
| 06 的只追加排放 | `assistant/chunk`、`assistant/message`、失败时可能有的 `llm/retry` | **对得上**：事实离开可逆边界。流式本身只是排放的形状 |
| 论文纤程 / Σ / 流式演算 | `StreamChunk`、`BlockAssembler`、适配器 HTTP | **对不上**。一盘一盘上菜是产品协议，不是时空可组合性的对象 |
| `docs/architecture.md` Turn flow | `agent/request -> llm/stream -> assistant/chunk* -> assistant/message` | **对得上**：与 `agent.ts` 的 `step()` 一致 |

不要把 `llm/stream` 说成循环的 `step`。瀑布流是翻译窗口上的拦截器；step 是催菜员的一道菜（一次模型请求 + 它点的配菜）。也不要把 `Agent.inject(message)` 说成适配器的 `inject = ['llm']`：一个往点菜单夹纸条，一个让插件等翻译席到岗。

---

## 可以记住的几句

1. **`ctx.llm` 是翻译席，不是某一家供应商。** 服务在 `packages/llm/llm`，不在 `packages/core/llm`。循环和插件面向 `LlmAdapter` + `stream()` 编程。
2. **没有 `chat()`。** 一次模型调用 = 一条 `AsyncIterable<StreamChunk>`。循环 `for await` 等的是盘，不是整桌宴会。
3. **先 `prepareCall` 钉死注册，再 `stream`。** 句柄一次性；HMR 不能把 A 适配器的能力结果接到 B 适配器的请求上。`NO_ADAPTER` 时循环仍可把流交给 `llm/stream` middleware。
4. **每盘先入账。** `assistant/chunk` 是原始分片；`BlockAssembler` 现场拼；成功后再写 `assistant/message`，用 `sourceEventSeqs` 指回那些盘。
5. **适配器抛错，窗口收成 `finish`。** middleware / 消费方错误仍然抛。取消走活的 `AbortSignal`；`deepFreeze` 不冻这根绳。
6. **`llm/stream` 不重试。** 产品恢复听 `agent/request-error`（`dsh-llm-retry`）。在已经吐盘之后包瀑布流重试，账上没有尝试边界。

---

## 下一篇读什么

**12 · agent-scope**（每个 agent 一根子纤程）。

本篇已经看到催菜员怎样把一道菜问到翻译席、一盘一盘记上账。下一篇读每位厨师自己的小厨房：`createScope`、`agent.ctx`、作用域里的工具和提示词怎样随工牌一起撤。先不要跳进文件系统或沙箱缝。

---

## 拉取记录

成功（默认分支是 `master`，不是 `main`；钉住 `47f943859bef60e4160492346772ded9b24f765a`；`GET /repos/deepseek-ai/deepseek-harness/commits/master` 仍是这一 SHA）：

- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/llm/llm/src/{index,types,assembler,call-config,adapter-failure,message,invariant,error,brand,content,api-key,attribution,retry-policy,never}.ts?ref=47f943859bef60e4160492346772ded9b24f765a`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/llm/llm/{package.json,README.md,README.zh.md}?ref=47f943859bef60e4160492346772ded9b24f765a`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/llm/{README.md,README.zh.md}?ref=47f943859bef60e4160492346772ded9b24f765a`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/llm/llm-deepseek/src/{index,adapter,types}.ts?ref=47f943859bef60e4160492346772ded9b24f765a`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/llm/llm-pi-ai/src/{index,adapter,stream}.ts?ref=47f943859bef60e4160492346772ded9b24f765a`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/llm/llm-retry/src/{index,types}.ts?ref=47f943859bef60e4160492346772ded9b24f765a`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/core/agent-loop/src/{agent,index,invariant}.ts?ref=47f943859bef60e4160492346772ded9b24f765a`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/core/agent-loop/tests/mock-adapter.ts?ref=47f943859bef60e4160492346772ded9b24f765a`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/docs/{architecture,architecture.zh}.md?ref=47f943859bef60e4160492346772ded9b24f765a`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/docs/subsystems/{llm-streaming,llm-streaming.zh,core,core.zh}.md?ref=47f943859bef60e4160492346772ded9b24f765a`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/docs/cookbook/{adding-an-llm-adapter,adding-an-llm-adapter.zh}.md?ref=47f943859bef60e4160492346772ded9b24f765a`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/master`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/llm/llm/src`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/llm`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/core`

404 / 不存在：

- **`packages/core/llm`**（课表点名的起点；LLM 服务在 `packages/llm/llm`）
- **`packages/llm/llm-openai`**、**`packages/llm/llm-anthropic`**、**`packages/providers`**
- **没有 `chat()`**：`LlmAdapter` / `LlmRuntime` / 循环热路径都只有 `stream`
- 没有单独的 `packages/core/llm/src/stream.ts`：流协议是 `types.ts` 的 `StreamChunk`，组装是 `assembler.ts`，窗口派发是 `index.ts` 的 `adapterStream`

文档与源码不一致（以源码为准）：

- **包 README**（`packages/llm/llm/README.zh.md`）列出 `ctx.llm.listModelDiscoveryNamespaces()`。`LlmRuntime` **没有**这个方法；同页生成的 Cordis catalog（`docs/subsystems/llm-streaming.md`）也不收录它。源码只有 `registerModelDiscovery` / `discoverModels`。
- **同一份包 README** 写「多模态内容（图像、音频等）没有核心块类型」。`types.ts` 的 `ContentBlockMap` 已有 `image`（`ImageBlock`）；注释说当前产品适配器声明纯文本输出，图像只出现在 user 内容里。
- **`docs/subsystems/llm-streaming.zh.md` 适配器约定**仍写循环「关闭失败步骤，再」把失败交给 `agent/request-error`。`agent.ts` 的 `step()` 在同一道尚未 `step/end` 时就 waterfall；10 已记。生成 catalog 与 `index.ts` 一致：适配器失败变成终止 `finish`，不是先关 step。
- **`docs/subsystems/llm-streaming.md`** 提到 `llmRetryPolicyOf(stream)`。当前 `packages/llm/llm/src` **没有**这个符号。循环拿到的是 `PreparedLlmCall.retryPolicy`；按路由查询是 `providerRetryPolicy(provider)`。
- **`docs/architecture.md` ASCII 轮次流程**与 `step()` 一致。时序图里 `request-error` / `step/end` 的错位仍以 10 的记录为准，本篇不重复。

每位 agent 一根子纤程、`createScope`，本篇未展开。
