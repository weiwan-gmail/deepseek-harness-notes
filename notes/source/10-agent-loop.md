# 10 · Agent 循环：turn / step / inbox / 驱动器

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[09 agent-registry](09-agent-registry.md) · 下一篇：[11 llm-streaming](../source-curriculum.md)（待写）

读的是 DeepSeek Harness 真正跑的那份炒菜机，不是自己再发明一套「agent 循环」。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 钉住 | `master` @ `47f943859bef60e4160492346772ded9b24f765a`（`dsh@0.1.0-rc.5`） |
| Harness 文档 | `docs/architecture.md`、`docs/architecture.zh.md`（轮次流程）、`docs/agent-lifecycle.md`、`docs/agent-lifecycle.zh.md`（时序图）、`docs/subsystems/core.md`、`docs/subsystems/core.zh.md` |
| 驱动器 | `packages/core/agent-loop/src/agent.ts`（`ReactLoopAgent`：`send` / `wakeDriver` / `kick` / `turn` / `step` / `preStep` / `buildRequest`） |
| 工厂 | `packages/core/agent-loop/src/index.ts`（`AgentLoop`；`prepare` / `publish` 让机器活着，**不**点火） |
| 点菜单 | `packages/core/agent/src/inbox.ts`（`Inbox`：`next-turn` / `next-step`、`splice` / `claim`） |
| 工具调度 | `packages/core/agent-loop/src/tool-calls.ts`（`executeToolCalls`：先记 `tool/call` 再跑；细节见 08） |
| 工牌方法 | `packages/core/agent/src/runtime-types.ts`（`followup` / `steer` / `inject` 是 `send` 的固定预设） |
| 包 README | `packages/core/agent-loop/{README,README.zh}.md` |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§6.1 排放；**没有** turn / step / inbox 对象 |

本篇钉子：一位已经在岗的厨师，怎么把一张点菜单做成一轮出餐。09 读的是工牌和主厨席；本篇读的是**这一口灶**。`followup` 把单子夹上轨并按铃；驱动器醒来、打开桌子、按步上菜；inbox 是点菜单，不是账本。

不要把「前台名册」（09）和「这一轮怎么炒」（本篇）混成一件事。LLM 怎么把 token 流回来留给 11；每位厨师自己的小厨房怎么建留给 12。

---

## 厨房：服务员点单，后厨按步出菜，收台再开下一桌

饭店里，一位已经上岗的厨师面前有三样东西：一块工牌（09 的 `Agent`）、一本流水账（06 的 `session`）、一份**点菜单**（inbox）。客人、服务员、稽核员都只对工牌喊话，不直接冲进灶台。

- **点菜单有两个夹子。** `next-turn` 是「新开一桌」的单；`next-step` 是「这一桌下一道还要加什么」的单。两夹子上的菜名不能重复。
- **按铃才开火。** `followup` / `steer` 会夹单并按铃；`inject` 只把纸条夹到「下一道」上，**不按铃**。没人按铃，厨师可以一直闲着——即便夹子上已经有纸条。
- **先开桌，再撕单。** 桌子编号写进流水账（`turn/start`）之后，才把这一桌该看的单从夹子上撕下来。撕下来的单如果被拒，这桌仍然记过一次空坐，不装作没开过。
- **一道菜 = 一次问灶神 + 它点的配菜。** 这是 step。一桌可以上零道或多道：配菜还欠一句回话、或夹子上又多了「下一道」，就继续上。
- **催菜员（驱动器）** 守着这一口灶：闲着就坐；铃响就进入 `running`，把该出的桌出完再坐下。`running` 说的是催菜员还在场，**不能**证明某一桌的台布还没收。

对应到 `dsh`：

