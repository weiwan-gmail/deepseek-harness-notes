# 分析过程（实际做过的事）

本文记录这次精读**真正走的路径**，不是理想化的「应该怎么读」。对照成品见仓库根目录的 `analysis.md` / `analysis-summary.md`。日期：2026-08-14。

没有 `git clone` 任何上游仓库。没有把 PDF 编成 base64，也没有往仓库里塞 Gmail 草稿。

---

## 1. 论文是怎么找到的

入口是 **DeepSeek Harness** 的公开 README（https://github.com/deepseek-ai/deepseek-harness），不是 arXiv 检索。

README / 文档把运行时骨架指到 **Cordis**（vendor 进仓库的插件框架），Cordis 一侧再指到形式论文：

- 论文仓库：https://github.com/cordiverse/paper
- 实现仓库：https://github.com/cordiverse/cordis
- 产品页：https://www.deepseek.com/harness/en/

关系是间接的，精读时要记住，不要说「Harness 仓库附带了论文」：

```
Harness README  →  vendored Cordis  →  论文 Table 2
论文案例        →  Koishi（不是 dsh）
论文 §8         →  自我演化 agent harness = 未来工作
```

封面元信息（只记 PDF 上有的）：

| 项 | 内容 |
|---|---|
| 标题 | A Programming Paradigm for Spatiotemporal Composability |
| 日期 | 2026-08-13 草稿；GitHub 声明 *preprint under active revision* |
| 作者 | Yifan Shi、Wei Zhang、Tianyi Cui |
| 单位 | Peking University、DeepSeek-AI |
| 页数 | 88 页（`pdfinfo`）；正文 8 节 + References |

中文名「史一帆 / 张伟 / 崔天一」是音译，封面没有汉字。

---

## 2. 正文怎么拿到（curl + pdftotext，不 clone）

论文 PDF 用 HTTP 直链拉下来，**没有** `git clone github.com/cordiverse/paper`：

```bash
curl -fsSL -o paper.pdf \
  https://github.com/cordiverse/paper/raw/main/paper.pdf
pdftotext -layout paper.pdf paper.txt
pdfinfo paper.pdf
```

本仓库里的副本：

- `paper/A-Programming-Paradigm-for-Spatiotemporal-Composability.pdf`
- `paper/paper.txt`（`pdftotext` 抽取；部分花体字母会乱码，精读时对照 PDF，不在乱码处编造公式）

没有把 PDF 编成 `paper.b64`，也没有按 Gmail / 邮件附件的分块方式传输。

---

## 3. 源码怎么对照（GitHub API / raw，不 clone）

Cordis 与 Harness 都**没有**整树 clone。需要看的文件用 GitHub raw / API 单文件拉取，对照论文 Table 2 与 Algorithm 1–5。

Cordis（`cordiverse/cordis`，`packages/core/src/`）：

| 文件 | 对照什么 |
|---|---|
| `context.ts` | `ctx`、isolate / intercept、Proxy |
| `fiber.ts` | Fiber、`effect`、`dispose`（反序）、`inject`、`committed`、`target`、`inertia`、`_reload` / `_unload` |
| `events.ts` | emit / parallel / serial / waterfall / bail；`on` 走 `fiber.effect` |

DeepSeek Harness（`deepseek-ai/deepseek-harness`）：

| 文件 | 对照什么 |
|---|---|
| `packages/core/agent-loop/src/index.ts` | `AgentLoop`、`static inject`、两处 `ctx.effect` |
| `packages/core/agent-loop/src/agent.ts` | `ReactLoopAgent`、turn / step / inbox |
| `packages/core/agent-loop/src/tool-calls.ts` | `executeToolCalls`；先记 `tool/call` 再跑 |
| `packages/core/tools/src/index.ts` | `ToolRuntime`；登记走 `ctx.effect` |
| `packages/core/session/src/types.ts` | `SessionEventMap` |
| `packages/core/session/src/index.ts` | 只追加日志 |
| `packages/core/scope/src/index.ts` | 每 agent 一根子纤程 |
| `docs/architecture.md` 等 | 产品骨架；**读论文不能代替读这份** |
| `vendor/README.md` | cordis 钉在 4.0.0-rc.7；可重入处置等本地补丁 |

单文件 raw 形如：

```
https://raw.githubusercontent.com/cordiverse/cordis/master/packages/core/src/fiber.ts
https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/agent-loop/src/index.ts
```

（默认分支名以当时 GitHub API 返回为准；精读记录的是文件内容，不是某次 commit SHA。）

---

## 4. 关键 Table 2 映射（只记用得上的几行）

论文 Table 2 把形式对象接到 Cordis 运行时。精读时反复用到的是：

