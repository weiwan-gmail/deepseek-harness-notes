# 14 · 审批、guard、策略

课表：[source-curriculum.md](../source-curriculum.md) · 上一篇：[13 fs-subprocess-sandbox](13-fs-subprocess-sandbox.md) · 下一篇：[15 subagents](../source-curriculum.md)（待写）

读的是 DeepSeek Harness 真正跑的那份「人点头、插件把关、会话策略」的缝，不是自己再发明一套权限演算。
源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 钉住 | `master` @ `47f943859bef60e4160492346772ded9b24f765a`（`dsh@0.1.0-rc.5`；与 13 相同，已重核 HEAD） |
| Harness 文档 | `docs/subsystems/{approval,permission-presets}.zh.md`、`docs/architecture.zh.md`、`docs/capability-seams.zh.md`、`docs/tool-execution-pipeline.zh.md` |
| 审批缝 | `packages/interaction/user-approval/src/{index,types}.ts`（**没有** `packages/core/approval`；也没有根上的 `docs/approval.md`） |
| 权限预设 | `packages/interaction/permission-presets/src/index.ts` |
| 加宽共用件 | `packages/sandbox/sandbox/src/escalation.ts`（`approveEscalation`） |
| 消费方 | `packages/core/tools/src/index.ts`（`serviceAsk`）、`packages/shell/tool-bash/src/index.ts`、`packages/fs/tool-fs/src/sandbox.ts` |
| 应答者 | `packages/host/apiproxy/src/api-proxy.ts`（人）、`packages/acp/acp/src/index.ts`（机器；ACP 本身不在本系列主干） |
| 循环卫生 | `packages/guard/{timeout-policy,repeat-tool-reminder}/src/index.ts`（**不是** `ctx.tools.guard()`） |
| 包 README | `packages/interaction/{README,user-approval/README,permission-presets/README}.zh.md`、`packages/guard/README.zh.md` |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）§3.1 可逆效应、§3.2.3 定义 30–31 余效应拦截；**没有** `ApprovalPolicy` / `allowed-once` / `permission/preset` 对象 |

本篇钉子：13 已经把院子篱笆钉在**文件效果**上。08 已经把工具流水线读成检查员 / 守卫 / 厨师 / 装盘。本篇不把那两条再讲一遍。这里只读：**谁可以临时把篱笆拉开一截**、一道工具怎样停下来等人点头、点头记在哪、一次签字和长期挂账分别是哪根旋钮、守卫插件怎样挂在 `ctx.effect` 上——卸掉它们，更严的默认会回来。

子 agent 怎样继承策略，留给 15。


---

## 厨房：领班可以特批，也可以把单子递给老板

13 的院子已经围好篱笆。今晚有人要点一道篱笆外的菜。后厨不能自己拆篱笆。

- **领班不点头，只递单。** 店里有一个专门管「问一声」的人：把问题写成小票，递给今晚值班的老板；老板不在，这道菜就不做。领班自己没有「我觉得可以」的章。
- **一次签字。** 老板在这张单上签了，只放行**这一道**。下次同一道菜再来，还要再问。墙上没有「从此这道菜随便做」的长条。
- **长期挂账是另一本。** 店主可以把整间院子改成「全开、别再问我」（拆篱笆 + 关掉问询），或者改成「无人对班、问了也拒」（CI 通宵档）。那是换院子规矩，不是给某一道菜办年卡。
- **硬规矩还在。** 店主写死的否决只能否决，不能把别人已经拒的单再放行。卫生巡视挂在出餐轨上，卸掉巡视员，轨还在，只是没人掐表、没人提醒。

对应到 `dsh`，领班是 `ctx.approval` 这份 Cordis Service：`request()` 记账并分发，自己不当应答者。

