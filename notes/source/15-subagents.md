# 15 · 子 agent 提供方

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[14 approval-guard](14-approval-guard.md) · 下一篇：[16 skills-mcp](../source-curriculum.md)（待写）

读的是 DeepSeek Harness 真正跑的那份「把活派给另一位厨师」的缝，不是自己再发明一套多智能体演算。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 钉住 | `master` @ `47f943859bef60e4160492346772ded9b24f765a`（`dsh@0.1.0-rc.5`；与 14 相同，已重核 HEAD） |
| Harness 文档 | `docs/subsystems/subagent.zh.md`、`packages/subagent/README.zh.md` |
| 服务定义 | `packages/subagent/subagent/src/{index,types,child-agent}.ts`（**没有** `packages/core/subagent`） |
| 进程内提供方 | `packages/subagent/subagent-spawn-in-process/src/index.ts`（默认名 `spawn`） |
| 模型消费方 | `packages/subagent/tool-subagent/src/index.ts` |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§3 纤程嵌套；**没有** subagent / spawn / continuable 对象 |

本篇钉子：09 已经把主厨席和活名册读完。10 已经把一位厨师怎么炒一轮读完。12 已经把每位活 agent 一根子纤程读完。14 已经把人审钉成「一次签字、没有年卡」。这里不把那四条再讲一遍。这里只读：**第一位怎样雇第二位**、小孩有没有自己的小票、结果怎样送回来、拆掉父级时小孩怎样收干净。

skills / MCP 留给 16。后台 Task 怎么排队留给 18。

---

## 厨房：主厨把一道菜派给侧档

店里不止一位厨师。主档今晚忙不过来，把一道「查目录、写摘要」派给侧档。

- **侧档是另一位厨师，不是同一口锅再添一把勺。** 小孩有自己的工牌、自己的小厨房、自己的小票。店还是这家店，总灶还是那几条插座（13 的 `ctx.fs` / `ctx.subprocess` / `ctx.sandbox`）。
- **雇人走前台名册，不走主厨席。** 09 的 `ctx.agents.create` 才真正铸工位。本篇的 `ctx.subagents` 是一张**具名运输商名册**：今晚可以同时挂 `spawn`、`fork`、`acp`。点名哪一家，哪一家负责把小孩送到工位上。这和 11 的适配器名册一个形状，和 bash「全店只有一个执行器」不是一类。
- **两种派活。** 一次性：侧档做完这道就交卷，父档等结果（或丢进 18 才读的后台任务）。可续跑：侧档有自己的点菜单，父档以后还能再塞一张条子；交卷不是 `SubagentRun`，是继续执行经理手里那块工牌。
- **小孩不能自己拆篱笆。** 14 的人审对委派下来的小孩钉死 `'never'`：侧档权限在开工时就定了，想加宽只能回来说，让父档去问老板。
- **拆主档，侧档先收工。** 可续跑的森林按小孩优先释放；一次性 run 的持有人必须 `dispose`。卸掉运输商名牌，已经出门的跑腿不收回。

对应到 `dsh`：

| 厨房 | Harness |
|---|---|
| 运输商名册 | `ctx.subagents`（`SubagentRuntime`） |
| 挂一家运输商 | `registerProvider`：一笔 `ctx.effect` |
| 全新侧档 | `spawn`：`inheritsParentContext = false`，不看父档已完成的对话 |
| 带着菜单去的侧档 | `fork`：小孩会话用父档已完成回合做 seed |
| 雇人铸工位 | 进程内路径最终仍是 `ctx.agents.create` / `resume`（09、12） |
| 小孩小票 | 自己的 `Session`，`origin: 'subagent'`，`parentSession` 指向父档 |
| 一次性交卷 | `SubagentRun`：`result` + 必须 `dispose` |
| 可续跑侧档 | `startContinuable`：稳定的 child session id；经理拿着 `AgentHandle`，轮次走小孩自己的 inbox（10） |

---

## 名册，不是第二套循环

出处：`packages/subagent/subagent/src/index.ts`。

