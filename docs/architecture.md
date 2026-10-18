# 架构与实现

总体设计见 [技术方案](lingo-sofa-plan.md)。当前协议版本为 1，应用和共享包的版本在各 workspace 的 `package.json` 同步管理。协议或 Bridge 配置 schema 改动后需重新执行 `package:native` 更新 native executable，旧产物会拒绝不兼容配置。

## 依赖方向

```text
browser-extension → web-extraction / translation-core / provider-pi/browser / protocol / ui-shared
browser-extension → provider-web → translation-core / protocol
Discord plugin    → translation-core / protocol / ui-shared → authenticated loopback Bridge
Discord native / Native Host → local-runtime → installed Node Bridge
Pi Bridge         → translation-core / provider-pi/node / protocol / constrained Pi SDK
Pi Bridge         → provider-web → translation-core / protocol
translation-core  → protocol / glossary
```

共享核心不导入 DOM、Discord、浏览器或 Node 专属实现。宿主提供模型客户端、凭证、持久化检查点与统计回调。`web-extraction` 只处理网页 DOM；Discord 使用自身消息状态和宿主 React，不捆绑另一份 React。

v0.1.9 起，翻译引擎与 Ask 模型独立配置。`provider-web` 通过宿主注入的网络接口接入必应和谷歌免 Key 翻译，复用共享队列、缓存和结果协议，不创建模型会话。无模型凭证时默认使用必应；已有模型配置与手动选择会保留。配置迁移、权限及计量边界见 [翻译引擎](translation-engines.md)。

## 网页生命周期

`PageTranslator` 扫描段落、列表、单元格和标题的叶子块，排除导航、表单、隐藏/编辑区域与代码块。每次扫描共享可见性缓存，避免为每个文字节点重复计算祖先样式。选区同样逐文字节点过滤，并保护实际选中的内联代码和链接文本。

每个元素记录稳定 ID、revision、原文和取消控制器。IntersectionObserver 优先调度可见范围，MutationObserver 只扫描变化区域，编辑/删除/隐藏会撤回过期节点和任务。渲染用安全文本 span，插入块内部，保持列表和表格结构。关闭时断开监听，仅移除自身节点。

`TranslationBatcher` 最多合并 16 段、约 4,000 字节的序列化输入，最多两个批次同时发送，待处理上限为 1,000 段；单个大段允许独立请求。后台队列另有 100 个任务上限。分批估算不冒充准确 tokenizer。批次取消按段生效，全部成员取消时才中止共享模型请求。输出按 ID 和 revision 对齐，损坏/缺项/重复结果不会显示。

## 核心执行与用量

后台和 Bridge 均使用 `TranslationService`：手动翻译/主动问答优先，最大并发 2，同一翻译范围串行、不同范围可并行，单问答会话最多一个回合在途；Pi 内存会话最多 50 个、空闲 30 分钟回收，不再限制为 20 个成功回合。新增翻译范围达到上限时，释放最久未使用且没有执行或排队任务的翻译会话，保留用量记录；Ask 对话不参与该回收。缓存最多 500 项，包含隔离域、正文、保护片段、语言、上下文、模型、提示词版本与术语表。混合批次只发送缓存未命中的段落；本地缓存命中不新增模型消耗。

本地统计 API 实际用量与请求单价计算出的计费金额，不设置日/月预算，不因缺少计费数据拦截请求；供应商决定余额、配额与限流。累计展示已计费金额，缺少用量或单价的记录单独列为待计费，不覆盖已经计算的费用。旧预算字段仅为读取既有配置而保留，执行路径忽略，设置页不再展示。主动取消不提前释放正在执行的队列槽位，必须等上游结束并完成结算，防止晚到结果重新入账或虚增并发。provider 的一般重试关闭；Pi 原生上下文压缩及溢出恢复的每次辅助调用都独立记账，用量持久化失败时停止后续未记账调用。重试按钮创建新请求。

Pi 互斥输入桶相加作为总输入；reasoning 不重复加入 output。TPS 只使用有效的首次至末次非空输出窗口；汇总按输出总数除以生成时长之和计算。模型返回的 durationMs 优先，缺失时补充单调时钟测量。DeepSeek 官方峰/谷价格按每次请求开始时间冻结快照；2026 年节假日按中国民用日期，时段和周末按 UTC 规则。未知日历年份峰时窗口用峰时上限；其他 provider 用 Pi 目录或显式用户价格。历史不回算，未知不能按免费处理。SDK 会话汇总与请求记录是同一消耗的不同视图，不相加。

## 可信边界与恢复