把单子递给老板走 waterfall，最内层默认 unavailable（关门，不是放行）。
人这边的值班老板是 Web 宿主 apiproxy：把问询推到 mux，等人 respond。
机器这边是 ACP 桥的 requestPermission，选项只有 allow-once / reject-once。ACP 本身不在本系列主干，这里只当应答者提一句。
一次签字是 ApprovalOutcome 里唯一的准许：allowed-once。源码里没有年卡，没有记住的规则，也没有授权仓库。
长期挂账是 permissionPresets：把 sandbox/mode 和 approval/policy 捆成一张表。默认 workspace-write + ask；全开是 danger-full-access + never。never 在分发应答者之前就 rejected。
店主硬规矩是 tools.guard（08 已读，只能否决，是 ctx.effect）。卫生巡视在 packages/guard：超时包装、重复调用提醒，挂 ctx.on，不是 tools.guard。

架构原话（docs/architecture.zh.md 核心包表）只点到 core/tools 的「带把关的执行流水线」。审批不在那张核心表里。能力图（docs/capability-seams.zh.md）把 ctx.approval 标成 seam：一次性决策走 approval/request waterfall；没有应答者时以 unavailable 关闭失败。dsh-base 组合包把「沙箱与审批策略」放进每个 profile 的第一层。

包注释把职责写成一句。出处：packages/interaction/user-approval/src/index.ts。

```ts
/**
 * Service Definition for the approval capability seam, covering requests, cancellation, audit, and per-session policy. Missing
 * answerers fail closed; grants apply only to the requested action.
 * @module @deepseek-ai/dsh-user-approval
 */
```

ApprovalService 才是 Cordis Service，`super(ctx, 'approval')`。工具注册表**不**静态注入它：`ctx.get('approval')` 拿不到就退化成拒绝。

---

## 没有 `packages/core/approval`

课表写「读 packages 里跟 approval / guard / policy / permissions 有关的」。真实目录里：

- 审批缝在 **`packages/interaction/user-approval/`**，不是 `packages/core/`。
- 权限预设在 **`packages/interaction/permission-presets/`**。
- 顶层 **`packages/guard/`** 是循环卫生家族（超时、重复提醒），不是人审。
- 根 docs 没有 `docs/approval.md`；子系统页在 `docs/subsystems/approval.zh.md`。也没有 `docs/subsystems/guard.zh.md`。

`interaction/` 族 README 原话：这些是**产品**包，由用户直接操作的真实接口。自动化走 ACP；`dsh` CLI 直接组合这些包。

---

## 一次签字：问、记一对账、只有 allowed-once 放行

结果词汇是闭合的。出处：`packages/interaction/user-approval/src/types.ts`。

```ts
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
```

包 README 写明：词汇里**没有** allow-always、已记住的规则、撤销或授权存储；会话策略只有 ask / never。ACP 桥注释同样写：只提供一次性选择，绝不从未知客户端响应推断出持久授权。

`request()` 要求当前会话处于尚未结束的轮次里——审计对必须落在 turn/start 与 turn/end 之间，否则重载时会被当成崩溃尾巴丢掉。然后发一个全新的 ApprovalRequestId，先追加 approval/asked，再决定，再追加配对的 approval/decided。任一端 append 在提交前失败，Promise 拒绝，不会返回一条没入账的决定。出处：packages/interaction/user-approval/src/index.ts。

顺序就是：asked → decide → decided。请求有意不带工具参数。应答者看见工具名、原因、可选 callId；UI 把提示贴到已经流式出去的那张 tool/call 卡片上。08 已经写过：小票在执行前入账，参数改了会对不上。

`decide` 里，`never` 在 waterfall **之前**由服务自己判掉。注释写明：后来用 prepend 挂上的应答者不能绕过它——只有服务自己的 request 路径能保住「never 一定拒」。`ask` 才进入瀑布；最内层默认 `unavailable`。应答者抛错、返回词汇外的值，一律收成 `unavailable`。信号 abort 则 `cancelled`，迟到的答案丢掉。