| 厨房 | Harness |
|---|---|
| 点菜单（两个夹子） | `Inbox`：`next-turn` / `next-step` |
| 夹单（先入账再改夹子） | `inbox.splice` → 持久 `agent/inbox/spliced`，再改活投影 |
| 按铃 | `send(..., wakeup: true)` → `wakeDriver` |
| 只夹不按铃 | `inject` = `send(next-step, false)` |
| 新开一桌并按铃 | `followup` = `send(next-turn, true)` |
| 这一桌加一道并按铃 | `steer` = `send(next-step, true)` |
| 催菜员 | `ReactLoopAgent` 的相位机：`idle` / `running` / `maintenance` |
| 铃响之后的循环 | `wakeDriver` → `kick` → `while (await this.turn())` |
| 一桌 | turn：先 `turn/start`，零个或多个 step，再 `turn/end` |
| 一道菜 | step：一次模型请求 + 它调用的工具 |
| 撕单 | `inbox.claim`：倒空 `next-step`，若在桌边界再取一条 `next-turn` |
| 这道上不上 | `agent/pre-step` waterfall：`reject` 或 `enter(messages)` |
| 问灶神之前对账 | `session.deriveMessages()`（06）；流式细节是 11 |
| 配菜下锅 | `executeToolCalls`（08 的流水线；本篇只记它怎么把灶接回这一桌） |
| 收台前问一句 | `agent/turn-stopping` serial：可以 `steer` 再上一道 |

架构原话（`docs/architecture.zh.md` 轮次流程）：一个**步骤**是一次模型请求加上它调用的工具。一个**轮次**包含零个或多个步骤：它在领取首条输入之前打开，并在不再欠下任何工作时关闭。输入通过同一个 inbox 到达驱动器。有些消息会立即唤醒它；注入的上下文会留在 inbox 中，直到另一条消息将其唤醒。

包注释把职责写成一句。出处：`packages/core/agent-loop/src/agent.ts`。

```ts
/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-agent-loop/agent
 */
```

`ReactLoopAgent implements Agent`。工厂包根不导出它：`packages/core/agent-loop` 的 `exports` 只有 `.` 和 `./invariant`，没有 `./src/*`。外面只认工牌上的 `followup` / `steer` / `inject`。

---

## 点菜单：先记账，再改夹子

inbox 是会话日志上 `agent/inbox/spliced` 的**活投影**，不是另一本账。构造时从 `session.header.seedLength` 之后的事件重放 splice；之后每次改夹子，都先 `session.append('agent/inbox/spliced', …)`，再改内存数组。同步订 `session/event` 的人看见的是改之前的夹子，可以从坐标把被撕掉的单拼回来。

出处：`packages/core/agent/src/inbox.ts`。

```ts
export class Inbox {
  private readonly state: InboxState = { 'next-turn': [], 'next-step': [] }
  // …
  get hasPending(): boolean {
    return this.nextTurn.length > 0 || this.nextStep.length > 0
  }
```

`InboxTarget = 'next-turn' | 'next-step'` 在 `packages/core/agent/src/types.ts`——这个文件**只有**这条持久词汇，工牌方法在 `runtime-types.ts`（09 已经对过文档写错出处）。

领取是循环的内部操作，标了 `@internal`，不是插件扩展点：

```ts
claim(target: InboxTarget, turn: number): UserMessage[] {
  const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
  if (target === 'next-turn') {
    claimed.push(...this.mutate('next-turn', 0, 1, [], false))
  }
  for (const message of claimed) this.notifications.claimed(message, turn)
  return claimed
}
```

厨房规则：

- 每次拟进入一步，**先倒空**「下一道」夹子。
- 若这是一桌的第一道（`target === 'next-turn'`），再从「新开一桌」夹子上取**一条**。
- 顺序是：先加菜纸条，再主单。架构那行 `claim next-step input plus one queued message` 说的就是这个。
- 领取是纯删除：不带 `outcome: 'canceled'`，不发 `discarded`。活通知是逐条 `agent/inbox/claimed`。
- 取消（`clear` / `remove`）才带 `canceled`，并发 `discarded`。
- 同一 `MessageId` 不能同时待在两个夹子上，`validate` 会抛 `already pending`。

`ReactLoopAgent` 构造时把这三声铃接到工牌的对讲机上。出处：`packages/core/agent-loop/src/agent.ts`。

```ts
this.inbox = new Inbox(session, {
  inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
  discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
  claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
})
```

