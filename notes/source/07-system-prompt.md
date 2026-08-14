# 07 · 提示词片段与工具 schema 组装

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[06 session-log](06-session-log.md) · 下一篇：[08 tools-pipeline](../source-curriculum.md)（待写）

读的是 DeepSeek Harness 真正跑的那份系统提示词注册表，不是自己再发明一套词。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 钉住 | `master` @ `47f943859bef60e4160492346772ded9b24f765a`（`dsh@0.1.0-rc.5`） |
| Harness 文档 | `docs/architecture.md`、`docs/architecture.zh.md`、`docs/subsystems/system-prompt.md`、`docs/subsystems/system-prompt.zh.md`、`packages/core/system-prompt/{README,README.zh}.md` |
| 提示词包 | `packages/core/system-prompt/src/{index,invariant}.ts`（**没有**单独的 `assemble.ts`：`assemble` 是 `SystemPrompt` 上的方法） |
| 作用域层 | `packages/core/scope/src/store.ts`（`ScopedLayers.effect` 把登记交回 `ctx.effect`） |
| 工具表接入 | `packages/core/tools/src/index.ts`（`ToolRuntime` 构造时 `ctx.systemPrompt.tools(...)`） |
| 插件登记 | `packages/preset/persona/src/index.ts`、`packages/shell/tool-bash/src/index.ts` |
| 循环用法 | `packages/core/agent-loop/src/agent.ts`（`assemble` → `renderPrompt`）；`packages/core/agent/src/dispatch.ts`（`assembleContextFor`） |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§3.1 可逆效应、§3.2 反应式余效应 |

本篇钉子：模型每一步看到的系统提示词和工具 schema，是**当场从还在岗的插件拼出来的菜单**，不是写进 06 那本黑匣子里的昨日流水。卸掉一个插件，它贡献的段和 schema 从下一次 `assemble()` 消失。没有单独的「删除提示词」API：登记本身就是 02 篇的 `ctx.effect`。

不要把提示词注册表和会话日志混成一件事。06 已经说过：`session.append` 写进去就还在。本篇的段、变量、工具提供方都挂在纤程上；纤程拆走，菜单上对应那一行就没了。

---

## 今日菜单，不是昨日小票

饭店每天开张前不印一本永远有效的菜谱。厨房看**今天谁当班**：招牌还在、主厨写了今日推荐、海鲜档的人在就有清蒸鲈鱼、酒水员在就有酒单。开除一个厨师，今晚菜单上他的菜立刻消失——不是把墙上那本去年的点菜单涂掉，是今晚根本不再写那一行。

对应到 `dsh`：

| 今日菜单 | Harness |
|---|---|
| 一块给全店共用的菜单板 | `ctx.systemPrompt`（Cordis Service，ctx 键 `systemPrompt`） |
| 餐厅招牌（几乎每天都一样） | `harness:identity`，`order: -100` |
| 今日主厨推荐 | `deployment:persona`，`order: 0`（`PERSONA_SECTION` / `PERSONA_ORDER`） |
| 当班档口写的菜品说明 | `PromptSection`（如 `tool:bash`，约定 `100–199`） |
| 可点的菜 / 酒单（给模型看的 schema） | `PromptAssembly.tools: ToolSchema[]` |
| 当日变量（几号桌、用哪套灶） | `{{model}}` / `{{cwd}}` 这类 `variable` |
| 动态贴条（运行时快照，不是系统提示词正文） | `PromptContext` → user 角色的 runtime-context |
| 开除厨师 | 卸插件 → effect dispose → 下次 `assemble()` 不再收录 |
| 昨天的点菜单 | 会话日志（06）：拆不走 |

架构原话（`docs/architecture.zh.md` 核心包表）：`core/system-prompt` 负责「提示词片段与工具 schema 的组装」，ctx 键 `ctx.systemPrompt`。轮次流程里，每一步都是 `assemble prompt sections + tool schemas`，然后才 `agent/pre-step`。新行为归属表写得更白：添加面向模型的能力时，在 `ctx.tools` 上注册；**其 schema 加入提示词组装**。

包注释把职责写成一句。出处：`packages/core/system-prompt/src/index.ts`。

```ts
/**
 * Registry for ordered system sections, dynamic context, tool schemas, and prompt variables.
 *
 * @module @deepseek-ai/dsh-system-prompt
 */
```

`SystemPrompt` 才是 Cordis Service。一次 `assemble()` 返回的 `PromptAssembly` 是普通对象：段、动态上下文、工具 schema、变量。渲染（`renderPrompt`）是之后的事。本篇不读工具怎么执行——那是 08。这里只认：模型「知道自己能干什么」和「该怎么说话」，是同一次组装的两面。

