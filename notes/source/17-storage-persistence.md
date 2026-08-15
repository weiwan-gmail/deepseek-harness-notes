# 17 · 持久化与会话恢复

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[16 skills-mcp](16-skills-mcp.md) · 下一篇：[18 jobs-schedule](../source-curriculum.md)（待写）

读的是 DeepSeek Harness 真正跑的那份「小票怎样落到盘上、灶怎样重新点着」的缝，不是自己再发明一套数据库。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 钉住 | `master` @ `47f943859bef60e4160492346772ded9b24f765a`（`dsh@0.1.0-rc.5`；与 16 相同，已重核 HEAD） |
| Harness 文档 | `docs/subsystems/{persistence,session,storage}.zh.md` |
| 内存账本 | `packages/core/session/src/{index,types,repair}.ts`（`ctx.sessions`；**没有** `packages/core/persistence`） |
| 持久化抽象缝 | `packages/session/session-persistence/src/{index,coordinator,write-behind}.ts`（`ctx.sessionPersistence`） |
| 后端 | `packages/session/session-persistence-jsonl`、`packages/session/session-persistence-sqlite` |
| 恢复入口 | `packages/core/agent/src/index.ts` 的 `ctx.agents.resume`；工厂在 `packages/core/agent-loop/src/index.ts` |
| 非会话 KV | `packages/storage/`（`ctx.storage`；课表 slug 里的 storage **不是**这个家族） |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§6.1 排放；**没有** persistence / resume / JSONL 对象 |

本篇钉子：06 已经把只追加小票和 `deriveMessages` 读完。09–10 已经把工位和一轮炒完。这里不把那三条再讲一遍。这里只读：**内存账本怎样被抄进保险柜**、**冷启动怎样把灶重新点着**、**崩溃留下的半成品怎样收口而不撕掉**。

后台任务怎么排队留给 18。Web 客户端怎样接到 `session/event` 留给 20。

---

## 厨房：今晚的点菜单，和保险柜里的账本

店打烊不等于账没了。今晚柜台上那本点菜单是活的；保险柜里那叠才过得了明天早上。

- **柜台账本是内存。** `ctx.sessions` 是今晚的点菜单夹。厨师往上追加一行，立刻就能再读。进程一停，夹子空了。持久化**不是**这个服务自己做的。
- **书记员订铃、不挡灶。** 每记一行，柜台按铃 `session/event`。书记员抄一张副本丢进待装订的盒子，**不让厨师等装订**。老板喊「先把账结了再接下桌」才响 `session/flush`。
- **封面不是小票。** 格式版本、cwd、血统、种子边界写在文件夹封面 `SessionHeader` 上，不进 `SessionEventMap`，模型也看不见。
- **对讲机不是账。** `agent/pre-step`、`agent/created` 这类 `agent/*` 是厨房对讲机：卸班、重启就没了。能过明天的只有小票本身。
- **粮仓账是另一本。** 课表 slug 叫 `storage-persistence`，但 `ctx.storage` 管的是**非会话**应用数据（设置、领域 KV）。会话小票走 `ctx.sessionPersistence`。本篇只提一次，免得两本账混成一个 ctx 键。

| 厨房 | Harness |
|---|---|
| 今晚的点菜单夹 | `ctx.sessions`（内存 `SessionStore`） |
| 一行小票 | `SessionEvent`（只追加；热路径不挡 I/O） |
| 文件夹封面 | `SessionHeader`（日志旁边，不进词汇表） |
| 按铃抄账 | Cordis `session/event`（提交后、即发即忘） |
| 结账栅栏 | Cordis `session/flush`（parallel，等耐久） |
| 保险柜抽象缝 | `ctx.sessionPersistence` |
| 两种柜子 | JSONL 一会话一文件；SQLite 一行一事 |
| 明早点灶 | `ctx.agents.resume({ resumeSessionId })`，先 `sessionPersistence.prepare` |
| 冷早发现半成品 | 合成 `turn/end { kind: 'interrupted' }`，**只在冷加载** |
| 粮仓账 | `ctx.storage`（另一家族，不写会话） |

