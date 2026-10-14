# LingoSofa：统一双语翻译与 Pi 助手技术方案及选型

**讨论版 v0.3 · 2026-10-14**

本版替代此前仅面向 Discord 的 v0.1 作为项目总体设计基线。当前实现、自动验证证据与真实客户端待验收条件见 [验收记录](acceptance.md)；“选型”不等于用户已批准第三方客户端修改或安装。

## 一、产品定位

LingoSofa 是统一双语翻译与 Pi 助手项目，提供三个交付物：

1. **浏览器扩展**：普通网页段落级双语翻译、划词翻译、页面内容问答
2. **Discord 桌面插件**：逐消息手动翻译、可选自动双语、围绕选中消息提问
3. **可选本地 Pi Bridge**：需要完整 Pi 会话、Node 侧认证或共享本地模型配置时安装

共用翻译和模型能力，各自适配宿主界面；不是同一个安装包通吃所有平台。

核心体验：保留原文、译文就地显示、技术符号不被改写、默认忠实翻译、只有用户主动选择才解释或润色。

### 首版范围建议

- 浏览器优先支持 Chrome / Edge 桌面版（MV3）；macOS 和 Windows 为验收平台
- Discord 候选适配 Vencord；是否采用非官方客户端修改需要单独确认
- 必须支持逐条/逐段手动翻译；自动模式按网站或频道明确启用
- 首版不承诺 PDF/OCR、字幕、移动端、Safari、所有 iframe/Shadow DOM、所有任意网站完全兼容
- Firefox 预留适配，必须单独验证后才能列为支持，不能因构建框架支持就直接宣称产品支持
- 不自动向网页表单或 Discord 发送生成内容

## 二、明确选型

| 层            | 首选                                                    | 为什么                                                                   |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| 语言/仓库     | TypeScript 严格模式 + npm workspaces + 单一锁文件       | 共享协议和纯逻辑；不额外引入大型构建编排系统                             |
| 浏览器框架    | WXT + Manifest V3                                       | 管理入口、manifest、开发构建及多浏览器输出；不替代浏览器原生权限机制 [1] |
| 网页处理      | 原生 DOM API + MutationObserver + IntersectionObserver  | 保留原网页结构；增量发现、按可见性调度                                   |
| 设置与问答 UI | React + 作用域 CSS                                      | 复用组件逻辑；网页正文不做整页 React 接管                                |
| Discord UI    | Vencord TypeScript 插件 + 宿主 React                    | 已有消息菜单和下方译文 accessory 的实现参考 [2]                          |
| 模型统一层    | @earendil-works/pi-ai 的项目适配器                      | 统一模型调用；浏览器可用，但必须验证 MV3 打包与供应商能力 [3]            |
| 完整 Pi 会话  | Node.js 侧受控 pi-coding-agent SDK                      | 仅在本地 Bridge 中使用；不打进 content script [4]                        |
| 本地运行时    | 满足锁定 Pi 版本要求的 Node.js                          | 直接接 TypeScript SDK，避免 Rust ↔ Node 双运行时增加首版复杂度           |
| 结构校验      | Zod                                                     | 统一校验 IPC、模型结果和配置迁移                                         |
| 浏览器存储    | browser.storage（设置/小量状态）+ IndexedDB（可选缓存） | 不把长文全部塞入同步存储；敏感内容默认不持久化                           |
| 本地缓存      | 内存 LRU；需要持久化时 SQLite                           | 与浏览器共享缓存规则，不共享实际数据库                                   |
| 单元/集成测试 | Vitest + 模拟模型服务                                   | 测试内容保护、队列、取消、缓存、协议和隔离                               |
| 浏览器 E2E    | Playwright + 固定测试页面                               | 检查扩展实际加载、DOM、SPA 和后台重启；具体浏览器安装验证独立执行        |

不先做独立 Electron 客户端；不先引入 Rust/Tauri；不首版同时适配 BetterDiscord 和 Vencord。若 Vencord 接入验证不通过，再调整宿主路线。

所有依赖在 M0 固定具体版本；最终以锁文件和兼容性清单为准，不把 main 分支文档等同于任意已发布版本的 API。

## 三、共享什么，不共享什么

