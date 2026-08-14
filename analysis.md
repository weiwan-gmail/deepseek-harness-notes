# DeepSeek Harness / Cordis 论文精读

> 本文是对预印本 *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿，修订中）以及 DeepSeek Harness / Cordis 开源实现的对照精读。
>
> **读者设定**：聪明、但不一定熟悉 AI Agent 或类型论。先用生活类比，再对照原文记号。
>
> **准确性约束**：公式、定理名、页码、引用均来自论文 PDF/文本与公开仓库；未在原文或仓库中出现的数字、指标、论文引用一律不编造。公式若在 `pdftotext` 抽取中乱码，会标明并只在上下文无歧义时复原。

---

## 元信息（先核对）

| 项 | 内容 |
|---|---|
| 英文标题 | A Programming Paradigm for Spatiotemporal Composability |
| 中文可译 | 一种面向时空可组合性的编程范式 |
| 作者 | Yifan Shi（史一帆）、Wei Zhang（张伟）、Tianyi Cui（崔天一） |
| 单位 | 史一帆：北京大学 + DeepSeek-AI；张伟：北京大学；崔天一：DeepSeek-AI（封面标注 `1 Peking University`、`2 DeepSeek-AI`） |
| 日期 | 2026 年 8 月 13 日草稿；GitHub 声明 *preprint under active revision* |
| 页数 | **88 页**（`pdfinfo`）；正文 8 节 + References |
| 章节 | 1 Introduction · 2 Preliminaries · 3 Revertible Effects and Reactive Coeffects · 4 A Calculus of Dynamic Composition · 5 Implementation and Case Study · 6 Discussion · 7 Related Work · 8 Conclusion |
| 论文仓库 | https://github.com/cordiverse/paper |
| 实现 | Cordis：https://github.com/cordiverse/cordis ；Harness：https://github.com/deepseek-ai/deepseek-harness |
| 案例 | Koishi 聊天机器人框架（论文称已运行约 4 年、超过 4000 个社区插件；Koishi 当时用 Cordis v3，论文写的是 v4） |

论文**没有**给出吞吐量、延迟、准确率一类评测数字。Koishi 一节明确说这是「存在性与采用」证据，不是对照实验；量化开销与开发者生产力是未来工作。

---

## 这篇论文在讲什么（先用生活类比）

想象一间可以随时改布局的厨房。

- 你今天装了一台咖啡机：它占用插座、占用台面、往水槽接了一根排水管。明天你把它拆走，插座、台面、排水管都应该回到装机前的样子——**不能留下半截管子，也不能把邻居的冰箱一起拔掉**。
- 咖啡机还依赖「有电」「有水」。水停了，它不该硬冲；电来了，它才该自动醒来。水又通了，它该重新工作，而不是整间厨房断电重启。

论文把这两件事分别叫做：

1. **时间可组合（temporal composability）**：拆掉一个部件时，它留下的痕迹必须能被完整、有序地收回。
2. **空间可组合（spatial composability）**：部件之间的依赖要能被声明出来，并且在依赖出现、消失、换人时自动重接。

传统软件大多是「编译时拼好、运行时别动」。插件系统、以及论文特别点名的**会自我改写的 AI Agent 运行时（self-evolving agent harness）**，却要求运行中随时装卸零件。现有做法往往是粗粒度的：整个进程重启、整个容器换掉。重启会丢掉缓存、连接、进行中的任务；容器编排又表达不了「同一进程里两个模块互相依赖」。

论文的主张是：把类型论里两个老概念——**effect（效应，程序对环境做了什么）** 和 **coeffect（余效应，程序需要环境提供什么）**——从编译期注解提升成**运行时机制**：

- **可逆效应（revertible effects）**：每次改环境，都带上一份「怎么改回去」的说明书，运行时负责记账。
- **反应式余效应（reactive coeffects）**：每个部件声明自己需要什么；环境一变，系统对照这份声明，决定是激活、停用，还是没事。

然后把两者收进同一个 **Context（上下文）**，再给出一套**动态组合演算**，证明：单个部件的保证，可以抬到一整棵互相交错的部件树上。工程实现就是 **Cordis**；DeepSeek Harness（`dsh`）是把这套东西用在 AI Agent 上的产品——「一切都是插件」。

生活类比到此为止。下面先补齐两个词，再进论文本身。

---

## 什么是 AI Agent，Harness 又是什么

**大语言模型（LLM）** 本身只会根据已有文字续写文字。它不知道你电脑上有哪些文件，也不能自己去跑命令。

**AI Agent（智能体）** 是把模型放进一个循环里：模型看当前对话与工具清单 → 决定是回复人，还是调用工具（读文件、跑命令、搜网页）→ 工具结果写回对话 → 再问模型。这个「想一步、做一步、再想」的循环，就是 Agent。

**Harness（挽具 / 运行时骨架）** 不是模型本身，而是把循环、工具、权限、会话记录、沙箱、界面拼在一起的那一层软件。OpenAI、Anthropic 近年也公开谈过 harness engineering；论文引用了这类工程文章，以及 LLM Agent 综述。没有 harness，模型只是聊天框；有了 harness，模型才能在真实环境里做事。

DeepSeek Harness 的口号是 **everything is a plugin**：模型适配器、工具注册表、会话日志、**连 Agent 循环本身**都是插件，都可以从配置替换。底下的插件框架就是 Cordis。论文写的是 Cordis 的形式基础；Harness 仓库是这套基础在 Agent 产品上的落地。论文第 8 节把「自我演化的 agent harness」标成**未来验证方向**，不是已经完成的评测。

---

## 论文要解决的问题

### 静态组合已经很成熟，动态组合没有

第 1 节开篇：组合是软件工程的基本原则，但传统组合是静态的——函数调用、模块导入、类继承在编译期就定死。现代软件越来越要求**动态组合**：运行中加载、卸载、改配置。插件架构和自我演化的 agent harness 都需要安全地热插拔功能，现有实践却常常退回「整进程重启、丢掉运行时状态」。动态组合的形式基础，远不如静态组合发达。

### 两个正交维度（第 1.1 节）

在代数意义的「怎么把零件拼起来」之外，论文单独抽出：

- **时间维**：卸下一个部件时，它对外共享环境的修改必须被完整、安全地反转。这要求跟踪它做过的每一次资源分配、事件注册、状态改写，并保证拆除时按序回收。
- **空间维**：部件必须能以结构化、可核验的方式声明、发现、解析彼此的依赖；依赖拓扑变了，生命周期要跟着协调。

静态世界里，时间维退化成词法作用域（RAII、bracket），空间维退化成模块导入解析。动态世界里，效应的寿命不再被词法括号框住，依赖也会在运行中出现、消失、换身份。

### 两个动机例子

**插件系统（以 VSCode 为例，第 1.2.1 节）。**

- 时间上的限制：扩展跑在共享的 extension host 里。装得进去，但没有「只卸这一个扩展的代码」的机制。`activate` 跑过之后，禁用或卸载要重启整个 host，所有扩展一起受影响。纯声明式扩展（主题、快捷键、snippet）可以随便卸；但按安装量前 100 的扩展里，**87 个带可执行代码**（脚注：数据取自 2026-06-09 的 VS Code Marketplace），卸它们就要重启。`deactivate` 只是进程退出时的礼貌回调，不是热卸载；而且它把「创建效应」和「清理效应」拆到两个函数，违背关注点局部性，完整清理很难核验。
- 空间上的限制：`extensionDependencies` 几乎没人用——前 100 里只有 **7 个**对非内置扩展声明了依赖。扩展 API 提供的是固定、表层的扩展点（命令、视图、语言功能），扩展往宿主贡献，而不是彼此依赖。跨扩展交互走 `vscode.extensions.getExtension(...).exports`，默认是 `any`，没有结构化契约。

论文说这两点不是 VSCode 独有，插件系统里反复出现，只是程度不同。

**自我演化的 Agent Harness（第 1.2.2 节）。**

现代 Agent 依赖运行时 harness：工具套件、执行环境、权限与沙箱、会话与持久化、上下文与记忆、子 Agent 与多 Agent 工作流、对人与自动化的接口。未来的 harness 可能一边服务请求，一边生成并部署对自己部件的修改。模型合成可复用工具，是「部件级自我修改」的较窄前驱。每一次这样的修改，都是一次动态组合。

没有时间可组合：每次自我修改都要全量重启，丢掉进程内累积状态；频率一高，不可用时间可观，进行中的任务反复被打断；更糟的是，一次错误的自我修改可能把用来恢复的进程本身弄死。没有空间可组合：每个模块只能用临时手段探测依赖的出现、消失、换身份；朴素的「换一段代码」可能悄悄弄坏依赖方，或引入只有重载时才暴露的循环依赖。

### 粗粒度权宜之计及其代价（第 1.2.3 节）

操作系统在**进程**粒度上给时间可组合；容器编排在**服务**粒度上给空间可组合。多数软件靠重启进程、靠编排器管依赖来凑合。代价是：

- 时间上：每次重启丢掉缓存、连接、部分计算结果，重建要数秒到数分钟；为了中间还能用，往往要冗余副本。
- 空间上：容器级编排表达不了同一地址空间里的依赖，本该是本地函数调用的交互被逼成网络调用。

粒度错位，要求一种和部件本身同级的组合抽象。

### 五项贡献（第 1.3 节，原文编号）

1. 形式化 **revertible effects**（§3.1）：每个上下文变换带显式逆，运行时跟踪；跟踪与恢复都保持组合，卸部件时上下文被恢复。这是**局部时间可组合**。
2. 形式化 **reactive coeffects**（§3.2）：部件用一份规格声明所需余效应；上下文每次变化都对照规格通知：激活 / 停用 / 中性。这是**局部空间可组合**。
3. 把效应上下文和余效应上下文收成**单一上下文类型**（§3.3）；余效应上的观察等价给效应提供独立性，构成一种编程范式。
4. 给出**动态组合演算**（§4）：把两套机制收成「部件」，配上操作语义；元理论把时空可组合从单个部件抬到交错的整系统。
5. 实现 **Cordis**（§5）：元框架，核心库做效应跟踪与余效应解析，声明式加载器做配置调和与热模块替换。


---

## 两个核心概念：时间可组合 vs 空间可组合