```ts
/**
 * Service Definition for the subagent capability seam (`ctx.subagents`): a named-provider registry plus a
 * capability-validating asynchronous start API.
 *
 * Unlike the bash seam (one executor per context, second load throws), MULTIPLE
 * providers coexist here: each registers under a unique name and a caller picks
 * one by name. The shape mirrors the LLM adapter registry
 * (`LlmRuntime.registerAdapter`), not the single-service bash executor.
 */
export class SubagentRuntime extends Service {
  private providers = new Map<string, SubagentProvider>()
  constructor(ctx: Context) {
    super(ctx, 'subagents')
    ctx.inject(['agents'], (childCtx: Context) => {
      const manager = new SubagentContinuationManager(childCtx, /* ... */)
      this.continuations = manager
      childCtx.effect(() => () => {
        if (this.continuations === manager) this.continuations = undefined
      }, 'subagents.continuationBinding()')
    })
  }
}
```

`inject ['agents']` 对回 03：名册自己可以先挂上，可续跑经理要等 09 的工厂席在岗。卸掉 `agents`，经理那根绑带按 LIFO 收回。

挂牌也是 02 的 `ctx.effect`。出处同一文件 `registerProvider`。

```ts
registerProvider(provider: SubagentProvider): () => void {
  const name = provider.name
  return this.ctx.effect(function* (this: SubagentRuntime) {
    if (this.providers.has(name)) {
      throw new SubagentError(`a subagent provider named "${name}" is already registered`, 'DUPLICATE_PROVIDER')
    }
    this.providers.set(name, provider)
    yield () => {
      this.providers.delete(name)
      this.emitLifecycle('subagent/provider-removed', name)
    }
    this.ctx.emit('subagent/provider-added', provider)
  }.bind(this), 'subagents.registerProvider()')
}
```

注释写明：摘牌挡住**新的** `start`，已经交到持有人手里的 run 不收回。`tool-subagent` 听 `subagent/provider-added` / `provider-removed` 才决定要不要把模型面前的那把委派刀挂上——运输商还没到岗，刀先不出现。

---

## 两种派活，两本账

提供方合同在 `packages/subagent/subagent/src/types.ts`。`inheritsParentContext` **只**描述小孩看不看父档已经写完的对话，不说工具、服务或审批权继承。

```ts
export interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
}
```

一次性：`SubagentRuntime.start(name, request)` 先按能力旗校验（缺旗是 `UNSUPPORTED_CAPABILITY`，不允许默默降级），再把描述符钉进请求，交给那家运输商的 `start()`。返回的 `SubagentRun` 有自己的 id（本地 run 必须等于小孩 session id）、可选的 `localAgent`、一份**不因小孩失败而 reject** 的 `result`（失败是 `stopReason: 'error'`），以及必须调用的 `dispose()`。

可续跑：`prepareContinuable` 方法在不在，就是能力在不在。有它的提供方只交一份**数据**：要不要把父档历史当 seed。身份预留、铸工位、投递初始提示、冷恢复、所有权、拆除，全是继续执行经理的事。提供方再也看不见小孩的 `Agent`、工牌或回合。`startContinuable` 在小孩 inbox **收下**那条初始提示时就 resolve（`{ childId, messageId }`），不等回合开炒，也不等小票落盘；此前任何失败两个 id 都不给，已经铸出的工牌整段回滚。

`spawn` 这家运输商把对比写进源码。出处：`packages/subagent/subagent-spawn-in-process/src/index.ts`。

```ts
class SpawnInProcessProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    outputSchema: true, depthLimit: true, toolFilter: true, persona: true,
  }
  // Context contract: a spawned child starts fresh — it never sees the parent conversation.
  readonly inheritsParentContext = false
  start(request: ResolvedSubagentStartRequest) {
    return startInProcessRun(request, {})
  }
  prepareContinuable(): Promise<ContinuableCreateSpec> {
    return Promise.resolve({})
  }
}
```

家族 README 还列了 `fork`（带着父档已完成历史去）、以及 ACP / Codex / Claude Code / dsh-sdk 这些进程外后端。本系列主干只需要看清：前台点的是**名字**，循环包仍然是 09–10 那一套；进程外后端是另一种运输，不是第二套 Agent 接口。

