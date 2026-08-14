# 06 · 只追加 SessionEvent 与 deriveMessages

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[05 boot-profiles-bundles](05-boot-profiles-bundles.md) · 下一篇：[07 system-prompt](07-system-prompt.md)

读的是 DeepSeek Harness 真正跑的那份会话日志，不是自己再发明一套词。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 文档 | `docs/architecture.md`、`docs/architecture.zh.md`、`docs/subsystems/session.md`、`packages/core/session/{README,README.zh}.md` |
| 会话包 | `packages/core/session/src/{types,index,surface,invariant,known-event-types}.ts` |
| 运行时断言 | `packages/core/agent-loop/src/invariant.ts`（循环把请求和日志对账） |
| 循环用法 | `packages/core/agent-loop/src/agent.ts`（`this.session.deriveMessages()`） |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§6.1 系统边界：acquisition / emission |

本篇钉子：模型看见的历史，为什么必须从一份**只能往后写、不能擦**的日志投影出来。01–04 的厨房（Context / effect / inject / 事件）是进程内、可拆走的；05 把树拼起来了。这一篇第一次碰到越过可逆边界的东西。

不要把 Cordis 总线和会话日志混成一件事。04 已经说过：`ctx.emit('agent/pre-step')` 卸插件就消失；`session.append('turn/start', …)` 写进去就还在。

---

## 黑匣子，不是白板

飞机上的黑匣子、店里的流水账：发生过的事只能再记一行。可以回头读，不能把昨天那页涂掉假装没发生。压缩、摘要、fork 都是**再追加一行**，让以后的投影换一种看法；原始行还在。

对应到 `dsh`：

| 黑匣子 / 账本 | Harness |
|---|---|
| 一架飞机、一本账 | 一个 `Session`（普通类，不是 Cordis Service） |
| 只能往后写的一行 | 一条 `SessionEvent`：`type` + `seq` + `time` + `data` |
| 账本种类表（可加新科目） | `SessionEventMap`（声明合并扩展） |
| 从账本算出「当时柜台看到什么」 | `session.deriveMessages()` |
| 柜台当场喊的对讲机 | Cordis 事件（04 篇）：活的、可拆走 |
| 把账本锁进保险柜 | 持久化插件订 `session/event`、在 `session/flush` 排空（17 篇） |

架构原话（`docs/architecture.zh.md` 会话日志节）：会话日志是模型所见上下文的来源。`deriveMessages()` 从中投影出模型历史，原始 `assistant/chunk` 事件则保证回放和 UI 保真。fork、恢复、transcript、遥测和持久化都派生自该事件流。

**模型可见即已记录。** 抵达模型请求的一切都必须能从日志重建，并由一项运行时不变量断言这一点。因此，新增一项模型可见输入就需要新增一个会话事件：扩展 `SessionEventMap` 并从日志渲染。

不要在循环里另存一份对话数组，也不要给模型塞一个日志里没有的旁路字段。那是本篇要钉死的不变量，不是文风。

---

## 两套账：Sigma 可以拆走，日志拆不走

01–03 读的 `Σ`（Sigma）是进程内、按纤程记账的共享服务表：`ctx.tools`、`ctx.llm`、`ctx.sessions` 这些钩子。`set` 是可逆效应，卸插件 = 钩子从桌上拿走，邻居会看见不满足。那是**厨房内部的台账**。

会话日志不是 Sigma。

| | Cordis `Σ` | 会话日志 |
|---|---|---|
| 住在哪 | 进程内 `ctx` / 纤程 | `Session` 的只追加数组；跨重启仍要能重建 |
| 改法 | `provide` / `effect`，带左逆 | 只有 `append`；没有 `erase`、没有 `dispose` 撤回一行 |
| 卸插件 | 服务从 `ctx` 消失 | 已经写下的事件还在；最多不再往这本账上写 |
| 论文位置 | 第 3–4 章，Table 2 的 `Σ` | §6.1 的 **emission（排放）** |
| 读法 | `ctx.sessions` 这个**钩子**仍是 Sigma | 钩子指向的那本**账**已经离开可逆边界 |

论文 §6.1 把一次越界操作分成两段。**acquisition（获取）**还在边界里：`open` 拿到描述符、`malloc` 占一块内存、`fork` 起一个子进程，记录本身是可逆效应。**emission（排放）**把数据推出这条通道：`write` 的字节、`send` 的数据报，作用相当于 `id_Γ`——Gamma 里没有逆可以收回已经出去的数据。

`ctx.sessions` 这个服务钩子是 acquisition：`SessionStore` 挂在纤程上，卸插件就从 `ctx` 拿走。一次 `session.append(...)` 是 emission：事实离开可逆边界。观察者（持久化、UI、遥测）可以抄走副本；循环自己也再读不到「没发生过」的世界。定理 73 保证的是静止状态等于最终配置，**不保证**沿途排放没发出去——论文自己把这条界划在 §6.1。

