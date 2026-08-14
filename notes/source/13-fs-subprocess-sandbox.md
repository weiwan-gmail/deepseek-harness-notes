# 13 · 文件系统、子进程、沙箱缝

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[12 agent-scope](12-agent-scope.md) · 下一篇：[14 approval-guard](../source-curriculum.md)（待写）

读的是 DeepSeek Harness 真正跑的那份「碰磁盘、拉进程、围院子」的缝，不是自己再发明一套沙箱内核。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 钉住 | `master` @ `47f943859bef60e4160492346772ded9b24f765a`（`dsh@0.1.0-rc.5`；与 12 相同，已重核 HEAD） |
| Harness 文档 | `docs/architecture.zh.md`（能力 seam、「添加文件系统 / 限制所启动的进程」）、`docs/subsystems/{filesystem,sandbox,subprocess,shell,workspace}.zh.md` |
| 文件系统族 | `packages/fs/{fs,fs-local,fs-sandbox,tool-fs}/src/`（**没有** `packages/core/fs`；也没有根上的 `docs/filesystem.md`） |
| 子进程族 | `packages/subprocess/{subprocess,subprocess-local}/src/` |
| 沙箱族 | `packages/sandbox/{sandbox,sandbox-policy,sandbox-local}/src/` |
| bash 消费方 | `packages/shell/{shell,bash-local,bash-sandbox,tool-bash}/src/` |
| 包 README | `packages/{fs,sandbox,subprocess,shell}/README.zh.md` |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§3.1 可逆效应；**没有** `SandboxMode` / `confine` / `FsTarget` 对象 |

本篇钉子：店里真正碰到磁盘和操作系统进程的那几道**插座**。08 已经读过工具怎么过检查员、厨师、装盘；本篇不把那条流水线再讲一遍。这里只读：一道工具被允许摸哪块盘、怎样拉起一棵子进程、院子的篱笆钉在哪里、宿主和围栏各干什么、拆一位厨师时哪些孩子会被收走。

12 已经写过：`agent.ctx` 是工位，**不是沙箱**。本篇对得上那句话。

---

## 厨房：后门通巷子，储藏室上锁，院子围篱笆

饭店后厨有三件不能混的东西。

- **后门通巷子。** 真正走到店外、在巷子里生火的，是操作系统进程。不是每位厨师自己 `fork`：店里有一个专门管出门的人，argv 怎么写、水管怎么接、走的时候怎么把整棵火堆浇灭，都归他。
- **储藏室上锁。** 盘上的米面油盐不让人直接撬门。先把「这一袋」换成工牌（稳定身份），再按工牌取、改、放回去。储藏室的默认钥匙只是「从哪条过道走进去」，**不是**篱笆。
- **院子围了一圈篱笆。** 有的活必须在院子里干：bash 命令被包进 runner 再出门；写文件前在店里再核一次「这袋米还在院子里吗」。篱笆只管**文件效果**——能不能改盘上的东西。不管网、不管隔壁灶看不看得见。
- **不是每位厨师都能开这两扇门。** 面向模型的 `read` / `write` / `edit` / `bash` 才是规定的入口。每次点单带着这位的会话工作目录、这次的院子规矩、以及这张小票的取消铃。
- **工位不是篱笆。** 12 给每位厨师一档工位（`agent.ctx`）。工位收走刀和便签；后门、储藏室、篱笆是店里的插座，还挂在总灶上。

对应到 `dsh`：

| 厨房 | Harness |
|---|---|
| 通巷子的后门 | `ctx.subprocess`：完全写明的 spawn，argv **不**经 shell 解释 |
| 出门管事的人 | `dsh-subprocess-local`：detached 进程树、SIGTERM→宽限→SIGKILL、服务卸掉时收光 |
| 上锁的储藏室 | `ctx.fs`：`resolve` 成 `FsTarget`，再 `readText` / `writeText` / `editText` |
| 「从哪条过道走进去」 | 会话 `header.cwd`（工具层）；`fs-local` 的 `config.cwd` 只是没会话时的解析默认，**不是**围栏 |
| 院子篱笆（包 argv） | `ctx.sandbox.confine`：Linux bwrap/Landlock、macOS Seatbelt、Windows ACL；消费方再去 spawn |
| 院子篱笆（写盘前核路径） | `dsh-fs-sandbox`：受信代码里 canonicalize-then-contain；**不是**内核边界 |
| 这次用哪套院子规矩 | `ctx.sandboxPolicy.resolve({ session })`：模式 + 工作区根，**按次调用**带着走 |
| 点菜入口 | `dsh-tool-fs`、`dsh-tool-bash`（注册进 `ctx.tools`，08 已经读过流水线） |
| 工位（另一件事） | `agent.ctx` / `createScope`（12） |