先用厨房，再用论文的词。

| | 时间可组合 | 空间可组合 |
|---|---|---|
| 生活 | 拆咖啡机，台面恢复原样 | 没电就别冲咖啡；来电再自动工作 |
| 静态世界 | RAII / 析构 / `try/finally` | `import` / 依赖注入容器 |
| 动态难点 | 效应寿命不被词法括号框住 | 依赖会在运行中出现、消失、换身份 |
| 论文机制 | 可逆效应：每次改动带逆，运行时记账 | 反应式余效应：声明依赖，变化时重分类 |
| 局部保证 | 一个部件自己的效应能被收回 | 一个部件只在依赖齐了才激活 |
| 全局保证 | 多个部件交错改环境，卸其中一个仍只收回它自己的贡献 | 提供方撤绑定之前，所有依赖它的部件先卸完；激活期间看到的绑定不偷偷换人 |

第 2 节把这两维接到经典理论：

- 效应系统把判断写成 \(\Gamma \vdash t : T^{\mathrm{effect}}\)（原文 (1)）：类型上标注「这段计算可能对外界做什么」。Monad、代数效应与 handler（`handle e with { op(v, κ) ↦ … }`，原文 (2)）是主流工具。
- 余效应系统把判断写成 \(\Gamma^{\mathrm{coeffect}} \vdash t : T\)（原文 (3)）：上下文上标注「这段计算需要环境给什么」——资源、权限、服务。Comonad、分级余效应（pre-ordered semiring）是对偶工具。

论文的关键转向（第 2.3 节）：经典效应/余效应是**静态仪器**——词法作用域里跟踪，编译期 handler 卸掉；余效应注解对照的是执行前就定好的上下文。动态组合要求这些保证对「部署之后才装进来的插件」也成立。所以他们不往类型系统上再堆注解，而是把效应和余效应**具体化成运行时能操作的对象**。

---

## 公式与推导（逐步、对照原文记号）

下面按论文编号走。记号尽量保持原文；`pdftotext` 把部分花体字母抽成带组合字符的形式，下文写成 \(\mathcal{V}\)、\(\mathcal{A}\)、\(\mathfrak{D}\) 等常见数学字体，并在首次出现时对照原文。

### 3.1 可逆效应：每次改动都带「怎么改回去」

#### 把脏函数变成「改上下文」

任意不纯函数 \(f_{\mathrm{impure}} : X \to Y\) 被改写成纯形式 \(f : \Gamma \times X \to \Gamma \times Y\)。\(\Gamma\) 是上下文，所有副作用都表示成对 \(\Gamma\) 的变换。固定输入 \(x\) 后，\(\gamma \mapsto \mathrm{pr}_1(f(\gamma, x))\) 就是与返回值无关的副作用。这些变换在复合 \(\circ\) 下构成幺半群：封闭、结合、单位元是 \(\mathrm{id}_\Gamma\)。

要能撤销，就把每个变换 \(f\) 配上另一个变换 \(g\)，满足 \(g \circ f\)（只要求左逆，不要求 \(f \circ g\)）。全文把 left inverse 简称为 inverse。

**定义 1（扭曲复合，原文 (4)）。**

\[
(f_1, g_1) \circ (f_2, g_2) \;\;\coloneqq\;\; (f_1 \circ f_2,\; g_2 \circ g_1)
\]

左边的作用在右边之后；逆按相反顺序堆积。\((\Gamma\to\Gamma)\times(\Gamma\to\Gamma)\) 以此成为幺半群，单位元 \((\mathrm{id}_\Gamma,\mathrm{id}_\Gamma)\)，称为 \(\Gamma\) 上的**扭曲复合幺半群** \(\mathfrak{T}_\Gamma\)。

**定义 2（效应上下文，原文 (5)）。**

\[
\partial\Gamma \;\;\coloneqq\;\; \Gamma \times (\Gamma \to \Gamma)
\]

一对 \((\gamma, \varphi)\)：\(\gamma\) 是当前状态；\(\varphi\) 是**累加器**，把到目前为止所有逆复合在一起，用来回到初始状态。初始效应上下文是 \((\gamma_0, \mathrm{id}_\Gamma)\)。还可以写 \(\partial^2\Gamma = \partial\Gamma \times (\partial\Gamma \to \partial\Gamma)\)，一层层塔上去。

**定义 3（track，原文 (6)）。**

\[
\mathrm{track}_\Gamma : (\Gamma\to\Gamma)\times(\Gamma\to\Gamma) \to \partial\Gamma \to \partial\Gamma
\]
\[
\mathrm{track}_\Gamma = (f,g) \;\mapsto\; (\gamma,\varphi) \mapsto (f(\gamma),\; \varphi \circ g)
\]

对 \(\gamma\) 做 \(f\)，把逆 \(g\) 接到 \(\varphi\) 上。

**定理 4（track 与底层变换交换，原文 (7)）。** 对每个 \((f,g)\)，

\[
\mathrm{pr}_1 \circ \mathrm{track}_\Gamma(f,g) = f \circ \mathrm{pr}_1
\]

证明只是展开：\(\mathrm{pr}_1(f(\gamma),\varphi\circ g)=f(\gamma)\)。直观：记账不改变「真正发生的那次变换」。

**定理 5（track 是幺半群同态，原文 (8)）。**

1. \(\mathrm{track}_\Gamma(\mathrm{id}_\Gamma,\mathrm{id}_\Gamma)=\mathrm{id}_{\partial\Gamma}\)
2. \(\mathrm{track}_\Gamma((f_1,g_1)\circ(f_2,g_2)) = \mathrm{track}_\Gamma(f_1,g_1)\circ\mathrm{track}_\Gamma(f_2,g_2)\)

证明：单位元显然；复合时 \((f_1(f_2(\gamma)), \varphi\circ g_2\circ g_1)\) 正好是扭曲复合再 track。直观：先记两笔账，等于先把两笔合成一笔再记。

**定义 6（recover，原文 (9)）。**

\[
\mathrm{recover}_\Gamma(\gamma,\varphi) = (\varphi(\gamma),\; \mathrm{id}_\Gamma)
\]

用累加器把状态拉回去，并把 \(\varphi\) 重置为单位。

**定理 7（恢复不变，原文 (10)）。** 若 \(g(f(\gamma))=\gamma\)，则

\[
\mathrm{recover}_\Gamma(\mathrm{track}_\Gamma(f,g)(\gamma,\varphi)) = \mathrm{recover}_\Gamma(\gamma,\varphi)
\]

逐步：右边变成 \((\varphi(g(f(\gamma))),\mathrm{id}_\Gamma)=(\varphi(\gamma),\mathrm{id}_\Gamma)\)。一串效应由定理 5 合成一次 track，再套定理 7，得到原文 (11)：整串 track 之后再 recover，等于一开始就 recover。从 \((\gamma_0,\mathrm{id}_\Gamma)\) 出发，恢复目标永远是它自己。\(\varphi(\gamma)=\gamma_0\) 称为 \(\partial\Gamma\) 的**健全性不变量（soundness invariant）**。

生活类比：每装一件电器就在抽屉里放一张「怎么拆」的纸条（\(\varphi\) 是纸条叠）。拆厨房时按反序执行纸条，台面回到第一天。

#### 逆不是事先写死的：效应函数

`track` 要求同一个 \(g\) 对所有状态都管用，而且 `recover` 是一锅端，不能只撤一笔。于是输入侧改成「做完再交逆」：\(\Gamma\to\partial\Gamma\)；输出侧改成「还可以再交一层逆」：\(\partial\Gamma\to\partial^2\Gamma\)。

**定义 8（效应函数与带见证的效应函数，原文 (12)）。**

\[
\mathfrak{E}_\Gamma \;\coloneqq\; \Gamma \to \Gamma\times(\Gamma\to\Gamma)
\]

\(\mathfrak{E}_\Gamma^*\) 再加一个见证：对每个 \(\gamma\)，若 \(e(\gamma)=(\delta,g)\)，则 \(g(\delta)=\gamma\)。逆只被要求在「它被交出来的那个状态」上把效应撤掉，别处不管。若某个 \(g\) 满足 \(g\circ f=\mathrm{id}_\Gamma\)，则 \(\gamma\mapsto(f(\gamma),g)\) 对每个状态都见证。

**定义 9（效应复合 \(\diamond\)，原文 (13)）。** \(f,g\in\mathfrak{E}_\Gamma\)：

\[
(f\diamond g)(\gamma) = \mathbf{let}\;(\delta,s)=g(\gamma)\;\mathbf{in}\;\mathbf{let}\;(\varepsilon,t)=f(\delta)\;\mathbf{in}\;(\varepsilon,\; s\circ t)
\]

先做 \(g\) 再做 \(f\)，逆按反序接。

**定理 10。** \((\mathfrak{E}_\Gamma,\diamond)\) 是幺半群，单位元 \(\eta_\Gamma=\gamma\mapsto(\gamma,\mathrm{id}_\Gamma)\)；\((f,g)\mapsto\gamma\mapsto(f(\gamma),g)\) 是 \(\mathfrak{T}_\Gamma\to\mathfrak{E}_\Gamma\) 的同态。

**定理 11。** \(\mathfrak{E}_\Gamma^*\) 是子幺半群；定理 10 的同态把每个满足 \(g\circ f=\mathrm{id}_\Gamma\) 的对送进 \(\mathfrak{E}_\Gamma^*\)。

**定义 12（effect 提升，原文 (14)）。**

\[
\mathrm{effect}_\Gamma : \mathfrak{E}_\Gamma \to \partial\Gamma \to \partial^2\Gamma
\]

\[
\mathrm{effect}_\Gamma(e)(\gamma,\varphi) = \mathbf{let}\;(\delta,g)=e(\gamma)\;\mathbf{in}\; \bigl((\delta,\;\varphi\circ g),\; \mathrm{track}_\Gamma(g,\;\mathrm{pr}_1\circ e)\bigr)
\]

提升后的逆本身也是一次 track：撤 \(e\) 就是做 \(g\)，再撤这次「撤」就是再做一次 \(e\)（\(\mathrm{pr}_1\circ e\)）。

**定理 13（effect 保持 \(\diamond\)，原文 (15)）。** \(\mathrm{effect}_\Gamma(f)\diamond\mathrm{effect}_\Gamma(g)=\mathrm{effect}_\Gamma(f\diamond g)\)。

