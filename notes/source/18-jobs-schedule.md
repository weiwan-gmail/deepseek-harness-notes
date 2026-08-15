# 18 · 后台任务与调度

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[17 storage-persistence](17-storage-persistence.md) · 下一篇：[19 compaction-context](19-compaction-context.md)

读的是 DeepSeek Harness 真正跑的那两套「现在还在炒」和「等会儿再响」的缝，不是自己再发明一套队列或 cron。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 钉住 | `master` @ `47f943859bef60e4160492346772ded9b24f765a`（`dsh@0.1.0-rc.5`；与 17 相同，已重核 HEAD） |
| Jobs 文档 | `docs/subsystems/jobs.zh.md`、`packages/jobs/README.zh.md` |
| Jobs 缝 | `packages/jobs/jobs`（`ctx.jobs`，抽象 `JobRegistry`） |
| Jobs 提供方 | `packages/jobs/jobs-local`（`LocalJobRegistry`） |
| Jobs 消费方 | `packages/jobs/tool-jobs`（`job_output` / `job_list` / `job_kill` + 完成通知） |
| Schedule 文档 | `docs/subsystems/schedule.zh.md`、`packages/schedule/README.zh.md` |
| Schedule 全家 | `packages/schedule/schedule` **仅此一家**；**没有** `ctx.schedule` |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§3.1 效应、§6.1 排放；**没有** jobs / schedule / reminder 对象 |

本篇钉子：08 已经把刀板读完。10 已经把一轮炒完。17 已经把小票怎样抄进保险柜读完。这里不把那三条再讲一遍。这里只读：**还在灶上的长菜怎样偷看 / 取消 / 等待 / 做完按铃**，以及 **这张桌子自己的小票上那张便利贴怎样到点再响——而且只在这桌还坐着的时候响**。

压缩留给 19。Web 客户端怎样接到 `session/event` 留给 20。

---

## 厨房：灶上那道长菜，和本桌小票上的便利贴

店里两件事都叫「过一会儿」，但不是同一口锅，也不是同一个 ctx 键。

- **灶上还在炖的那道菜是 jobs。** 火已经点着：bash 还在跑、侧档还在炒。这道菜挂在今晚的灶上，有工号 `bash-1`，可以揭盖看一眼、喊停、等到出锅。工号名册是 `ctx.jobs`。进程打烊，灶灭，这道菜没了——本地实现不进保险柜。
- **本桌点菜单上贴的便利贴是 schedule。** 不是第二口灶，也不是全店广播。纸条写进**这张桌子自己的小票**（`schedule/change`），到点了只在这桌还坐着、根档还在岗时，从同一本对话的 follow-up 队列再叫一声。冷桌不会响门铃；明早这桌重新坐下来，过期的条子才变成 overdue 再处理。这**不是**外部通知渠道。
- **不要收成同一个键。** jobs 有 `ctx.jobs`。schedule **有意不公开** Schedule service，**没有** `ctx.schedule`，也没有可变数据库。timer 是投影，权威是小票折叠。

| 厨房 | Harness |
|---|---|
| 长菜名册 | `ctx.jobs`（抽象 `JobRegistry`） |
| 今晚内存灶台 | `LocalJobRegistry`（进程内；记录不落盘） |
| 揭盖 / 列表 / 喊停 | `job_output`、`job_list`、`job_kill`（挂在 08 的 `ctx.tools`） |
| 出锅按铃 | `onJobDone`：忙则 `inject`，闲则默认 `followup` 叫醒 |
| 本桌便利贴 | 版本化 `schedule/change`，从 Session 日志 **fold** |
| 到点再叫一声 | 活根 Agent 的 `followup()`，再追加 `dispatch` |
| 冷桌 | 不跑 timer；`resume` 之后 overdue 才进同一对话 |

---

## Jobs：名册是缝，灶台是提供方，刀是消费方

