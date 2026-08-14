# 16 · skills 与 MCP

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[15 subagents](15-subagents.md) · 下一篇：[17 storage-persistence](../source-curriculum.md)（待写）

读的是 DeepSeek Harness 真正跑的那两套「模型面前多出来的刀」：一份是菜谱卡片，一份是外请师傅自带的刀。不是自己再发明一套插件市场。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 钉住 | `master` @ `47f943859bef60e4160492346772ded9b24f765a`（`dsh@0.1.0-rc.5`；与 15 相同，已重核 HEAD） |
| Skill 文档 | `docs/subsystems/skills.zh.md`、`packages/skill/README.zh.md` |
| Skill 服务 | `packages/skill/skill/src/index.ts`（`ctx.skills`；**没有** `packages/core/skill`） |
| Skill 消费方 | `packages/skill/tool-skill`（面向模型的 `skill` 工具 + 目录消息） |
| MCP 家族 | `packages/mcp/README.zh.md`、`packages/mcp/mcp-client/{README.zh.md,src/index.ts}` |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§3.1 可逆效应；**没有** skill / MCP 对象 |

本篇钉子：08 已经把工具管线读成检查员 / 守卫 / 厨师 / 装盘。07 已经把提示词片段怎么拼进菜单读完。这里不把那两条再讲一遍。这里只读：**菜谱卡片从哪上架、模型怎样按需取正文**，以及 **外请师傅的刀怎样挂到同一块刀板上、卸插件刀怎样消失**。

持久化与会话恢复留给 17。

---

## 厨房：墙上的菜谱，和自带刀的外请师傅

店里本来就有一套常驻刀（bash、读盘、写盘）。今晚另外两件事会让菜单变长。

- **菜谱卡片不是刀。** 墙上挂着一叠 `SKILL.md`：名字、一两句「什么时候用」，正文先不贴进菜单。模型要点某张卡，才把整页说明夹进这一步。卡片可以来自本店文件夹、用户家目录、随包徽章，也可以运行时塞一张。重名时近的一层赢。
- **外请师傅自带刀。** 另一家店通过 MCP 协议把他们的刀借过来。挂上之后，模型看到的是普通工具，只是名字带了店号前缀 `mcp__github__create_issue`。卸掉这位师傅，他的刀整代撤走，不会留下半套。
- **两条缝都挂在纤程上。** 提供方登记是 `ctx.effect`。纤程卸掉，名册和刀板回到上一档。这是 02，不是论文里的「技能演算」。

不要把这两件事收成同一个 ctx 键。skill 有自己的 `ctx.skills`。MCP **没有** `ctx.mcp`：它直接往 08 的 `ctx.tools` 上 `register`。

| 厨房 | Harness |
|---|---|
| 菜谱名册 | `ctx.skills`（`SkillRegistry`） |
| 本地书架 | `dsh-skill-filesystem`（`.dsh/skills`、`.agents/skills`、用户目录……） |
| 按需取正文 | `dsh-tool-skill` 的 `skill({ name })` |
| 墙上目录 | 会话里一条 user-role 的 `<available_skills>`，只有 name + description |
| 外请师傅 | `@deepseek-ai/dsh-mcp-client` 每个实例连一台服务器 |
| 借来的刀 | `ctx.tools.register`，公开名 `mcp__<server>__<tool>` |

---

## Skill：目录在墙上，正文按需取

出处：`packages/skill/skill/src/index.ts`。服务注释把职责写死：本包只做提供方名册和胜出解析；卡片从哪来，是 `dsh-skill-filesystem` 那些提供方的事。

分层形状跟 08 的工具名册、12 的 scope 一样：登记落到调用方那一层；读的时候全局层加观察 scope 的链，近层同名直接赢，rank 只在单层内打破平局。

```ts
/**
 * Register a borrowed same-process provider synchronously during plugin
 * apply, into the calling context's layer ... Fiber disposal
 * unregisters the provider and invalidates catalog caches.
 */
registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void
```

`register()` 往调用方层塞一张运行时卡片，返回的也是同一类 disposer。同层重名 runtime 条目 first-wins，后来者拿到空操作 disposer，拆不掉赢家。

本地发现按 rank 扫根目录（数字越小越优先）：项目 `.dsh/skills` 是 100，`.agents/skills` 是 200，然后是自定义目录、用户目录，随包 bundled 是 600。名字必须是 kebab-case。目录只接受直属 `SKILL.md` 包或扁平 `.md`，不递归 `**/SKILL.md`。