**定理 14。** 写 \(f=\mathrm{pr}_1\circ e\)，\(e'=\mathrm{effect}_\Gamma(e)\)，\(f'=\mathrm{pr}_1\circ e'\)。则 \(\mathrm{pr}_1\circ f'=f\circ\mathrm{pr}_1\)；在每个 \((\gamma,\varphi)\) 上，提升后的逆与底层逆也通过 \(\mathrm{pr}_1\) 对齐（这就是定理 4 用在 \(g'=\mathrm{track}_\Gamma(g,f)\) 上）。

**定理 15（提升后的逆恢复到哪，原文 (16)）。** \(e\in\mathfrak{E}_\Gamma^*\)，\((\delta,g)=e(\gamma)\)，\((\Delta,g')=\mathrm{effect}_\Gamma(e)(\gamma,\varphi)\)，则

\[
g'(\Delta)=(\gamma,\;\varphi\circ g\circ f)
\]

状态被精确恢复。累加器也恢复（即 \(\mathrm{effect}_\Gamma(e)\in\mathfrak{E}_{\partial\Gamma}^*\)）当且仅当 \(g\circ f=\mathrm{id}_\Gamma\)。无论哪种，\((\varphi\circ g\circ f)(\gamma)=\varphi(\gamma)\)，健全性不变量保住。

**定理 16（LIFO 撤销）。** \(e_1,\ldots,e_n\in\mathfrak{E}_\Gamma^*\) 从 \((\gamma_0,\mathrm{id}_\Gamma)\) 起按序应用，再按反序撤销：每一步撤销都回到它当初作用的状态；每个中间状态满足健全性不变量。不需要独立性假设——因为每个逆正好拿到「自己当初交出来时」的那个状态。

#### 独立性：别人插队之后，我的逆还能撤我自己

定理 16 管「按记账顺序撤」。但卸一个还在跑的部件时，后面别人已经又改过环境；几个部件的效应还会交错。这时逆碰到的是被别人挪过的状态，能不能只撤自己、不动别人，是交换问题。

**定义 17（变换幺半群）。** \(\mathfrak{M}(e)\) 是由 \(e\) 的前向映射以及它在各状态交出的所有逆生成的 \(\Gamma\to\Gamma\) 子幺半群（原文 (17)）。

**引理 18。** 交换性在生成元上判定即可；\(\diamond\) 不会把变换幺半群撑出 \(\langle\mathfrak{M}(e_1)\cup\mathfrak{M}(e_2)\rangle\)。

**定义 19（独立）。** \(e_1,e_2\) 独立，当且仅当：

1. 双方所有变换两两交换：\(\forall f\in\mathfrak{M}(e_1),\; g\in\mathfrak{M}(e_2).\; f\circ g=g\circ f\)（原文 (18)）；
2. 一方的变换不扰动另一方交出的逆：\(\forall g\in\mathfrak{M}(e_2),\;\gamma.\; \mathrm{pr}_2(e_1(g(\gamma)))=\mathrm{pr}_2(e_1(\gamma))\)，对称亦然（原文 (19)）。

由对 \((f_i,g_i)\) 诱导的效应，条款 (2) 自动成立（逆处处相同）。

**定理 20。** 两两独立的 \(e_1,\ldots,e_n\) 从 \(\gamma_0\) 按序应用。固定 \(j\)，把 \(e_j\) 从序列里拿掉后的状态记为 \(\delta'_u\)。则对每个 \(u\ge j\)：\(\delta_u=f_j(\delta'_u)\) 且 \(g_j(\delta_u)=\delta'_u\)；后面的 \(e_i\) 在「没做过 \(e_j\)」的状态上交出的逆，与原来相同。

直观：独立时，\(e_j\) 的逆可以从「后面已经叠了很多别人的改动」的状态上，一刀切回「从来没做过 \(e_j\)」的状态。

**推论 21。** 同样假设下，在最终状态 \(\delta_n\) 上按**任意排列**执行这 \(n\) 个逆，都回到 \(\gamma_0\)。LIFO 是其中一种排列（定理 16 甚至不需要独立）；独立买到的是所有其他顺序，以及第 4.4.2 节整条系统轨迹上的交错。

局部时间可组合的判据（论文原话的意思）：一个部件应用的每一串效应，累加器都能回到起点（定理 7），并且按反序撤销时每个逆都拿到自己当初的状态（定理 16）。装部件 = 应用这串并往 \(\varphi\) 里堆逆；卸部件 = 跑 \(\varphi\)。独立（推论 21）再补上「不按记账顺序撤」和「中间夹着别人」。独立不成立时，顺序必须另找地方扛：部件内部靠累加器的 LIFO（§4.3.2），部件之间靠声明的余效应（§4.3.1）。

### 3.2 反应式余效应：依赖要能被声明，并且跟着环境变

空间可组合：部件声明彼此依赖，系统在运行时解析、提供、撤回。依赖是否满足，必须在共享上下文每次变化时重评：齐了就激活，撤了就停用。

**定义 22（余效应上下文，原文 (20)）。** 给定类型族 \(\mathcal{V}:K\to\mathrm{Type}\)，

\[
\Sigma \;\coloneqq\; (k:K) \rightharpoonup \mathcal{V}_k
\]

\(\sigma:\Sigma\) 是有限偏函数。写法：\(\sigma(k)\)、\(\sigma[k\mapsto v]\)、\(\sigma\setminus k\)、\(k\in\mathrm{dom}(\sigma)\)。同一 key 不能提供两次，也不能撤一个不存在的 key；违反前置条件报错、不产生转移。

**定义 23（get / set，原文 (21)）。**

\[
\mathrm{get}(k)(\sigma)=\sigma(k)\qquad(k\in\mathrm{dom}(\sigma))
\]
\[
\mathrm{set}(k,v)(\sigma)=\bigl(\sigma[k\mapsto v],\; \lambda\sigma'.\;\sigma'\setminus k\bigr)\qquad(k\notin\mathrm{dom}(\sigma))
\]

关键观察：\(\mathrm{set}(k,v)\) 的类型正好是 \(\mathfrak{E}_\Sigma^*\)——余效应操作本身就是可逆效应。于是 §3.1 的整套 track/recover 直接套上来：**余效应操作是效应，效应可逆。** 这是两套机制的交汇。

**定义 24（一个 key 上的余效应）。** 三元组 \((\mathcal{V}_k,\;\simeq_k,\;\mathcal{A}_k)\)：值类型、比较用的等价、以及该值提供给持有者的操作集。操作 \(a\in\mathcal{A}_k\) 的类型是原文 (22)：

\[
a : X_a \to \mathcal{V}_k \rightharpoonup \mathcal{V}_k \times (\mathcal{V}_k\rightharpoonup\mathcal{V}_k) \times B_a
\]

前两份构成带见证的效应函数，第三份是结果。操作必须尊重 \(\simeq_k\)。提升到整个 \(\Sigma\) 是原文 (23)：只改 \(k\) 那个绑定，别的 key 不动。

满足谓词（原文 (24)）：

\[
\sigma \models d \;\coloneqq\; \forall k\in d.\; k\in\mathrm{dom}(\sigma)
\]

可判定（\(\mathrm{dom}(\sigma)\) 有限）。所有对 \(\sigma\) 的改动都走效应函数，所以满足性的变化在每个效应边界都能被看见——这是反应性的代数基础。

**定义 25。** 余效应规格 \(\mathfrak{D}_\Sigma \coloneqq \mathsf{Set}(K)\)：部件向环境声明的依赖集合。

**定义 26（通知分类，原文 (26)）。**

\[
\mathrm{notify}_d(\sigma,\sigma') =
\begin{cases}
\mathrm{activating} & \sigma\not\models d \;\land\; \sigma'\models d \\
\mathrm{deactivating} & \sigma\models d \;\land\; \sigma'\not\models d \\
\mathrm{neutral} & \text{否则}
\end{cases}
\]

激活 → 执行部件效应（全程跟踪）；停用 → 跑累加器恢复。精确操作语义在第 4 节。

局部空间可组合的判据：部件只在规格被满足的状态激活，所以从不读缺席的绑定；每次上下文变化都对照规格分类，满足性丢失会就地被发现并驱动停用。

单向顺序已经有了：\(A\) 提供 \(k\)、\(B\) 声明 \(k\in d_B\)，则 \(B\) 只能在 \(A\) 激活并提供 \(k\) 之后激活。反过来不行：卸 \(A\) 会拆掉 \(k\)，通知本身不能保证 \(B\) 拆自己时还能读到 \(k\)，也不能拦住 \(A\) 的恢复直到 \(B\) 拆完。这是**全局**保证，放到 §4.3.1。

#### 隔离与拦截（§3.2.3）

扁平表不够：同一逻辑依赖可能要给不同部件绑不同值。

**定义 27（两种实现方式）。** 效应函数可以：

- **原地（in-place）**：改原上下文，交非平凡逆；恢复跑逆。
- **派生（derived）**：原上下文不动，交出一个从它派生的新上下文，逆是恒等；恢复就是丢掉派生上下文。

纯函数里两者重合；命令式宿主可以按操作选。隔离和拦截被直接做成派生实现。

**定义 28（带隔离的余效应上下文，原文 (27)）。**

\[
\Sigma^{\mathrm{iso}} \;\coloneqq\; (K\rightharpoonup R)\times\bigl((r:R)\rightharpoonup\mathcal{V}_r\bigr)
\]

一对 \((\rho,\sigma)\)：\(\rho\) 把 key 分到隔离域（realm）；不在 \(\mathrm{dom}(\rho)\) 的 key 以自身为域（\(R\supseteq K\)）。访问 \(k\) 先看 \(\rho(k)\) 再看 \(\sigma(r)\)。

**定义 29（get / set / isolate，原文 (28)）。** get/set 的前置条件沿 \(\rho\) 搬运；\(\mathrm{isolate}(k,r)\) 派生一个把 \(k\) 指到 \(r\) 的新上下文，表本身不动。已隔离的 key 是改派，不是拒绝。\(\mathrm{set}\) 仍是 \(\mathfrak{E}^*_{\Sigma^{\mathrm{iso}}}\)，可逆；\(\mathrm{isolate}\) 不需要逆。

**定义 30（带拦截的上下文与规格，原文 (29)）。**

\[
\Sigma^{\mathrm{inter}} \;\coloneqq\; \bigl((k:K)\to\mathcal{M}_k\bigr)\times\bigl((k:K)\rightharpoonup(\mathcal{M}_k\to\mathcal{V}_k)\bigr)
\]
\[
\mathfrak{D}^{\mathrm{inter}} \;\coloneqq\; (k:K)\rightharpoonup\mathcal{M}_k
\]

\(\iota\) 是上下文自带的元数据（默认空 \(\epsilon_k\)）；\(\sigma(k)\) 是「元数据 → 值」的提供方函数。每个 key 的元数据带幺半群 \((\mathcal{M}_k,\oplus_k,\epsilon_k)\)。

**定义 31（get / set / intercept，原文 (30)）。** 访问时算 \(\sigma(k)(d(k)\oplus_k\iota(k))\)：部件声明的元数据与上下文携带的元数据合并，右偏，所以 \(\iota(k)\) 优先，外层上下文可以约束部件怎么用一个余效应而不改部件代码（§6.3 的权限例子）。

### 3.3 上下文范式：一个类型同时扛效应和余效应

**定义 32（统一上下文，原文 (31)）。**

\[
\Gamma_\infty \;\coloneqq\; \mu\Gamma.\; \Gamma \times (\Gamma\to\Gamma) \times \Sigma
\]

三份投影：递归的当前状态、本层累加器、余效应表。\(\mathrm{effect}\) 把 \(\mathfrak{E}_{\Gamma_\infty}\) 映到自身，\(\partial\)-塔收成自相似类型。\(\mathcal{V}\) 不受限，任何要跨部件共享的状态都可以做成一个依赖——\(\Sigma\) 吞下的不只是「模块依赖」，而是全部共享可变状态。部件与环境的每次交互都经过这一个实体。

递归结构支持树状层级：父上下文聚合子级效应。装 = 执行效应（插入）；卸 = 恢复效应（拔出，不影响旁人）；不同层独立装卸。

#### 观察等价：恢复不必是比特级复原

定理 7 写的是状态相等，但这是理想化：`free` 不会把堆布局恢复成 `malloc` 前那样；生成式名字丢了再造是新的。所以 §3 的等号都应读成某个等价 \(\simeq\)。论文取**观察等价**：没有观察者能分辨，就算一样。观察者手里只有余效应，每个余效应自带一份 \(\simeq_k\)（定义 24）。

**定义 33（原文 (32)）。**

\[
\sigma\simeq\sigma' \;\coloneqq\; \mathrm{dom}(\sigma)=\mathrm{dom}(\sigma') \;\land\; \forall k\in\mathrm{dom}(\sigma).\; \sigma(k)\simeq_k\sigma'(k)
\]
\[
\gamma\simeq\gamma' \;\coloneqq\; \sigma_\gamma\simeq\sigma_{\gamma'}
\]

没被任何 key 绑住的部分被忘掉——堆布局、生成式名字若不出现在某个 key 上，就不参与比较。相关状态有相同定义域，所以 \(\sigma\models d\) 和 \(\mathrm{notify}_d\) 在 \(\Sigma/\simeq\) 上仍然良定。

**定义 34（不可分辨 \(\approx_{\mathcal{A}}\)）。** 在操作集 \(\mathcal{A}\) 上，一次测试是各 \(\mathfrak{M}(a)\) 生成元上的有限字。两个值不可分辨，当且仅当每个测试在两边同时有定义或同时无定义，且结果相同。

**引理 35。** 不可分辨是操作所尊重的最粗关系；每个可接受的 \(\simeq_k\) 都含于 \(\approx_{\mathcal{A}_k}\)，且后者本身可接受。

**定义 36–37。** 映射尊重 \(\simeq\)；\(\mathfrak{E}_\Gamma^*\) 改读为：\(e\) 作为 \(\Gamma\to\partial\Gamma\) 尊重 \(\simeq\)，且 \(g(\delta)\simeq\gamma\)、\(g\) 也尊重 \(\simeq\)。取 \(\simeq\) 为相等就回到定义 8。

**引理 38。** 如此改读后，§3.1 里每一条状态相等都把 \(=\) 换成 \(\simeq\) 仍成立；从 \((\gamma_0,\mathrm{id}_\Gamma)\) 走到的每个状态，其累加器都尊重 \(\simeq\)。

**定义 39 / 定理 40。** 操作独立 = 提升后的效应函数独立，且不扰动对方的结果（原文 (35)）。**不同 key 上的操作一定独立**——各自只读写自己的绑定。

**定义 41（余效应中介的效应函数）。** \(\mathfrak{E}_\Sigma^{\mathcal{A}}\) 是含单位元、并对「做一次操作再按结果选后续」封闭的最小集（原文 (36)）。

**定理 42。** 若 \(e_1,e_2\in\mathfrak{E}_\Sigma^{\mathcal{A}}\)，且双方都用到的每个 key 都是交换的（定义 39），则 \(e_1,e_2\) 独立（定义 19）。

这就是 §3.1.3 留下的假设如何被卸掉：只要共享位置都做成 key，且这些 key 的接口是交换的（注册路由、注册监听是典型；有序中间件链不是），部件的效应函数就独立，整系统的时间可组合才站得住。交换性是**提供该 key 的部件的义务**，不是消费方的义务。系统无法收成余效应的位置，落在 §6.1 的边界之外，定理也不管。

#### 范式在光谱上的位置（§3.3.3）

- **显式穿状态（函数式）**：State 单子 \(S\to(A,S)\)，效应在类型里看得见，但每层都要传状态，效应一多就单子叠罗汉。
- **隐式突变（命令式 / OOP）**：React 的 `useEffect` 既不把效应目标也不把注册机制做成参数；Java / Spring 的 service locator 运行时从进程级注册表取依赖，关系散落各处。

上下文范式：效应和余效应都经过**显式的上下文参数**，每次操作都能追到是哪个上下文、因而哪个部件做的；同时开发者只需为每个原子操作提供逆、为每个部件声明依赖，复合逆和重接线由运行时自动完成。本来靠纪律的正确性，变成范式的结构性质。


---

## 动态组合演算在说什么

第 3 节只给了**局部**保证。抬到整系统，要把系统拆成部件：每个部件 = 一份余效应规格 + 一份带见证的效应函数。第 4.1–4.2 节先给最小演算（转移原子、立即、不会失败）；第 4.3 节丢掉这三条，得到真实运行时实现的演算；第 4.4 节证明保持、全局时空可组合、进展、合流。

### 部件、纤程、注册表

**定义 43（部件，原文 (37)）。**

\[
\mathfrak{C}_\Gamma \;\coloneqq\; \mathfrak{D}_\Gamma \times \mathfrak{P}_\Gamma \times \mathfrak{E}_\Gamma^*
\]

三元组 \((d,p,e)\)：\(d\) 是声明的依赖；\(p=\mathsf{Set}(K)\) 是它**可以**提供的 key（效应函数不得写 \(p\) 以外的 key）；\(e\) 是激活时贡献的效应及撤回用的逆。同一注册表里任意两根纤程的 \(p\) 不相交——这是「单源提供」纪律。带隔离的演算会把不相交放松到「同一 realm 内不相交」；本章不引入 realm，每个 key 只有一个可能的提供方。因此，有非空 \(p\) 的部件同时只能有一根纤程；多次实例化的是「只消费、或只去注册别人」的部件。

**定义 44（纤程 fiber）。** 部件的一次实例化：\(\langle d,p,e,\pi,\sigma,\tau,\theta\rangle\)。

- \(\pi\)：父纤程名，或根标记 \(\mathsf{root}\)
- \(\sigma\)：这根纤程自己的余效应表，激活前为空
- \(\tau\)：退役旗，新鲜为 \(\bot\)，编排器退役后为 \(\top\)
- \(\theta\)：生命周期。两状态模型里 \(\Theta_\Gamma=\mathsf{Inactive}\mid\mathsf{Active}(g,\omega)\)（原文 (38)），\(g\) 是累加器，\(\omega:d\to\mathfrak{N}\) 是**已提交视图**（激活时每个声明 key 由哪根纤程提供）

**定义 45。** 状态 \(\gamma\) 带着注册表 \(F_\gamma:\mathfrak{N}\rightharpoonup\mathfrak{F}_\Gamma\)，父指针成树。余效应上下文是**算出来的，不是另存一份**（原文 (40)）：

\[
\sigma_\gamma \;\coloneqq\; \bigcup\{\sigma_m \mid m\in\mathrm{dom}(F_\gamma),\; \theta_m=\mathsf{Active}(-,-)\}
\]

并只对 **Active** 纤程取并。提供方一旦离开 Active（例如进入 Unloading），它的 key 立刻从 \(\sigma_\gamma\) 消失，依赖方会看到不满足——但绑定本身还在，拆依赖方时还能读。这是后面「先停服务、再等依赖方拆完、最后才跑逆」的关键。

**定义 46（目标视图，原文 (41)–(42)）。**

\[
\mathrm{target}_n(\gamma) =
\begin{cases}
\bot & \text{若 }\tau_n\text{ 或 }\gamma\not\models d_n \\
(k\in d_n)\mapsto\mathrm{provider}_k(\gamma) & \text{否则}
\end{cases}
\]

静止 \(\mathrm{quiet}(\gamma)\)：每个 Inactive 纤程的 target 是 \(\bot\)，每个 Active 纤程的 target 等于它的已提交视图 \(\omega_n\)。实现里 \(\omega\) 存在 `fiber.committed`，target 的摘要存在 `fiber.target`（§5.1.3）。

### 基础五规则（§4.2）

编排规则（编排器可做，前缀 O-，写成 \(\Rightarrow\)）与生命周期规则（前提成立就自发走，前缀 L-，写成 \(\longrightarrow\)）分开：

- **O-Insert**：新鲜名字、父存在、提供集与已有不相交 → 插入一根 Inactive 纤程
- **O-Retire**：无条件把 \(\tau\) 置 \(\top\)（退役是请求，不是立刻删）
- **O-Remove**：已退役、已 Inactive、没有孩子 → 从注册表拿掉（更早删会丢掉累加器、泄漏）
- **L-Reload**：Inactive 且 target \(\neq\bot\) → 跑 \(e_n\)，进入 \(\mathsf{Active}(g,\omega)\)
- **L-Unload**：Active 且 target \(\neq\omega\) → 跑累加器，回到 Inactive

**定义 47。** 效应函数的一次应用（或一次迭代）可以注册另一个部件：正向是带 \(\pi=n\) 的 O-Insert，逆是对该纤程的 O-Retire（不是 O-Remove，因为 Remove 有前提，逆必须在它被拿到的任何状态都能跑）。

**定义 48（禁闭 confined）。** 效应函数只能改自己那根纤程的 \(\sigma\)，只能读自己声明过的表；不能读别人的控制字段。这样第 4.4 节才能把 Table 1 当成完整的写集合。

规则是非确定性的：多根纤程同时该动时，不规定顺序。也不提调度器——对所有序列成立的定理，对任何调度策略都成立。

### 进行中的转移（§4.3）：真实运行时的四件事

**定义 49（加宽后的生命周期，原文 (43)）。**

\[
\Theta_\Gamma = \mathsf{Inactive}(\zeta) \mid \mathsf{Reloading}(i,g,\omega) \mid \mathsf{Active}(g,\omega) \mid \mathsf{Unloading}(g,\omega,\zeta)
\]

\(\zeta\) 是结局：\(\bot\) 或错误集 \(\Xi\) 里的一个错。`installed` = 不是 Inactive；`failed` = Inactive 带着错误。静止条件相应加宽（原文 (45)）：失败的 Inactive 也算静止（它不再重入）。

对应 Figure 2：Inactive ─L-Begin→ Reloading ─L-Iter 循环─ L-Finish→ Active；Reloading 也可 L-Divert / L-Raise 进 Unloading；Active ─L-Leave→ Unloading ─L-Unload→ Inactive。

**§4.3.1 撤回（Withdrawal）。** 基础 L-Unload 把「不再提供」和「跑逆」挤在同一步，依赖方拆自己时读不到正在被撤的 key（关连接池往往要把连接还回去）。于是拆成两步：

**定义 50（被依赖 relied，原文 (46)）。** 某根**已安装**的别的纤程，其已提交视图把某个 key 指到 \(n\)。

- **L-Leave**：Active 且 target \(\neq\omega\) → 标成 Unloading，**立刻不再出现在 \(\sigma_\gamma\) 里**，但 \(\omega\) 还在
- **L-Unload**：Unloading 且 \(\neg\mathrm{relied}_n(\gamma)\) → 这才跑累加器

守卫看起来会死锁。不会，是因为 L-Leave 之后 \(n\) 已不在 \(\sigma_\gamma\) 里，没有任何新的 target 还会点名 \(n\)，所有曾经提交到 \(n\) 的消费者自己也在往外走。定理 66 证明守卫总会放开。

**§4.3.2 迭代。** 激活可以是一串效应，中间允许被打断。

**定义 51（效应迭代器，原文 (47)）。**

\[
\mathfrak{E}_\Gamma^{\mathrm{iter}} \;\coloneqq\; \mu\mathfrak{I}.\; \Gamma \to \Gamma\times(\Gamma\to\Gamma)\times\mathsf{Maybe}(\mathfrak{I})
\]

每步交出 \((\delta,g,o)\)：新状态、本步的逆、以及 `Nothing`（结束）或 `Just(i')`（下一步）。见证按 \(\simeq\) 读。这就是主流语言 `yield` 所暴露的定界续延。

**定义 52（effectiter，原文 (48)）。** 每步把逆接到 \(\varphi\) 上；`Just` 时递归。累加器按 LIFO 恢复。整个迭代器本身也是一个效应。

规则：

- **L-Begin**：Inactive(\(\bot\)) 且 target \(\neq\bot\) → Reloading(\(e_n,\mathrm{id}_\Gamma,\omega\))
- **L-Iter**：target 仍是 \(\omega\) 且迭代器交出下一步 → 累加器接上新逆，继续 Reloading
- **L-Finish**：target 仍是 \(\omega\) 且迭代器结束 → Active
- **L-Divert**：target 变了 → 带着目前的累加器进 Unloading（可中止当前迭代，或让它落地再卸；粒度就是迭代器边界）

平凡效应函数 = 第一步就 `Nothing`：仍然经过 Reloading，但要么全部装上，要么什么都没装。

**§4.3.3 异步。** 一步可以是 `Future`：提交和落地之间外界会变。一旦发射，这一步**必须落地**（惯性 inertia），不能中途拒收。target 在飞行中变了，只能走 L-Divert「落地再卸」那一支。实现里就是 reload 与 unload 互相链式调用。卸完若 target 又不是 \(\bot\)，L-Begin 可以立刻再激活。

**§4.3.4 失败。** 迭代器可在交出三元组的位置 raise（原文 (49) 的 \(\mathfrak{E}_\Gamma^{\mathrm{fail}}\)）。**L-Raise**：Reloading 上 raise → Unloading，带着错误结局；然后仍走唯一的 L-Unload。失败记在纤程上，不传给父，兄弟继续跑——这是插件宿主想要的。`L-Begin` 要求 `Inactive(⊥)`，失败纤程不会对着没变的环境重试。

十规则一览（论文 Table 1）：O-Insert / O-Retire / O-Remove / L-Begin / L-Iter / L-Finish / L-Divert / L-Raise / L-Leave / L-Unload。

### 元理论（§4.4）——整系统上的保证

约定：状态相等按观察等价 \(\simeq\) 读；另有 \(\approx\) 表示「控制字段以外都一样」（效应看 \(\approx\)，规则是否可触发看 \(\simeq\)）。从空注册表出发，每根纤程都由 O-Insert（编排器的或迭代器注册的）进入。一步分解为 \(\gamma^{t+1}=\mathrm{edit}^t(\Psi^t(\gamma^t))\)（原文 (52)）：\(\Psi\) 是状态映射（迭代器前向或累加器），edit 改控制字段。

**引理 54。** 对照 Table 1 + 禁闭：表 \(\sigma\) 只被当事纤程的 \(\Psi\) 改；\(\omega\) 只在 L-Begin 出现、只在 L-Unload 消失，一集（episode）内恒定；只有 L-Unload 跑累加器；installed 的进出只由 L-Begin / L-Unload；\(\pi,d,p,e\) 写入后不再改，\(\tau\) 单调只升到 \(\top\)。

**引理 55（\(\simeq\)-不变）。** \(\simeq\) 相关的状态上，同一规则对同一纤程同时可触发或同时不可，到达的状态仍 \(\simeq\)。

**引理 56（等变）。** 纤程名的双射重命名与规则交换。

**引理 57（残留条目 vestigial）。** 退役、Inactive(\(\bot\))、空表、且无孩子的条目，与「纤程不存在」在规则看来无法区分。

**定义 58 / 定理 59（保持 Preservation）。** 良形注册表：父指针落地、提供集两两不交、已安装纤程的 \(\omega\) 全定义且指向仍在的纤程、\(\omega\) 指向的纤程仍 installed。任一步都保持良形。L-Unload 的守卫是条款 (3)(4) 的关键：不会有陈旧 \(\omega\) 指名一根已被 Remove 的纤程，所以名字可以回收。

**定义 60。** 把独立性从效应函数扩到迭代器：生成元包括可达续延上的所有前向与逆；还要求续延本身不被对方扰动。

**定理 61（恢复精确性 Recovery exactness，原文 (56)）。** 步骤两两独立时，纤程 \(n\) 的一集 \([b,u]\) 内，在 \(\gamma^u\) 上跑 \(g_n^u\)，得到的状态 \(\approx\) 「从 \(\gamma^b\) 起只跑那些**不是** \(n\) 的步骤」会到达的状态。也就是：**跑逆只撤掉这根纤程的贡献，别的原样留下。**

**推论 62（终端恢复，原文 (57)）。** 一集关闭时（无论结局是成功还是失败），\(\gamma^{u+1}\) 就是「这根纤程从未开始」时别人会走到的状态。失败纤程对外界的贡献是零。

**定理 63（顺序 Ordering）。**

- L-Begin 只在 \(\gamma\models d_m\) 时发生（原文 (58)）
- 若 \(m\) 的已提交视图把 \(k\) 指到 \(n\)，则：整集里这个指向不变；\(n\) 的集严格包住 \(m\) 的集（提供方比消费方先装、后卸）；在 \(m\) 的整集里，\(k\) 一直在 \(n\) 的表里且值不变

**定理 64（解析连贯 Resolution coherence）。** 一集开头的 Reloading 区间里，每一次 L-Iter / L-Finish 都对着同一份 \(\omega\)（原文 (59)）。离开这段区间时恰有两支：L-Finish 进入 Active；或 L-Divert / L-Raise 然后按推论 62 恢复。飞行中的迭代仍按旧解析落地——惯性使保证变成析取，第二支让第一支安全。

**定义 65（先于 \(\prec\)，原文 (60)）。** \(n\prec m \iff p_n\cap d_m\neq\emptyset\)（\(n\) 可能提供 \(m\) 声明的 key）。\(\prec\) 无环是**假设**，不是定义推出来的（自依赖会 \(n\prec n\)）。

**定理 66（进展 Progress）。** 假设 \(\prec\) 无环、每个 \(e_n\) 长度 \(\le K\)、名字集有限、每步都是生命周期规则。则：

1. 不静止 ⇒ 某条生命周期规则可触发（无死锁；Unloading 链沿 \(\prec\) 上升，有限故停）
2. 作用在 \(n\) 上的步数 \(S(n)\le(K+4)(V(n)+1)\)，\(V(n)\) 是 target 翻转次数，两者都有限

因此每条极大生命周期序列都停在静止状态。证明不依赖「中止迭代」那支 L-Divert，所以受惯性约束的宿主也覆盖。

**定义 67–70 / 引理 71–72。** 「被支持」的纤程（未退役、注册它的纤程被支持、依赖的提供方被支持）在无环 \(\prec\) 下良基；静止且无失败时，被支持集恰好是仍 Active 的那些（每个部件对其 \(p\) 是 total，定义 69）。转置引理：独立步骤可交换而不改终点。删除引理：关掉的一集可以被抽掉。

**定理 73（合流 Confluence）。** 到达一个无失败的静止状态、步骤两两独立、部件对其提供 total 时：

1. **标准形**：可重排成「编排步骤保持原相对顺序，生命周期按支持序 \(\triangleleft\) 的线性化，每根存活纤程恰好一集」
2. **合流**：从同一 \(\gamma^0\) 出发、做同一串编排步骤的任意两条这样的序列，到达的状态在重命名后既 \(\simeq\) 又 \(\approx\)

失败被排除在陈述外，因为它是真正的分叉源：同一步在不同状态下可能 raise 也可能完成。但由推论 62，两条静止状态只在那根纤程的生命周期字段上不同，对外贡献都是零。

定理 73 许可把 Cordis 应用**当成静态组装来推理**：编排器加、减、换提供方、再换回去，最终状态等于一开始就写下最终名单再装一次。它保证的是**状态**，不是沿途对外发出的那些不可收回的排放（§6.1 的 acquisition vs emission）。

---

## 工程落地：Cordis 怎么实现

第 5 节把形式模型收成三层：核心库（§5.1）→ 部件加载器（§5.2）→ 应用框架如 Koishi（§5.3）。Cordis 是**元框架**：不规定 Web / ORM / UI，只提供通用动态组合语义。

### 理论 ↔ 运行时（论文 Table 2，照录对应关系）

| 理论 | 实现 |
|---|---|
| \(\Gamma_\infty\) | `ctx`，一等上下文 |
| \(\mathfrak{E}_\Gamma,\mathfrak{E}_\Gamma^{\mathrm{iter}}\) | 返回 / yield 逆的 Effect 回调 |
| \(\mathrm{effect}_\Gamma(e)\) | `ctx.effect(callback)` |
| \(\Sigma,\Sigma^{\mathrm{iso}},\Sigma^{\mathrm{inter}}\) | `ctx[@@store]`、`ctx[@@isolate]`、`ctx[@@intercept]` |
| get / set | `ctx.get(key)` / `ctx.set(key, value)` |
| isolate / intercept | `ctx.isolate(key, realm)` / `ctx.intercept(key, metadata)` |
| 纤程 \(\langle d,p,e,\pi,\sigma,\tau,\theta\rangle\) | `fiber` |
| \(\mathrm{dom}(F_\gamma)\) | `ctx.registry` |
| \(n\) | `fiber.uid` |
| \(d\) | `fiber.inject` |
| \(p\) | 部件的 `provide` |
| \(e\) | `fiber.apply` |
| \(\pi\) | `fiber.parent.fiber.uid` |
| 派生实现 | `fiber.ctx`（纤程在其中运行的子上下文） |
| \(\theta\) | `fiber.state`（LOADING = Reloading；FAILED = Inactive(\(\xi\))） |
| 累加器 \(g\) | `fiber.dispose` |
| \(\omega\) | `fiber.committed` |
| \(\mathrm{target}_n(\gamma)\) | `fiber.target`（`refresh` 重算；\(\bot\) = INACTIVE） |
| Future / 惯性 | `fiber.inertia` |
| O-Insert / O-Retire | `ctx.use` 及其回调的逆 |
| L-Begin / L-Iter / L-Finish | `execute` 的迭代循环（Algorithm 1） |
| L-Leave | `refresh` 把状态标成 UNLOADING |
| L-Unload 的守卫 | `unload` 等待被通知的依赖方（Algorithm 5 第 25 行） |
| L-Raise | 错误记在纤程上，target 置 \(\bot\) |

论文写明：运行时**不检查** \(\mathfrak{E}_\Gamma^*\) 的见证——回调交一个逆，这个逆是否真能恢复，是部件作者的义务，不是运行时验证的性质。定理 61 依赖它；§6.1 划清义务边界。

### Algorithm 1：`ctx.effect`（可逆效应的唯一入口）

伪代码（论文 Algorithm 1）：

```
async function execute(callback, guard)
    iter ← callback()
    inverse ← id
    while guard()
        (value, done) ← await iter.next()
        if value then inverse ← value ∘ inverse
        if done then break
    return inverse

function effect(ctx, callback)
    armed ← true
    task ← execute(callback, () ↦ armed)
    async function dispose()
        if not armed then return
        armed ← false
        recover ← await task
        recover()
    ctx.dispose ← dispose ∘ ctx.dispose
    return dispose
```

两件事：自处置（`armed` 保证恢复至多一次——跑两次会把逆用在「从未产生过该效应」的状态上）；父复合（子效应的逆本身是父上下文上的效应，即 \(\partial^2\Gamma\) 的递归）。部件级 `execute` 用「`fiber.target` 是否仍稳定」做 guard，而不是 `armed`。

上游实现见 `cordiverse/cordis` 的 `packages/core/src/fiber.ts`：`Fiber.effect()` 收集 disposer，`dispose` 按**反序**跑；async iterator 在每步检查 `runner.epoch` 是否仍是旧值（对应 guard）。生命周期状态机：

```ts
export const enum FiberState {
  PENDING, LOADING, ACTIVE, FAILED, DISPOSED, UNLOADING,
}
```

`_setEpoch` 在 inject 解析出的 epoch（各提供方 `uid` 拼成的字符串，或 `__INACTIVE__`）变化时，若没有飞行中的 `inertia`，就启动 `_reload` 或 `_unload`；两者在收尾时若 epoch 又变了，就链式切到对方——这就是 §4.3.3 的惯性。

`Context`（`packages/core/src/context.ts`）用 Proxy 做属性访问；`isolate` / `intercept` 派生子上下文，改的是 `@@isolate` / `@@intercept` 表，符合定义 27 的派生实现。

事件（`packages/core/src/events.ts`）四种分发：`emit`、`parallel`、`serial`、`waterfall`（另有 `bail`）。`on` 通过 `this.ctx.fiber.effect(...)` 注册，卸插件时监听器自动摘掉——注册即效应。

### Algorithm 2–3：余效应

`set` 是一次 `ctx.effect`：写入 `@@store[realm]`，`notify`；dispose 时删除并再 `notify`。`notify` 遍历活纤程，若其 `inject` 含该 key 且 realm 相同，就 `refresh`。提供只在纤程 **ACTIVE** 时算数——进入 UNLOADING 的提供方已经「停服」，依赖方先看到不满足并开始拆，而绑定还在。

### Algorithm 4–5：`ctx.use` 与惯性状态机

`use` 把子纤程的 refresh/unload 登记成**父纤程上的一个 effect**（定义 47）：卸父自动退役子。`refresh` 重算 target；变了且没有 inertia，就按 target 是否为 \(\bot\) 启动 reload 或 unload。`reload` 先 `committed ← resolve(inject)`，再 `execute(apply, () ↦ target 仍是当初那份)`；完了若 target 没变则 ACTIVE 并 notify，否则链式 unload。`unload` **先** `await` 所有被 notify 的依赖方 `f.await()`（L-Unload 守卫），再跑 `fiber.dispose()`，然后按新 target 进 INACTIVE 或再 reload。

定理 63 的三行：

1. reload 第 14 行提交视图，unload 在所有逆跑完才丢掉——装载期间（含自己的拆除）读到同一份绑定
2. refresh 第 10 行在创建任务**之前**标 UNLOADING（L-Leave）
3. unload 第 25 行等待依赖方 Inactive

### Algorithm 6：Proxy 访问

从当前纤程往父走：第一份 `committed` 里有这个 key 就返回；若某层声明了但还没 commit，抛 `INACTIVE_ACCESS`；走到根还没有声明，抛 `UNDECLARED_ACCESS`。这和裸 `ctx.get`（只查表、不失败）不同：Proxy 按访问者自己的视图强制规格 \(d\)。拆依赖触发的拆除里，部件仍能读到那份依赖——定理 63 靠的就是读视图而不是读现表。

### 加载器（§5.2）

编排器不再手写 `ctx.use`，而是写一份持久配置。**定义 74**：一条 entry 记录 `id`、`url`、`isolate`、`intercept`、`config`、`disabled`。`@cordisjs/group` 把子条目列表当配置；`@cordisjs/include` 把外部 YAML/JSON 接成子树。两者都是普通部件，仍在演算里。

调和之所以合法，论文直接引用元理论：定理 73（静止状态只取决于最终配置）、定理 66（一定会静止）、推论 62（卸一根不留贡献）、定理 63（不必排装载顺序，依赖只约束何时激活）。字段级最小打扰：`id`/`url` 变则重建；`isolate` 走 Algorithm 7 改派 realm；`intercept` 原地改；`config` 交给部件（group 对子 id 做 keyed diff）；`disabled` 卸或装。

HMR（§5.2.2，Algorithm 8–10）：模块级套同一套可逆效应。分类 accepted/declined → 找出依赖树碰到已接受模块的 stale entry → 失效缓存并换新纤程；任一步失败则恢复缓存、用备份重建。论文强调：因为纤程已经框住该部件的全部效应和余效应，**不需要** Webpack/Vite 那种开发者标注的 acceptance boundary。

### Koishi（§5.3）

开放聊天机器人框架，Cordis 上的应用。论文称四年、超过 4000 社区插件。用来说明：元框架够表达完整生产系统、且不绑定领域或运行时（服务端 bot 与浏览器控制台是两套独立的 Cordis 应用）。插件作者不必手写卸载路径也能得到有序清理；开放生态里不同作者只靠余效应约定协作。**威胁效度**（原文）：单一生态、单一宿主语言、观察性而非对照实验；测开销与生产力是未来工作。Koishi 当时用 Cordis v3，论文写 v4。


---

## 对照 DeepSeek Harness 源码：一次 Agent 回合怎么跑

Harness（dsh）把 Cordis vendor 进仓库。

架构文档原话：产品每一部分都是插件，包括模型适配器、工具注册表、会话日志、以及 agent loop 本身。没有特权内核。注册都是效应，插件一卸就撤销。

### 启动时怎么拼出一棵树

运行中的 dsh 是一棵插件树，启动时按层叠加：profile 列出的每个 bundle（dsh-base 是第一层：模型、工具、持久化、沙箱与审批、设置、凭据、遥测；dsh-web-app / dsh-headless 再往上加）、profile 自己的 cordis.patch.yml、home 级的那份、命令行 --patch。一条 patch 按 id 整行替换或插入。dsh --profile web --dump-config 打印实际启动的树。这就是论文加载器：声明式配置 + 调和。Agent preset 里的服务行需要 isolate realm——论文定义 28–29 的隔离。

### 核心 ctx 键（架构表）

| 包 | 职责 | ctx 键 |
|---|---|---|
| packages/core/session | 只追加的 SessionEvent 日志 | ctx.sessions |
| packages/core/system-prompt | 提示词片段与工具 schema 组装 | ctx.systemPrompt |
| packages/core/tools | 作用域化工具表 + 把关流水线 | ctx.tools |
| packages/core/agent | Agent 接口、活注册表、agent/* 事件 | ctx.agents |
| packages/core/agent-loop | 默认驱动器 | ctx.agentLoop |
| packages/core/scope | 按 agent 划分的注册原语 | 无键，库 |
| packages/llm/llm | 消息/流式词汇 + 适配器缝 | ctx.llm |

AgentLoop（packages/core/agent-loop/src/index.ts）是一个 Cordis Service。static inject = [agents, sessions, llm, tools, systemPrompt] 就是余效应规格 d。这些服务不齐，这个插件不会变成 ACTIVE。

ctx.effect(() => () => this.ownership.dispose()) 是可逆效应：正向开始接管活 agent 的拆除，逆是 ownership.dispose()（中止工厂、等所有活 agent 拆完）。ctx.effect(() => ctx.agents.setFactory(this)) 是 set：把「Agent 工厂」这个 key 提供出去；卸 loop 插件时工厂登记撤销。配置里声明的每个 agent，若是 resume，再用 ctx.inject([sessionPersistence], …) 等持久化服务出现——反应式余效应。

ReactLoopAgent（packages/core/agent-loop/src/agent.ts）是默认驱动。一次 turn（轮次）= 零或多步；一次 step（步骤）= 一次模型请求 + 它点名的工具。架构文档给出的骨架：turn/start → claim 输入 → assemble 提示词与工具 schema → agent/pre-step（reject 或 enter）→ step/start → 记 user/message → deriveMessages → agent/request → llm/stream → assistant/chunk* → assistant/message → tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result* → step/end → 若还欠请求则下一步 → agent/turn-stopping → turn/end。

源码对应：followup → send(..., next-turn, true) → wakeDriver → kick → turn。Inbox.claim 领取输入；steer 进 next-step 并唤醒，inject 进 next-step 但不唤醒。ctx.systemPrompt.assemble 组装提示词。dispatch.waterfall(agent/pre-step) 让插件改写或拒绝本步。session.append 记持久轮次/步骤边界。session.deriveMessages() 只从日志投影模型历史，不另存一份对话数组。dispatch.waterfall(agent/request) 后走 ctx.llm.prepareCall / llm.stream。每个 chunk 记 assistant/chunk。executeToolCalls（tool-calls.ts）调度工具。dispatch.serial(agent/turn-stopping) 是收尾检查点（serial，无 next()）。

createScope（packages/core/scope/src/index.ts）本身就是一次 ctx.plugin(scope)——再挂一根 Cordis 纤程。该 agent 通过 agent.ctx 做的工具注册、监听器、提示词片段，都记在这根子纤程上；scope.dispose() 等 fiber.inertia 静止，对应论文卸纤程要等惯性结束。这是 Gamma_infty 树状层级在「每个会话一个作用域」上的用法。

AgentLoop.prepare 把拆除登记在工厂纤程和 owner 纤程上、且在 publish 之前：ownership.track(dispose) 加上 ownerCtx.effect(() => () => { abort; return dispose(true) })。中途 unload 会回滚——论文「注册是效应、卸父级联卸子」在 Agent 生命周期上的直接应用。INACTIVE_STATES 含 UNLOADING | DISPOSED | FAILED，与定义 49 的 installed/failed 对齐。

---

## 插件、沙箱、工具、会话日志怎么对上论文

### 插件 = 部件 = 纤程

Cordis primer（docs/cordis-primer.md / .zh.md）用五个日常词复述论文：(1) 插件是实现 Service 的对象；(2) 上下文是服务容器（ctx.tools、ctx.llm、ctx.sessions）；(3) inject 声明依赖，齐了才启动；(4) 类型化事件 emit / waterfall / parallel / serial；(5) 注册是可逆副作用：ctx.effect() / ctx.on()，reload 与 teardown 按预期撤销。

Harness 没有另写一套生命周期：它就是 Cordis 纤程树。vendor 日志第 6 条还硬化了论文 Algorithm 5 在重入场景下的空隙：效应的 owner-list 包装在 setup 体之前登记；UNLOADING 时拒绝新建效应；子纤程在 internal/plugin 发布前就拿到父拥有的 disposer。

### 工具流水线 = 余效应 + 拦截，不是循环内核

ToolRuntime（packages/core/tools/src/index.ts）也是 Service，static inject = [systemPrompt]。register / restrict / guard / presentAs 全部走 this.layers.effect(ctx, …)，也就是 ctx.effect。卸提供该工具的插件，工具从模型可见集合里消失，tools/change 发出，下一轮提示词组装看到新集合——反应式余效应，粒度是「工具」而不是「整个 Agent」。

流水线（docs/tool-execution-pipeline.md + execute()）：(1) tools/pre-execute waterfall：允许 / 拒绝 / 询问；(2) ctx.approval 一次性询问，没有或不可答则拒绝；(3) 单调 guard：只能拒绝或弃权，不能把别人的拒绝改回允许；(4) tools/execute waterfall：超时、重试、指标；(5) 工具 execute() 本体，文件系统变异另走 fs/write-intent / fs/edit-intent；(6) tools/post-execute waterfall：接受 / 拦截 / 替换 / 附加上下文；(7) finalizeContent（定义拥有的、同步、只动 content）；(8) tools/result emit：冻结后的最终结果。

这是论文定义 30–31 的拦截：策略元数据活在上下文/事件上，不写进工具体，也不写进循环。换一套审批或沙箱 = 换一个提供方或加一个 waterfall 监听，循环文件不用动。

executeToolCalls（packages/core/agent-loop/src/tool-calls.ts）在循环侧只做调度：exclusive 是屏障，parallel 是有界滚动池；策略、结果、结果上下文仍按模型顺序提交。先 session.append(tool/call) 再执行——「模型可见即已记录」。

### 会话日志 = 模型看见的世界的唯一来源

SessionEventMap（packages/core/session/src/types.ts）是可合并扩展的只追加日志。核心事件：turn/start、turn/end、step/start、step/end、user/message、assistant/chunk、assistant/message、tool/call、tool/result、todo/write、request/header、request/context、session/end-seed。

架构不变量：模型可见即已记录。任何进入模型请求的东西都必须能从日志重建，运行时断言这一点。所以新的模型可见输入必须加新的会话事件类型，从日志渲染，而不是在循环里塞一个旁路字段。SESSION_FORMAT_VERSION = 0：未发布期间不做兼容，不提供迁移。这是 harness 现状，论文未讨论。

日志不是论文里的 Sigma。Sigma 是进程内、可逆、按纤程记账的共享服务表；会话日志是跨进程重启仍在、只追加、不可用 dispose 撤回的事实流。一次 append 更接近 §6.1 的 emission（排放）：数据离开可逆边界。fork / resume / transcript / 遥测都从这股流派生。

### 沙箱 = 能力缝 + 论文 §6.3，不是演算里的形式对象

packages/sandbox/README.md：这一族给进程执行加按会话的限制。ctx.sandbox 定义服务；sandbox-local 提供本地后端；ctx.sandboxPolicy 解析持久的每会话策略。孤立环境是整份能力实现替换，不是在这里再挂一个后端。

论文 §6.3 分两层：(1) 基于能力的访问控制（语言层）：inject 是能力请求，Proxy 是中介；拦截元数据可在不触发重载的情况下收紧路径/权限。(2) 不信任代码的沙箱（语言层不够）：需要 SFI、独立运行时、沙箱进程或容器。不信任部件跑在自己的沙箱上下文里，经桥访问宿主依赖——桥是普通纤程，能力仍可被上面那层衰减。

Harness 的 ctx.sandbox 属于第 2 层的工程缝，不是第 4 章演算的形式对象。论文没有声称「沙箱策略 = 某个定理」。preset 上的 isolate 是第 1 层（同一 key、不同会话不同绑定）。

### 事件分发 = 扩展点，也是可逆效应

EventsService.on 用 fiber.effect 登记 hook。四种模式与 primer 表一致。Harness 里 agent/pre-step、agent/request、llm/stream、三个 tools/* 是 waterfall（必须 next() 才能交给下游；不调用就是短路）。agent/turn-stopping 是 serial。卸插件 = 摘监听器，循环看不到它。

---

## 一个完整例子：从用户一句话到工具调用再回来

假设用户在 Web UI 里说：「看看仓库根目录有哪些文件」。下面按源码真实路径走，不编造中间变量名。

1. UI / SDK 找到该会话的 Agent，调用 agent.followup(userMessage)。
2. ReactLoopAgent.send 把消息 splice 进 inbox 的 next-turn，并 wakeDriver。
3. 驱动从 idle 进入 running，kick → turn()。
4. session.append(turn/start, { turn })。这是持久事实，重载后仍在。
5. preStep：inbox.claim(next-turn, turn) 领走那句用户话；ctx.systemPrompt.assemble(...) 收集各插件用 ctx.effect 登记的提示词片段和当前可见工具 schema（刚卸掉的工具插件不会出现——余效应）。
6. agent/pre-step waterfall。压缩插件（dsh-compaction-basic）可以在这里因上下文压力改写或拒绝。拒绝或第一次 enter 被改成空：轮次仍关闭，但不花一步，日志记下「试过」。
7. session.append(step/start)；对每条进入的消息 session.append(user/message, …, { surfaceOp: append })。
8. step()：session.deriveMessages() 从日志投影模型历史。buildRequest 走 agent/request waterfall，插件可改 provider/model/采样；ctx.llm.prepareCall 绑到当时登记的适配器（换模型适配器插件 = 换 ctx.llm 上的提供方）。
9. llm.stream waterfall 拉流。每个 token：session.append(assistant/chunk, { turn, step, chunk })。UI 听 session/event，不是听循环内部状态。
10. 流结束：session.append(assistant/message, { message, usage }, { sourceEventSeqs: chunkSeqs })。sourceEventSeqs 列出构成这条消息的 chunk，回放保真。
11. 若助手消息里有 tool-call 块（例如 name: bash, arguments: {"command":"ls"}）：executeToolCalls。立刻 session.append(tool/call)——先记再跑。tools.prepare：tools/pre-execute（沙箱/审批/hooks 可 deny 或 ask）→ 单调 guard → 通过才 dispatch。tools.execute 环绕工具体；本地 bash 经 ctx.shell / ctx.subprocess，argv 可被 ctx.sandbox 包一层。tools/post-execute 可拦截或附加上下文；finalizeContent；tools/result 通知 UI。session.append(tool/result, …, { sourceEventSeqs: [callSeq] })。additionalContexts 被 acceptContext 推进 inbox 的 next-step。
12. session.append(step/end)。若工具还欠一次模型请求，或 next-step 又有输入：再 preStep(next-step)，新一步。
13. 自然结束且 next-step 空：agent/turn-stopping serial。监听器可做最后干预，但没有 next()。
14. session.append(turn/end, { reason })。驱动若 inbox 已空则回 idle 并发 agent/status。

若此时有人热卸了 bash 工具插件：该插件的 ctx.effect 逆跑，工具从 ToolRuntime 的层里消失，tools/change 发出。当前这步已经记下的 tool/call 仍会跑完（惯性：飞行中的迭代要落地）；下一轮 assemble 不再把该工具 schema 交给模型。若卸的是整个 dsh-agent-loop 插件：ownership.dispose() 中止工厂，对每个活 agent cancel({ kind: disposed }) 并 whenIdle()，再 scope.dispose()——子纤程树上的提示词片段、每 agent 工具、监听器按 LIFO 撤销。会话日志文件还在：排放已越过可逆边界（§6.1），这是设计，不是泄漏。

---

## 局限与现状（developer preview）

分三层说：论文自己承认的、论文标成开放问题的、Harness 仓库额外暴露的。

### 论文自己划的边界

- 系统边界（§6.1）。只有系统能独占修改、并能恢复修改前状态的位置，才在 Gamma 里被跟踪。write 到共享文件、send 到网络是 emission（排放）：获取句柄（open/malloc/fork）可逆，把数据推出去不可逆。补救是推迟排放（output commit）或补偿（compensation）；补偿的交换性要在更粗的等价上重证，现有元理论不管。
- 逆的见证不由运行时检查（§5.1.1）。作者交一个 dispose，定理 61 假设它真能恢复。交错了的 dispose 是作者 bug，不是框架能证伪的。
- 先于关系无环是假设（定义 65、定理 66/73）。循环依赖让相关部件永远 Inactive；运行时可在装载时报告，但演算不解开环。§6.5 建议拆成更细的单向部件，最坏集成部件数可随 n 二次增长。
- 合流排除失败（定理 73）。失败是真分叉；只保证失败纤程对外贡献为零。
- 独立性是义务，不是自动成立（定理 42、§6.1）。共享位置必须做成 key，且该 key 的接口必须交换。有序中间件链不是交换的。系统无法收成余效应的位置，落在边界外。
- Koishi 不是对照实验（§5.3）。单一生态、单一宿主语言、观察性证据。论文没有报告延迟、内存、吞吐量数字。
- Agent harness 是动机和未来工作，不是已完成评测（§1.2.2、§8）。论文没有声称 DeepSeek Harness 已经实现「自我演化」。

### 论文标成开放问题（§6.5、§8）

1. 更丰富的余效应规格。现在 D_Sigma = Set(K) 只表达「这个 key 在不在」。可选依赖、版本约束、能力级需求（「只读，不要写」）都没有。§6.3 的拦截是工程补丁，不是规格语言。
2. 静态分析。演算是操作语义。循环依赖、缺失提供方、效应独立性，今天都是运行时才发现。编译期检查无环、检查提供/消费匹配，是开放问题。
3. 跨进程 / 分布式。演算假设共享地址空间里的一个 Gamma。把 isolate realm 做成跨进程、把桥做成网络，形式保证会不会掉，论文没证。
4. 量化开销与开发者生产力。Koishi 证明「能用」，没证明「比手写卸载更便宜」。
5. 自我演化的 agent harness。第 8 节原话：未来工作包括把范式用到会在服务请求的同时生成并部署对自己部件修改的运行时。这是动机，不是已发表结果。

### Harness 仓库自己写的现状

README 第一句：developer preview。API、包边界、会话格式、配置 schema 都会变；SESSION_FORMAT_VERSION = 0，不做迁移。文档目录写明：docs/ 是内部设计笔记，不是对外稳定承诺。

仓库里没有把论文 PDF 或形式演算当作产品文档。连接是间接的：Harness 用 vendored Cordis；Cordis 实现论文 Table 2；论文用 Koishi 而不是 dsh 做案例。读论文不能代替读 docs/architecture.md。

vendor 层说明实现与论文伪代码并不逐行相同：可重入处置、事务性调和、HMR 盯配置文件，都是论文 Algorithm 没有写全、产品必须补的缝。精读时不要把 Algorithm 1–10 当成 vendor/cordis 的逐行注释。

---

## 参考文献与链接

### 论文本身

- 预印本仓库：https://github.com/cordiverse/paper （2026-08-13 草稿，preprint under active revision）
- 本地副本：/workspace/deepseek-harness/paper.pdf、/workspace/deepseek-harness/paper.txt

### 论文 Related Work（§7）点名的方向，不编造未出现的篇名

第 7 节按主题回顾，而不是给一份「我们比 X 快 N 倍」的表。文本中明确出现的线索包括：效应方面有 Moggi 的 monad，Plotkin & Power / Plotkin & Pretnar 的代数效应与 handler，Kiselyov 等的 Extensible Effects，Leijen 的 Koka，Brady 的 Idris 效应，Brachthäuser 等的 Effekt，Bauer & Pretnar 的 Eff，Lindley、McBride、McKinna 的 Frank；余效应方面有 Petricek、Orchard、Mycroft 的 coeffect 演算，graded / quantitative 类型，Uustalu & Vene 的 comonad。
可逆 / 双向方面，论文讨论可逆计算与 lens / bidirectional transformation。模块与热替换方面讨论模块系统与热代码加载。依赖注入与组件方面讨论 Spring、OSGi 一类实践。Agent / harness 方面引用 LLM agent 综述以及 OpenAI / Anthropic 关于 harness engineering 的工程文章。完整条目以 PDF References 为准。本文不把未核对的引用写成「论文证明了 X」。

### 实现仓库

| 资源 | URL |
|---|---|
| Cordis | https://github.com/cordiverse/cordis |
| DeepSeek Harness | https://github.com/deepseek-ai/deepseek-harness |
| Harness README | https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md |
| 架构 | https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md |
| Cordis 入门 | https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md |
| Agent 生命周期 | https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.md |
| 工具流水线 | https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-execution-pipeline.md |
| Vendor 说明 | https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/README.md |

### 本文对照过的源文件（未 git clone，经 GitHub API / raw）

Cordis（cordiverse/cordis，packages/core/src/）：
- context.ts — Context、isolate、intercept、Proxy
- fiber.ts — Fiber、FiberState、effect、dispose、_reload / _unload、inertia、committed、target
- events.ts — emit / parallel / serial / waterfall / bail；on 走 fiber.effect

DeepSeek Harness（deepseek-ai/deepseek-harness）：
- packages/core/agent-loop/src/index.ts — AgentLoop、FactoryOwnership、static inject、ctx.effect
- packages/core/agent-loop/src/agent.ts — ReactLoopAgent、turn / step / buildRequest / inbox
- packages/core/agent-loop/src/tool-calls.ts — executeToolCalls
- packages/core/tools/src/index.ts — ToolRuntime、execute 流水线、ToolPresentationMode
- packages/core/session/src/types.ts — SessionEvent、SessionEventMap、TurnEndReason
- packages/core/session/src/index.ts — Session 服务、只追加日志
- packages/core/scope/src/index.ts — Scope、createScope、scopeOf
- docs/architecture.md、docs/cordis-primer.md、docs/agent-lifecycle.md、docs/tool-execution-pipeline.md、vendor/README.md、packages/sandbox/README.md

草稿写于 2026-08-14。论文仍在修订；若 PDF 与本文冲突，以 PDF 为准。

勘误（Related Work 以论文原文为准，上一小节里若干篇名写过了）：第 2 节实际点名 Lucassen & Gifford、Moggi、Wadler、Plotkin & Power、Plotkin & Pretnar、Koka、Eff、OCaml 5、Uustalu & Vene、Petricek / Orchard / Mycroft、Gaboardi 等。第 7 节实际点名 ZIO / Effect-TS / fp-ts、Brachthäuser 的 Effekt、Heunen 等的可逆效应、Orchard 等的 Granule 分级类型、COP、AOP、Erlang/OTP 热替换、OSGi / R-OSGi、Spring / Guice 依赖注入、Landauer & Bennett 可逆计算。Agent harness 引用是 [8] Lopopolo 的 Harness Engineering（Codex）与 [9] Anthropic 的 Harness Design，不是笼统的「OpenAI / Anthropic 两篇」。Kiselyov 在参考文献里是定界续延，不是 Extensible Effects；Brady / Idris / Frank / lens 未在正文点名。完整条目以 PDF References 为准。

补充：vendor/README.md 把 cordis 钉在 4.0.0-rc.7，并记录可重入处置、事务性调和、HMR 盯配置文件等本地补丁。AgentLoop 源码里的对照片段：

```
export class AgentLoop extends Service implements AgentFactory {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']
  constructor(ctx, config) {
    super(ctx, 'agentLoop')
    ctx.effect(() => () => this.ownership.dispose(), 'agentLoop.transactions()')
    ctx.effect(() => ctx.agents.setFactory(this), 'agentLoop.setFactory()')
  }
}
```

static inject 是余效应规格 d；两处 ctx.effect 分别登记拆除与工厂提供，卸插件时按逆撤销。

封面只印英文名 Yifan Shi / Wei Zhang / Tianyi Cui 与单位 Peking University、DeepSeek-AI；中文名是通行音译，不是 PDF 原文。