审计事件只写入日志，**不进**模型 transcript。模型看见的是消费方据此写成的工具结果，外加运行时上下文快照里那句完整的策略说明（ask 或 never 各有一句；策略没变就不另贴）。这是 06 的排放：问过、点过的头，回放还在；活着的应答者听筒卸掉就没人接。

---

## 一道工具怎样停下来等人

两条入口，不要混成一条流水线。08 的 `tools/pre-execute` 可以返回 `{ kind: 'ask' }`；产品里真正把篱笆加宽的 bash / write / edit，停在**工具体里**、出门 / 写盘**之前**。

### 流水线的 ask：注册表代问

`PreToolDecision` 第三种是 `ask`。注册表 `prepareExecution` 看到它，就走内部的 `serviceAsk`：`ctx.get('approval')`，没有服务、没有 agent，都退化成 deny。只有 `allowed-once` 才变成 allow，随后才跑 08 那道单调守卫。出处：`packages/core/tools/src/index.ts` 的 `serviceAsk`。

这是通用门禁。当前第一方 bash / fs **没有**靠 pre-execute 返回 ask 来加宽院子——它们走下面这条。

### 工具体里的加宽：approveEscalation

`dsh-tool-bash` 文件头仍有 TODO：部署权限策略属于 `tools/pre-execute` 和沙箱执行器。13 已经记下这句还没兑现。今天真正的人审加宽在 `execute()` 里：模型带上 `sandbox_permissions` + `justification`，工具在跑命令之前调用 `approveEscalation`。`dsh-tool-fs` 的 write / edit 共用同一份函数。出处：`packages/sandbox/sandbox/src/escalation.ts`。

梯子是严格变宽：read-only 可以去 workspace-write 或 danger-full-access；workspace-write 只能去 danger-full-access。不是加宽的请求**不会**弹出人审。缺服务、缺 agent、被拒、被取消、没人接，一律 throw；注册表把 throw 收成这次调用的 isError 结果，命令还没跑。准许只盖在**这一次**调用的 `SandboxExecutionPolicy.mode` 上，不改会话的长期模式。模型被教导：先跑、读到 `[sandbox: file access denied …]`，再在同一轮用最窄的更宽档重试一次；会话若声明审批已关闭，就不要设 `sandbox_permissions`。

谁可以拉开篱笆：模型只能**请求**一次加宽（permissions 字段 + 一句话理由），不能自己改会话模式。人 / ACP 应答者对这一张问询回 allowed-once 或拒，不能签发「以后都准」，也不能绕过 never。用户切权限预设，改的是会话的沙箱模式 + 审批策略（长期挂账），不是给某一道菜办年卡。没挂应答者的部署默认 unavailable，消费方当拒绝。

Web 宿主把问询变成 mux 上可回答的帧（approval/requested），等人 respond；代理 dispose 时把还挂着的条目结算成 cancelled。ACP 为自己拥有的 agent 提供机器决定。两种应答者都是 `ctx.on('approval/request', …)`——04 已经写过，`ctx.on` 走进 `fiber.effect`。卸掉宿主或 ACP 插件，听筒摘掉，瀑布掉回 unavailable。这就是 02 的形状：装上才能放宽「有人可问」；卸掉，更严的关门默认回来。

---

## 长期挂账：预设捆两根旋钮，不是记住的准许

一次签字解决不了「今晚这桌要不要一直开着后门」。那是另一张表。PermissionPresetService（ctx.permissionPresets）把 sandbox/mode 和 approval/policy 捆成具名预设。

默认表两项：workspace-write = 沙箱 workspace-write + 策略 ask（工作区里可写，再宽要问）；danger-full-access = 沙箱 danger-full-access + 策略 never（全盘可写、不再弹审批）。