| 理论 | 实现 | 精读时怎么用 |
|---|---|---|
| \(\Gamma_\infty\) | `ctx` | 一等上下文；Harness 的 `ctx.tools` / `ctx.llm` / `ctx.sessions` 都挂在这棵树上 |
| \(\mathrm{effect}_\Gamma(e)\) | `ctx.effect(callback)` | **可逆效应的唯一入口**。回调交出左逆；运行时**不检查**逆是否真能恢复 |
| 纤程 \(\langle d,p,e,\ldots\rangle\) | `fiber` | 部件的一次实例化 |
| \(d\) | `fiber.inject` | 余效应规格。不齐 → 不 ACTIVE |
| 累加器 \(g\) | `fiber.dispose` | 逆按 **LIFO** 跑（后登记的先撤） |
| \(\omega\) | `fiber.committed` | 激活时看到的那份依赖视图；拆的时候读视图不读现表 |
| Future / 惯性 | `fiber.inertia` | 飞行中的一步必须落地，不能中途拒收 |

其余行（`fiber.uid` / `fiber.apply` / `fiber.target` / `ctx.use` …）见 `analysis.md` 的完整照录。不要把 Algorithm 1–10 当成 `vendor/cordis` 的逐行注释：产品补了可重入处置、事务性调和、HMR。

`AgentLoop` 源码里最直接的对照（教学转写，不是文件副本）：

```
static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']
ctx.effect(() => () => this.ownership.dispose(), ...)
ctx.effect(() => ctx.agents.setFactory(this), ...)
```

`static inject` 就是 \(d\)；两处 `ctx.effect` 分别登记拆除与工厂提供。

---

## 5. Turn 骨架（会话日志顺序）

一次 turn ≠ 论文里的 Sigma。会话日志是只追加、跨重启仍在、**不能**用 `dispose` 撤回的事实流，更接近 §6.1 的 emission（排放）。

架构文档 + `ReactLoopAgent` 的真实骨架比教学例子长：

```
followup → send → wakeDriver → kick → turn
  session.append(turn/start)
  claim 输入 → assemble 提示词与工具 schema
  agent/pre-step（waterfall：reject 或 enter）
  session.append(step/start)
  session.append(user/message)
  deriveMessages → agent/request → llm.stream
  session.append(assistant/chunk)*
  session.append(assistant/message)
  executeToolCalls:
    session.append(tool/call)    ← 先记再跑
    tools/pre-execute → execute → post-execute
    session.append(tool/result)
  session.append(step/end)
  （若还欠模型请求 → 下一步）
  agent/turn-stopping（serial）
  session.append(turn/end)
```

`examples/agent-turn.ts` 把这条链收成教学顺序：

`turn/start → user/message → assistant/chunk → assistant/message → tool/call → tool/result → turn/end`

不把 `step/*`、`agent/*`、`tools/*` 写进玩具日志，以免读者以为那也是 SessionEvent 的最小核。最小核以 `SessionEventMap` 为准；玩具只演示「模型可见即已记录」的排放顺序。

---

## 6. 刻意排除了什么

| 排除 | 原因 |
|---|---|
| `paper.b64`、`b64-chunks/` | 学习仓库要的是 PDF / 文本，不要邮件附件编码 |
| `create_draft_args.json`、Gmail 草稿残片 | 与论文无关的工具中间态 |
| 完整 `cordiverse/cordis`、`deepseek-ai/deepseek-harness` 树 | 不 clone；对照用 raw。`examples/` 是教学草稿，不是上游副本 |
| `.env`、凭据、token、cookie | 本次只读公开 HTTP / API，仓库不收秘密 |
| 论文未给出的评测数字 | 不编造延迟 / 吞吐 / 准确率 |
| 「Harness 已经实现自我演化」 | 论文 §8 标成未来工作 |

`.gitignore` 把 `*.b64`、`create_draft_args.json`、`b64-chunks/` 写死，避免以后误提交。

---

## 7. 局限（读的时候就要记住）

**论文自己划的边界**

- 逆的见证不由运行时检查（§5.1.1）。交错的 `dispose` 是作者 bug。
- 系统边界（§6.1）：写出共享文件、打到网络是 emission；句柄可逆，推出去的数据不可逆。
- 先于关系无环是假设（定理 66 / 73）。环让相关部件永远 Inactive。
- 合流排除失败（定理 73）。失败纤程对外贡献为零，但是真分叉。
- Koishi 是存在性证据，不是对照实验；**没有**延迟 / 内存 / 吞吐数字。
- Agent harness 是动机和未来工作，不是已完成评测。

**论文标成开放问题（§6.5、§8）**

更丰富的余效应规格、静态分析、跨进程 / 分布式、量化开销、自我演化的 agent harness。

**Harness 仓库自己写的现状**

developer preview；`SESSION_FORMAT_VERSION = 0`；`docs/` 是内部设计笔记。连接是间接的：Harness → vendored Cordis → Table 2；论文案例是 Koishi 不是 dsh。

**这次方法自己的局限**

- 单文件 raw，没有固定 commit SHA，上游一改，对照就会漂。
- `pdftotext` 会弄乱花体字母；公式以 PDF 为准。
- 没跑 Koishi，也没跑 dsh；生命周期结论来自论文 + 公开源码阅读，不是动态 trace。
- 教学例子把异步、`armed` guard、epoch、isolate realm 都删了，不能拿去当 polyfill。

草稿写于 2026-08-14。论文仍在修订；冲突以 PDF 为准。