两本账不要混：`agent/inbox/spliced` 是 06 那种写出去就涂不掉的小票；`inserted` / `claimed` / `discarded` 是 09 那种活对讲机。时序图（`docs/agent-lifecycle.md`）把 `agent/inbox/spliced` 画成 Agent 发给 SDK 的活事件——跟类型声明对不上，下文按实文件走。

---

## `send`：夹子 × 按铃；三个别名只是预设

工牌上的投递原语只有一个。出处：`packages/core/agent/src/runtime-types.ts` 的注释，实现在 `agent.ts`。

```ts
send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
  const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
  const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
  this.inbox.splice(resolvedTarget, Infinity, 0, [message])
  if (wakeup) this.wakeDriver(wakingAfterAbort)
}

followup(input: UserMessage): void {
  this.send(input, 'next-turn', true)
}
steer(input: UserMessage): void {
  this.send(input, 'next-step', true)
}
inject(input: UserMessage): void {
  this.send(input, 'next-step', false)
}
```

| 别名 | 夹子 | 按铃 | 人话 |
|---|---|---|---|
| `followup` | `next-turn` | 是 | 新开一桌，并且现在就炒 |
| `steer` | `next-step` | 是 | 这一桌加一道；若灶是冷的，也等于新开一桌 |
| `inject` | `next-step` | **否** | 给下一道塞模型可见上下文，等别人按铃 |

`wakeup && 当前活动已经 abort` 时，这条唤醒输入会被改路由到 `next-turn`：正在收的那桌接不住新铃，单子改挂到下一桌。这个分类**写在 splice 之前**，免得 splice 的观察者同步 `cancel`，把「按铃」重新解释成别的。`disposed` 取消不锁存铃；闲着时按铃**总是**开一桌——即便单子在 claim 之前被清空，流水账仍会记下一次空坐（`idle → running → idle`）。

`inject` 可能赶不上已经 claim 过的那一步：纸条夹晚了，这道菜的批次已经撕走。它会等到下一个 step 边界。空闲时它就待在夹子上，直到 `followup` 或 `steer` 按铃。

`cancel` 默认 `inbox.clear()`（先清 next-step 再清 next-turn）；`keepInbox` 则只 abort 当前活动，夹子不动、不记 canceled splice。

---

## 催菜员：`wakeDriver` → `kick` → `turn`

相位是私有的，对外 `status` 只有 `idle` | `running`。`maintenance` 对外仍报 `idle`：那是压缩一类非 turn 活，占着灶但不算在炒菜。

```ts
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }
```

闲着按铃：立刻翻成 `running`（新的 `AbortController`，`turn` 先抄 `lastTurn`，`step` 归零），再在发起方作用域里跑 `kick`。出处同上文件。

```ts
private wakeDriver(wakeAfterAbort = false): void {
  if (this.phase.kind !== 'idle') {
    const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
    if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
      this.phase.wakeRequested = true
    }
    return
  }
  // …setPhase running…
  this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
}

private async kick(): Promise<void> {
  try {
    while (await this.turn()) {}
  } catch (_error) {
    // Reported failures and cancellation are contained at the driver boundary.
  } finally {
    if (this.phase.kind === 'running') {
      const { turn, wakeRequested } = this.phase
      this.setPhase({ kind: 'idle', lastTurn: turn })
      if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
    }
  }
}
```

活着的 `running` 催菜员**自己**会在桌与桌之间看夹子，不靠再锁一次铃。只有维护态、或 abort 之后收敛前赶到的唤醒，才把 `wakeRequested` 记下，等坐下再补按一次。`kick` 把失败和取消收在催菜员边界：单桌可以挂，催菜员卸任时回到 `idle`。`whenIdle()` 跟的是整段 `activityDone`，不是某一张单。

工厂的 `publish()` **不**调用 `wakeDriver`。`prepare()` 里 `new ReactLoopAgent(...)` 时相位就是 `idle`；`publish` 进名册、敲 `agent/created`、发不可否决的 `agent/session-start`，然后把工牌交出去。包 README 写「此后才启动驱动器」——源码里启动的是**活机器**（从 `session-start` 起就能 `send` / `inject`），不是已经在 `kick`。点火要等 wakeup 输入。`session-start` 监听器按文档用 `agent.inject()` 塞模型可见上下文；那不按铃。