出处：`packages/jobs/README.zh.md`。家族三包，形状跟 bash 那一套一样：约定 / 进程内实现 / 面向模型的刀。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `@deepseek-ai/dsh-jobs` | 任务注册表和生命周期约定 | `ctx.jobs` |
| `@deepseek-ai/dsh-jobs-local` | 进程本地注册表 | 注册到 `ctx.jobs` |
| `@deepseek-ai/dsh-tool-jobs` | 观察、取消、等待、完成通知 | 注册到 `ctx.tools` |

抽象缝自己不能上岗。出处：`packages/jobs/jobs/src/index.ts`。

```ts
export abstract class JobRegistry extends Service {
  constructor(ctx: Context) {
    if (new.target === JobRegistry) {
      throw new Error('@deepseek-ai/dsh-jobs is the abstract job registry seam; load an implementation such as @deepseek-ai/dsh-jobs-local instead')
    }
    super(ctx, 'jobs')
  }
  abstract start(spec: JobStart): JobId
  abstract list(caller?: Agent): JobSnapshot[]
  abstract get(id: JobId, caller?: Agent): JobSnapshot
  abstract read(id: JobId, caller?: Agent): JobRead
  abstract kill(id: JobId, caller?: Agent, reason?: string): 'requested' | 'already-finished'
  abstract wait(id: JobId, timeoutMs: number, caller?: Agent, signal?: AbortSignal): Promise<JobSnapshot>
  abstract onJobDone(listener: JobDoneListener): () => void
  abstract onJobsChanged(listener: JobsChangedListener): () => void
  abstract attachController(name: string): () => void
}
```

一个 context 只能挂一家实现；第二家抛错，这是 Cordis 的重复服务行为。`start` 在调用生产方 `run()` 之前做完预检；`run()` 一返回钩子，登记就不能再失败。生产方拥有执行资源，运行时拥有工号和生命周期。没有挂上控制器的 owner，`start` 直接拒——组合里没装 `dsh-tool-jobs`，就借不了别人的控制刀开后台活。

工号是品牌化 id，形状 `<kind>-N`，可预测，所以隔离靠授权不靠保密。有主的活按 owner 的 session id 围栏；无主的活谁都能看，活到服务 dispose。`JobKindMap` 目前声明 `bash` 和 `subagent`，插件用声明合并往上加；注册表把每个 kind 当不透明命名空间。

状态机是 `'running' | 'stopping' | 'completed' | 'killed' | 'failed'`。快照每次新建一份只读投影，从不把可变记录递出去。`reported` 压住重复的完成通知：kill / 终止读 / 等待 / teardown 取消都会占掉这一位。

进程内提供方是 `LocalJobRegistry`。出处：`packages/jobs/jobs-local/src/index.ts`。记录全在内存；`maxConcurrentJobsPerOwner` 默认 10，按**确切** owner 统计 `running` + `stopping`，无主的活另共用一个服务级桶。满了在 `run()` 和发号之前失败，不排队、不抢占。id 按 kind 递增：

```ts
const id = JobId(`${spec.kind}-${count}`)
```

登记活得比生产方 fiber、控制器 fiber 都长。owner 的第一份活会在那个确切 `Agent` 的 scope 上挂一个会被等待的 `jobs.ownerCleanup()`；拆掉这位厨师，取消他的活、等到停稳、拿掉快照。服务 dispose 取消全部存活记录。结算 first-wins：一条终止记录、释放等待方、一轮被兜住的监听器。完成通知排在最后，因为报告方可能同步开一轮模型。

面向模型的刀在 `dsh-tool-jobs`。出处：`packages/jobs/tool-jobs/src/index.ts`。`inject = ['tools', 'jobs', 'systemPrompt']`。加载时 `ctx.jobs.attachController('tool-jobs')`，并挂三段工具：

