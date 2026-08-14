# 05 · 启动、profile、bundle、patch

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[04 events](04-events.md) · 下一篇：[06 session-log](06-session-log.md)

读的是 DeepSeek Harness 真正跑的那份启动与组装，不是自己再发明一套词。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 文档 | `docs/architecture.md`、`docs/architecture.zh.md`、`docs/cordis-tutorial/06-composition-and-hmr.md`、`apps/cli/README.md`、`apps/cli/reference/README.md` |
| 启动粘合 | `packages/boot/app-boot/{README,README.zh}.md`、`packages/boot/app-boot/src/{index,profile}.ts` |
| 组合包 | `packages/bundle/{README,base,web-app,headless}/README.md` 及对应 `.zh.md`、各自 `package.json` 与 `cordis.patch.yml` |
| 启动器 | `apps/cli/src/{bin,args,dump-config,profile-boot}.ts` |
| Include 补丁算法 | `vendor/include/src/index.ts`（`applyEntryPatches`、`PatchOptions`） |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§5.2 部件加载器、定义 74、定理 63 / 73 |

本篇钉子：一次 `dsh` 是怎样从空列表叠成一棵会跑的插件树。01–04 已经把厨房（Context）、拆机（effect）、水电（inject）、对讲机（事件）钉住了；这一篇才第一次谈**菜单是谁点的**。

---

## 套餐，不是单点

去餐馆，可以一份一份点（a la carte），也可以要一份**具名套餐**（set menu）。

套餐有名字，比如「网络午餐」「外卖一份」。它不自己炒菜：它只规定几道菜按什么顺序上，以及你事后能不能按编号换一道。

对应到 `dsh`：

| 餐馆 | Harness |
|---|---|
| 一份具名套餐 | **profile**：存在 Harness home 里的具名组装 |
| 套餐里的一道菜（冷盘 / 主菜 / 甜品） | **bundle（组合包）**：一份可安装的 patch 层，带着它要挂上的代码 |
| 按编号换一道菜，或加一道 | **patch**：按条目 `id` 整行替换 `config`，或 `insert` 新行 |

架构文档原话（`docs/architecture.zh.md`）：运行中的 `dsh` 是一棵插件树，由启动时按序叠加的各层组合而成。**profile** 是存放在 Harness home 中的具名组装。它列出自己叠放的组合包，存放自己安装的树外插件，并保存用户自己的 `cordis.patch.yml`。`web` 和 `headless` 作为模板随发行版交付。**组合包**是 Cordis 配置项及其挂载代码的分发格式，因此它插入的内容始终可被其上各层 patch。

单点当然也能做：手写一整份 `cordis.yml`，像教程第 6 章那样。产品入口不走那条路。`dsh --profile web` 点的是套餐；套餐的根是一份**故意写空**的菜单，真正的菜全是后来叠上去的。

---

## 两份身份证：`dsh.profile` 和 `dsh.bundle`

两者都在各自的 `package.json` 里用 `dsh` 字段声明。架构文档（`docs/architecture.md`）：`dsh.profile` 列出一个 profile 的 bundles，`dsh.bundle` 指向一个组合包的 patch 文件。

组合包这一半，三个发行包写法相同。出处：`packages/bundle/base/package.json`（`web-app`、`headless` 同结构）。

```json
"dsh": {
  "bundle": {
    "patch": "./cordis.patch.yml"
  }
}
```

profile 那一半由启动器写进 `$DSH_HOME/profiles/<name>/package.json`。出处：`packages/boot/app-boot/src/profile.ts` 的 `initProfile`。

```ts
dsh: { profile: { bundles: [...bundles] } },
```

发行模板只有两份。出处：同一文件的 `PROFILE_TEMPLATES`。

```ts
export const PROFILE_TEMPLATES: Record<string, readonly string[]> = {
  web: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
}
```

读法：

- **web** = 共享核心 + 浏览器表层。两道菜，不是一道。
- **headless** = 共享核心 + 一次性 runner。和 web **同级**，都骑在 base 上；headless 不挂 web-app。
- 其它名字第一次用会响亮报错，直到 `dsh plugin --profile <name> add …` 创建；那种自定义套餐默认只带 `@deepseek-ai/dsh-base`（`DEFAULT_PROFILE_BUNDLES`）。