### 共享纯逻辑

- 翻译任务、结果、错误和流式事件类型
- 语言配置、提示词版本、术语表、模型配置描述
- 代码/链接等片段保护与恢复、模型输出验证
- 缓存键计算、去重、优先级、并发、取消、重试规则
- provider 能力抽象、请求长度/用量估算和预算逻辑
- Pi 用量数据的展示映射、汇总和预算状态；复用 Pi 现有统计能力
- 问答上下文组织和用户选择记录

### 各端独立实现

- 网页：段落提取、DOM 定位、网页样式与 SPA 变动
- Discord：消息 ID、编辑版本、引用、附件占位和虚拟列表
- 浏览器：host permissions、后台生命周期、存储、扩展配置页
- 桌面：插件加载/卸载、本机配对与宿主组件兼容

核心包不得导入 window/document、chrome/browser、Discord 内部模块或 Node 文件系统。网络、存储、凭证和日志通过接口注入。

## 四、架构

```text
浏览器 Content Script                    Discord 插件
  提取段落 / 插入译文                      消息 / 译文 accessory
          │                                    │
          ▼                                    ▼
扩展后台：请求验证、任务管理               经鉴权的本机连接
  ├─ 浏览器 pi-ai provider → 模型 API            │
  └─ Native Messaging ───────────────► 本地 Pi Bridge
                                         ├─ pi-ai 翻译
共享 translation-core / protocol          └─ 受控 Pi SDK 问答
```

### 轻量模式

浏览器扩展直接使用已验证可在浏览器运行的 provider，不要求用户安装本地软件。网络请求在扩展后台执行，content script 不持有供应商密钥。仅请求用户启用的网站和模型 endpoint 权限。[5]

### 本地 Pi 模式

用户另装本地 Bridge，浏览器经 Native Messaging 连接；Discord 使用经鉴权的 loopback 接口或可用的受限 native bridge。两种传输承载同一应用层协议。[6]

本地 Bridge 同时可服务两个前端，但浏览器/Discord 的内容上下文默认隔离，不自动混在一个会话里。凭证共享、预算共享和缓存共享是不同选择，不应捆绑授权。

### Pi 支持的含义

- **pi-ai**：普通翻译和轻量问答的模型接口，浏览器和 Node 分别打包
- **Pi SDK**：本地 Bridge 中的完整会话接入；默认配置可能启用工具和资源发现，必须显式约束
- **RPC**：后续需要对接独立 Pi 进程时增加，不首版同时维护 SDK/RPC 两套实现
- 独立 pi-ai 不会自动继承所有 Pi CLI 登录状态；凭证复用通过明确配置适配
- 浏览器不支持的认证/provider 走本地模式，不通过把 token 暴露给网页来规避

## 五、普通网页双语流程

1. 用户点击翻译页面/选中文本，或授权该网站自动翻译
2. 找到正文候选块，排除导航、隐藏内容、输入框、contenteditable、脚本和代码块
3. 以段落/列表项/表格单元格为基本单位；保留正文内联标记的位置关系
4. 为段落生成稳定的当前文档标识、正文摘要与 revision
5. 可见块优先进入队列；按 token 预算批量请求，结果用 block ID 对齐，不能只靠返回顺序
6. 校验模型输出及保护片段，插入独立译文节点；不替换原节点的 innerHTML
7. 页面更新后仅重处理变化内容；自身插入节点带标记，防止 MutationObserver 递归翻译
8. 关闭翻译时移除本工具节点和监听，恢复原页面；不得覆盖网站后续更新

注意：任意 DOM 位置直接插入一个 div 可能破坏表格、列表、行内布局。渲染器需要按父节点语义选择合法插入位置；不支持的结构先提供悬浮译文或跳过。

SPA/无限滚动采用增量扫描和节流，禁止每次变动重新遍历整个 document。开放 Shadow DOM 可后续适配；封闭 Shadow DOM、跨域 iframe、浏览器内置页及 PDF 等限制明确显示，不假装已翻译完整页面。

### 网页问答

支持“解释选中内容”和“询问当前文章”，后者必须先预览提取范围。不会因页面写着“读取其他标签页”就读取其他标签页；不自动访问页面链接、附件或下载文件。