包注释把这层意思写进模块第一句。出处：`packages/core/session/src/index.ts`。

```ts
/**
 * Event-sourced session service: append-only session log, in-memory store, and
 * the derived LLM message history. Persistence is a plugin concern (subscribe
 * to `session/event`, drain on `session/flush`).
 */
```

`Session` 是普通类；活实例走 `ctx.sessions.create()`，脱离态回放走 `Session.create()`。`SessionStore` 才是 Cordis Service，ctx 键 `sessions`。本篇不读磁盘后端——那是 17。这里只认：真源是内存里那份只追加日志，持久化是订户。

---

## `SessionEventMap`：可加科目的只追加词汇

出处：`packages/core/session/src/types.ts`。注释原话：这是一次 agent 交互可合并扩展、只追加的真源。消息历史由这份日志派生。每条事件都是无损 JSON，序号连续（含原始 chunk），所以持久化可以按规范日志原样存储。

核心科目（本包声明的，不是我编的）：

| 事件 | 记什么 | 会不会进 `deriveMessages` |
|---|---|---|
| `turn/start` / `turn/end` | 一轮的开闭；`end` 带 `TurnEndReason` | 否 |
| `step/start` / `step/end` | 一步 = 一次模型调用 + 它点名的工具 | 否 |
| `user/message` | 用户角色消息：人话、`agent.inject()` 的合成上下文、goal 续轮。三者 `content` 原样投影，靠 `source` 区分 | **是** |
| `assistant/chunk` | 原始流式分片，token 级回放 / UI | 否 |
| `assistant/message` | 这一步拼好的助手消息（派生历史用这个） | **是**（空 content 除外） |
| `tool/call` | 模型点名的工具：`name` + 未解析的 `arguments` 字符串 + `callId` | 否（调用活在助手消息里） |
| `tool/result` | 工具面向模型的结果 | **是** |
| `todo/write` | 整份待办快照；最新一次覆盖。只给 UI，永不进派生历史 | 否 |
| `request/header` | 下一次请求的完整信封（配置 / 系统提示词 / 工具 schema） | 否 |
| `request/context` | 路由元数据（provider / model / 窗口），路由或容量变了才记 | 否 |
| `session/end-seed` | 构造种子到此结束；载荷为空，位置即意义 | 否 |

三种会进模型历史的类型合称 `SurfaceEventType`。出处同一文件。

```ts
export type SurfaceEventType =
  | 'user/message'
  | 'assistant/message'
  | 'tool/result'
```

只有它们可以带 `surfaceOp` 和 `sourceEventSeqs`。`turn/start`、`assistant/chunk` 带这些字段，编译期就拒。插件用声明合并往 `SessionEventMap` 加自己的类型（压缩的 `compaction/*`、钩子的 `hook/*`）；那些默认是**只日志**，不是 surface，除非以后有人把类型也扩进 `SurfaceEventType`——本篇读到的源码没有这样做。

`SessionEvent` 是按 `type` 收窄的判别联合，不是互不相干的 `type` / `data` 两个联合。每条还有：

- `seq`：会话内单调序号，合同是 `seq = log.length`（下一条的序号永远等于当前长度）。
- `time`：Unix 毫秒。
- `ignorable?: true`：读取器不认识这个 `type` 时可否跳过。**缺省 = 必需**：不认识又没打标记，必须拒绝重建，不能默默丢掉——丢掉可能改写整本账的读法。

生成清单 `KNOWN_SESSION_EVENT_TYPES`（`packages/core/session/src/known-event-types.ts`）枚举本仓库声明过的全部成员。持久化读路径碰到集合外的类型，除非信封带 `ignorable`，否则拒读：那多半是更新的 harness 写的，默默跳过会重建出一本错账。

---

## `append`：热路径不碰磁盘，写进去就不能改

`Session.append` 的合同（`packages/core/session/src/index.ts`）：给 `data` 和 surface 元数据做一份无损 JSON 快照并深冻结；校验标记形态；**同步**推进日志；再通知观察者。热路径不阻塞 I/O。事件一旦进日志，这次追加就提交了：观察者失败按监听器收容，不改返回值，也不拦后面的人看见同一条已接受事件。

调用形状（编译器按类型强制第三参）：

```ts
append (
  type: T,
  data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
): SessionEvent
```

读法：