---

## 内存夹子，保险柜是订户

出处：`packages/core/session/src/index.ts`。模块第一句和 `SessionStore` 注释把职责写死：

```ts
/**
 * Event-sourced session service: append-only session log, in-memory store, and
 * the derived LLM message history. Persistence is a plugin concern (subscribe
 * to `session/event`, drain on `session/flush`).
 */

/**
 * In-memory session store (`ctx.sessions`).
 *
 * Persistence is intentionally not implemented here — persistence plugins
 * subscribe to `session/event` and flush on `session/flush` / dispose.
 */
```

`append` 的热路径注释原话：The hot path never blocks on I/O — persistence plugins buffer asynchronously. 一行进了内存日志，这次追加就提交了；订户失败记日志、兜住，不改返回值，也不挡住后面的订户看见同一行。

第一方后端共用 `PersistenceCoordinator.installWritePath()`。出处：`packages/session/session-persistence/src/coordinator.ts`。

```ts
ctx.on('session/event', (session, event) => {
  const live = this.initFor(session)
  live.writes.enqueue(event)
})
ctx.on('session/flush', session => this.flush(session))
```

`enqueue` 把冻结事件 `structuredClone` 进持久化自有队列；第一个待办开启固定窗口（默认 200ms），后续事件加入但**不重置**截止。窗口到了才写盘。`session/flush` 取消等待、排空到停稳。后台写失败保留批次、暂停自动重试；显式 flush 立刻再试。dispose 做同样的最终排空。

构造种子（恢复、fork、回放带进来的那些行）**不**发 `session/event`。协调器在 `session/created` 时把种子一次性持久化；恢复路径只追加 `firstLiveSeq` 之后的后缀，不会把已落盘的前缀再写一遍。

抽象缝是 `ctx.sessionPersistence`，不是第二套事件类型。出处：`packages/session/session-persistence/src/index.ts`。后端实现 locate / create / append / prepare / load / inspect / readFrom / list。两家提供方：

- `dsh-session-persistence-jsonl`：每会话一份只追加 JSONL（默认 `.jsonl.zstd`）；`locate` 给绝对路径。
- `dsh-session-persistence-sqlite`：每条 `SessionEvent` 一行；共享一个库，`locate` 返回 `undefined`。

都是延迟实体化：`create` 可以不写盘，第一次 `append` 才出现在 `list` 里。没有删除接口。

---

## 封面在夹子外头；版本钉死 0

出处：`packages/core/session/src/types.ts`。

```ts
/**
 * The on-disk session format version, stamped into every newly-written SessionHeader
 * and enforced by every persistence backend on load.
 * While the harness is unreleased it is pinned at `0`: no compatibility is
 * implied, incompatible logs are rejected, and no migration is provided.
 */
export const SESSION_FORMAT_VERSION = 0
```

header 的 `version` 对不上就拒：更新的 harness 写的，请升级；更旧的，本构建没有升级路径。损坏是 `SessionPersistenceCorruptionError`；读不懂但文件还在是 `SessionFormatUnsupportedError`。

`SessionHeader` 注释原话：Immutable validated storage metadata, kept outside the conversation event log。字段是 version、id、createdAt、cwd、parentSession、seedLength、origin、delegationDepth、agentPreset。这些不进 `deriveMessages()`。血缘和委托深度必须过重启——只放运行时，恢复后的小孩会假装自己是顶层。

同一格式版本里，有几条**范围受限的读取期形状归一**（旧消息补 id、旧 `turn/start` 去掉 trigger）。这不是通用 v0 迁移承诺。存储仍然只追加：读不改写旧行。

---

## 冷早收口，热灶不盖章