## 六、Discord 适配

- 手动入口：消息菜单、悬浮按钮
- 自动入口：按频道开启，优先当前可见消息，不抓全部历史
- 显示：原文下方译文，可折叠、重试、复制、向 Pi 提问
- 编辑/删除：以 messageId + revision 绑定结果，过期响应丢弃
- 虚拟列表：组件卸载不等于消息不存在，重挂载从任务/缓存层取结果
- 草稿翻译：预览后用户手动替换/复制；不自动发送

已有 Vencord Translate 证明相关 UI 接入点有参考实现，不代表它提供可直接注册 Pi 的 provider 接口。我们使用自己的服务调用、状态和缓存，避免依赖它的内部 provider 分发逻辑。[2]

Vencord 自定义插件需要自行构建和维护；Discord 没有官方桌面内嵌译文插件 API。此路线仍有账号、条款与版本兼容风险；官方 User Install 仅作为手动操作的备选，不等价于原位自动翻译。[7][8]

## 七、任务协议、缓存与费用

统一 TranslationUnit：

```ts
interface TranslationUnit {
  id: string;
  revision: string;
  sourceKind: "web" | "discord";
  text: string;
  sourceLanguage?: string;
  targetLanguage: string;
  context?: string; // 仅用户明确选择的上下文
}
```

宿主 DOM 引用不进入协议。origin、tab/frame 和 Discord 账号/频道边界由宿主可信元数据绑定，不能直接信任页面伪造的字段。

状态为 idle → queued → running → success / failed / cancelled。只缓存经过校验的最终成功结果。请求携带 requestId、revision、幂等键；UI 忽略旧 revision 和已经取消的请求事件。

缓存键含隔离域、原文摘要、目标语言、模型/provider、提示词及术语表版本、上下文摘要。网页本地缓存与 Discord 缓存不默认混用，隐私模式不持久化。

手动翻译和主动问答优先于后台自动任务。初始并发建议每个执行后端 2 个翻译请求、每个问答会话 1 个回合；队列有上限。限额在浏览器和 Bridge 各自生效，直连模式下不能假装自动拥有跨端统一预算。

取消尽量中止上游请求，但无法保证模型供应商停止计费。超时/断线后可能已计费，结果未知的请求不无限重放。价格信息缺失或过期时显示 token 用量并标注费用未知。

### LLM 用量、额度与性能展示

首版提供用量监控，帮助用户了解翻译和问答的消耗、速度及剩余预算。实现以 **复用 Pi 已有数据，补齐展示和跨任务汇总** 为原则，不重复实现 provider 的 token 统计或费用计算。

核对当前 Pi 源码可见：`pi-ai` 的 `AssistantMessage.usage` 已包含 input、output、cacheRead、cacheWrite、totalTokens 和分项 cost；还提供可选 reasoning、durationMs 及流式事件。本地 `pi-coding-agent` 提供 `getSessionStats()` 汇总会话 tokens、费用和上下文占用。[12][13] M0 需以锁定版本及实际 provider 验证这些能力，不能把 main 分支字段直接当作所有版本的保证。

#### 展示方式

参考 DeepSeek Harness 生态中的用量面板：紧凑状态栏展示主要指标，展开后查看汇总卡片、趋势和单次请求明细。`dsh-usage-chart` 是社区插件，其用量、费用、余额与 TTFT/TPS 展示可作交互参考，不作为 LingoSofa 的运行依赖。[14]

- **紧凑状态栏**：扩展弹窗、问答面板和 Discord 插件面板显示当前模型、Input / Output、TPS、估算费用与预算进度；网页正文不逐段堆积指标。
- **请求明细**：展开单次翻译批次或问答回合，查看缓存读写、首输出延迟、耗时、结束状态及费用；一个批次包含多段时，用量归属于整个请求，不伪造逐段精确账单。
- **用量面板**：按当前页面/频道、问答会话、今日和本月查看请求数、tokens、估算费用与趋势；支持按 provider、模型、浏览器/Discord、本地/直连模式筛选。日期边界使用用户配置的时区。
- **额度区域**：分别显示本地预算余量、供应商账户余额和可查询的额度重置时间，并标注统计范围、来源与更新时间。缺失项显示“未提供”或“未知”。

