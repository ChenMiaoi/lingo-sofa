# Windows 模型接入与 oh-my-pi SDK/Agent 架构

2026-10-21 · 本文定义模型与认证的目标契约；当前桌面开放目录中的 API Key 与订阅登录服务商。总方案见 [技术方案](lingo-sofa-plan.md)，边界见 [模块设计](windows-modules.md)，验证项见 [阶段验收](windows-acceptance-plan.md)，现有实现与已测范围见 [当前架构](architecture.md) 和 [验收状态](acceptance.md)。

## 确定使用 oh-my-pi

确定采用 `can1357/oh-my-pi`（下称 OMP）作为 LLM 与会话运行时，替代此前规划的原版 Pi SDK。Rust + Tauri 2 管理桌面、系统与产品任务；OMP 统一负责 provider、认证、翻译/Ask 会话和压缩。Rust 不平行实现同类 LLM 引擎。本文保留历史文件名以保持文档链接稳定。

| OMP 层                      | 职责                                                               | 本项目的使用边界                                                   |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `@oh-my-pi/pi-ai`           | provider 调用、流式与用量事件                                      | 由 SDK 会话层调用，不在 Rust 重写                                  |
| `@oh-my-pi/pi-catalog`      | 模型目录与 provider 描述                                           | 作为能力来源之一，仍区分目录存在与账户可用                         |
| `@oh-my-pi/pi-agent-core`   | Agent 循环与状态                                                   | 经 SDK 使用，产品不额外实现 Agent 循环                             |
| `@oh-my-pi/pi-coding-agent` | AgentSession、SessionManager、AuthStorage、ModelRegistry、Settings | worker 内嵌；限制工具、资源发现、重试/回退及后台行为               |
| OMP Rust native addon       | SDK 使用的原生能力                                                 | 按所选版本审查 Windows 二进制/ABI与许可，不能只打包 Bun 和 TS 文件 |

正式 workspace 已移除原版 Pi 1.2.0，锁定 OMP 18.12.3 与 Bun 1.3.14。生产入口为 `apps/omp-worker/src/worker.ts`，Rust 应用服务在 `crates/app-services`。当前桌面只开放 DeepSeek API Key，OAuth 和其他 provider 仍属于后续目标。