架构原话（`docs/architecture.zh.md` 新行为表）：「添加文件系统访问或策略」→ 注册 `ctx.fs` 提供方，或监听 `fs/*` 事件；「限制所启动的进程」→ 使用 `ctx.sandbox` 后端，消费方在启动进程前包装 argv；「添加 shell 执行」→ 注册 `ctx.shell` 后端，本地后端通过 `ctx.subprocess` spawn。能力 seam 写成三种角色：Service Definition、Provider、Consumer。换提供方就能把执行世界搬走；容器 / microVM / 远程执行是**整条能力缝的同级实现**，不是 `ctx.sandbox` 的提供方。

课表写「读 packages 里跟 fs / sandbox / subprocess 有关的」。真实目录里它们都是**产品族**，不在 `packages/core/`：`packages/fs/`、`packages/subprocess/`、`packages/sandbox/`、`packages/shell/`。根上没有 `docs/sandbox.md` / `docs/filesystem.md`；子系统页在 `docs/subsystems/`。

---

## 三道缝，都是店里的插座，不是工位上的刀

`ctx.fs`、`ctx.subprocess`、`ctx.sandbox`、`ctx.shell`、`ctx.sandboxPolicy` 都是 Cordis Service，一个上下文一份实现。12 已经写过：仅仅通过带标签的上下文去调一个普通 Cordis 服务，那个服务**仍是上下文全局的**。`agent.ctx.fs` 还是店里那一间储藏室。

包注释把文件系统缝写成一句。出处：`packages/fs/fs/src/index.ts`。

```ts
/**
 * Filesystem Service Definition for one execution world. Backends own stable target
 * identity, process paths and file URIs, containment, text reads, decoding,
 * binary rejection, and atomic mutations. Read windows and
 * observed-state policy stay in consumer and policy plugins; `editText`
 * remains here so version check, literal match, and rewrite share one critical
 * section.
 * @module @deepseek-ai/dsh-fs
 */
```

子进程缝把「命令默认值、shell 语义、时限、呈现」明确留给消费方。出处：`packages/subprocess/subprocess/src/index.ts`。

```ts
/**
 * Service Definition for the subprocess capability seam (`ctx.subprocess`): execution-world executable lookup,
 * fully specified managed process trees with raw or
 * collected stdio, and one terminal-process primitive. Command defaulting,
 * shell semantics, deadlines, protocol framing, terminal readiness, and
 * presentation belong to consumers.
 */
```

沙箱缝只做一件事：把**即将 spawn 的 argv**包进文件效果策略。出处：`packages/sandbox/sandbox/src/index.ts`。

```ts
/**
 * Service Definition for the same-world process-confinement capability seam: wrap exact subprocess argv under a
 * host-path file policy. Containers, microVMs, and remote execution replace the
 * surrounding capability seam instead; this service shares the host kernel and filesystem.
 */
```

厨房规则：储藏室、后门、篱笆是三条缝。bash 工具不直接 `child_process.spawn`；它问 `ctx.shell`，本地执行器再问 `ctx.subprocess`。要围院子时，沙箱执行器先 `ctx.sandbox.confine(['bash', '-c', command])`，再把**包过的 argv**交给同一条后门。文件系统工具问 `ctx.fs`，不问后门。`glob` / `grep`（`dsh-tool-fs-search`）故意走后门 spawn 打包的 `rg`，不扩展 `ctx.fs` 约定。

`dsh-workspace` 的 `ctx.workspaceRegistry` 是 GUI 用的「用户工作目录名册」（稳定 id、标题、会话账本），**不是**沙箱的 `workspaceRoot`。本篇的工作区根是会话不可变的 `header.cwd`。E2B / 终端 PTY 是同级或下游消费方，课表不覆盖 `e2b`，本篇不走进去。

---

## 储藏室：先换成工牌，再碰磁盘

每次操作先把模型给的路径 `resolve` 成 `FsTarget`：`targetKey` 是品牌化的不透明 id，消费方禁止当本地绝对路径解析；`displayPath` 才给人看。同一执行世界里的子进程要开门，走另一条坐标：`processPath(target)`。出处：`packages/fs/fs/src/index.ts`。