#### 指标口径

| 指标               | 数据来源与显示规则                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input              | 展示总输入；按 Pi 的互斥桶口径为 `input + cacheRead + cacheWrite`，展开显示未缓存输入、缓存读取和缓存写入                                                   |
| Output / Reasoning | 使用 Pi 的 output；reasoning 仅在提供时展示，它是 output 的子集，不重复累加                                                                                 |
| Total tokens       | 使用 Pi 的 totalTokens；汇总遵循同一口径，不把缓存或 reasoning 重复计入                                                                                     |
| 模型缓存命中率     | `cacheRead / 总输入`；总输入为 0 时不计算。与 LingoSofa 本地译文缓存命中率分开展示                                                                          |
| 费用               | 优先展示 Pi 的分项 cost 和 total，明确标为估算费用并保留价格来源/币种；自定义模型无有效价格时显示未知，不能把默认 0 当成免费                                |
| 模型耗时           | 优先使用 Pi 的 durationMs；缺失时在执行端用单调时钟补充计时。队列等待和译文校验/渲染耗时分开记录                                                            |
| TTFT / 首译文延迟  | 从请求发送到首次非空输出事件的时间；思考输出与正文输出分别记录，状态栏优先展示用户等待首段译文的时间，不用 SSE 心跳代替输出                                 |
| TPS（tokens/s）    | 优先复用锁定 Pi 版本提供的同口径性能数据；否则以最终 output tokens 除以首输出至末输出的秒数，标为客户端观测平均吞吐。思考计入 output 时计时也需覆盖思考阶段 |
| 请求与状态         | 展示运行中/排队数量、成功、失败、取消和重试次数；与模型计费次数区分，底层重试不可见时注明统计不完整                                                         |

流式过程中展示 Pi 已提供的用量；若 provider 只在结束时返回 usage，则显示“统计中”，结束后再更新，不把 chunk 数或字符数当作 tokens。缺少有效时间窗口、非流式响应或仅有一次输出时，TPS 显示“不可用”。汇总 TPS 用有效请求的 output 总数除以各请求生成时长之和，并注明是平均单请求吞吐，不把并发请求误算成模型单路速度。

#### 数据接入与汇总边界

- 浏览器轻量翻译直接从 pi-ai 结果及事件取数；本地 Pi 问答复用 SDK 会话统计和事件，不为展示强制引入完整 Agent 会话。
- `provider-pi` 负责薄适配，将 Pi 数据与 requestId、执行端、模型和任务范围关联；`protocol` 传递展示所需的元数据，`ui-shared` 负责格式化和面板逻辑。统计不依赖 DOM 或 Discord 内部组件，不额外引入大型监控系统。
- 单请求数据与会话汇总是同一消耗的不同视图，不能相加；流式更新采用替换快照，最终按稳定请求/消息标识去重，后台恢复或重新挂载不能重复入账。本地 SDK 的汇总范围需保留压缩等辅助调用产生的消耗。
- 本地译文缓存命中不新增模型用量；失败或取消仍保留 Pi 返回的 usage。上游结果未知时显示未知消耗，不直接记为 0；仅在执行端可观察到各次重试时逐次统计。
- 直连模式只汇总当前扩展可观测的用量；两端经同一 Bridge 执行且用户启用共享统计时，才展示跨端汇总。不得声称覆盖同一 API Key 在其他应用中的全部支出。
- 默认统计仅保留当前会话的元数据，不保存正文、译文或密钥。今日/月度趋势需用户启用有限保留期的本地用量历史；未启用时明确显示仅当前会话可用，并提供清除入口。

#### 额度与预算

Pi 的 usage 表示已观测消耗，不能直接推导账户剩余额度。优先复用 Pi 在锁定版本中已提供的账户能力；没有统一接口时，仅为支持的 provider 增加可选查询。例如 DeepSeek 官方 `GET /user/balance` 可返回余额和币种，但不等于所有供应商都有余额、订阅额度或重置时间接口。[15] 查询由扩展后台或 Bridge 使用现有凭证执行，前端只接收结果；按需查询并限频，不逐段请求余额，失败时保留带时间戳的旧值。

