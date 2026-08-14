# examples/ — 教学小品，不是上游源码

这些文件**刻意不复制** `cordiverse/cordis` 或 `deepseek-ai/deepseek-harness` 的实现。
它们用很短的 TypeScript 把论文三个概念讲清楚，方便对照根目录的 `analysis.md`。

| 文件 | 论文概念 | 生活 / Agent 类比 |
|---|---|---|
| [revertible-effect.ts](revertible-effect.ts) | 可逆效应；真实 API 是 `ctx.effect`；dispose **LIFO** | 厨房装咖啡机，拆走按反序恢复台面 |
| [reactive-coeffect.ts](reactive-coeffect.ts) | 反应式余效应；`classify`；`fiber.inject` | 没电就别冲；AgentLoop 五依赖齐了才 ACTIVE |
| [agent-turn.ts](agent-turn.ts) | 一次 toy turn 的只追加会话事件 | 用户一句话 → 流式回复 → 工具 → 结束 |

## 和真实运行时的对照（Table 2，不编造字段）

- 效应入口是 **`ctx.effect`**，不是这里的 `EffectStack.effect`。
- 余效应规格是 **`fiber.inject`**。`AgentLoop.static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']`。
- 累加器是 **`fiber.dispose`**，按反序跑。
- 已提交视图是 **`fiber.committed`**；飞行中的一步是 **`fiber.inertia`**。
- 会话日志是 §6.1 的 **emission（排放）**，不是论文里的 \(\Sigma\)。`append` 不能用 dispose 撤回。

教学代码删掉了异步 iterator、`armed` guard、epoch、isolate realm、waterfall / serial。不能当 polyfill，也不能拿去对拍上游测试。

## 可选运行

本目录不带 `node_modules/`（已写入根 `.gitignore`）。若本机有 Node：

```bash
npx --yes tsx examples/revertible-effect.ts
npx --yes tsx examples/reactive-coeffect.ts
npx --yes tsx examples/agent-turn.ts
```