```ts
abstract resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
abstract processPath(target: FsTarget): string
abstract writeText(
  target: FsTarget,
  content: string,
  expected?: FsWriteIntent,
  signal?: AbortSignal,
  sandboxPolicy?: SandboxExecutionPolicy,
): Promise<FsWriteOutcome>
```

`writeText` / `editText` 末尾那个 `sandboxPolicy`：强制沙箱的后端按它围栏，裸本地后端**忽略**它。省略则留给后端自己的默认。文件 IO **不**设 `timeoutMs`——文档写明，超时杀不掉进行中的 `fsync` / `rename`；取消仍走工具执行的 `signal`，在系统调用边界尽力中止。

本地后端自己说：`config.cwd` 是相对路径的解析默认，**不是**围栏。出处：`packages/fs/fs-local/src/index.ts`。

```ts
/**
 * The host-filesystem backend. Reads resolve relative paths from {@link Config.cwd}
 * (a resolution default, NOT a containment boundary — see the filesystem
 * capability-seam Agent Note); enforce
 * containment with a stricter backend or a `tools/execute` permission plugin.
 */
```

面向模型的 `read` / `write` / `edit` 在 `dsh-tool-fs`。相对路径对着**这位**的会话 cwd 解析，不是服务器启动目录。出处：`packages/fs/tool-fs/src/session-cwd.ts`。

```ts
export function sessionCwd(exec: ToolExecution, requestedPath: string): string | undefined {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined || (!PARENT_PATH_SEGMENT.test(cwd) && !PARENT_PATH_SEGMENT.test(requestedPath))) return cwd
  return canonicalPath(cwd)
}
```

`write` 的执行顺序（本篇只记碰盘这一截，08 的 pre/guard/post 不重讲）：先 `sandbox.resolvePolicy`（站立模式，或经审批的一次性加宽——审批细节留给 14），再 `ctx.fs.resolve`，再 `fs/write-intent` waterfall 问要不要版本守卫，再 `writeText(..., exec.signal, sandboxPolicy)`，成功后 `fs/observed`。没有观测策略插件时，waterfall 的默认 thunk 返回 `undefined`，就是无条件覆盖。`dsh-fs-observation-policy` **不注册服务**，只听 `fs/*`；卸掉它，工具还在，只是不再要求先读后写。这和 08 的 `ctx.tools.guard()` 不是同一道门。

`FS_SANDBOX_DENIED` 是强制沙箱后端的策略拒绝；`FS_PERMISSION_DENIED` 是宿主内核拒绝。两码事。

---

## 院子篱笆：写盘是店里核路径，跑命令是包 argv

`SandboxMode` 只有三档，而且**只管辖文件效果**。出处：`packages/sandbox/sandbox/src/index.ts`。

```ts
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
```

`read-only`：拒绝写入（POSIX runner 仍给 `/dev/null` 这类必要水槽）。`workspace-write`：工作区根 + 后端承诺的临时区。`danger-full-access`：**绕过隔离**——消费方直接 spawn 原始 argv，**不**调用 `ctx.sandbox`。网络和进程可见性不在这套词里。

完整策略按**每次能力调用**解析，不焊在提供方上。出处同上。

```ts
export interface SandboxExecutionPolicy {
  mode: SandboxMode
  workspaceRoot: string
  sessionId?: SessionId
}
```

`ctx.sandboxPolicy.resolve()` 拥有优先级：已批准的显式模式 > 会话最后一条 `sandbox/mode` > 部署默认（缺省 `read-only`）。工作区根是会话不可变 cwd；没有会话时才用配置的 fallback。bash 和 fs 都来这里取，免得各写一套。

### 写文件：受信代码里的围栏，不是内核

`dsh-fs-sandbox` 扩展 `LocalFileSystem`，只在两次变更上加篱笆；读取原样通过——每种模式都允许读。包注释把威胁模型写死：这是对**模型控制的路径**做 canonicalize-then-contain，**不是**内核边界；不信任的**代码**才是 `ctx.shell` + `dsh-bash-sandbox` 的活。出处：`packages/fs/fs-sandbox/src/index.ts`。

```ts
private async checkedTarget(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsTarget> {
  const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
  const { mode } = policy
  if (mode === 'danger-full-access') return target
  if (mode === 'read-only') {
    throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
  }
  const fresh = await this.resolve(target.displayPath)
  // …writableRoots(policy) + isPathUnder(fresh.targetKey, root)…
  return fresh
}
```