`loadProfile` 解析每个 `dsh.profile.bundles` 名字时是**双锚点**：先从正在跑的这份 dsh 安装目录找，再从 profile 目录找。inbox 组合包（`dsh-base` / `dsh-web-app` / `dsh-headless`）因此永远来自当前安装，不会被 profile 本地的一份冒名顶替。列出的包若没有 `dsh.bundle` 声明，不是「这层没补丁」，而是配置错误，启动失败。

Harness home 由 `resolveDshHome` 决定：先 `$DSH_HOME`，否则 `~/.dsh`。profile 目录是 `$DSH_HOME/profiles/<name>`。

---

## 真正的叠菜顺序：从空盘子开始

套餐上菜有固定顺序。启动器把顺序写进了两处互相核对的地方：文档（`docs/architecture.md`、`apps/cli/reference/README.md`）和 `composeProfile`（`apps/cli/src/profile-boot.ts`）。

空根配置每次启动都会被重写成同一份数组。出处：`apps/cli/src/profile-boot.ts`。

```yml
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

文件名是 profile 目录里的 `cordis.yml`。它必须在磁盘上，因为 Cordis Loader 需要一个真实的 include 根，好把 `baseUrl` 锚在 profile 目录；配置 dump 也锚在同一文件上。注释写着：改 `cordis.patch.yml`，别改这份空根。启动器每次 `prepareProfile` 都会覆盖它——因为 vendored Loader 可能把当前树写回配置文件，若不擦掉，下次启动会把组合包的 insert **再插一遍**。

然后按这个顺序往空列表上叠：

```text
[]                                          ← 空条目列表（profile 的 cordis.yml）
  + 每个 bundle 的 cordis.patch.yml         ← 按 dsh.profile.bundles 列出的顺序
  + 该 profile 自己的 cordis.patch.yml      ← $DSH_HOME/profiles/<name>/
  + home 级 $DSH_HOME/cordis.patch.yml      ← 整台机器、所有 profile 共享，因此压过逐 profile 那层
  + 每个 --patch <file>                     ← 按 argv 顺序，可重复
```

`composeProfile` 把这四段收成一次 `composeEntries` 调用。出处：`apps/cli/src/profile-boot.ts`。

```ts
const bundlePatches = profile.layers.flatMap(layer => layer.patches)
const rows = new Map<string, EntryOptions>()
for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays])) {
  if (typeof row.id === 'string') rows.set(row.id, row)
}
```

`composeEntries` 自己不再发明算法：它把各层拍扁，交给 include 插件的 `applyEntryPatches`，底是空数组。出处：`packages/boot/app-boot/src/profile.ts`。

```ts
export function composeEntries(
  layers: readonly PatchOptions[][], warn: (message: string) => void = () => {},
): EntryOptions[] {
  return applyEntryPatches([], structuredClone(layers.flat()), (message: string, ...args: unknown[]) => {
    let index = 0
    warn(message.replace(/%C/g, () => JSON.stringify(args[index++])))
  })
}
```

厨房说法：先上冷盘（base），再上主菜（web-app 或 headless），然后按桌号换菜（profile 自己的 patch），再按这间店的总规矩换一次（home 级），最后是你进门时递上的加菜单（`--patch`）。后写的压过先写的，**按行 id，不按字段深合并**。

启动器在这四层之后还会再塞两件自己的事，不属于套餐合同，但启动时确实会发生：若树上有 `agent-presets` 行，补上发行自带的 preset 根目录；若环境变量 `DSH_TELEMETRY_DISABLED` 非空且树上有遥测行，把那一行 `disabled: true`。dump 路径不跑这两步。本篇以文档写明的四层为准，不把启动器私货说成 profile 合同。

---

## patch 按 id 换整道菜

include 插件把「换菜」写成一种数据结构。出处：`vendor/include/src/index.ts`。

```ts
export interface PatchOptions {
  id?: string
  insert?: EntryOptions[]
  name?: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: any
  intercept?: any
  isolate?: any
  [key: string]: any
}
```

`applyEntryPatches` 的规则（同一文件，注释写明 dump 与挂载共用，避免两套语义）：

1. **无 `id` 的 `insert`**：把新行追加到当前列表末尾。base 组合包就是这样：一整份 `insert` 扣在空根上。
2. **带 `id` 的 `insert`**：只允许插进某个 `group` 行的子列表；目标不是 group 或找不到，就警告并跳过。
3. **带 `id`、无 `insert`**：在已有行上按字段覆盖。`config` 是其中一格——赋的是**整份新 config**，不是深合并。`disabled: true` 把这道菜留在菜单上但不端上桌。
4. 找不到 `id`：警告，跳过。一份 overlay 因此可以在 web 和 headless 之间共用，不必每棵树都命中每一行。
5. 同一份列表里，先 insert 的行立刻编入索引，后面的 patch 就能按 id 改它。这正是「后一层改前一层刚插的行」能成立的原因。

app-boot README 把用户层说得更硬：按 id 定位的 patch **不做深度合并**，所以 profile 覆盖必须把要保留的组合包字段再写一遍。空文件或只有注释会抛错（解析结果不是数组）；要关掉这一层，写 `[]`。

`!!js` 是这份 YAML 方言的标量：挂载时按该行自己的上下文求值。dump 原样打印，不求值。base 里平台门控就是这样写的。出处：`packages/bundle/base/cordis.patch.yml`。

```yml
- id: bash-sandbox
  name: '@deepseek-ai/dsh-bash-sandbox'
  disabled: !!js process.platform === 'win32'