`set(session, name)` 先追加只记日志的 permission/preset（保住用户选的是哪一个名字，两个预设若捆同一组值也不糊），再只对实际变了的旋钮走各自的规范 setter：setSandboxMode、setApprovalPolicy。执行、提示词、回放仍然读旋钮自己的折叠，不读预设名。custom 只能推导得出，不能选、不能写入事件。

活 agent 切策略走 approval.setPolicy：除了写日志，还 agent.inject 一条插件来源的用户消息，好让模型在下一步看见。新会话在 session/created 时把三件事实钉进日志；已有 seed 的会话只补缺失项，不拿最新的用户默认去覆盖。

把长期挂账说成年卡准许是错的。never 的含义是：问询在见到应答者之前就被拒。
它和全开沙箱捆在一起，是因为篱笆已经拆了，模型被明确告知不要再申请更宽档。
通宵档也可以单独设 never，那时篱笆未必拆，只是没人可问。
服务要求挂着有约束能力的 ctx.shell（有 sandboxMode）和 ctx.approval。预设表是进程级配置，改表要重载插件。


## 两套把关

第一套是 ctx.tools.guard()，08 已经读过。登记仍是 layers.effect 再进 ctx.effect。返回字符串就是最终拒绝；undefined 就是不管。没有 allow。卸插件等于 undo 那一行，否决消失，流水线回到 pre 放行之后不再多一道硬拒。这是 02 的 LIFO，方向是卸掉额外否决。本篇不把 08 的三段瀑布再讲一遍。

第二套住在顶层 guard 目录。族 README 说它们监视循环里的无效模式，并套单次调用预算。它们是核心服务的自包含消费方，不是可替换能力。
一份挂在厨师那一站套钟；一份挂在装盘那一站，反复同一道只提醒、不否决。
两份都是 ctx.on，随插件纤程 dispose（04 / 02）。它们都不调用 tools.guard()。掐钟那份的文件头还有 FIXME，想在首次打 tag 前改名，说明连上游都觉得这个词容易糊。
反复提醒用 WeakMap 记连续次数；卸插件，这张表随纤程丢掉。这和 13 观测策略丢掉 WeakMap 是同一形状：账记在插件纤程上，不是 agent.ctx。
人审坐在 ctx.approval；卫生巡视坐在工具瀑布上。卸应答者，问询关门（更严）；卸掐钟插件，不再套这层钟（更松）。「卸插件恢复更严的默认」对得上的是审批瀑布的 unavailable，以及只否决不放行的 tools.guard()——对不上掐钟包装。

---

## 对回 02、08、13 与论文：只在对得上的地方连

02 的 ctx.effect / LIFO：应答者的 ctx.on；tools.guard 的 layers.effect；掐钟 / 提醒的 ctx.on；apiproxy 卸掉时把挂起的问询结算掉。对得上形状：装上记账，卸纤程摘听筒。审批瀑布的默认是关门。

08 的 pre-execute ask：注册表 serviceAsk 再进 ctx.approval.request。对得上这条门。第一方 bash / fs 的加宽另外走 approveEscalation，在工具体里，不在 pre。

13 的院子篱笆：会话 sandbox/mode；一次 allowed-once 只盖在这一次调用的 mode 上。对得上「谁可以加宽」。篱笆仍是文件效果；人审不是第二道内核围栏。

论文第三节可逆效应对得上「痕迹收回」。演算里没有 ApprovalOutcome。
定义 30–31 的 intercept：本篇源码没有调用 ctx.intercept。对不上。策略不是给 ctx.fs 或 ctx.tools 叠余效应元数据。
Table 2 的 isolate：审批、预设都对不上。换预设不是换 isolate realm。

不要把 permissionPresets 说成 Cordis 的策略演算。不要把顶层 guard 目录说成 tools.guard()。不要把 never 说成永远允许。不要把一次 allowed-once 说成改了会话的沙箱模式。

运行时仍然不证明应答者真是那位店主——02 写过，那是组件作者的义务；这里的义务写在缝上：缺应答者必须关门，准许只覆盖所问的那一次。