崩溃可以留下一个已打开的 `turn/start` 却没有 `turn/end`。后端**不截断**已提交的长轮次。`interruptedTurnClosers` 补上缺的 `tool/result`（`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN`）、可选 `step/end`，最后一条合成 `turn/end { reason: { kind: 'interrupted' } }`。出处：`packages/core/session/src/repair.ts`。循环从不发出 `interrupted`——这是唯一不是 loop 写的 `TurnEndReason`。

只对**冷**会话落盘。`load` 遇到活 id：先等权威内存快照 flush 完，日志已经平衡才返回；活轮次还开着就拒绝，不盖中断章。HMR 接管活前缀，截撕裂尾、不关正在炒的那一轮。`inspect` 可以在内存里配平，但不提交修复、不发布。

---

## 点灶：prepare 之后 resume

回放/fork 活会话走 `ctx.sessions.create(id, { seed })`。把**持久化**会话恢复成活 agent，走 `ctx.agents.resume({ resumeSessionId })`。工厂注释原话：先 `ctx.sessionPersistence.prepare`，再铸未发布的工位。出处：`packages/core/agent/src/index.ts` 的 `ResumeAgentOptions`；实现在 `packages/core/agent-loop/src/index.ts` 的 `resumeWith`。

```ts
async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
  const persistence = this.runtime.ctx.get('sessionPersistence')
  if (persistence === undefined) {
    throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
  }
  return this.resumeWith(ownerCtx, persistence, options)
}
```

`prepare` 预留那份未发布 Session，提交待处理的冷修复，返回可 dispose 的句柄；发布失败整段回滚。`session/end-seed` 标出构造种子到此结束；种子已有这条就不会每开一次就再追加。

对讲机 `agent/*`（`agent/created`、`agent/session-start`、`agent/pre-step`……）仍是 04 的 Cordis 事件：活的、可拆走、不进保险柜。持久化订的是 `session/event` 这条已经提交的小票铃。

---

## 对回论文

06 已经把 `session.append` 钉成 §6.1 的排放。本篇的保险柜是排放的**抄本**：订户把已经离开可逆边界的事实再写到盘上。`ctx.sessionPersistence` 这个钩子仍是 acquisition（挂在纤程上，卸插件就从 `ctx` 拿走）；一次 `appendBatch` / `commitRepair` 又是排放。

合成 `interrupted` 是再追加一行，不是擦掉崩溃前的行。定理 73 保证静止状态等于最终配置，不保证沿途排放没发出去。

论文没有 JSONL、SQLite、`resumeSessionId`、`SESSION_FORMAT_VERSION`。`ctx.storage` 更是产品里的另一本粮仓账，不在论文对象里。

---

## 文档对不上的地方

- 课表直觉里的 `packages/core/persistence`、`packages/core/storage`、根上的 `docs/persistence.md` / `docs/storage.md`、`docs/subsystems/session-persistence.md`：**404**。会话持久化文档在 `docs/subsystems/persistence.{md,zh.md}`；内存会话在 `docs/subsystems/session.{md,zh.md}`；非会话 KV 在 `docs/subsystems/storage.{md,zh.md}`。
- 架构里 `ctx.sessions` 是内存店。磁盘能力是可选缝 `ctx.sessionPersistence`，要另挂 jsonl 或 sqlite 提供方。
- slug `storage-persistence` 容易让人去翻 `ctx.storage`。那条缝明确写着「持久保存一切不属于会话事件日志的数据」。本课读的是会话保险柜。
- 同格式版本的旧形状归一不是迁移器。`SESSION_FORMAT_VERSION` 仍是 0，没有升级链。

---

## 下一篇读什么

本篇已经看到内存夹子怎样被书记员异步抄进保险柜、封面为什么不进小票、冷早怎样给半成品盖 `interrupted`、明早怎样 `prepare` 再 `resume`。下一篇读后台任务与调度：活做完这一桌之后，怎样把活排到以后再炒。先不要跳进压缩或 Web 客户端。
