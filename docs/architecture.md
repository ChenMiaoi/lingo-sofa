# 架构与实现

总体设计见 [技术方案](lingo-sofa-plan.md)。当前协议版本为 1，各应用版本为 0.1.0。协议或 Bridge 配置 schema 改动后需重新执行 `package:native` 更新 native executable，旧产物会拒绝不兼容配置。

## 依赖方向

```text
browser-extension → web-extraction / translation-core / provider-pi/browser / protocol / ui-shared
Discord plugin    → translation-core / protocol / ui-shared → authenticated loopback Bridge
Discord native / Native Host → local-runtime → installed Node Bridge
Pi Bridge         → translation-core / provider-pi/node / protocol / constrained Pi SDK
translation-core  → protocol / glossary
```

共享核心不导入 DOM、Discord、浏览器或 Node 专属实现。宿主提供模型客户端、凭证、持久化检查点与统计回调。`web-extraction` 只处理网页 DOM；Discord 使用自身消息状态和宿主 React，不捆绑另一份 React。

## 网页生命周期

`PageTranslator` 扫描段落、列表、单元格和标题的叶子块，排除导航、表单、隐藏/编辑区域与代码块。每次扫描共享可见性缓存，避免为每个文字节点重复计算祖先样式。选区同样逐文字节点过滤，并保护实际选中的内联代码和链接文本。

每个元素记录稳定 ID、revision、原文和取消控制器。IntersectionObserver 优先调度可见范围，MutationObserver 只扫描变化区域，编辑/删除/隐藏会撤回过期节点和任务。渲染用安全文本 span，插入块内部，保持列表和表格结构。关闭时断开监听，仅移除自身节点。

`TranslationBatcher` 最多合并 16 段、约 4,000 字节的序列化输入，最多两个批次同时发送，待处理上限为 1,000 段；单个大段允许独立请求。后台队列另有 100 个任务上限。预算采用保守字节估算，不冒充准确 tokenizer。批次取消按段生效，全部成员取消时才中止共享模型请求。输出按 ID 和 revision 对齐，损坏/缺项/重复结果不会显示。

## 核心执行与用量

后台和 Bridge 均使用 `TranslationService`：手动翻译/主动问答优先，最大并发 2，单问答会话最多一个回合在途、20 个成功回合，最多 50 个会话。缓存最多 500 项，包含隔离域、正文、保护片段、语言、上下文、模型、提示词版本与术语表。混合批次只发送缓存未命中的段落；本地缓存命中不新增模型消耗。

发起模型调用前按日/月预算检查已用和在途预留。Bridge 默认按认证前端来源分别计算预算；`shareBudget` 显式启用后才合并跨端预算，与 `shareUsage` 的统计授权独立。结果通过 Pi usage 结算；失败/取消保留可观测用量。未知费用或消耗可暂停严格预算。主动取消不会提前释放正在执行的队列槽位，必须等上游结束并完成结算，防止晚到结果重新入账或虚增并发。provider 和 SDK 的自动重试均关闭；重试按钮创建新请求。

Pi 互斥输入桶相加作为总输入；reasoning 不重复加入 output。TPS 只使用有效的首次至末次非空输出窗口；汇总按输出总数除以生成时长之和计算。模型返回的 durationMs 优先，缺失时补充单调时钟测量。DeepSeek 官方峰/谷价格按每次请求开始时间冻结快照；2026 年节假日按中国民用日期，时段和周末按 UTC 规则。未知日历年份峰时窗口用峰时上限；其他 provider 用 Pi 目录或显式用户价格。预算按峰时上限预留，历史不回算，未知不能按免费处理。SDK 会话汇总与请求记录是同一消耗的不同视图，不相加。

## 可信边界与恢复

页面请求只来自当前扩展的顶层 HTTP(S) content script。网站、tab/frame/document 由后台 sender 元数据绑定；页面不能传任意网络代理 URL、读取密钥或查询账户。问答预览绑定随机文档标识，刷新/导航后必须重新预览。

Native Messaging 与 Discord loopback 使用同一 Zod 应用协议，版本不匹配拒绝。Native caller 必须在允许的扩展列表中；loopback 另外验证 Origin、Host、服务实例 Bearer token、请求大小和速率。Origin 和 token 是前端认证边界；已配对的同一 Discord 进程内不同账号/频道 scope 由插件绑定，Bridge 无法独立验证 Discord 账号身份。

浏览器 session storage 保存已发送任务的最小元数据检查点。后台重启时恢复成功用量及消耗未知任务，不重放正文或模型调用。Bridge 默认会话内存统计；用户开启历史后将元数据原子写入 `usage.json`，发送前写 unknown，完成后以同一 requestId 替换。禁用历史会删除旧文件。持久化校验失败时拒绝启动/操作，不静默当成零预算。

本地 Pi 使用内存会话、空工具集、空 resource loader，关闭扩展、资源发现、模板展开、压缩、缓存预热和自动重试。受限配置不是操作系统沙箱。

## 构建约束

浏览器只使用明确导入的 OpenAI completions/DeepSeek provider，Node 入口单独构建。Zod 4.6.7 的可选 JIT 探针与编译器在 WXT 构建中被移除，普通解析器保留；版本源码改变会使构建失败，要求重新审查适配。

`verify:extension` 解析每个产物脚本，拒绝远程/计算式 import、运行时 require、eval 和动态 Function 构造器，并验证 MV3 与可选 host permissions。Pi 包中的 Bun 环境分支会触发 Vite 的 node:fs externalization 提示，但产物不含实际 Node module import；真实 Chromium service worker 测试验证当前 provider 路径。此审计不代替客户端和供应商兼容性验收。

## 本地后台服务

默认通过安装后的共享 Bridge 执行；已有浏览器直连仍是显式可选模式。`local-runtime` 是 Node 宿主启动/连接边界，不进入共享翻译核心或网页。Native Host 与 Vencord native 层使用同一个 `RuntimeClient`：发现健康服务、启动固定本地安装入口、更新连接租约。HTTP 服务状态验证版本与随机实例 ID；浏览器 stdio 外层只增加 `transportId` 与 `payload` 以匹配并发响应，应用协议仍为版本 1。Discord HTTP 与浏览器 relay 转发同一业务请求，不向 content script 下发服务 token。

服务先绑定本机端口，再初始化历史和发布连接描述文件。并发启动的其他进程无法获得该端口，因此不会成为竞争的历史写入者。实例凭据随机生成并只存于 0600 描述文件，随服务重启轮换；没有永久全局配对令牌，也无每小时人工配对。

在线租约每 15 秒续期，45 秒过期；正常停用/stdio 关闭释放对应来源的租约。只在全部租约消失 60 秒且没有排队、执行、配置保存任务时退出。HTTP 优雅关闭等待已接受请求完成，持久化写入队列完成后删除描述文件。连接断开只重连控制通道，不重发模型调用。保留 unknown 检查点和预算暂停状态。具体安装、边界和验收见 [服务生命周期](service-lifecycle.md)。