---

## 可以记住的几句

1. **领班记账，老板点头。** ctx.approval.request 先写 asked，再问瀑布，再写 decided。服务自己不当应答者。
2. **只有一次签字。** 准许词汇是 allowed-once。没有年卡、没有记住的规则。ACP 也只给 allow-once / reject-once。
3. **加宽篱笆的是人，盖的是这一次。** bash / fs 在执行前走 approveEscalation；准许只改这一次调用的 mode。会话长期模式走预设，不走这次签字。
4. **长期挂账是两根旋钮捆在一起。** workspace-write+ask 对 danger-full-access+never。never 是问询前必拒，不是永远允许。
5. **缺应答者就关门。** 瀑布默认 unavailable。卸掉 apiproxy / ACP 听筒（ctx.on → effect），默认回来。
6. **两套把关。** tools.guard() 只能否决；顶层 guard 目录是掐钟和重复提醒。都挂在 effect 上，都不是论文的 intercept。

---

## 下一篇读什么

**15 · subagents**（子 agent 提供方）。

本篇已经看到人怎样点头、一次签字怎样入账、预设怎样换院子规矩、把关插件怎样随纤程卸掉。approval/policy 事件上有一个 source?: 'delegation'，给子会话播种覆盖——下一篇读子 agent 怎样另开一档、策略怎样传下去。先不要跳进 skills / MCP。


---

## 拉取记录

成功（默认分支是 master，不是 main；钉住 47f943859bef60e4160492346772ded9b24f765a；HEAD 与 13 相同）：

- packages/interaction/user-approval/src/{index,types}.ts
- packages/interaction/permission-presets/src/index.ts
- packages/sandbox/sandbox/src/escalation.ts
- packages/core/tools/src/index.ts（serviceAsk）
- packages/shell/tool-bash/src/index.ts
- packages/fs/tool-fs/src/{index,sandbox}.ts
- packages/guard 下 timeout-policy 与 repeat-tool-reminder 的 src/index.ts
- packages/host/apiproxy/src/api-proxy.ts
- packages/acp/acp/src/index.ts
- docs/subsystems 下 approval.zh.md 与 permission-presets.zh.md
- docs/architecture.zh.md 与 docs/capability-seams.zh.md
- interaction 族与 guard 族 README.zh.md
- GitHub API：commits/master、contents/packages、code search

404 / 不存在：

- packages/core/approval（课表直觉起点；真实缝在 packages/interaction/user-approval/）
- docs/approval.md、docs/subsystems/guard.zh.md（子系统页是 docs/subsystems/approval.zh.md；guard 族没有单独子系统页）
- packages/interaction/permission/（README 表格写 permission/ 链到 permission-presets；目录名是 permission-presets/）

文档与源码不一致（以源码为准）：

- dsh-tool-bash 文件头 TODO 仍把部署策略指向 tools/pre-execute。当前人审加宽在工具体里的 approveEscalation；通用 ask 门在注册表 serviceAsk。不要把 TODO 当成已实现的 pre-execute 插件。
- 能力图表把 ctx.approval 的消费方写成 tools 和 tool-bash。源码里 tool-fs 的 write / edit 同样走 approveEscalation；表上没写。所属包写成 approval，真实目录是 packages/interaction/user-approval。

- 架构「新行为的归属位置」表没有「添加审批应答者」一行。应答者挂的是 approval/request，不是 agent/* 或 tools/*。
- 权限预设 README 写 /permissionPresets 命令；源码注册的命令名是 permission。Settings namespace 是 permission，不是 permissionPresets。
- 顶层 guard 目录与 ctx.tools.guard() 同词不同物。前者是掐钟 / 重复提醒；后者是单调否决表。

子 agent 委托时的 source: delegation、以及 user-questions 那条平行的「问人」缝，本篇未展开。