1. **surface 事件必须声明怎么入账。** `user/message` / `assistant/message` / `tool/result` 要带 `SurfaceIntent`（至少 `surfaceOp`）。`turn/start` 不许带。
2. **非 JSON 进不去。** BigInt、函数、`undefined`、`-0`、非有限数字、循环引用、稀疏数组、`Map`/`Date`/类实例，当场抛。坏事件在追加点失败，而不是等后端 flush 才爆。
3. **`seq` 连续。** 新事件的 `seq` 就是追加前的 `this.log.length`。种子也必须从 0 连续，否则构造失败——回放不能造出一份磁盘存不下的活日志。
4. **返回值是进账的那份快照。** 读 `event.data` 看到的是日志里的值，不是调用方手里还可能改的那个对象。`session.events` 是冻结快照，下次追加才换一份；已经拿在手里的数组不会变长。

`surfaceOp` 两种（`types.ts`）：

- `'append'`：接到尾巴。人话、助手消息、工具结果的常路。
- `{ op: 'replace', start, end }`：用这一条替换当前 surface 上从 `start` 到 `end`（含）的节点。**日志行并不删**——被挡住的只是以后的投影。压缩走这条路（19 篇）；本篇只要记住：只追加的是账本，换看法的是 surface。

活会话挂上 store 之后，追加还会 `emit` `session/event`（提交后、即发即忘）。`session/flush` 是 parallel：每个持久化监听器都跑，调用方等全部结算。这是 04 篇的分发模式，挂在排放之后：总线可以拆走，账还在。

---

## `deriveMessages`：从 surface 投影，不另存对话

循环在每一步组请求时，把历史从日志现算出来。出处：`packages/core/agent-loop/src/agent.ts`。

```ts
const { request, preparedCall } = await this.buildRequest(
  turn, step, assembly.tools, system, this.session.deriveMessages(), signal,
)
```

没有第二份 `messages: Message[]` 字段跟着改。`Session.deriveMessages` 的注释（`index.ts`）：沿 `surfaceOp` 维护的、产生消息的有序序号往前走。surface 是派生历史的唯一来源：每条会产生消息的追加都记下 `surfaceOp`，所以没有标记的原始事件（chunk、轮次边界）正确地缺席；压缩的 `replace` 则把被挡住的节点从派生里拿掉。逐节点规则是 `deriveEventMessage`。

投影本身（`packages/core/session/src/surface.ts`）是直通，不加框：

```ts
export function deriveEventMessage(event: SessionEvent): Message | null {
  switch (event.type) {
    case 'user/message': {
      return event.data
    }
    case 'assistant/message': {
      if (event.data.message.content.length === 0) return null
      return event.data.message
    }
    case 'tool/result': {
      return event.data.message
    }
    default:
      return null
  }
}
```

读法：

- `user/message` → 事件里那份用户消息，`content` 一字不改。人话、注入、goal 续轮都走这里；谁写的看 `source`，不在投影里再包一层。
- `assistant/message` → 助手消息。空 content 的那条只是为了扛 max-tokens 的 usage，**不得**往提供方 transcript 里塞一轮没字的助手。
- `tool/result` → 工具结果消息（用户角色、一块 `tool-result`）。
- 其它（`turn/*`、`step/*`、`assistant/chunk`、`tool/call`、`todo/write`、`request/header`、插件只日志事件）→ `null`。

`deriveMessages` 按 `surface.nodes` 的序号取日志行，对每个节点调用上面这条规则；`null` 不进数组。结果缓存：每个 surface 节点第一次看见时投影一次，以后追加只扫新节点；`replace` 会抬 `replaceGeneration`，缓存整份重建。返回的是**新数组**，里面的 `Message` 对象共享且深冻结——改投影改不了账。

面向人的 transcript 不读 `session.surface`。README 原话：落地的替换会挡住读者已经看过的对话；人读追加来源事件（`isAppendSurfaceEvent`），模型读 surface。本篇不展开压缩，只要分清两份投影。

`request/header` 也不进 `deriveMessages`。它重建的是信封（系统提示词、工具 schema、采样），前缀在投影**外面**拼上。那是下一篇 system-prompt 的钉子；这里只记住：信封也必须先落日志，循环才能对账。

---

## 运行时真的在对账

架构说「一项运行时不变量断言这一点」。断言不在会话包的关系轨迹里（`session/invariant.ts` 管的是序号递增、轮次/步骤开闭、同一步里 `tool/call` 配 `tool/result`），而在循环配套的请求重建检查。出处：`packages/core/agent-loop/src/invariant.ts`。

它挂在 `llm/stream` 瀑布最前面（`prepend: true`），专查循环自己造的请求：

```ts
const expected = session.deriveMessages()
if (JSON.stringify(options.messages) !== JSON.stringify(expected)) {
  fail(`llm request for session "${String(session.id)}" diverges from the dispatch-time durable derivation (log-reconstruction desync)`)
}
```

同时还要求：请求已冻结、带活的 `sessionId`、日志里已有 `step/start`、已有 `request/header`，并且 model / system / 采样 / tools 与折好的信封一致。对不上就 fail，不是警告。这就是「模型可见即已记录」的牙齿：想给模型看新东西，先扩展 `SessionEventMap`、先 `append`、再让 `deriveMessages` 投影出来。循环里塞一个旁路字段，过不了这一关。