09 写过：`Setup composes, it never drives`。本篇补上后半句：布置完工位，催菜员坐着等铃。

---

## 一桌：先写桌号，再撕单，再按道上菜

架构文档把顺序画成这一张（`docs/architecture.zh.md` / `docs/architecture.md`，两边 ASCII 相同）：

```text
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step                   reject | enter(messages)
     reject, or a first enter rewritten empty -> close the turn with no step
     step/start
     append entered messages as user/message
     derive model history from the log
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> claim -> next step
  -> agent/turn-stopping
turn/end
```

`ReactLoopAgent.turn` 按这张图走。先 `session.append('turn/start', { turn })`，**然后**才 `preStep`。`preStep` 里：claim → `systemPrompt.assemble` → 可选贴一张运行时上下文快照 → `agent/pre-step` waterfall。

```ts
private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
  const claimed = this.inbox.claim(target, position.turn)
  const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
  // …
  const decision = await this.dispatch.waterfall(
    'agent/pre-step', { messages: claimed, ...position, signal },
    (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
      kind: 'enter',
      messages: context === undefined ? claimed : [...claimed, context],
    }),
  )
  return decision.kind === 'reject' ? decision : { ...decision, assembly }
}
```

默认 `enter` 把领取到的批次原样送进去；若 `RuntimeContextProjection` 认为系统提示词里的动态快照变了，会在批次末尾多贴一条 plugin 来源的 `UserMessage`。监听器可以整批换掉，也可以 `reject`。

第一道就被拒，或 `enter` 被改写成空消息：这桌**仍关闭**，但不花 step。拒是 `{ kind: 'blocked' }`；空的首次 enter 是 `{ kind: 'completed' }`。claimed 的单既不丢回夹子，也不写成 `user/message`——对讲机上的 `claimed` 就是它的终点。领取之后才夹上的纸条还在，不跟这桌走。

过了这关才 `step/start`，把 `enter` 的消息逐条 `append('user/message')`，再跑 `step(assembly)`。`step/end` 在 `finally` 里，成功失败都记。

一桌何时收台：

1. 这一道正常结束（没有工具，或工具带了 `concludesTurn`），**并且** `next-step` 夹子是空的 → 跑 `agent/turn-stopping`（serial，没有 `next()`）。监听器可以在这里 `steer`。跑完再看一眼夹子：有单就继续下一道，没单才 `break`。
2. 工具还欠模型一句回话（`executeToolCalls` 返回 `concluded: false`）→ `turnEnds` 仍是 `null`，不管夹子空不空，都进入下一道（claim 的 target 改成 `'next-step'`，可以领到空批次）。
3. `max-tokens` 会粘在这一桌上：后面的 step 即便 `completed`，也不能把桌的结局降级。
4. abort / 抛错：`turn/end` 仍写；原因是 `aborted` 或 `error`。失败先 `agent/error`，再在催菜员边界收住。

桌关上之后若 `inbox.hasPending`，`turn()` 返回 `true`：换一个新的 `AbortController`，`step` 归零，`kick` 开下一桌。对外 `status` 可以一直是 `running`，中间不回到 `idle`。这就是「`running` 不能证明某一桌还开着」。

`agent/turn-stopping` 的数据说了算，不是监听器排队顺序。工具结果上的 `concludesTurn` 是反向的数据：想提前收台，把结论写进结果，而不是喊停。同一道里工具塞进 `next-step` 的 `additionalContexts`、以及抢跑的 `steer`，都还要再上一道；夹子排干了才真正收台。包 README 写：**没有内置轮次预算**——跑飞了必须从这种既有扩展点 `cancel`。

---

## 一道菜：一次请求 + 它点的配菜

`step` 的核心是：从账本投影历史，冻一份请求，把流式结果记回账本，若有 `tool-call` 块就调度工具。流式适配器、`BlockAssembler`、chunk 怎么拼，是 11 的题。本篇只钉循环怎么把这一道接上 06 的账本和 08 的流水线。