---

## 登记就是 effect：厨师上岗写菜，下岗擦掉

`section` / `context` / `tools` / `variable` / `suppressRuntimeContext` 五条登记入口，最后都走进同一扇门：`this.layers.effect(...)`。JSDoc 写明返回值是 **exact Cordis effect disposer**。出处：`packages/core/system-prompt/src/index.ts`。

```ts
section(section: PromptSection): () => void {
  if (!Number.isFinite(section.order)) {
    throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
  }
  return this.layers.effect(
    this.ctx,
    layer => layer.sections.insert(section.name, section),
    { label: 'systemPrompt.section()' },
  )
}
```

`tools` 同形，只是插入的是匿名提供方，不是按名占位：

```ts
tools(provider: (context: AssembleContext) => ToolProviderResult): () => void {
  return this.layers.effect(
    this.ctx,
    layer => layer.toolProviders.append(provider),
    { label: 'systemPrompt.tools()' },
  )
}
```

`ScopedLayers.effect` 自己不另搞一套生命周期。它按调用上下文选出全局层或某个 agent 层，把 `action` 的同步 undo 交给 `ctx.effect` 的 generator。出处：`packages/core/scope/src/store.ts`。

```ts
const dispose = ctx.effect(function* (this: ScopedLayers<L>) {
  // …选/建 layer，action(layer) 得到 undo…
  yield () => {
    undo()
    if (scope !== undefined && layer.isEmpty()) this.scoped.delete(scope)
    if (notify) this.onChange()
  }
  if (notify) this.onChange()
}.bind(this), options.label)
return dispose
```

`SystemPrompt` 构造 `ScopedLayers` 时，把 `onChange` 接到 `this.ctx.emit('system-prompt/change')`。登记和撤销都会喊一声。这是 04 篇的 `emit`：对讲机广播，不等回音。谁要重绘菜单，自己订。

一层里同名段会抛；带作用域的同名段**遮蔽**全局，而不是复制一份。`PERSONA_SECTION = 'deployment:persona'` 导出，就是为了让 agent preset 用同一个名字盖住部署默认人设，而不是旁边再贴一张。

---

## 插件怎么把菜写上菜单

两种写法，都落到上面那扇门，没有第三套 API。

**1. 直接调用登记方法。** Bash 工具同时写两样东西：一段跨调用的文字引导，以及真正可调用的工具。出处：`packages/shell/tool-bash/src/index.ts`。

```ts
export const inject = ['tools', 'shell', 'systemPrompt', 'shellEnv']

export function apply(ctx: Context, config: Config = {}): void {
  ctx.systemPrompt.section({
    name: 'tool:bash',
    order: 105,
    text: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',
  })

  ctx.tools.register(defineTool({
    name: 'bash',
    description: bashDescription(backgroundEnabled, escalationModes),
    // …
  }))
}
```

`section(...)` 和 `tools.register(...)` 各自返回 disposer，所有权在调用纤程上。卸掉 `tool-bash`，引导段没了，`ctx.tools` 里的 `bash` 也没了。两件事独立登记：限制某个工具的可见性，**不会**自动撕掉别人单独注册的引导——包 README 写明了这一点。

**2. 再包一层 `ctx.effect`。** Persona 行是 scope-only：它必须挂在某个 agent 的 `agent.ctx` 上，用同一个 `deployment:persona` 名字遮蔽全局。出处：`packages/preset/persona/src/index.ts`。

```ts
export const inject = ['systemPrompt']

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_SECTION,
    order: PERSONA_ORDER,
    text: config.text,
    ...(config.complete ? { complete: true } : {}),
  }), 'persona.section()')
  if (!(config.includeRuntimeContext ?? true)) ctx.systemPrompt.suppressRuntimeContext()
}
```

外层 `ctx.effect(() => …)` 是 02 篇的分组写法：内层 `section()` 已经是 effect，再包一层只是把「登记人设」标成 `persona.section()`，方便诊断。全局再挂一行同名 persona 会和注册表自己的那条撞车——插件注释说挂在无作用域上下文上会 fails loud。

空间依赖写在 `inject` 上。没有 `systemPrompt` 这块菜单板，厨师插件按 03 篇停着等，不会假装已经把菜写上去了。菜单板被拆走，依赖它的插件一并卸，电回来再按当时配置重挂。

---

## 工具 schema 怎样从 `ctx.tools` 走进提示词

插件一般**不**自己调用 `ctx.systemPrompt.tools()`。它们调 `ctx.tools.register()`。把注册表投影成「这一次组装该给模型看哪些 schema」的，是 `ToolRuntime` 自己。