页面请求只来自当前扩展的顶层 HTTP(S) content script。网站、tab/frame/document 由后台 sender 元数据绑定；页面不能传任意网络代理 URL、读取密钥或查询账户。问答预览绑定随机文档标识，刷新/导航后必须重新预览。

Native Messaging 与 Discord loopback 使用同一 Zod 应用协议，版本不匹配拒绝。Native caller 必须在允许的扩展列表中；loopback 另外验证 Origin、Host、服务实例 Bearer token、请求大小和速率。Origin 和 token 是前端认证边界；已配对的同一 Discord 进程内不同账号/频道 scope 由插件绑定，Bridge 无法独立验证 Discord 账号身份。

本地服务每个已认证来源每分钟最多接受 1,024 次请求，包含模型、配置和用量读取；该容量覆盖整页分批及页面切换的控制请求，仍保留并发、队列和消息大小限制。超过后返回 429 与重试时间，不自动重发模型请求。

浏览器 session storage 保存已发送任务的最小元数据检查点。后台重启时恢复成功用量及消耗未知任务，不重放正文或模型调用。Bridge 默认会话内存统计；用户开启历史后将元数据原子写入 `usage.json`，发送前写 unknown，完成后以同一 requestId 替换。禁用历史会删除旧文件。持久化校验失败时拒绝启动/操作，不静默当成零用量。

本地 Pi 使用内存会话、空工具集、空 resource loader，关闭扩展、资源发现、模板展开、缓存预热和一般自动重试；启用 Pi 原生上下文压缩。受限配置不是操作系统沙箱。

## 构建约束

浏览器只使用明确导入的 OpenAI completions/DeepSeek provider，Node 入口单独构建。Zod 4.6.7 的可选 JIT 探针与编译器在 WXT 构建中被移除，普通解析器保留；版本源码改变会使构建失败，要求重新审查适配。

`verify:extension` 解析每个产物脚本，拒绝远程/计算式 import、运行时 require、eval 和动态 Function 构造器，并验证 MV3 与可选 host permissions。Pi 包中的 Bun 环境分支会触发 Vite 的 node:fs externalization 提示，但产物不含实际 Node module import；真实 Chromium service worker 测试验证当前 provider 路径。此审计不代替客户端和供应商兼容性验收。

## 本地后台服务

大模型请求统一通过共享 Bridge 执行，不再提供独立的浏览器账户或模型直连入口；没有助手时仍可使用免 Key 翻译。`local-runtime` 是 Node 宿主启动/连接边界，不进入共享翻译核心或网页。Native Host 与 Vencord native 层使用同一个 `RuntimeClient`：发现健康服务、启动固定本地安装入口、更新连接租约。HTTP 服务状态验证版本与随机实例 ID；浏览器 stdio 外层只增加 `transportId` 与 `payload` 以匹配并发响应，应用协议仍为版本 1。Discord HTTP 与浏览器 relay 转发同一业务请求，不向 content script 下发服务 token。

服务先绑定本机端口，再初始化历史和发布连接描述文件。并发启动的其他进程无法获得该端口，因此不会成为竞争的历史写入者。实例凭据随机生成并只存于 0600 描述文件，随服务重启轮换；没有永久全局配对令牌，也无每小时人工配对。

在线租约每 15 秒续期，45 秒过期；正常停用/stdio 关闭释放对应来源的租约。只在全部租约消失 60 秒且没有排队、执行、配置保存任务时退出。HTTP 优雅关闭等待已接受请求完成，持久化写入队列完成后删除描述文件。连接断开只重连控制通道，不重发模型调用。保留 unknown 检查点。具体安装、边界和验收见 [服务生命周期](service-lifecycle.md)。

## 翻译会话与供应商额度（2026-10-14）

共享 Bridge 的翻译使用 Pi `AgentSession` 与 `SessionManager.inMemory`，按认证前端来源、网页实例或 Discord 账号/频道、目标语言、术语配置隔离。网页实例包含标签页、文档 ID 与完整 URL 的 SHA-256 摘要，查询参数不直接进入用量记录。Ask Pi 使用另一命名空间，历史不会混入翻译。队列按会话范围串行，完成版本/保护标记校验后才运行下一回合，其他范围仍可并行。压缩使用 Pi 自带切分、摘要、持久条目投影机制；模型较小的测试/兼容端点将 Pi 默认保留额度裁到供应商容量内，不自建另一套历史摘要引擎。

会话的模型调用入口统一检查全输入（包括历史）及输出容量。翻译、问答与每笔压缩都有独立 requestId 和 `purpose`，写入原有 in-flight 检查点与用量历史；一个回合的展示可汇总辅助消耗，但不能再与记录相加。摘要用量无法记录时不继续生成；未发送的回合通过 Pi 的原生树导航恢复投影，保留已完成的摘要，避免失败请求堆入后续输入。原始树条目仍仅在内存中，清理/进程退出后消失。