- 支持用户设置日/月 token 或费用预算，以及可配置提醒阈值（如 80%、100%）；明确其为 LingoSofa 本地预算，与供应商余额、订阅额度和速率限制分别展示。
- 发起请求前检查已用量和在途预留，避免并发任务同时越过预算；完成后按 Pi usage 结算。费用未知或结果未知时，严格预算模式暂停新请求并提示处理。
- 达到预算上限时停止派发新任务，用户可主动调整预算；在途请求仍可能产生费用，不能承诺绝对不超支。429 显示限流状态，仅在供应商返回可靠信息时展示恢复时间。

## 八、MV3 必须先解决的工程问题

- pi-ai 的浏览器兼容性不等于其所有动态依赖天然适合扩展 service worker；只打包需要的 provider，检查产物不含无法执行的动态 import、远程代码或 Node-only 依赖 [3][9]
- 后台可能终止，不能把任务、设置、队列只放全局变量；恢复时区分未发送任务与结果未知任务，禁止盲目重新计费 [10]
- 默认隐私模式可用会话级状态保存小量上下文；持久化任务/缓存需可关闭、有限保留期
- 跨域模型请求需要 endpoint 权限；content script 不接受网页转发任意 URL 的“通用代理”请求 [5]
- 本地 Native Messaging host 必须单独安装并限制允许的扩展 ID；content script 经扩展后台转发，不能直接调用本机程序 [6]
- 首版对慢模型设置明确超时；需要长时推理的问答优先使用本地 Bridge，不通过无意义心跳长期占用后台

## 九、安全与隐私默认值

- 页面和聊天都是不可信输入；不能成为 system 指令、Shell 命令、文件路径或可执行模型输出
- 翻译、普通问答工具集为空；本地 SDK 关闭非必要扩展、模板展开和工作目录资源发现
- 默认不上传表单、密码框、隐藏内容和整页 DOM，不扫描其他标签页
- 自动模式必须显示发送目标与范围；改变模型供应商不得悄悄改变数据接收方
- 用户自带密钥；不在包里内置共享 API Key，不把密钥写入页面或同步存储
- 扩展本地存储不是硬件安全保险箱；限制 content script 存储访问，提供仅会话保留选项。更强凭证保护使用本地 OS 凭证存储与 Bridge
- 译文仅以安全文本或受限结构呈现，不执行 HTML，不自动加载模型提供的远程资源
- 本机接口只绑定 loopback，短期配对令牌、来源校验、限流与最小权限。localhost/CORS 不能代替身份验证，独立进程不能代替沙箱
- 日志默认只记状态/耗时/用量，不记正文与令牌；清除缓存、会话和站点授权都有明确入口

## 十、目录与交付

```text
apps/
  browser-extension/    # WXT：content / background / options / Q&A
  discord-vencord/      # Vencord 独立构建目标
  pi-bridge/            # Node 本地服务，可选安装
packages/
  translation-core/    # 纯 TS 规则、调度策略、保护和校验
  provider-pi/         # browser/node 分离入口，禁止混入Node依赖
  protocol/            # schema、错误、流式事件
  glossary/            # 术语规则及版本
  ui-shared/           # 设置/问答逻辑；不绑定宿主React实例
  web-extraction/      # 网页特有，不让Discord依赖
tests/
  fixtures/            # 合成网页与聊天
  integration/
  e2e-browser/
  desktop-acceptance/
docs/
  architecture.md
  privacy.md
  compatibility.md
  acceptance.md
```

浏览器插件商店包、Discord 插件构建、Bridge 安装包分别版本化，协议支持兼容检查。不要在浏览器包中夹带 Vencord 客户端补丁，也不要让网页适配器依赖 Discord 内部模块。

## 十一、开发顺序与完成标准

### M0：两端接入与 Pi 打包验证

- Chrome/Edge 真正加载 MV3 包，一段文本通过指定 provider 翻译成功
- 验证后台终止、重新唤醒、取消、超时和缺权限状态
- Discord 显示 mock 译文 accessory、翻译按钮和问答入口；经授权后才安装测试
- 本地 SDK 使用受限配置完成问答，不执行工具和扩展
- 核对锁定 Pi 版本的 usage、cost、会话汇总和流式事件；记录各 provider 的字段支持、价格来源及账户额度查询能力
- 每项记录实际版本、证据和未通过事项；任一核心接口失败先调整选型