- `job_output(job_id, wait?, timeout_ms?)`：默认非阻塞读。流式只给下一截增量；最终输出类活在终止后给结果。`wait: true` 才走注册表的有界 `wait`（默认 30s，上限 10min）。没有单独的 `job_wait` 工具。
- `job_list()`：调用方看得见的活，一行 `<id> [<kind>] <status> — <label>`。
- `job_kill(job_id, reason?)`：立刻请求取消。

完成通知不是第四把刀。`onJobDone` 看到尚未 `reported` 且有主的结算，把 `background job <id> … Read its output with job_output.` 交给那位确切 owner：忙则 `inject` 进下一步 inbox，闲则默认 `followup` 叫醒。`completionDelivery: quiet` 让空闲也走注入。每个 owner 最多被叫醒 `maxConsecutiveWakes`（默认 3）轮，用户撰写的输入才补预算。

已知限制写在提供方 README：记录随进程消失；持久或跨重启执行要另做一家实现同一缝的后端。约定仍是进程内的：`JobStart.run()` 传入回调和确切 `Agent` 对象。

---

## Schedule：没有服务键，权威是这桌小票的 fold

出处：`packages/schedule/README.zh.md`。家族表只有一行：`schedule/`，ctx 键写明 **无**。本包有意不公开 Schedule service 或可变数据库。工具与 runtime 向 Session stream 追加事件；到期工作通过 Agent 的普通 follow-up 队列进入同一对话。

入口是函数插件，不是 Service。出处：`packages/schedule/schedule/src/index.ts`。

```ts
export const name = 'schedule'
export const inject = ['agents', 'sessions', 'tools', 'sessionPersistence']

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (stopping || runtimes.has(agent) || !ctx.agents.roots().includes(agent)) return
      const runtime = new ScheduleRuntime(ctx, agent)
      const cleanup: OwnerCleanup = agent.ctx.effect(() => {
        const disposeTools = registerScheduleTools(ctx, agent.ctx, agent, () => { runtime.requestDrive() })
        ...
        runtime.start()
        return async () => { /* 卸刀、停 timer，不删持久记录 */ }
      }, 'schedule.runtime()')
      runtimes.set(agent, cleanup)
    })
    return async () => { /* 取消对 agent/created 的监听，排空各桌 owner */ }
  }, 'schedule.lifecycle()')
}
```

只监听**之后**发布的根 Agent。加载时已经 live 的工位、运行时子 agent，都没有 Schedule。工具挂在那位根档自己的 `agent.ctx` 上，不是全局刀板。

