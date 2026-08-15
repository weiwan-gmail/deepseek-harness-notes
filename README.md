# DeepSeek Harness / Cordis 个人精读笔记

这是一份**个人学习仓库**，对照阅读论文

> *A Programming Paradigm for Spatiotemporal Composability*
> （一种面向时空可组合性的编程范式，2026-08-13 草稿，*preprint under active revision*）

并把形式对象映射到两个开源实现：

| 项目 | 角色 | 链接 |
|---|---|---|
| 论文仓库 | 2026-08-13 草稿 PDF | https://github.com/cordiverse/paper |
| Cordis | 论文的运行时（元框架） | https://github.com/cordiverse/cordis |
| DeepSeek Harness | 把 Cordis vendor 进仓库的 Agent 产品 | https://github.com/deepseek-ai/deepseek-harness |
| Harness 产品页 | 官方介绍 | https://www.deepseek.com/harness/en/ |

作者封面只印英文名 **Yifan Shi / Wei Zhang / Tianyi Cui**，单位 Peking University、DeepSeek-AI。中文名「史一帆 / 张伟 / 崔天一」是通行音译，**不是 PDF 原文**。

论文用 Koishi 做存在性案例（约 4 年、超过 4000 社区插件；当时宿主用 Cordis v3，论文写的是 v4），把「自我演化的 agent harness」标成动机与未来工作，**不是已完成评测**。本文不编造延迟、吞吐、准确率一类数字——论文也没有报告这些。

---

## 一句话

传统软件编译时拼好；插件和会自我改写的 Agent 运行时却要运行中装卸零件。论文把「拆掉一个部件，痕迹必须收回」（**时间可组合**）和「依赖要能声明、并跟着环境变」（**空间可组合**）做成运行时机制：可逆效应 + 反应式余效应，再收进同一个 Context。

厨房类比：装咖啡机，拆走必须恢复台面（时间）；没电就别冲、来电再自动工作（空间）。不能整间厨房断电重启。

---

## 目录

| 路径 | 内容 |
|---|---|
| [paper/](paper/) | 论文 PDF（`A-Programming-Paradigm-for-Spatiotemporal-Composability.pdf`）与 `pdftotext` 抽出的 `paper.txt` |
| [analysis.md](analysis.md) | 全文精读：生活类比 → 公式与定理 → Table 2 → Harness 对照 |
| [analysis-summary.md](analysis-summary.md) | 一页摘要 |
| [notes/process.md](notes/process.md) | **实际分析过程**：怎么找到论文、怎么对照源码、刻意排除了什么 |
| [examples/](examples/) | 教学小品，**不是** DeepSeek / Cordis 源码副本 |

`examples/` 三份 TypeScript 只演示论文概念：

1. 可逆效应（`effect` + dispose LIFO）
2. 反应式余效应（`activating` / `deactivating` / `neutral` + `inject`）
3. 一次 toy turn 的会话事件顺序

---

## 源码系列

按主干顺序对照 Harness vendor 的 Cordis / 产品源码精读（不 clone 上游）。

- 课表：[notes/source-curriculum.md](notes/source-curriculum.md)
- 01 · Context 与 Fiber：[notes/source/01-cordis-context-fiber.md](notes/source/01-cordis-context-fiber.md)
- 02 · ctx.effect / 后装先卸：[notes/source/02-revertible-effects.md](notes/source/02-revertible-effects.md)
- 03 · inject / provide / 反应式余效应：[notes/source/03-reactive-coeffects.md](notes/source/03-reactive-coeffects.md)
- 04 · emit / waterfall / serial / parallel：[notes/source/04-events.md](notes/source/04-events.md)
- 05 · 启动、profile、bundle、patch：[notes/source/05-boot-profiles-bundles.md](notes/source/05-boot-profiles-bundles.md)
- 06 · 只追加 SessionEvent 与 deriveMessages：[notes/source/06-session-log.md](notes/source/06-session-log.md)
- 07 · 提示词片段与工具 schema 组装：[notes/source/07-system-prompt.md](notes/source/07-system-prompt.md)
- 08 · 工具注册表与 pre/execute/post 流水线：[notes/source/08-tools-pipeline.md](notes/source/08-tools-pipeline.md)
- 09 · Agent 接口、工厂、活注册表：[notes/source/09-agent-registry.md](notes/source/09-agent-registry.md)
- 10 · Agent 循环、turn / step / inbox：[notes/source/10-agent-loop.md](notes/source/10-agent-loop.md)
- 11 · ctx.llm 适配器与流式：[notes/source/11-llm-streaming.md](notes/source/11-llm-streaming.md)
- 12 · 每个 agent 一根子纤程：[notes/source/12-agent-scope.md](notes/source/12-agent-scope.md)
- 13 · 文件系统、子进程、沙箱缝：[notes/source/13-fs-subprocess-sandbox.md](notes/source/13-fs-subprocess-sandbox.md)
- 14 · 审批、guard、策略：[notes/source/14-approval-guard.md](notes/source/14-approval-guard.md)
- 15 · 子 agent 提供方：[notes/source/15-subagents.md](notes/source/15-subagents.md)
- 16 · skills 与 MCP：[notes/source/16-skills-mcp.md](notes/source/16-skills-mcp.md)
- 17 · 持久化与会话恢复：[notes/source/17-storage-persistence.md](notes/source/17-storage-persistence.md)
- 18 · 后台任务与调度：[notes/source/18-jobs-schedule.md](notes/source/18-jobs-schedule.md)
- 19 · 上下文压缩：[notes/source/19-compaction-context.md](notes/source/19-compaction-context.md)
- 20 · Web / client 接到 session/event：[notes/source/20-web-client.md](notes/source/20-web-client.md)
- 补充 · Reflect / extend / isolate / intercept：[notes/source/reflect-extend-isolate.md](notes/source/reflect-extend-isolate.md)

## 版权与归属

- `paper/` 下的 PDF 及其文本抽取**属于原作者**，本仓库只作个人学习副本，不主张任何版权。
- 中文译名、作者中文名均为个人转写；若与作者自用写法冲突，以作者为准。
- `examples/` 为独立教学草稿，不复制上游源码树。
- 本仓库**不收录** `paper.b64`、Gmail 草稿残片、`create_draft_args.json`、密钥或完整上游 clone。
- DeepSeek Harness 仓库自称 developer preview；会话格式 `SESSION_FORMAT_VERSION = 0`。

论文仍在修订。若笔记与 PDF 冲突，以 PDF 为准。