模型容量来自供应商 `/models`、官方规格快照或已安装 Pi 的模型目录，注明来源。DeepSeek 官方端点在 Runtime 初始化时读取 `/models`；网络暂不可用时使用注明核对日期的官方快照。兼容端点缺少容量元数据时拒绝猜测，可在本地配置文件的 Provider 模型配置中提供带模型标识和来源的已核实 `model.capabilities`。`maxOutputTokens: 0` 表示按本次任务自动分配，并受真实模型输出/上下文额度约束；正值保留为用户明确选择的请求额度，不再有应用的 8,192 上限。自动分配不是供应商的精确 tokenizer。分批、队列与 Native Messaging 帧限制是传输/资源策略，不是宣称模型只支持这些上下文大小。

网页与 Discord 的大模型请求共用上述原生 Pi 能力；浏览器的本地执行路径仅用于免 Key 翻译，不会读取旧浏览器凭证。

## OpenAI OAuth 与 API 等值用量

OpenAI 可选择 API Key 或 ChatGPT 订阅，认证集中于 Bridge；两端复用一个注入宿主 React 的登录组件，兼容各自运行时。OAuth 使用独立的 Pi 凭据文件，订阅请求限制为官方 OpenAI Responses 端点；登录状态和操作不暴露给网页内容脚本。重新登录/退出清理旧上下文，自动刷新保留同账号上下文。订阅与 API Key 均按响应的实际 Tokens、缓存分桶及价格快照计算费用，订阅调用标记 API 等值，不以 SDK 的订阅零 cost 代替计算结果。具体存储、流程和升级见 [OAuth 说明](oauth.md)。

## 独立模型与多账户（2026-10-15）

账户、任务默认值和会话覆盖分开管理。`settings.model` 保留为翻译默认配置，`settings.askModel` 是新 Ask 的默认值；Ask 请求可携带独立 `model`，界面在新建会话时固定初始选择，后续变更默认值不修改已有对话。`accountId` 仅引用后台凭证，客户端不能提供或接收保存的 Key。账户同时绑定 provider、endpoint、authMode；修改地址不能复用旧账户 ID。

共享的纯账户更新与导入逻辑位于 `provider-pi/accounts`；Bridge 是唯一活动账户存储，原子保存 `accounts.json`，POSIX 权限 0600。支持命名、多账户、同供应商多个 Key、更新与移除，默认模型仍引用的账户需先重新选择默认值再移除。旧单 Key 配置迁移成账户，保留 `provider.json` 的翻译默认值兼容写入。

旧浏览器 local/session 凭证仅作待迁移数据保留，不再用于请求或写入新凭证。用户从连接页发起迁移，通过已授权 Native Messaging 导入账户；相同 provider/endpoint/authMode/Key 去重，不同 Key 保留为独立账户并重映射 ID。翻译/Ask 默认值和迁移收据在同一次原子写入提交，收到确认后才删除浏览器副本。收据跨重启保留，重复提交不重置后续修改，也不发起模型请求。未更新的助手拒绝新操作时保留浏览器数据，要求同时更新两端。余额查询也在助手中使用当前共享 Key，缓存按 Key 隔离，认证错误只返回安全提示。

每个 Bridge Ask 会话拥有独立 Pi 运行时和凭证。切换 provider/model/effort 时通过 Pi `SessionManager.inMemory` 转移本会话的分支、压缩条目和累计费用，验证新运行时后再释放旧实例。其他会话及翻译运行时保持隔离。用量及压缩记录按本次实际模型记账，不重复累加历史。Ask 的账户/模型选择不会保存成翻译配置，也不会清除其他对话。

模型目录通过 Pi `getSupportedThinkingLevels` 提供真实可选档位；切换模型清理旧 effort、容量和价格。请求端拒绝不支持的档位，使用 Pi 原生 `thinkingLevel`。API Key 账户支持多个；ChatGPT OAuth 仍由一个 Bridge 的 Pi 登录文件管理，账户别名不代表多个独立订阅登录。

设置与 Ask 的组件通过注入宿主 React 在扩展和 Discord 中共享。界面分为翻译、Ask 默认值和供应商账户三个区域，Ask 使用紧凑的会话选择器。设计参考 Envoi 的账户管理与聊天交互、[LobeHub 的设计规范](https://github.com/lobehub/lobehub/blob/canary/DESIGN.md)以及 [Nanobrowser 的按任务选择模型](https://github.com/nanobrowser/nanobrowser)；布局与样式为本项目重新实现，保留用户 Figma 标志。