持久形状声明合并进 06 的词汇表，不是另开一本账。出处：`packages/schedule/schedule/src/types.ts`。

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'schedule/change': ScheduleChange
  }
}
```

v1 变更是封闭联合：`create` 存完整记录，`delete` 和一次性 `dispatch` 只带 id，Every 的 `dispatch` 多一个墙钟 `acceptedAt`。记录三种：`after`（正整数秒延时）、`at`（绝对时刻）、`every`（固定间隔，下限 `MIN_EVERY_INTERVAL_SECONDS = 300`）。`ScheduleId` 在单会话内永不复用。`deliveryMode` 钉死 `'session-local'`。

活动视图不是另存一份可变表，是 fold。出处：`packages/schedule/schedule/src/domain.ts`。

```ts
export function foldScheduleEvents(
  events: readonly SessionEvent[],
  seedLength = 0,
): FoldedSchedules {
  for (const event of events.slice(seedLength)) {
    if (event.type !== 'schedule/change') continue
    const change = decodeScheduleChange(event.data)
    // create / delete / dispatch；未知版本、复用 id、对非活动记录动手都拒
  }
}
```

普通会话折完整日志。fork 只折 `seedLength` 及之后，**不**接管父桌还贴着的便利贴。timer、工具返回值、模型 follow-up 都是可丢弃投影。

管理刀三把，同样挂在 08 的 `ctx.tools`：`schedule_create`、`schedule_list`、`schedule_delete`。每次读或判断先等 `ctx.sessions.flush(session)`（17 那道结账栅栏的一句话指针）；create 和真正执行的 delete 追加后再等一次。barrier 失败返回 `persistence_uncertain`，不猜 eager write 有没有提交。一条按 Agent 串行的队列把管理事务和到期事务排好。

到点交付在 `ScheduleRuntime`。出处：`packages/schedule/schedule/src/runtime.ts`。进程内 owner 从 fold 算出最早目标，把超过 Node timer 范围的等待切开，每次醒来重读墙钟。到期的一次性优先，每次只进一个后续轮次；没有一次性到期时，所有 overdue 的 Every 合成一批，每条只贡献**最新一次**到期，不回放错过的间隔。获准入场的路径是：认领 `runMaintenance` → 构造 framing → 同步 `agent.followup(message)` → 再 `session.append('schedule/change', { operation: 'dispatch', … })`。绝不会 `steer()`，也绝不会打断当前轮次。framing 或入队失败不写 dispatch；队列准入后、持久 dispatch 前的狭窄窗口可能重复，文档写的是尽力而为的至少一次，不是恰好一次。

冷会话不执行任何工作。重新 live（17 的 `resume`）会重建 timer，已经过去的目标变成 overdue。这仍是同一桌对话，不是推送、不是邮箱、不是另一条总线。

---

## 对回论文

两套缝挂在纤程上的那部分，仍是 02：jobs 的 `attachController` / `onJobDone` / owner cleanup 是 effect-scoped；schedule 的 `schedule.lifecycle()` 和每桌 `schedule.runtime()` 卸掉就停 timer、撤刀，**不删**已经写进小票的记录。`ctx.jobs` 这个键是 acquisition。

`session.append('schedule/change', …)` 是 06 已经钉过的 §6.1 排放：写进去就越过可逆边界，卸插件收不回那一行。fold 只是把排放再读成活动视图。

论文没有 JobRegistry、没有 reminder、没有 `session-local` 交付、没有 `<kind>-N`。把 jobs 名册说成「效应演算」、把 schedule-in-session-log 说成 Cordis 的时空组合，都对不上。Jobs 注册表是产品。Schedule 写进会话日志也是产品。

---

## 文档对不上的地方

- `packages/core/jobs`、`packages/core/schedule`、根上的 `docs/jobs.md` / `docs/schedule.md`、`docs/subsystems/jobs-schedule.md`：**404**。真文档在 `docs/subsystems/{jobs,schedule}.{md,zh.md}`；家族在 `packages/jobs/` 与 `packages/schedule/`。
- `packages/schedule/schedule-local`、`packages/schedule/tool-schedule`、独立的 `ctx.schedule`：**不存在**。Schedule 全家只有 `packages/schedule/schedule`。工具直接 `ctx.tools.register`，状态从 Session 日志 fold。
- 课表把 jobs 与 schedule 收成一篇是对的，但它们不是同一个 ctx 键，也不是「后台队列」的两个后端。一个活在进程内存，一个活在这桌小票上。
- 没有名为 `job_wait` 的工具。等待是 `job_output(..., wait: true)` 走到 `JobRegistry.wait`。完成通知是 `onJobDone`，不是第四把控制刀。
- Agent Note `.agents/notes/implemented/architecture/{2026-06-20-generic-long-running-tool-runtime,2026-07-26-job-registry-seam}.md` **存在**；jobs 家族 README 指到它们。早期 runtime 注记把 `dsh-jobs` 写成同时拥有约定和实现，2026-07-26 那篇已经把缝拆成三包——以拆完后的源码为准。

---

## 下一篇读什么

本篇已经看到灶上的长菜怎样挂名册、怎样偷看和喊停，以及本桌小票上的便利贴怎样 fold、怎样只在这桌还坐着时再叫一声。下一篇读上下文压缩：小票太长时，投影怎样换一种看法，而不把原始行涂掉。先不要跳进 Web 客户端。