模型面前的刀是另一张插件：`dsh-tool-subagent`。它 `inject` 的是 `tools` + `subagents` + `systemPrompt`，配置里写死委派给哪个 provider 名。前台一次性默认等结果，收齐后 `run.dispose()`；`backgroundMode: 'continuable'` 则默认后台，立刻返回耐久的 `subagentId`。没有 `exec.agent` 就拒绝——非 agent 调用方没有父档，雇不了人。

---

## 小孩是另一根纤程，另一本小票

进程内小孩不是「父档 ctx 上再挂几个工具」。`child-agent.ts` 把铸工位的材料收成一处，供一次性驱动器和可续跑经理共用。

深度：`delegationDepthOf(parent) + 1`，可选 `maxDepth` 超了就 `SubagentDepthError`。恢复后的父档不能假装自己是顶层再往下派。

小票头：`childSessionMeta` 写入 `parentSession`、`origin: 'subagent'`、`delegationDepth`，cwd 从父档 header 抄来。`origin` 只给列表分类用，能不能恢复、模式是一次性还是可续跑，权威仍是小孩日志里的 `subagent/descriptor`。

工位布置：`applyChildComposition` 在小孩自己的 `childCtx` 上加入父档 preset、登记一句「你是委派下来的，权限不能从里面加宽」，再挂上可选的 persona / `tools.restrict`。这些登记跟 12 的小厨房走：父档和兄弟姐妹看不见。

策略播种对回 14。出处同一文件 `captureDelegatedPolicyOverrides`：

```ts
export function captureDelegatedPolicyOverrides(parent: Agent): DelegatedPolicyOverrides {
  return {
    sandboxMode: parent.ctx.get('sandboxPolicy')?.overrideOf(parent.session),
    approvalPolicy: parent.ctx.get('approval') === undefined ? undefined : 'never',
  }
}
```

只抄父档会话上**显式**的沙箱覆盖，不抄部署默认，也不抄某一道菜的一次性特批。审批一律钉成 `'never'`：小孩问了也拒。这两笔以 `source: 'delegation'` 追加进小孩自己的日志，冷恢复只读这本小票就能重建篱笆。

可续跑的所有权图：每个 Activation 拿着一块 `AgentHandle` 和一份 `ownedChildren`。父档只要还挂着没拆完的小孩，自己就 settle 不了。经理拆林子是小孩优先、自顶向下取消；持久化的子会话不随这次进程内拆卸消失。一次性路径没有 Activation，交卷靠持有人 `dispose`。

跟 09 的 `FactoryOwnership` 不要混：卸掉循环插件会排干**所有**活灶；本篇卸掉的是某一家运输商，只挡住新派活。拆掉**某一位父档**，收的是它名下那片侧档森林。

---

## 对回论文

论文的纤程可以有子纤程，效应栈后装先卸。进程内小孩是循环纤程下再铸一根（12），挂在小孩 `agent.ctx` 上的刀随工位走，这与 §3.1 一致。

论文没有「子 agent」「spawn」「continuable」这些对象。会话小票仍是 06 的只追加排放；`subagent/descriptor` 不进模型历史。审批钉 `'never'` 是产品策略，不是余效应拦截（14 已经说过，那不是 `ctx.intercept`）。

---

## 文档对不上的地方

- 课表直觉里的 `packages/core/subagent`、根上的 `docs/subagent.md`：**404**。真服务在 `packages/subagent/subagent`，文档在 `docs/subsystems/subagent.{md,zh.md}`。
- 家族 README 把共享驱动器写成 `subagent-inprocess/`，目录实际是 `subagent-in-process-driver/`。
- `docs/subsystems/subagent.zh.md` 很长，把列表投影、report 通道、interrupt 权威都写进同一页。本篇只钉雇人、两本账、小孩小票和拆除顺序；`list_agents` / `send_message` / `report` 是可选控制刀，不在主干必读路径上。
- 进程外提供方（ACP、Codex、Claude Code、dsh-sdk）在家族表里，本系列把 ACP 标成非主干。它们证明运输商名册可以挂多家，不改 `Agent` 工牌。

---

## 下一篇读什么

本篇已经看到第一位怎样点名一家运输商雇第二位、小孩怎样另开小票、篱笆怎样在开工时钉死、拆父档时侧档怎样先收工。下一篇读 skills 与 MCP：模型面前又多出来的那些刀，从哪登记、跟 08 的工具管线怎么接。先不要跳进持久化恢复。
