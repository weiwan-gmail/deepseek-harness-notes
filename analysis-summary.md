# DeepSeek Harness / Cordis 精读一页摘要

论文 *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿，88 页，8 节 + References）。作者：Yifan Shi（北京大学 + DeepSeek-AI）、Wei Zhang（北京大学）、Tianyi Cui（DeepSeek-AI）。实现：Cordis；案例：Koishi（约 4 年、超过 4000 社区插件，当时用 v3，论文写 v4）。DeepSeek Harness 是把 Cordis vendor 进仓库的 Agent 产品，论文把它标成动机与未来工作，不是已完成评测。

**一句话。** 传统软件编译时拼好；插件和会自我改写的 Agent 运行时却要运行中装卸零件。论文把「拆掉一个部件，痕迹必须收回」（时间可组合）和「依赖要能声明、并跟着环境变」（空间可组合）做成运行时机制：可逆效应 + 反应式余效应，再收进同一个 Context，用动态组合演算证明整棵部件树上仍然成立。

**生活类比。** 厨房里装咖啡机：拆走必须恢复台面（时间）；没电就别冲、来电再自动工作（空间）。不能整间厨房断电重启。

**形式主线。** 效应函数带左逆；track 记账、recover 一锅端恢复（定理 7）；effect 提升保持复合（定理 13）；LIFO 撤销不需独立（定理 16）；独立时任意顺序撤都回到起点（推论 21）。余效应表 Sigma 上的 set 本身就是带见证的效应。部件只在规格满足时激活（notify：activating / deactivating / neutral）。统一上下文 Gamma_infty。观察等价让恢复不必比特级复原。不同 key 上的操作独立（定理 40）；经余效应中介且接口交换则效应独立（定理 42）。

**演算主定理。** 部件 = (依赖 d, 可提供 p, 效应 e)；实例化叫纤程。十规则：O-Insert / O-Retire / O-Remove / L-Begin / L-Iter / L-Finish / L-Divert / L-Raise / L-Leave / L-Unload。定理 59 保持良形；定理 61 / 推论 62 恢复精确（卸一根只撤它自己，失败贡献为零）；定理 63 / 64 提供方先装后卸、一集内绑定不变；定理 66 无死锁且终止（假设依赖先于关系无环）；定理 73 合流：最终静止状态只取决于最终配置，可当静态组装推理。

**工程。** ctx.effect 是可逆效应入口；fiber.inject / provide / dispose / committed / target / inertia 对照 Table 2。运行时不检查逆是否真能恢复。Koishi 是存在性证据，无延迟/吞吐数字。

**Harness 对照。** AgentLoop.static inject 是 d；ctx.effect 登记拆除与工厂。一次 turn：followup → send → turn → assemble → agent/pre-step → llm.stream → executeToolCalls → session.append。会话日志是只追加排放，不是 Sigma。沙箱是 §6.3 工程缝，不是演算对象。状态：developer preview，SESSION_FORMAT_VERSION = 0。

**全文：** /workspace/deepseek-harness/analysis.md