```

孪生的 `pwsh-sandbox` 用取反表达式，只在 win32 挂载。同一份 patch，每个宿主恰好一道壳。

web-app 叠在 base 之上时，按 id 改 persona、关掉共享 HMR，并 insert 一整排 Web 宿主行。它也会把一批模型可见工具改成 `disabled: true`，让每个会话用 agent preset 再挂回来——**禁用而不是删除**，因为 base 是共享的，缺一行的 overlay 哪天被重排，那一行会悄悄回到桌上。出处：`packages/bundle/web-app/cordis.patch.yml` 行内注释。

---

## 三道发行菜

`packages/bundle/README.md`：组合包的实质是它的 patch 列表；有的另外带着自己的 patch 要挂的运行时胶水插件。

**`@deepseek-ai/dsh-base`**（`packages/bundle/base/README.zh.md`）：每个 profile 的第一层。在空根上 insert 全部基础插件行——模型适配器、默认模型选择、工具、持久化、沙箱与审批、settings / credentials、遥测、宿主级 subagent provider。它**没有运行时 API**；组合器只读 `dsh.bundle.patch`，从不 import 这个包的代码来「启动核心」。Codex / Claude provider 以休眠状态加载。模式专属的值不放这里，留给 web-app / headless 按 id 重写整行。

**`@deepseek-ai/dsh-web-app`**：浏览器表层。设置 coding persona，insert Web 宿主（webserver、API 网关、workspace、存储…）和浏览器插件名录，挂本包的 `web-runtime`。`web-startup` 解析 `--host` / `--port` / `--trusted-host` 和该应用自己的 `--help`。由 flag 配置的行会 `inject: [webStartup]`，Loader 等这个服务出现才求 `!!js`，所以 `dsh --profile web --help` 不会绑端口。拒绝 `--host 0.0.0.0`。

**`@deepseek-ai/dsh-headless`**：一次性任务。不挂 Host、HTTP、Web runtime、浏览器插件。`headless-startup` 读 `dsh --profile headless "task"` 的位置参数；`headless-runner` 注入该服务，Loader 结算后建一个新 Agent、提交任务、等停稳、把最后一条非空 assistant 文本写到 stdout，再经 `ctx.appExit` 退出。缺任务会在 runner 激活前被拒绝。`ctx.appExit` 由启动器提供，在 `dsh` 之外硬启动这个 profile 会失败。

行顺序**不决定加载顺序**。base 的 patch 文件开头就写：activation is service-availability driven。这和 03 篇的 `inject` 对得上：没电就等，不是按菜单行号开机。

---

## `dsh --profile web --dump-config` 并不启动

架构文档给的查看办法：

```sh
dsh --profile web --dump-config
```

它打印出的任何条目，都可以由你自己的 patch 替换。

启动器把 dump 做成一种**独立调用**，不是 boot 的副作用。出处：`apps/cli/src/args.ts`。

```ts
.option('--dump-config', 'print the composed profile tree and exit')
.option('--dump-default-config', 'print the profile tree without its user layer or --patch overlays and exit')
```

规则（`apps/cli/src/{args,dump-config,bin}.ts`、`apps/cli/reference/README.md`）：

- `bin.ts` 在 `dump-config` 分支动态 import `runDumpConfig`，**不**走 `runProfile`。
- dump 不接受应用参数：`--dump-config` 后面再跟 `--port` 是用法错误。它也因此看不到 web-startup 解析后的端口。
- `--dump-config` 与 `--dump-default-config` 互斥。后者只打印组合包层，连 profile / home 的 `cordis.patch.yml` 都不读——这是用户层写坏时的恢复诊断。
- `--dump-default-config` 不能带 `--patch`。
- `dsh web --dump-config` 是 `--profile web --dump-config` 的别名。

`runDumpConfig` 用 include 自己的解析器和 `applyEntryPatches` 离线合成，经 `renderConfigDump` 打成 YAML。出处：`apps/cli/src/dump-config.ts`。

```ts
const layers: ConfigDumpLayer[] = loaded.layers.map(layer => ({
  label: layer.packageName,
  patches: layer.patches,
}))
```

非 `defaultOnly` 时再追加 profile 自己的 patch 文件、home 级文件、每个 `--patch`。输出仍是一份可加载文档：每一段连续行前面有 `# ==` 注释，标明来自哪个文件、被哪些层改过。`!!js` 原样保留。未命中的 patch 连同层标签写到 stderr。