模型并不把正文预加载进每一次请求。`dsh-tool-skill` 做两件事：

1. 在 `agent/pre-step` 看到第一份非空完整目录时，往会话里塞一条持久的 user-role 目录，里面只有排好序的 `name` 和截断过的 `description`。digest 变了再 `agent.inject()` 一条完整替换；删光了就塞一条空替换。不完整快照保住上一份能用的视图。
2. 面向模型的 `skill({ name })` 先按调用策略拒绝无权的卡，再按调用方 cwd 重读正文，返回 `<skill_content>` / `<skill_instructions>`。改正文不会改写墙上的目录，只影响下一次加载。

skill **不是**会话事件。词汇不在 core 里。目录消息一旦写入，就是 06 那种只追加小票；卡片文件本身仍在磁盘上，下次 `get()` 再读。

`skills/change` 是不带 diff 的失效铃：消费方用自己的查找选项重新 `snapshot()`。监听器失败不能否决名册改动。

---

## MCP：没有独立服务键，刀直接挂上刀板

`packages/mcp/README.zh.md` 全家只有一个包：`mcp-client`，「将外部服务器工具注册到 `ctx.tools`」。根上没有 `docs/subsystems/mcp.md`（404）。架构表的核心包也不列这项能力——它是可选缝，不是循环的一部分。

一个插件实例连一台服务器。`inject = ['tools']`。`apply` 是 async：激活会等到初次 `listTools()` 和登记结束，这样纤程变成 ACTIVE 时，刀已经在板上。

出处：`packages/mcp/mcp-client/src/index.ts`。

```ts
export const name = 'mcp-client'
export const inject = ['tools']

export async function apply(ctx: Context, config: Config): Promise<void> {
  ctx.effect(() => {
    // 占用 serverName；重复则本实例失败，先到的实例不动
    ...
  }, 'mcp-client.serverName')

  const connection = startConnection(ctx, config, reconnect)
  ctx.effect(() => {
    return () => connection.dispose()
  }, 'mcp-client.connection')

  const outcome = await connection.ready
  if (outcome.error !== undefined && config.failOnStartupError) {
    throw new Error(`mcp-client(${config.serverName}): initial connection or tool synchronization failed`, { cause: outcome.error })
  }
}
```

生命周期是 02：dispose 断开连接、注销这一代全部工具、释放 `serverName`。热替换等于拆掉旧实例再挂新的；`serverName` 不变，公开工具名就不变。

公开名是 `(serverName, rawName)` 的纯函数，形如 `mcp__github__create_issue`。发给服务器的仍是原始协议名。执行走 08 的同一条 pre / execute / post；桥只做 `client.callTool`。协议上的 resources / prompts **没有** harness 消费口，文档写明暂缓。

重连时上一世代的登记还在，对新世代登记冲突则整代回滚，不留半套刀。预算耗尽就注销工具、停止重连，直到热替换或重启。

---

## 对回论文

两套缝都是可逆效应：提供方和外连挂在纤程的 disposer 上，卸掉就回到上一档菜单。分层名册是 03 / 12 的 scope 链，不是新演算。

论文没有 skill、SKILL.md、MCP、`mcp__` 前缀。目录一旦 `inject` 进会话，就变成 06 的只追加排放；磁盘上的卡片和外连进程都不是 Σ。

---

## 文档对不上的地方

- `packages/core/skill`、`packages/core/mcp`、独立的 `ctx.mcp` 键：**不存在**。
- `docs/subsystems/mcp.md` / `mcp.zh.md`：**404**。这项能力只在 `packages/mcp/` 家族 README 和 `mcp-client` 包文档里。
- 架构「新行为」表把「添加面向模型的能力」写成在 `ctx.tools` 上注册——外连正是这条。skill 没有单独一行：它先走 `ctx.skills`，再由 `skill` 工具把正文变成一次工具结果。
- 外连只桥接 tools。资源和提示词没有消费口，不要从包名脑补「完整 MCP 主机」。

---

## 下一篇读什么

本篇已经看到菜谱卡片怎样上墙、正文怎样按需夹进这一步，以及外请师傅的刀怎样整代挂上、整代撤走。下一篇读持久化与会话恢复：小票怎样落到盘上、进程重启后怎样把灶重新点着。先不要跳进 jobs。