`ToolRuntime.static inject = ['systemPrompt']`。构造函数里挂上一个提供方，每次 `assemble` 用当时的 `scope` 再算一遍。出处：`packages/core/tools/src/index.ts`。

```ts
export class ToolRuntime extends Service {
  static inject = ['systemPrompt']

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'tools')
    this.defaultMode = config.mode ?? 'native'
    this.maxParallelSubCalls = resolveMaxParallelSubCalls(config.maxParallelSubCalls)
    ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))
    // mode !== 'native' 时再挂 code-only / SDK 两段提示词
  }
```

`wireSchemas` 读的是工具注册表在该作用域下的可见视图：native 模式交出全部可见 schema；`code` 模式折叠成只剩 `run_code`。`knownNames` 是限制**前**的名称全集，好让配置里的 `toolOrder` 分清「写错了名字」和「这个作用域故意藏起来」。

```ts
private wireSchemas(scope?: ScopeKey): ToolProviderResult {
  const view = this.view(scope)
  const mode = this.modeFor(scope)
  if (mode === 'native') {
    const schemas = [...view.visible.values()].map(definition => this.schemaOf(definition, false))
    return { schemas, knownNames: [...view.knownNames] }
  }
  // …
}
```

所以「从 `ctx.tools` 加入提示词」不是另开一条旁路：工具表用 `systemPrompt.tools(provider)` 把自己登记成提供方；`assemble()` 调用每个还活着的提供方，`structuredClone` 一份参数，再按 `toolOrder` 或字典序排好。卸载一个工具插件 → `tools.register` 的 effect 撤回 → 下次 `wireSchemas` 的可见集合里没有它 → 菜单上的 schema 行消失。卸载整个 `dsh-tools` → 连这个提供方一起从 `systemPrompt` 的层上拿掉。

---

## `assemble`：按今天在岗的人拼一版

没有 `assemble.ts`。方法在 `SystemPrompt` 上。循环在每一步的 `preStep` 里叫一次。出处：`packages/core/agent-loop/src/agent.ts`。

```ts
const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
```

`assembleContextFor` 把当前 agent 同时填进 `agent` 和 `scope`（声明合并扩展的字段），可选带上这一轮的 `AbortSignal`。出处：`packages/core/agent/src/dispatch.ts`。

```ts
export function assembleContextFor(agent: Agent, signal?: AbortSignal): AssembleContext {
  return { agent, scope: agent, ...signal === undefined ? {} : { signal } }
}
```

`assemble` 自己做的事，按源码顺序：

1. 用 `context.scope` 取出作用域链上的层（远祖在前，最近的在后）。
2. 变量：先全局，再沿链覆盖，**最近的赢**。
3. 段和动态上下文：`layers.merge`，同名作用域项遮蔽全局，再按 `order` 升序。
4. 工具：全局提供方 **加上** 作用域链上的提供方都跑一遍（工具是累加，不是按名遮蔽）。`parameters` 做 `structuredClone`，避免后面 waterfall 改到注册表里的那份。
5. `complete: true` 的段超过一个就抛；恰好一个会先记下来。
6. 排好 `PromptAssembly`，丢进按作用域筛选的 `system-prompt/assemble` **waterfall**。
7. waterfall 之后：若有 complete 段，**只保留那一段**当系统提示词（工具、变量、上下文仍用 waterfall 的返回值）；若运行时上下文被抑制，contexts 强制清空。

出处：`packages/core/system-prompt/src/index.ts`（节选）。

```ts
const transformed = await this.ctx.waterfall(
  scopeTarget(this, scope), 'system-prompt/assemble', assembly, context,
  () => Promise.resolve(assembly),
)
if (completeSection === undefined && !runtimeContextSuppressed) return transformed
return {
  ...transformed,
  sections: completeSection === undefined ? transformed.sections : [completeSection],
  contexts: runtimeContextSuppressed ? [] : transformed.contexts,
}
```

这是 04 篇的托盘：监听器必须 `next()`，返回值作准。complete 段是托盘送完之后的硬约束——专家可以改工具列表，但不能在 complete 生效时给这块作用域另塞一段系统提示词。不变量伴侣挂在 waterfall 上，检查组装结果里段名不空、不重复、变量名合法。出处：`packages/core/system-prompt/src/invariant.ts`。

`renderPrompt` 这时才插值 `{{variable}}`：未知、无值、格式坏了都抛；空段丢掉，其余空行拼接。循环在 `step` 里调用，并把 **同一份** `assembly.tools` 送进模型请求。出处：`packages/core/agent-loop/src/agent.ts`。

```ts
const system = renderPrompt(assembly)
const { request, preparedCall } = await this.buildRequest(
  turn, step, assembly.tools, system, this.session.deriveMessages(), signal,
)
```