`renderConfigDump` 的注释写：结果与 `boot()` 挂载的内容一致——指的是**同一套** `entryListSchema` / `applyEntryPatches`，不是「再跑一遍插件」。dump 不执行 `!!js`，不装 Loader，也不跑上面说的遥测 / preset 启动器补丁。

---

## `boot()`：空厨房，先装 Loader，再挂 include

叠好的 patch 列表最后交给 `boot()`。出处：`packages/boot/app-boot/src/index.ts`。

```ts
export async function boot(
  binName: string,
  absoluteConfigPath: string,
  patches?: PatchOptions[],
  prepare?: (ctx: Context) => Promise<void> | void,
  bareModuleBaseUrl?: string,
): Promise<Context> {
  const ctx = new Context()
  // ...
  ctx.provide('dshHomePath', dshHomePath)
  await ctx.plugin(Loader)
  await prepare?.(ctx)
  await mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl)
  await ctx.get('loader')?.await()
  await assertEntriesActivated(ctx, binName)
  return ctx
}
```

顺序可以对着 01–04 读：

1. `new Context()`：空厨房（01）。
2. `provide('dshHomePath', …)`：给 YAML 里的 `!!js dshHomePath('sessions')` 一个插座。
3. `ctx.plugin(Loader)`：装上论文 §5.2 说的那个声明式加载器。
4. `prepare`：启动器在**任何配置树条目挂上之前**塞自己的东西。`dsh` 在这里 `provide` 冻结的环境快照和 `cmdlineArgs` / `appExit`（`apps/cli/src/profile-boot.ts`）。
5. `mountRootInclude`：把静态导入的 `cordis:include` 和 `cordis:group` 登记为 builtin，再挂一根 id 钉死为 `'include'` 的根条目，配置里带着空根路径和已经叠好的 `patches`。
6. 等 Loader 结算，再 `assertEntriesActivated`：已启用却没有 fiber 的条目、FAILED、一直 PENDING（缺服务）都变成带 bin 名前缀的启动失败。PENDING 会列出它还在等哪些服务——03 篇那盏没亮的灯。

`runProfile` 在树站住之后，还会用 `watchUserPatches` 盯 profile 和 home 两份 `cordis.patch.yml`。改文件就按「组合包在下、overlay 在上」重新组合用户层，走 Loader 的事务更新。web-app 把共享模块重载 HMR 行禁用了；若树上因此没有 `hmr` 服务，启动器会再挂一个 `root: []` 的 watch-only HMR，让用户 patch 仍然热替换。读失败或解析失败时，上一棵可用树继续跑，并广播 `hmr/config-update-failed`。这是产品层的热替换，不是 Webpack 那种要你标 acceptance boundary 的 HMR。

环境变量另有一层，和 patch 不是一回事：`loadLayeredEnv` 是继承环境 > 调用目录 `.env` > home `.env`，且不覆盖已经继承的名字。`DSH_*` 等 bootstrap 名禁止写进 `.env` 文件。凭据不靠这层，走 `.credentials.yaml`。

---

## 和论文 §5.2 对得上的部分

论文 §5.2（部件加载器）把编排者从手写 `ctx.use` 里解放出来：期望的组成写成一份持久配置，加载器把它译成纤程上的装 / 卸 / 改。

对得上、且本篇用得上的只有这些：