```ts
const { request, preparedCall } = await this.buildRequest(
  turn, step, assembly.tools, system, this.session.deriveMessages(), signal,
)
const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
for await (const chunk of stream) {
  chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
  assembler.push(chunk)
}
```

没有第二份对话数组。`buildRequest` 把 `deriveMessages()` 的结果冻进请求；可选的 `agent-loop-invariant` 在 `llm/stream` 上用 `JSON.stringify` 对账（06 已经读过牙齿，这里不重复）。

`agent/request` waterfall 只能换冻结的调用配置（provider / model / 采样），**不能**改消息。缺 provider/model 就抛，让监听器补，或在 `AgentOptions` 里带上。

请求失败（`finish.kind === 'error' | 'aborted'`）走 `agent/request-error` waterfall：有人返回 `{ kind: 'retry' }` 且不 `next()`，这一道内部 `continue` 再请求一次（**不**先 `step/end`）。没人认领就抛 `LlmError`，由外层 `finally` 写 `step/end`，再关桌。时序图把 `step/end` 画在 `request-error` **之前**，`docs/subsystems/core.zh.md` 也写「失败的模型步骤关闭之后」才跑 `request-error`——跟 `agent.ts` 对不上。ASCII 轮次流程没画这条恢复枝，按源码：恢复发生在**同一道尚未写下 `step/end` 的时候**。

没有工具调用，或命中 `max-tokens`：这一道结束。有 `tool-call` 块则：

```ts
const { concluded } = await executeToolCalls(
  this.loopCtx, turn, step, toolCalls, signal,
  context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
)
return concluded ? { kind: 'completed' } : null
```

`executeToolCalls`（`tool-calls.ts`）按 08 已经读过的顺序：**先** `session.append('tool/call')`，再 `prepare` / `dispatch` / `finalize`。独占调用是屏障；并行安全调用用有界滚动池（默认 10，`ctx.agentLoop.config.maxParallelToolCalls`）。策略、结果、结果上下文保持模型顺序。工具结果里的 `additionalContexts` 被接回「下一道」夹子——这是循环把灶上的配菜纸条夹回去，不是插件的 `inject` API，但走同一份 inbox。`concludesTurn` 只决定这一道回不回 `completed`；夹子上已有的下一道仍会出。

取消时，已开工的配菜要排干；未下锅的补一对合成 `tool/call` + `ABORTED_BEFORE_DISPATCH` 结果，回放才对得上。调度器自己炸了：**不**虚构结果，把已经记下的 `tool/call` 留在账上，错误抬到催菜员边界。这些是产品调度约定，不要说成论文里的惯性 Future。

---

## 对回论文与架构图：只在对得上的地方连

| 机制 | 本包里的真名字 | 是否同一件事 |
|---|---|---|
| §6.1 排放 | `turn` / `step` / `claim` / `step` 里每一条 `session.append` | **对得上**：事实离开可逆边界。06 已经钉过；本篇是排放发生的那台炒菜机 |
| 04 的 waterfall / serial | `agent/pre-step`、`agent/request`、`agent/request-error`、`agent/turn-stopping` | **对得上**：活扩展点，卸插件没人听 |
| 可逆效应 / 余效应 | 循环插件自己的 `setFactory`、`static inject`（09） | 对得上，但那是工厂上岗，不是这一桌 |
| 论文纤程 / Σ / Algorithm 1–5 | turn、step、inbox、`kick` | **对不上**。一轮对话不是一根纤程；点菜单不是 Sigma；催菜员不是 `fiber.inertia` |
| `docs/architecture.md` Turn flow | `ReactLoopAgent.turn` / `step` / `preStep` | **对得上**：ASCII 顺序与 `agent.ts` 一致（先 `turn/start`，再 claim / assemble / pre-step，再 `step/start`） |
| `docs/agent-lifecycle.md` 时序图 | 同上 | **部分对不上**：assemble 被画在 `step/start` 之后；`request-error` 被画在 `step/end` 之后；`agent/inbox/spliced` 被画成活 `agent/*`。以 `agent.ts` + `inbox.ts` 为准 |