可写根的含义只有一个家：`writableRoots`（`packages/sandbox/sandbox/src/roots.ts`）。Seatbelt 画像和 fs 围栏共用它，避免出现「write 工具不能写 `/tmp`、bash 却可以」。`workspace-write` 允许策略的工作区根、`/tmp`、以及 `os.tmpdir()`。

### 跑命令：包完 argv，仍走同一扇后门

`ctx.sandbox.confine(argv, policy)` 返回 `ConfinedArgv`（包过的 argv + 强制执行完整度 + 这一种 runner 的拒绝方言）。没有可用后端就抛 `SandboxUnavailableError`（`SANDBOX_UNAVAILABLE`）。静默无隔离透传永远不合法。`danger-full-access` 根本不走进这里。

本地提供方按平台选链：Linux `bwrap` 再 Landlock；macOS 只有 Seatbelt；Windows 只有 ACL 受限令牌。多候选才探测；唯一候选不探测，它自己拒绝仍是故障关闭。出处：`packages/sandbox/sandbox-local/src/index.ts`。

```ts
confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
  // …
  const selected = this.selectRunner(policy.mode)
  const runnerArgv = this.runnerArgv(selected.runner, policy)
  return {
    argv: [...runnerArgv, '--', ...argv],
    enforcement: selected.enforcement,
    denialSignatures: DENIAL_SIGNATURES[selected.runner],
    runnerFailureRules: RUNNER_FAILURE_RULES[selected.runner],
  }
}
```

`dsh-bash-sandbox` 是消费方：站在本地执行器上，把 `['bash', '-c', command]` 交给 `confine`，再 `runArgv` / `startArgv` 把**包过的 argv**交给 `ctx.subprocess`。前台 runner 没跑起来就抛 `SANDBOX_UNAVAILABLE`；后台只能在结算事实里标 `runnerFailed`。拒绝分类用**这一种**后端的 `denialSignatures`，不用跨后端并集。

工具层在真正执行前解析策略；模型若带 `sandbox_permissions` + `justification`，走共享的 `approveEscalation`（`packages/sandbox/sandbox/src/escalation.ts`），经 `ctx.approval` 要一次严格更宽的授权。人怎么点头、08 的 `tools/guard` 怎么否决，留给 14。这里只记：fs 和 bash **同一套**加宽梯子、同一句 `[sandbox: file access denied under <mode> mode]`。`dsh-tool-bash` 文件头还有一条 TODO：部署策略属于 `tools/pre-execute` 和沙箱执行器，不写进 bash 工具体。

---

## 后门：argv 不进 shell，收的是整棵树

`SubprocessSpawnSpec` 没有任何隐藏默认值：argv、cwd、每条流的处置、`graceMs`、可选的 abort signal、显式 env，全写在 spec 上。`argv` 在这一层**绝不**经 shell 解释。bash 消费方自己拼 `['bash', '-c', command]`——或者沙箱 runner 包过的那一串。

本地 spawn 在 POSIX 上 `detached`，好让拆除有一个进程组根；Windows 用 `taskkill /T`。出处：`packages/subprocess/subprocess-local/src/spawn.ts`。

```ts
const child = spawn(program, args, {
  cwd: spec.cwd,
  env,
  stdio: [/* ignore | pipe，按 spec */],
  detached: platform !== 'win32',
})
```

终止只有一个动词 `terminate()`：SIGTERM → `graceMs` → SIGKILL，范围是**整棵树**。abort signal 只触发这个动词，不负责给超时贴标签——那是调用方的（bash 执行器用融合 deadline 拆 `timedOut` / `aborted`）。出处同上。

```ts
const terminate = (): void => {
  if (treeExitObserved || graceTimer !== undefined) return
  void observeTreeExit()
  if (treeExitObserved) return
  kill('SIGTERM')
  graceTimer = setTimeout(() => { kill('SIGKILL') }, spec.graceMs)
}
const onAbort = (): void => { terminate() }
spec.signal?.addEventListener('abort', onAbort, { once: true })
```

凭据不会悄悄漏到巷子里：`scrubbedParentEnv()` 去掉名字像 KEY/PASSWORD/SECRET/TOKEN 的项，以及所有 `DSH_*`。调用方显式写入的 env 在清洗**之后**合并，所以有意转发才能留下。

本地服务把活句柄放进一个 `Set`，并用 **02 的 `ctx.effect`** 记账。出处：`packages/subprocess/subprocess-local/src/index.ts`。