- **声明式条目**（定义 74）：一条 entry 记录稳定 `id`、模块、`isolate` / `intercept`、`config`、`disabled`。Harness 配置行用 `name` 写插件说明符（论文写的是 `url`），其余字段对得上。没有 `id` 的行每次读都会拿到新生成的 id，配置文件一改就变成「删掉再加」——教程 06 原话。
- **`include` / `group` 仍是普通部件**。论文写 `@cordisjs/include` 把外部 YAML/JSON 接成子树、`@cordisjs/group` 把子条目列表当配置。Harness vendor 里对应 `@deepseek-ai/cordis-plugin-include` 与 `@deepseek-ai/cordis-plugin-group`；`boot()` 把它们登记成 builtin，所以 home 下的 agent preset 也能写 group 行。
- **调和按 id**。后一层 patch 命中同一 `id`，Loader 按字段做最小打扰，而不是拆掉整棵树重建。定理 73：静止状态只取决于最终配置。这就是「后写的层赢」合法的原因。
- **不必手排加载顺序**（定理 63）。base 的 patch 注释和 03 篇的 `inject` 是同一句话：依赖约束的是**何时激活**，不是模块何时求值。Loader 并发挂载；`assertEntriesActivated` 才把一直 PENDING 的条目变成启动失败。
- **用户 patch 的热替换**走 §5.2.2 同一套可逆效应：卸旧纤程、效应收回、再装新配置。`watchUserPatches` 是产品在这套机制上加的文件监视，不是另一套生命周期。

对不上、本篇不拉来充数的：

- 论文 §5.2 没有 profile / bundle / `--patch` 这些产品词。它们是 Harness 在 Loader 外面叠的发行格式。
- `applyEntryPatches` 是 include 插件的预合成，发生在 Loader 调和之前：先算出最终条目列表，再交给 include 去挂。不要把「YAML 补丁算法」说成论文里的 Algorithm 7–10。
- 论文案例是 Koishi（§5.3），不是 `dsh`。

---

## 可以带走的四件事

1. profile 是具名套餐，bundle 是一道菜，patch 是按 id 换菜。身份证写在 `package.json` 的 `dsh.profile` / `dsh.bundle` 里，不写在 TypeScript 入口里。
2. 真正的根是空数组。叠的顺序是：各 bundle（按列表）→ 该 profile 的 `cordis.patch.yml` → home 级那份 → `--patch`。后写的整行替换，不深合并。
3. `dsh --profile web --dump-config` 用同一套 `applyEntryPatches` 离线打印这棵树，不启动、不求 `!!js`。`--dump-default-config` 连用户层都不读。
4. `boot()` 只做 01–04 已经出现过的事：新建 Context、装 Loader、挂 include、等激活。插件何时变成 ACTIVE，仍然看 `inject`，不看 YAML 行号。论文 §5.2 解释的是 Loader 这一段，不是套餐名词。

---

## 下一篇读什么

**06 · session-log**（只追加 SessionEvent 与 deriveMessages）。

本篇已经把树拼起来了。树上有一行叫 `session`（base 组合包 insert 的）。下一篇读这行挂上之后，模型看见的历史为什么必须从一份只追加的日志投影出来。先不要跳到提示词组装。

---

## 拉取记录

成功：

- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/architecture.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/architecture.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/cordis-tutorial/06-composition-and-hmr.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/glossary.md`（本篇未引用词条，无 profile/bundle 专条）
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/boot/README.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/boot/app-boot/{README,README.zh}.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/boot/app-boot/src/{index,profile}.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/bundle/{README,base,web-app,headless}/README.md` 及对应 `README.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/bundle/{base,web-app,headless}/{package.json,cordis.patch.yml}`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/boot/app-boot/package.json`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/apps/cli/{README.md,reference/README.md}`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/apps/cli/src/{bin,args,dump-config,profile-boot}.ts`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/vendor/include/src/index.ts`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/{docs,packages,packages/boot,packages/bundle,packages/boot/app-boot,packages/boot/app-boot/src,apps/cli/src,vendor,vendor/include/src}`

404：本篇列出的路径均返回 200，没有需要标「文件不存在」的项。`packages/boot/app-boot` 只有 `src/{index,profile,invariant}.ts`，没有第三个「boot.ts」。`docs/glossary.md` 没有 profile / bundle / patch 专条，定义以 architecture 与 app-boot README 为准。