### M1：共享核心与浏览器手动 MVP

- 普通文章、列表、表格单元格、带链接/行内代码段落可双语显示
- 选中翻译、关闭恢复、站点授权、模型选择可用
- 批量返回缺项/重复 ID/保护片段损坏均可检测，不错位显示
- 不翻译输入框或代码，不破坏原网页交互
- 用量状态栏与请求明细可展示 Pi 返回的 Input / Output、缓存、估算费用和耗时；缺失数据明确降级

### M2：自动模式与 Discord 手动版

- 可见性队列、无限滚动、消息/段落编辑与删除处理正确
- 原文不变时滚动返回不会重复请求；队列有上限
- 日/月预算提醒和停止派发可用；验证批量请求、并发预留、取消、重试与后台恢复不重复统计
- Discord 手动翻译和重复挂载稳定；适配失效时显示错误，不影响原聊天

### M3：两端问答与本地 Pi 模式

- 上下文预览、多轮问答、停止、新建、清理都可用
- 浏览器 Native Messaging 与 Discord 经鉴权连接同一 Bridge
- 不同网页/频道/账号会话隔离，未经选择不相互携带上下文
- 问答复用 SDK 会话统计；共享 Bridge 用量汇总按用户设置生效，不与单请求用量重复累加
- 先实现 Pi SDK，RPC 只有明确需要时再增加

### M4：自动双语完善与发布验收

- Discord 频道自动翻译、网页站点自动模式、预算和隐私设置全部有实测
- 测试 1,000 段合成页面及 100 次 SPA/频道切换：不重复节点、不无限增长订阅、不展示过期译文
- 记录 UI 响应、提取耗时、缓存延迟、模型延迟分别测量；建议本地反馈目标 <100ms，具体机器和方法写入报告
- 模型失败、429、异常输出、断网、Bridge 退出、版本不兼容均可恢复
- 验证流式/非流式、思考输出、未知费用、余额查询失败、模型切换和历史清除；TPS 计时口径、缓存/reasoning 计数及费用汇总有固定数据验收
- 真实客户端键盘/读屏与 Windows/macOS 矩阵验收，不把“能编译”作为发布标准
- Firefox/PDF/OCR/移动端等未测目标明确不在首版支持范围

## 十二、许可证与风险决策

浏览器功能和共享核心可以自主设计；若复制 Vencord Translate 的代码，必须遵守其 GPL-3.0-or-later 条件和版权声明。不能因为放进 monorepo 就消除许可证义务，也不能因此直接断言所有独立组件都必须同一许可证。发布前按实际复用与链接关系核对。

Pi 和 WXT 的许可分别以固定版本 LICENSE 为准。LingoSofa 的许可证尚未由用户选择；GitSofa 的许可证决定不自动套用到 LingoSofa。

**建议下一步：确认首个真实验收平台及是否接受 Vencord 路线，然后做 M0。** 设计阶段无需安装、提取 Discord token、注册新账号或发布任何消息。

## 资料

1. WXT：https://wxt.dev/guide/introduction.html
2. Vencord Translate：https://github.com/Vendicated/Vencord/blob/main/src/plugins/translate/index.tsx
3. pi-ai 浏览器支持：https://github.com/earendil-works/pi/tree/main/packages/ai#browser-usage
4. Pi SDK：https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
5. Chrome 网络与权限：https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
6. Native Messaging：https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
7. Vencord 自定义插件：https://docs.vencord.dev/installing/custom-plugins/
8. Discord 条款：https://discord.com/terms
9. MV3 service worker 基础：https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics
10. MV3 生命周期：https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
11. Content scripts：https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
12. Pi 消息、Usage 与流式事件类型：https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts
13. Pi AgentSession 会话统计：https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts
14. DeepSeek Harness 社区用量面板参考：https://github.com/Max-Samson/dsh-usage-chart
15. DeepSeek 账户余额 API：https://api-docs.deepseek.com/api/get-user-balance/

设计中的目录、协议、默认并发和指标是本项目建议，不是上述项目已提供的成品功能。
