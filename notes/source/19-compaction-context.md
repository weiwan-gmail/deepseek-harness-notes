# 19 · 上下文压缩

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[18 jobs-schedule](18-jobs-schedule.md) · 下一篇：[20 web-client](../source-curriculum.md)（待写）

读的是 DeepSeek Harness 真正跑的那套压缩缝。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 钉住 | `master` @ `47f943859bef60e4160492346772ded9b24f765a`（`dsh@0.1.0-rc.5`；与 18 相同，已重核 HEAD） |
| 家族说明 | `packages/compaction/README.zh.md`、`docs/subsystems/compaction.md` |
| 缝 | `packages/compaction/compaction/src/{index,types,checkpoint}.ts`（`ctx.compaction`；**没有** `packages/core/compaction`） |
| 后端 | `packages/compaction/compaction-basic`（`BasicCompactionEngine`） |
| 剪枝 | `packages/compaction/compaction-tool-result-pruner`（`ctx.toolResultPruner`） |
| 命令 | `packages/compaction/command-compact`（`/compact` 挂到 `ctx.commands`） |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§6.1 排放；**没有** compaction 对象 |

本篇钉子：06 已把会话钉成只追加，`deriveMessages()` 读当前表层。17 读过保险柜。11 读过 `ctx.llm.stream()`。这里只读表层怎样换成检查点、原始行为什么还在、剪枝和摘要为什么不是同一把刀。Web 客户端留给 20。`packages/spill` 的 `ctx.spillStore` 是过大工具输出落盘，不是本课。

## 厨房：夹子太厚，传菜口塞不进去

今晚点菜单越写越长。传菜口（模型这一步能看见的那一层）有固定宽度。厨房不把旧票涂黑——06 已经钉死只追加——而是换投影。

- 剪枝不是摘要。某一张工具回执太长，书记员只留开头和末尾，中间盖章 [... tool result middle pruned ...]。原文那一行仍在夹子里，传菜口换成短的那张。这一步不叫模型。
- 摘要才是折一页检查点。把一段较早的票折成结构化摘要，用一张新的 `user/message` 盖在传菜口上。夹子里仍能翻到被盖住的那些 seq。
- 盘点中挂牌。开始先追加 `compaction/start`，结束才追加 `compaction/end`。中间崩了，夹子上会留下一枚没有配对的 start，而不是一枚假装做完的 end。
- 这不是循环的脊椎。文档写明 compaction 是可选能力，词汇不进 `core.md`。没挂后端，循环照跑，只是窗口满了没人收拾。

| 厨房 | Harness |
|---|---|
| 压缩缝 | `ctx.compaction`（抽象 `CompactionEngine`） |
| token 压力后端 | `dsh-compaction-basic` 注册到 `ctx.compaction` |
| 不叫模型的剪枝 | `ctx.toolResultPruner` |
| 客人喊一声 | `/compact` → `compactNow`（挂在 `ctx.commands`） |
| 尺子 | `ctx.tokenMeter`（缝自己没有计价 API） |
| 过大输出落盘 | `ctx.spillStore`（**另一家族**，本课不读） |

不要把这几件事收成 `ctx.compact`。那个键不存在。

## 真正的代码路径

### 缝在 `packages/compaction/compaction`

`CompactionEngine` 继承 Cordis Service，构造里 super(ctx, compaction)，把 `ctx.compaction` 接到抽象类上。三个动词：

- `compactIfNeeded(agent, trigger, signal)` — 自动。trigger 只有 pressure 或 context-overflow。没有可压的安全范围就返回 null。
- `compactNow(agent, signal, sourceCommandId?)` — 空闲时显式压一段，哪怕还没到压力线。没有用处的范围不写盘。
- `compactRegion(start, end, agent, signal?)` — 按表层位置闭区间强制压。seq 被 replace 之后可以不再单调，所以 start 可以大于 end；权威集合是 `shadowedSeqs`。

两端必须工具调用与结果配对平衡：`toolPairingBalancedBefore` / `toolPairingBalancedAfter`。替换那张 user 消息必须带 `compactCheckpointSource(compactionId, sourceCommandId?)`，好让客户端不绑死后端也能认出检查点。

### 锁和表层是两套票

`packages/compaction/compaction/src/types.ts` 用 declare module 往 `SessionEventMap` 合并四种事件。注释写明它们是 log-only：记锁、摘要输入、影子价，不进表层。`SurfaceEventType` 有意不扩展。

- `compaction/start` 抢锁。turn 是数字 = 套在这轮自动压缩里；null = 轮次之间的手动事务。
- `compaction/summary` 安全摘要投影 + 被盖住的 range / seqs / token 数 + 模型信封。`llmStreamCall: true` 才表示走了本 ctx 的 `ctx.llm.stream()` 恰好一次。
- `compaction/end` 放锁。error 记录失败尝试。
- `compaction/prune` 一次无模型剪枝的影子价；紧跟着才追加那张替换后的 `tool/result`。