系统提示词来自还在岗的插件；对话历史来自 06 的只追加日志。两路合成一次请求。历史不能靠卸插件改写；菜单可以。

---

## 反应式余效应：卸插件 = 菜单少一行

把 02 / 03 对上这张菜单：

| 论文 / 前篇 | 本包里的真名字 | 厨房说法 |
|---|---|---|
| 可逆效应（02，`ctx.effect`） | `ScopedLayers.effect` → `layer.sections.insert` / `toolProviders.append` | 上岗写菜；下岗 `undo()` 擦掉 |
| 反应式余效应（03，`inject`） | `inject = ['systemPrompt']`；`ToolRuntime.static inject = ['systemPrompt']` | 没有菜单板就不开档；板撤了档口一并停 |
| 空间遮蔽 | `layers.merge`：同名段 / 变量，近的覆盖远的 | 这桌的主厨推荐盖住全店默认 |
| 空间累加 | 工具提供方全局 + 作用域链都计入 | 全店酒单，外加这桌临时加的一杯 |
| 提交视图 | 每次 `assemble()` 现场求值提供方 | 不缓存「昨天那版菜单」当今天的 |

开除厨师发生的具体顺序：纤程进入 UNLOADING（01）→ 后装先卸跑 disposer（02）→ `undo()` 从 `NamedEntries` / `AnonymousEntries` 拿走这一行 → `system-prompt/change` 喊一声 → 下一次 `assemble()` 的 `merge` / 提供方列表里没有它。没有「先改一份全局提示词字符串再通知大家」的中心黑板。菜单是投影，真源是还活着的那些 effect。

这和 06 的边界正好相反。会话日志是 emission：写出去收不回。提示词注册表还在 Sigma 里：钩子 `ctx.systemPrompt` 是 acquisition，卸掉就从 `ctx` 拿走；钩子指向的那些段，也随纤程一起走。定理 73 保证静止状态等于最终配置——对这张菜单来说，最终配置就是「还在岗的厨师写下的菜」。已经发给模型、已经写入日志的那一版请求，是排放，本篇改不了。

---

## 可以记住的几句

1. **系统提示词是今日菜单，不是昨日小票。** 每一步 `assemble()` 按还在岗的插件拼；会话日志（06）按已经发生的事实投影。
2. **登记 API 只有 `section` / `context` / `tools` / `variable` / `suppressRuntimeContext`，返回值都是 effect disposer。** 没有删除 API。卸插件就是撤回。
3. **插件把引导写进 `systemPrompt.section`，把可调用能力写进 `ctx.tools.register`。** schema 由 `ToolRuntime` 经 `ctx.systemPrompt.tools(wireSchemas)` 自动并入组装。
4. **同名段遮蔽，工具提供方累加。** agent 作用域的 `deployment:persona` 盖住全局人设；bash 卸掉则段和 schema 一起没。
5. **`assemble` 在 waterfall 之前克隆工具参数、排好序；complete 段在 waterfall 之后强制成为唯一系统段。** 监听器改的是这一次组装，改不了注册表。
6. **余效应：没有 `systemPrompt` 服务，依赖它的厨师插件不会启动；服务被替换，它们会卸了再挂。** 这是 03，不是另写一套提示词生命周期。

---

## 下一篇读什么

**08 · tools-pipeline**（工具注册表与 pre/execute/post 流水线）。

本篇已经看到 schema 怎样走进提示词。下一篇读 `ctx.tools` 自己：登记、限制、以及一次 `tool/call` 如何走过 `tools/pre-execute` → `tools/execute` → `tools/post-execute`。先不要跳到 Agent 循环的 inbox。

---

## 拉取记录

成功（默认分支是 `master`，不是 `main`）：

- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/system-prompt/src/index.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/system-prompt/src/invariant.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/system-prompt/{README,README.zh,package.json}`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/architecture.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/architecture.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/system-prompt.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/system-prompt.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/tools/src/index.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/scope/src/store.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/preset/persona/src/index.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/shell/tool-bash/src/index.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/agent-loop/src/agent.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/core/agent/src/dispatch.ts`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/core/system-prompt`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/core/system-prompt/src`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/docs/subsystems`

404：

- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/main/packages/core/system-prompt/src/index.ts`（仓库默认分支是 `master`）
- 不存在 `packages/core/system-prompt/src/assemble.ts`（`assemble` 在 `index.ts` 的 `SystemPrompt` 类上）

`docs/subsystems/system-prompt.md` 与 `.zh.md` 均存在。测试文件 `tests/{system-prompt,scoped,tool-order,invariant}.spec.ts` 本篇未展开。