不要把 `Agent.inject(message)` 说成 Cordis 的 `ctx.inject`：一个往点菜单夹纸条，一个让纤程等水电。09 已经写过，本篇只再钉一次，因为这两个词在循环热路径上挨得更近。

---

## 可以记住的几句

1. **step = 一次模型请求 + 它调用的工具；turn = 零个或多个 step。** 先开桌（`turn/start`）再撕单；拒单或空的首次 enter 仍关一桌，不花 step。
2. **inbox 是点菜单，两个夹子。** `next-turn` 新开一桌，`next-step` 这一桌加一道。先入账（`agent/inbox/spliced`）再改夹子。claim 倒空下一道，桌边界再取一条新桌单。
3. **`followup` / `steer` / `inject` 只是 `send(target, wakeup)` 的三个预设。** 按铃才 `wakeDriver`；`inject` 不按铃。
4. **催菜员是相位机，不是名册。** `wakeDriver` → `kick` → `while (turn)`。`running` 跨越连续的排队桌；`publish` 只让机器活着，不点火。
5. **模型看见的历史仍只从账本投影。** `step` 调用 `deriveMessages()`；想加模型可见输入，先 `append`。工具先写 `tool/call` 再跑（08）。
6. **收台看数据，不看谁先举手。** `turn-stopping` 没有 `next()`；`concludesTurn` 和夹子是否排干决定还上不上。没有内置轮次预算。

---

## 下一篇读什么

**11 · llm-streaming**（`ctx.llm` 适配器与流式）。

本篇已经看到催菜员怎样开桌、撕单、按道上菜。下一篇读模型请求怎么 `prepareCall`、怎么 `stream`、chunk 怎么拼成 `assistant/message`。先不要跳进每位 agent 一根子纤程。

---

## 拉取记录

成功（默认分支是 `master`，不是 `main`；钉住 `47f943859bef60e4160492346772ded9b24f765a`）：

- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/{agent,index,tool-calls,constants,invariant,runtime-context}.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent/src/{inbox,runtime-types,types}.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/{README,README.zh,package.json}`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/docs/{architecture,architecture.zh,agent-lifecycle,agent-lifecycle.zh}.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/{core,core.zh}.md`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/core/agent-loop/src`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/master`

404 / 不存在：

- 本篇点名的循环文件均存在（`agent.ts`、`index.ts`、`tool-calls.ts`、`inbox.ts` 都在）。没有单独的 `loop.ts` / `driver.ts`：催菜员就是 `ReactLoopAgent`。
- `docs/architecture.md`、`docs/architecture.zh.md`、`docs/subsystems/core.md`、`docs/subsystems/core.zh.md`、`docs/agent-lifecycle.md`、`docs/agent-lifecycle.zh.md` 均存在。

文档与源码不一致（以源码为准）：

- **`docs/agent-lifecycle.md` 时序图**：`system-prompt/assemble` 画在 `step/start` 之后；源码在 `preStep` 里、`agent/pre-step` 之前、`step/start` 之前组装。`docs/architecture.md` 的 ASCII 与源码一致。
- **同一张时序图**把 `step/end` 画在 `agent/request-error` 之前；`docs/subsystems/core.zh.md` 写「失败的模型步骤关闭之后」才跑 `request-error`。源码在 `step()` 的 `while` 里先 waterfall，`retry` 则继续同一道；不 retry 才抛，由 `turn()` 的 `finally` 写 `step/end`。
- **时序图**把 `agent/inbox/spliced` 画成 Agent → SDK 的活事件。它是 `SessionEventMap` 里的持久科目；活对讲机是 `inserted` / `claimed` / `discarded`。
- **包 README**「此后才启动驱动器」：`publish()` 不调用 `wakeDriver` / `kick`。机器在 `prepare()` 起就是活的、相位 `idle`；点火等 wakeup。
- **`docs/subsystems/core.zh.md`** 仍把 `Agent` 句柄出处写成 `packages/core/agent/src/types.ts`（09 已记）。公开句柄和活 `agent/*` 在 `runtime-types.ts`。

LLM 流式内部、`createScope` 子纤程，本篇未展开。