成功事务的顺序是：先 start，再做摘要，再 summary，再那张带 `surfaceOp` replace 的 `user/message`，最后才 end。崩溃变成可检测的孤儿锁，而不是一枚谎称做完的 end。比 `session/end-seed` 更早的未匹配 start 是上一世留下的陈旧证据，忽略。之后的未匹配 start 会让入口报 busy。

### 后端 `BasicCompactionEngine`

`dsh-compaction-basic` 实现这条缝。它要 `ctx.llm`、`ctx.tokenMeter`、`ctx.sessions`。默认策略：窗口的 `thresholdRatio` 0.8 处动手，近期表层按 `retainRatio` 0.16 逐字留着（与 `retainTokens` 互斥）。auto 默认 true 时挂两个 listener：串行 `agent/pre-step` 在派生请求前量压力；`agent/request-error` 在提供方确认窗口溢出后剪枝再做一次最大平衡头部缩减，只有 `surface.replaceGeneration` 前进才允许重试。

压力或规范溢出达标后，可选的 `ctx.toolResultPruner` 先改超大工具结果，再用 `ctx.tokenMeter` 重测。已经回到安全范围就跳过摘要。低于压力的步骤检查绝不剪枝。

摘要是一次独立的 `ctx.llm.stream()`，`GenerateOptions.purpose` 设成 compaction（DeepSeek 适配器会带 x-deepseek-harness-compact: 1），不走 agent loop 的 `agent/request`。它逐字回放被盖区域的系统提示词、工具和消息，最后追加压缩指令，好复用提供方 KV Cache。只有返回文本进入检查点；推理和工具调用都丢掉。检查点正文包在 `<compacted-summary>` 里。`compactNow()` 用 turn: null，先预留空闲接纳；摘要期间注入的上下文可以夹在 start/end 之间，位置替换之后它们还在。

### 剪枝 `ctx.toolResultPruner`

`dsh-compaction-tool-result-pruner` 不是压缩后端，也不是给模型的刀。Compact-basic 用 `ctx.get("toolResultPruner")` 读它，两个包可各自不装。

`pruneSession(session)` 扫当前表层快照。超预算的 `tool/result` 会再追加一条新的，带着 `surfaceOp` replace 指向 originalSeq，只改 content。原文仍在只追加日志里。默认 `thresholdChars` 8192，头 4096、尾 1024，中间固定标记 [... tool result middle pruned ...]。按 Unicode 码点切，不按 token，也不叫模型。

### 客人 /compact

`dsh-command-compact` 往 `ctx.commands` 注册全局 `/compact`，内部只调 `compactNow`。不接受参数。斜杠输入和直接结果都不进模型请求。没有可压历史就回 `No compactable history yet.`，不写标记。轮次占着时是 busy，命令本身不会排队。

`ManualCompactionErrorCode` 是 busy、cancelled、changed、summary、commit、persistence。changed 和 summary 表层不变，但失败尝试仍进日志。

## 对回论文

06 已经把 `session.append` 钉成排放。压缩追加的 compaction 事件和那张替换用的 `user/message` 同样是排放：写进去就越过可逆边界，卸插件收不回那一行。

表层 replace 改的是 `deriveMessages()` 看见的投影，不是把旧事件擦掉。被盖住的 seq 还在夹子里。这跟定理 73 静止状态等于最终配置不是一回事——排放已经出去了。

`ctx.compaction` 这个钩子仍是 acquisition（挂在纤程上，卸插件就从 ctx 拿走）。一次 compact 事务里的若干 append 又是排放。

论文没有 token 窗口、没有 `compacted-summary`、没有 `/compact`、没有 `ctx.toolResultPruner`。把压缩说成 Cordis 的时空组合，对不上。这是产品。

## 文档对不上的地方

- 课表直觉里的 `packages/core/compaction`、`ctx.compact`、根上的 `docs/compaction.md`、`packages/context/compaction`、`docs/subsystems/compaction-context.md`：404。真文档在 `docs/subsystems/compaction.md` 与 `compaction.zh.md`；家族在 `packages/compaction/`。
- slug compaction-context 容易让人去翻 `packages/context/`。那是另一套上下文组装，07 已经读过。本课读的是压缩缝。
- `packages/spill`（`ctx.spillStore`）也容易混进来：它把过大工具输出落到会话范围的文件里，换有界预览。剪枝是改表层文本；spill 是换存放地点。不是同一个 ctx 键。
- 压缩不是 agent-loop 脊椎的一节。没挂 `dsh-compaction-basic`，10 的循环照样转。
- 没有名为 compact 的 `ctx.tools` 刀。客人入口是 `ctx.commands` 上的 `/compact`。
- Agent Note .agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md 与 architecture/2026-06-13-capability-seams.md 家族 README 有引用。以源码为准。

## 下一篇读什么

本篇已经看到传菜口怎样换投影：无模型剪枝改超长工具回执，摘要用一张带 `compactCheckpointSource` 的 `user/message` 盖住较早范围，原始行仍在只追加夹子里。下一篇读 Web / client：这些 `session/event` 怎样接到浏览器那一头。先不要跳进 ACP、E2B 或 workflow。