本次核对的 OMP main 文档要求 Bun ≥1.3.14。会话入口为 `createAgentSession`，会话/账户通过 SessionManager、AuthStorage 和 ModelRegistry 接入，模型目录还涉及 pi-catalog。main 上的 API 和版本不是项目依赖锁定；W0 固定可复现的 OMP 发布版本或 commit、Bun、原生 addon 与协议。[SDK](https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md)、[provider](https://github.com/can1357/oh-my-pi/blob/main/docs/providers.md)、[包与运行时声明](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/package.json)。

## 确定的运行结构

```text
React/TS UI → Tauri/Rust 应用服务
                ├── Windows 取文 / OCR / 凭证密文 / 设置 / 用量账本
                ├── 免 Key 翻译适配器（Bing/Google）
                └── 私有 IPC → 受限 TS OMP worker（随包 Bun）
                                  └── OMP SDK / AgentSession / AuthStorage / ModelRegistry
                                        └── @oh-my-pi/pi-ai provider → LLM 服务
```

安装包携带经验证的 Bun 与 OMP 依赖，用户无需自行安装 Bun 或 OMP；“无需用户安装 Bun”不等于“产品没有 Bun 运行时”。Tauri 仍使用系统 WebView，不因 OMP 进程改回 Electron。Bun、OMP 及所需 native addon 是受控内部组件，不是第二个用户需要管理的助手安装。

推荐在 TS worker 中内嵌完整 OMP SDK，并暴露有限命令：创建/清理会话、提交翻译或 Ask、取消、选择已验证模型、模型目录、登录/退出/状态。worker 显式设置默认关闭、逐次确认的工具集、隔离 Settings、文件 SessionManager 和受控后台行为；不沿用原版 Pi 的空 resourceLoader 配置。选定 OMP 版本的登录、AuthStorage/ModelRegistry 适配与压缩事件能否满足约束，在 W0 验证。

Rust 与 worker 通过版本化私有命令/事件协议通信；可以参考 OMP RPC 的关联、背压和终态语义，但产品协议不等于直接暴露 OMP CLI 的全部 RPC。仅在现成 RPC 可以证明同等受限配置时才考虑替换 wrapper，不同时维护 SDK/RPC 两种运行路径。不能把 `--no-session` 当成禁用工具、扩展或重试。

worker 首次 LLM/认证/目录操作时启动；首次免 Key 翻译不启动 OMP。只要还有活跃会话、任务、登录或凭证写入就不退出；所有会话明确关闭后才进入空闲回收。worker 退出后通过 OMP 文件会话显式恢复上下文，不在 Rust 维护第二套完整对话；不自动重发中断的模型调用或执行工具。

## 权威状态与会话边界

- **OMP**：provider 请求、模型能力、流式语义、认证协议、AgentSession 消息/上下文、压缩与模型切换；不重新实现 Rust LLM SDK 或摘要器。
- **Rust**：快照和窗口归属、taskId/callId、业务队列、账户 ID 与默认值、DPAPI 密文持久化、用量幂等账本和 UI 状态。Rust 可保留明确的显示投影，但不是会话上下文权威。
- **翻译会话**：按随机来源 scope、快照/目标语言及模型隔离；同一可变文档的修订不得把旧结果显示到新内容。默认不跨应用混用上下文，关闭来源或清除快照时释放对应会话。
- **Ask 会话**：按固定快照与用户主动对话创建独立 AgentSession，不与翻译会话共用消息历史；窗口间不得串内容。切换模型在 OMP 内校验能力与上下文兼容后执行，结果成功前保留旧配置。

普通网络取消由 Rust 请求 OMP 中止，OMP 报告运行终态；Rust 不将“命令已接受”当作模型调用已完成。跨进程崩溃时当前调用标记失败/消耗未知，不重发；重建 worker 只恢复控制通道、账户与设置，不自动重放正文。

## OMP 的受限嵌入策略

本节定义产品要求，W0 必须逐项证明可配置或可由受控 wrapper 实现，不能仅看 SDK 有参数就标为通过。

- **工具与发现**：默认 active tools 为空；Ask 可启用内置文件与命令工具，每次执行须经过用户确认门。`toolNames` 本身不是白名单，须结合 `restrictToolNames` 并验证空工具列表语义；关闭 MCP、LSP、扩展、skills、上下文文件、模板与自定义命令的自动发现。不得从用户的 `~/.omp`、项目 `.env` 或其他工具目录自动获取配置/凭证。
- **会话实例**：显式注入 SessionManager.create/open 与隔离 Settings；每个并发顶层会话提供私有 AgentRegistry，避免默认进程级 Main 身份冲突。明确配置模型，不接受自动选择第一个可用模型。SDK 所需 SessionManager、AuthStorage、ModelRegistry 从包根导入，不能假设窄 `/sdk` 子路径都导出。
- **账户与回退**：每个会话绑定 accountId/provider/model。关闭自动账户轮换、跨模型/供应商回退与一般付费自动重试；认证刷新允许按原账户执行并独立验证是否重发请求。用户主动切换才改变绑定。相同 provider 的多个 Key 不能因 OMP 内置轮换而绕过产品选择。
- **后台行为**：审查并控制模型预连接、在线目录刷新、cache warming、自动标题、memory/auto-learn、advisor、提醒和遥测。打开卡片/设置不能偷偷触发生成或上传正文；允许的无正文目录/连通性请求需单列验证。SDK 默认预热不等于已经满足本产品空闲网络约束。
- **终态与销毁**：`agent_end` 不总是完成，按锁定版本区分非终态维护与真正结束，不能在压缩/重试尚未完成时释放队列槽位。关闭先阻止新入队，再 await dispose；销毁失败/超时保留 unknown 并回收 worker。
- **凭证**：注入同一 AuthStorage 实例给 ModelRegistry/会话，使用与 Rust 密文存储相连的受控适配，不默认建立第二份 `~/.omp/agent/agent.db` 凭证库。SDK 是否支持所需存储与刷新钩子是 W0 硬门槛，broker 模式只可在满足相同本机/权限边界后评估，不预先承诺无需适配。

上述接口依据 [OMP SDK 文档](https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md) 与 [账户解析规则](https://github.com/can1357/oh-my-pi/blob/main/docs/providers.md)。这些功能边界服务于翻译软件：OMP Agent 负责生成和会话，桌面默认关闭工具，用户可启用受单次确认控制的 Ask 文件与命令工具，具体边界见[会话指南](sessions.md)。

## 首版接入矩阵

下表是计划和验收优先级，均不表示新桌面版已支持。所有首版必需项到 W3 必须有通过证据；W1 可先交付较小验证闭环。

| 接入                             | 请求/能力边界                                                           | 凭证         | 阶段与验收重点                                                                         |
| -------------------------------- | ----------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------- |
| DeepSeek 官方                    | OMP DeepSeek provider；模型 ID/容量以核实来源为准                       | API Key      | W0/W1：生成、思考可用档位、usage、缓存桶；余额仅官方提供时查询                         |
| OpenAI 官方                      | OMP OpenAI provider 的 Responses 路径和事件映射                         | API Key      | W0/W1：流式终态、错误、取消、模型/账户绑定                                             |
| 自定义兼容端点                   | 初始支持明确的 Chat Completions profile；Responses 必须单独声明与测试   | 端点绑定 Key | W1：有/无流式、有/无 usage、未知容量、异常返回；不能仅通过 `/models` 就声明可用        |
| ChatGPT 登录                     | 官方注册/授权、账号模型目录、Responses；禁止把订阅 token 送往自定义地址 | OAuth        | W0 验证可行性，W3 必过登录/刷新/退出/失效/额度错误；由 OMP 登录/刷新，采用官方授权入口 |
| Bing/Google 免 Key               | 独立翻译服务，不承载 Ask                                                | 无模型账户   | W1/W3：账户异常不影响选择，失败不自动换服务；接口可用性单独记录                        |
| Anthropic/Gemini/其他 OMP 目录项 | 非首版默认承诺；按 provider 建能力与协议 profile                        | 各自认证     | 后续逐项验收，不继承 OMP 目录的全部品牌为产品支持表                                    |

免 Key 服务沿用产品意图，不将网页服务通道视为稳定 SLA；若发布前不可用，明确记录并作产品决策，不提供虚假的免费成功状态。

OMP 的登录与推理行为仍需与官方流程核对，SDK 的存在不能代替产品验收。该流程要求绑定每次登录的 state/nonce/PKCE；推理要消费到明确终态，部分输出不是成功。[官方登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)。账户资格、注册和可用模型仍由供应商决定，不承诺任何订阅都可用。

## 生成、目录与错误语义

标准事件包含 started、text_delta、可用时的 reasoning_delta、usage_snapshot、completed、failed、cancelled。provider 明确终态之前只展示“生成中”；连接中断保留部分文本并标记不完整，不缓存为最终成功。供应商 SSE 由 OMP/provider 解析；应用只做 OMP 事件映射和自己的 IPC 分帧，不另写相同网络解析器。用合成/脱敏事件验证 UTF-8、终止、错误和限流映射。

能力描述分开记录：API profile、streaming、reasoning 档位、usage/缓存字段、contextWindow、maxOutput、模型目录/余额能力及来源和更新时间。未知为 unknown，不猜默认容量，不向模型发送其不支持的参数；手动设置需带模型标识和来源。模型列表刷新失败保留最后已知选择及时间，不重置引擎。

端点与账户绑定，修改 host/profile 不能复用旧凭证引用；认证头不得跨源重定向。官方 OAuth token 限定官方资源，刷新按账户串行化，取消登录关闭回调并销毁临时 verifier；退出清除本机 token 和关联会话，远端撤销是否完成单独说明。密文只由后台使用，不进入 WebView 或普通日志。

请求错误分为认证失效、无权限、容量不足、限流、服务故障、协议不匹配、取消及消耗未知。带部分输出的失败仍可包含 usage；不以 UI 已关闭为由丢掉计量。付费调用和自动压缩不进行无界重试；默认不自动重发结果未知的生成请求。

## 上下文与用量

翻译默认按本次快照组织，可携带用户明确选择的上下文；Ask 按固定快照与当前对话组织，不后台扩展读取。估算输入与输出预留，按模型核实容量做前置检查，估算不当作供应商精确 tokenizer。

上下文投影、自动压缩和摘要检查点由 OMP 的 AgentSession/SessionManager 管理，Rust 不自行裁历史或生成第二份摘要。固定原文通过受控会话上下文提供，不能依赖摘要必然完整保留原文；UI 中的原始快照单独保留。压缩的每次实际模型调用必须暴露独立 callId/purpose，占全局并发并记账；OMP 版本若缺少所需钩子，W0 需解决适配或选定版本，不能以遗漏费用通过验收。压缩失败保留已有上下文并报告，不无限重试或静默换模型。

用量以 callId 幂等结算；Input/Output/cache/reasoning 的互斥/包含关系由 provider 映射明确声明，不套同一个公式。缺少单次压缩计量的后端不能声称具备完整费用统计。价格按请求开始快照冻结，汇总不回算历史，SDK 汇总与底层调用记录不相加。没有可靠输出时间窗口时 TPS 不可用。

## OMP worker 的必需契约

正式实现已有 Rust 私有 IPC、Windows Job 回收、DPAPI/SQLite、持久化用量账本、有界队列和全局双并发限制。真实 DeepSeek 路径覆盖流式、取消和压缩内部调用计量；取消时缺失最终 usage 保留 unknown，API Key 调用已有 SDK 价格估算，订阅及缺失价格保持未知。兼容范围与待验项见 [验收状态](acceptance.md)。合成 OAuth 刷新验证不代表真实 OAuth 通过；下列生产契约仍需逐项核对。

- 按需启动、版本握手、关闭应用后退出；失败不影响取文和已完成卡片，不能自动重发未知生成。
- JSON 记录含 requestId/sessionId，stdout 只输出协议、stderr 脱敏；消费流与背压不阻塞进程。OMP RPC 的“接受命令”与“会话完成”分开映射，终态以锁定版本为准。
- 开放生成、会话、目录和受控认证；Ask 文件与 bash 工具必须按次确认。仍不开放扩展安装、任意工作目录切换、用户全局 OMP 配置发现或其他工具凭据自动导入。
- Rust 是账户 ID/默认值及 DPAPI 密文的持久化权威；OMP 负责 OAuth 交换/刷新，通过受控凭证适配层读写。刷新按账户串行，新的 token 由 Rust 原子保存并确认后才算提交，worker 不保留第二套长期明文账户库。W0 必须验证所选 SDK 的 AuthStorage 持久化适配、与 ModelRegistry 共享实例及刷新写回钩子；不满足时先解决接口/版本，而不是假设参数存在。
- 固定 OMP、随包 Bun 与 Windows native addon 的版本、许可证和更新责任；全部计入安装体积与进程资源，应用升级协调 worker 退出和版本一致性。
- 后端来源显示在诊断中；首版 UI 不要求用户理解 Rust/OMP 进程。OMP 登录成功不意味着模型调用、余额或所有目录模型都可用。

## W0 必须形成的结论

OMP 已确定采用。W0 集成 ADR 锁定 OMP/Bun/native addon 版本、受限 SDK wrapper 与 IPC、模型/认证矩阵、会话生命周期、凭证适配与刷新提交、压缩事件和并发/用量钩子、完整资源数据。先验证本产品必须的能力，不把整个 OMP 目录当成已支持。

未运行的真实认证/供应商测试标为待验证；没有用户凭证时允许文档与模拟测试，但相关项不通过。核心集成钩子或必需行为不成立时暂停该阶段并修正设计，不悄悄改回 Rust 自建 provider/会话。架构评审完成后才开始实现，本文件不是实测证据。