```ts
constructor(ctx: Context) {
  super(ctx)
  ctx.effect(() => {
    const onHostExit = (): void => { this.terminateForHostExit() }
    process.prependListener('exit', onHostExit)
    return async () => {
      try {
        await this.disposeManagedProcesses()
      } finally {
        process.off('exit', onHostExit)
      }
    }
  }, 'local subprocess teardown')
}
```

`disposeManagedProcesses` 先 `terminate()`，再 `waitForExit()` 等到**整棵树**停稳，不是只等直接孩子。这是子进程**插件纤程**卸掉时的 LIFO，不是每位厨师工位上的 effect。文档原话：后台进程在组合拆除时被杀掉并等待；只重载执行器，进程还在——所有权在 `ctx.subprocess`。

`dsh-bash-local` 前台 `run` 把工具的 `exec.signal` 和超时融进 spawn spec 的 signal；后台 `start` 忽略 `timeoutMs`，`kill()` 就是 `running.terminate()`。面向模型的 `bash` 工具：前台把 `signal: exec.signal` 传下去；后台在 `ctx.jobs` 还没接手前若 `exec.signal` 已 abort 就拒绝 spawn，交出之后 `cancel: () => proc.kill()`，并写上 `owner: exec.agent`。任务 id 和所有权账本是 18 的活。

---

## 拆一位厨师：工位收刀，巷子里的火怎么灭

12 的拆除顺序还在：先 `cancel` 停催菜员，再 `scope.dispose()` 卸子纤程，再从名册拿掉。本篇补上磁盘和进程这一截——**不要**把「卸 `agent.ctx`」说成「卸 `ctx.subprocess`」。

| 还在烧的东西 | 谁来灭 | 挂在哪根纤程 |
|---|---|---|
| 进行中的前台 `read` / `write` / `edit` / `bash` | 工具执行的 `exec.signal` abort → fs 尽力中止；bash 的 spawn spec.signal → `terminate()` | 循环取消这张小票；**不是** `agent.ctx.effect` |
| 已经交给 jobs 的后台 bash | `jobs.start({ owner: exec.agent, run: () => ({ cancel: proc.kill, … }) })` | 通用任务运行时（18）；句柄背后仍是 `ctx.subprocess` 的 live set |
| 所有还活着的受管进程树 | `LocalSubprocessRuntime` 的 `'local subprocess teardown'` effect | 子进程**服务**那根插件纤程。卸组合才走；只卸一位厨师或只重载 bash 执行器，走不到这里 |
| Windows ACL 的私有临时授权 | `sandbox-local` 构造里的 `ctx.effect(() => () => this.revokeAclGrants())` | 沙箱提供方纤程 |
| 已观测文件版本 | 观测策略插件内部的 `WeakMap`；dispose 丢弃 | 策略插件纤程；不做任何文件 I/O |

工位上经 `agent.ctx` 登记的工具 / 提示词 / 监听器，拆一位就按 12 收回。`dsh-tool-fs` 和 `dsh-tool-bash` 的 `apply(ctx)` 通常挂在组合上下文上，是全店菜单，不跟某一档工位走。每次调用靠 `exec.agent` 读会话 cwd 和沙箱模式，靠 `exec.signal` 把取消铃递到后门。

所以：12 的子纤程管的是**登记**；本篇的后门管的是**活着的操作系统孩子**。两条 LIFO 叠在一起，但不是同一本账。

---

## 对回 01–02、12 与论文：只在对得上的地方连

| 机制 | 本包里的真名字 | 是否同一件事 |
|---|---|---|
| 02 的 `ctx.effect` / LIFO | `'local subprocess teardown'`；Windows ACL `revokeAclGrants`；观测策略 dispose 丢 WeakMap | **对得上形状**：装上就记账，卸纤程时杀树 / 收授权 / 丢观测。账记在**服务插件纤程**上，不是 `agent.ctx` |
| 12 的 `agent.ctx` / `createScope` | 工具经 `exec.agent` 读 session cwd；`exec.signal` 随取消走 | **对得上调用时的身份**。工位本身不是篱笆，也不是后门 |
| 01 的 `ctx.isolate` | 沙箱路径没有调用 | **对不上**。`danger-full-access` 也不是换 isolate realm |
| 08 的 `tools/guard` / `tools/pre-execute` | fs 走 `fs/write-intent` waterfall；bash 文件头 TODO 指向 pre-execute | **不是同一道门**。人审加宽走 `ctx.approval`，留给 14 |
| 论文 §3.1 可逆效应 | 杀子进程、等整棵树、关宿主 `exit` 监听、撤销 ACL | **对得上「痕迹必须收回」**。演算没有 `SandboxMode` / `confine` / `FsTarget` |
| 论文 Table 2 的 `ctx.isolate` | 本篇的院子篱笆 | **对不上**。篱笆是文件效果策略 + argv 包装，不是服务回路 |

