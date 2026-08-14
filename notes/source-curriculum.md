# 源码精读课表

对照 DeepSeek Harness 把 Cordis vendor 进仓库的真实源码，按主干顺序一篇一篇读。
本系列**不 clone** `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`；需要看的文件用 GitHub raw / API 单文件拉取。

状态：`pending` 未写 · `in_progress` 正在写 · `done` 已交稿（日期填交稿日）。
输出路径约定：`notes/source/NN-slug.md`。

## 主干（必须全部写完，系列才算结束）

| # | slug | 标题 | 状态 | 输出 | 日期 |
|---|---|---|---|---|---|
| 01 | cordis-context-fiber | Cordis 内核：Context 与 Fiber 生命周期 | done | [notes/source/01-cordis-context-fiber.md](source/01-cordis-context-fiber.md) | 2026-08-14 |
| 02 | revertible-effects | ctx.effect / dispose 后装先卸 | done | [notes/source/02-revertible-effects.md](source/02-revertible-effects.md) | 2026-08-14 |
| 03 | reactive-coeffects | inject / provide / refresh / committed | done | [notes/source/03-reactive-coeffects.md](source/03-reactive-coeffects.md) | 2026-08-14 |
| 04 | events | emit / waterfall / serial / parallel | done | [notes/source/04-events.md](source/04-events.md) | 2026-08-14 |
| 05 | boot-profiles-bundles | 启动、profile、bundle、patch | done | [notes/source/05-boot-profiles-bundles.md](source/05-boot-profiles-bundles.md) | 2026-08-14 |
| 06 | session-log | 只追加 SessionEvent 与 deriveMessages | done | [notes/source/06-session-log.md](source/06-session-log.md) | 2026-08-14 |
| 07 | system-prompt | 提示词片段与工具 schema 组装 | done | [notes/source/07-system-prompt.md](source/07-system-prompt.md) | 2026-08-14 |
| 08 | tools-pipeline | 工具注册表与 pre/execute/post 流水线 | pending | notes/source/08-tools-pipeline.md | |
| 09 | agent-registry | Agent 接口、工厂、活注册表 | pending | notes/source/09-agent-registry.md | |
| 10 | agent-loop | turn / step / inbox / 驱动器 | pending | notes/source/10-agent-loop.md | |
| 11 | llm-streaming | ctx.llm 适配器与流式 | pending | notes/source/11-llm-streaming.md | |
| 12 | agent-scope | 每个 agent 一根子纤程 | pending | notes/source/12-agent-scope.md | |
| 13 | fs-subprocess-sandbox | 文件系统、子进程、沙箱缝 | pending | notes/source/13-fs-subprocess-sandbox.md | |
| 14 | approval-guard | 审批、guard、策略 | pending | notes/source/14-approval-guard.md | |
| 15 | subagents | 子 agent 提供方 | pending | notes/source/15-subagents.md | |
| 16 | skills-mcp | skills 与 MCP | pending | notes/source/16-skills-mcp.md | |
| 17 | storage-persistence | 持久化与会话恢复 | pending | notes/source/17-storage-persistence.md | |
| 18 | jobs-schedule | 后台任务与调度 | pending | notes/source/18-jobs-schedule.md | |
| 19 | compaction-context | 上下文压缩 | pending | notes/source/19-compaction-context.md | |
| 20 | web-client | Web / client 如何接到 session/event | pending | notes/source/20-web-client.md | |

## 非主干 / 以后再说

本系列不覆盖：`acp`、`e2b`、`lsp`、`workflow`、`examples`、`test-support`。
它们是产品周边或测试支架，不是把「一切都是插件」这条主干读通所必需的。

## 读法

先读 01，再按编号往下。02–04 仍在 Cordis 内核（效应、余效应、事件）；05 起进入 Harness 自己的启动与产品缝。
论文记号只在源码对得上时引用，不另证定理。