---

## `SESSION_FORMAT_VERSION = 0`

出处：`packages/core/session/src/types.ts`。每个新写入的 `SessionHeader.version` 盖这个戳；持久化后端加载时核对。头本身在事件日志**外面**（存储元数据，不是可回放的对话状态）。

```ts
export const SESSION_FORMAT_VERSION = 0
```

注释写明：未发布期间钉在 `0`——不暗示兼容，不兼容的日志直接拒绝，不提供迁移。版本是单个单调整数，没有 major/minor。该不该加一，看**写方**发出去的东西，不看更新的读方能不能解析：「解析不报错」不是正确性——默默跳过会塑造重建的内容，就是读错。加一个普通事件类型不加版本号，靠每条事件的 `ignorable` 管词汇增长；改信封、改 `SessionEvent` 外壳、改核心语义、改 surface 机制才加。拿不准就加：一次近乎恒等的升级几乎免费，漏加一次会让旧运行时把新日志读错还不出声。

这是 harness 现状，论文没讨论。developer preview 的会话格式会变；本仓库 README 也写了同一句。

---

## 和论文对得上、对不上的

对得上：

- **§6.1 acquisition / emission。** `ctx.sessions` 这个钩子是余效应，可逆。`append` 把事实推过边界，作用相当于 `id_Γ`。卸 loop、卸 session 插件，已经写下的行收不回来——这是设计，不是泄漏。analysis 里那句「会话日志不是 Sigma」就是这句话。
- **定理 73 的范围。** 静止状态只取决于最终配置；沿途排放不在保证里。一次 turn 发出的 `user/message` / `assistant/message` 不会因为后来热卸某个工具插件而从账上消失。
- **04 篇的总线仍是效应。** `session/event` 的监听器随纤程走；持久化插件卸了就不再抄新行，但抄走过的字节是排放。

对不上、本篇不拉来充数的：

- 论文没有 `SessionEvent`、`deriveMessages`、`SESSION_FORMAT_VERSION`。这些是产品的事件溯源账本，不是演算对象。
- Sigma 的 key 不能提供两次、不能撤一个不存在的 key；日志的约束是 `seq` 连续和 surface 合同，不是「同一 key 一份绑定」。
- `session/invariant` 的轮次开闭、`fork` 的边界、崩溃修复的 `interrupted`，都是工程缝，不是 §6.1 的形式对象。持久化与恢复是 17，压缩是 19，循环逐步驱动是 10。

---

## 可以带走的四件事

1. 会话日志是黑匣子：只能 `append`，没有擦。`SessionEventMap` 是可加科目的词汇；消息历史不另存，只从日志投影。
2. 这不是 Cordis 的 Sigma。Sigma 是进程内可逆台账；一次 `append` 是论文 §6.1 的排放。卸插件拆的是钩子，拆不掉已经出去的事实。
3. `deriveMessages` 只走三条 surface：`user/message`、`assistant/message`、`tool/result`。chunk、边界、`tool/call`、todo、请求头都不进模型历史。空 content 的助手消息也不进。
4. **模型可见即已记录。** 循环在 `llm/stream` 上用 `JSON.stringify(options.messages) === JSON.stringify(session.deriveMessages())` 对账。想给模型看新东西，先加事件类型、先写入日志。`SESSION_FORMAT_VERSION` 现为 `0`，不做迁移。

---

## 下一篇读什么

**07 · system-prompt**（提示词片段与工具 schema 组装）。

本篇已经看到：模型历史从日志投影，请求信封也必须先落成 `request/header`。下一篇读信封里那两块——系统提示词和工具 schema——是怎样由各插件用 `ctx.effect` 登记、再在一步开始时 `assemble` 出来的。先不要跳到工具流水线。

---

## 拉取记录

成功：

- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/session/src/types.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/session/src/index.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/session/src/surface.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/session/src/invariant.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/session/src/known-event-types.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/session/{README,README.zh}.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/architecture.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/architecture.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/session.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/agent-loop/src/invariant.ts`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/core/session/src`
- `https://api.github.com/search/code?q=repo:deepseek-ai/deepseek-harness+deriveMessages`（核 `agent.ts` 调用点）

404：本篇列出的路径均返回 200。`packages/core/session/src/` 还有 `chunk-rows.ts`、`json.ts`、`preparation.ts`、`repair.ts`、`request-header.ts`，本篇未展开（存储编码、修复、信封折叠分别属 17 / 循环恢复 / 07）。`docs/subsystems/session.md` 存在；未再拉 `session.zh.md`，中文定义以 `architecture.zh.md` 与包内 `README.zh.md` 为准。