不要把 `createScope` 说成沙箱。不要把 `fs-local` 的 `cwd` 说成工作区围栏。不要把卸一位 agent 说成卸 `ctx.subprocess`。运行时仍然不证明「杀树」真把巷子恢复原状——02 写过，那是组件作者的义务；这里的义务写在服务约定里：处置必须 terminate 并等待整棵树。

---

## 可以记住的几句

1. **三条缝，一个执行世界。** `ctx.fs` 管盘，`ctx.subprocess` 管进程树，`ctx.sandbox` 只包 argv。容器和远程沙箱换的是整条能力缝，不是来注册 `ctx.sandbox`。
2. **工位不是篱笆。** `agent.ctx`（12）限定登记；碰盘和出门仍是店里的插座。每次调用带着会话 cwd、按次策略、以及 `exec.signal`。
3. **储藏室先发工牌。** `resolve` → 不透明 `FsTarget`；子进程开门用 `processPath`。裸本地 `cwd` 只是解析默认。围栏在 `dsh-fs-sandbox` 的变更路径上，读取放行。
4. **院子只问文件效果。** `read-only` / `workspace-write` / `danger-full-access`。最后一档不调用 `confine`。没有 runner 就 `SANDBOX_UNAVAILABLE`，禁止静默透传。
5. **后门收的是树。** `terminate` = SIGTERM→宽限→SIGKILL；服务 dispose 等 `waitForExit`。这笔记在子进程插件的 `ctx.effect` 上。
6. **拆一位 ≠ 拆后门。** 前台靠小票 abort；后台交给 jobs（18）；组合卸掉才收光 live set。fs 和 bash 的加宽审批留给 14。

---

## 下一篇读什么

**14 · approval-guard**（审批、guard、策略）。

本篇已经看到碰盘和出门怎样走插座、篱笆钉在文件效果上、活进程记在子进程服务纤程上。下一篇读人怎么点头、08 的守卫怎样卡住一次调用。先不要跳进子 agent。

---

## 拉取记录

成功（默认分支是 `master`，不是 `main`；钉住 `47f943859bef60e4160492346772ded9b24f765a`；HEAD 与 12 相同）：

- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/packages/fs/{fs,fs-local,fs-sandbox,tool-fs}/src/…`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/packages/sandbox/{sandbox,sandbox-policy,sandbox-local}/src/…`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/packages/subprocess/{subprocess,subprocess-local}/src/…`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/packages/shell/{shell,bash-local,bash-sandbox,tool-bash}/src/…`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/{filesystem,sandbox,subprocess,shell,workspace}.zh.md`
- `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/packages/{fs,sandbox,subprocess,shell}/README.zh.md`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/packages/{fs,sandbox,shell,subprocess,workspace,host,terminal,code-runtime}`
- `https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/docs/subsystems`

404 / 不存在：

- **`packages/core/fs`**（课表「packages/ related to fs」的直觉起点；真实族在 `packages/fs/`）
- **`docs/sandbox.md`、`docs/filesystem.md`、`docs/subprocess.md`、`docs/shell.md`**（根 docs 没有这些文件；子系统页在 `docs/subsystems/*.md`）
- `packages/fs/fs/src/pipeline.ts`（没有单独流水线文件；工具执行仍走 08 的 `ctx.tools`）

文档与源码不一致（以源码为准）：

- **`dsh-workspace` 的「工作区」**是 GUI 名册（`ctx.workspaceRegistry`），与沙箱 / 工具层的 `workspaceRoot`（会话 `header.cwd`）同词不同物。子系统页自己也把 `dsh-agent-instructions` 排除在该注册表消费方之外。
- **包 README** 写 `fs-sandbox`「读取直接通过」。源码一致：只 override `writeText` / `editText`。不要把「沙箱后端」理解成读也被内核拦住——那是 bash runner 的活。
- **`dsh-tool-bash` 文件头 TODO** 仍把部署权限策略指向 `tools/pre-execute`；当前围栏在沙箱执行器 + `ctx.sandboxPolicy`，人审加宽在 `approveEscalation`。本篇不把 TODO 当成已实现的 guard。

审批、`tools/guard`、策略插件的产品细节，本篇未展开。
