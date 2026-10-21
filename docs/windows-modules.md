# Windows 桌面模块与接口设计

2026-10-21 · 本文定义目标模块与接口，包括尚未实现的 OCR 等能力；现有目录与进程边界以 [当前架构](architecture.md) 为准。总体基线见 [技术方案](lingo-sofa-plan.md)，模型运行时见 [模型与 OMP](windows-models-and-pi.md)，验收见 [阶段验收](windows-acceptance-plan.md)。

## 职责与依赖

Tauri 2 + Rust 后台已确定；React/TS 负责交互与展示；另有 TS OMP worker 承接全部 LLM provider 与会话。领域模块不依赖 Tauri、Windows、WebView 或具体 provider。模块是责任边界，不要求全部立即拆成 crate。

| 边界             | 拥有的职责/状态                                                                | 公开操作                           | 不承担                                 |
| ---------------- | ------------------------------------------------------------------------------ | ---------------------------------- | -------------------------------------- |
| 桌面 UI          | 窗口内视图、未提交编辑稿、选中项                                               | 发起动作、展示快照/事件            | 网络认证、模型请求、业务队列、密钥存储 |
| Tauri 适配层     | 窗口身份、capabilities、托盘、快捷键、显示器                                   | 校验命令、转发事件、协调焦点/位置  | 提示词、OCR 推理、计费规则             |
| 应用服务         | capture/task/session ID、归属、revision、任务生命周期                          | 取文、翻译、取消、固定、提问、关闭 | 供应商协议、COM 对象                   |
| 翻译领域         | 文本块、保护片段、术语版本、缓存键、调度策略                                   | 生成请求、校验结果、恢复片段       | 窗口、文件/网络 I/O、凭证              |
| 会话协调（Rust） | 窗口/快照/会话 ID 归属、模型绑定与状态投影                                     | 创建/关闭 OMP 会话、转发提问/取消  | 自建上下文引擎、压缩、工具执行         |
| OMP worker       | OMP provider、AuthStorage/ModelRegistry 认证、AgentSession 消息/压缩、流式事件 | 受限的目录/认证/翻译/Ask/取消操作  | 系统取文、产品窗口、另一套账户持久化   |
| 取文适配         | 前台窗口/焦点、来源范围、瞬时句柄                                              | UIA 选区、主动剪贴板读取           | 获取未授权窗口全文                     |
| OCR 适配         | 引擎实例、图像句柄、块坐标与阅读顺序                                           | 识别、取消、卸载引擎               | 翻译、模型问答、云端图片上传           |
| 数据服务         | 设置、账户元数据、DPAPI 密文、迁移收据、可选用量账本                           | 原子读取/提交、迁移、清除          | 自动持久化正文或截图                   |
| 用量服务         | 每次实际模型调用、价格快照、完成/unknown                                       | 预登记、更新、汇总、导出元数据     | 从字符数猜 tokens、重算历史价格        |

依赖方向：UI → Tauri 适配 → 应用服务 → 领域与接口；provider、Windows、OCR、存储是接口的实现，由组合入口注入。取文与 OCR 的输出只包含领域快照和坐标数据，不能把 HWND、COM 指针或数据库连接传进前端。

## 进程与线程

- **Rust Core**：管理窗口/子进程、应用状态和异步网络；不在窗口线程执行阻塞 I/O、SQLite 查询、OCR 或 COM 调用。
- **UIA 辅助进程**：专门的 COM apartment/线程，串行接受当前取文任务；超时可终止进程，重新启动不能重放模型调用。默认同一时刻最多一个取文操作。
- **OCR 工作进程**：隔离 native runtime 与模型推理；默认并发 1，用户新框选替代尚未开始的旧框选；正在运行的旧任务可取消/丢弃结果，必要时终止工作进程。
- **WebView 进程**：由 Tauri/WebView2 管理；各窗只接收属于自己的事件，卡片关闭不影响另一固定阅读窗。
- **OMP 模型进程**：必需运行组件，随包 Bun/OMP；首次模型操作按需启动，活跃会话期间保留。OMP 拥有上下文和压缩；并发顶层会话注入私有 AgentRegistry 和隔离 Settings，Rust 不再实现同类引擎，详见 [OMP 架构](windows-models-and-pi.md)。

全应用最初最多两个在途模型调用，同一 Ask 会话串行，翻译和 Ask 共用槽位；压缩也占槽位，OMP 的每次实际调用通过受控钩子获得 Rust 调度许可，不能由 OMP 自动压缩绕开并发和用量登记。队列上限初始为 32 个逻辑任务，手动 Ask/翻译优先，超过上限显示忙碌，不无限存入正文。并发、OCR 空闲卸载时间及资源限额在 W0 测量后固定。

正式实现已有持久化账本、全局双调用准入、有界优先级队列、排队取消/到期及 revision 失效保护；压缩预留两个名额，每次实际调用继续经过全局准入。兼容范围与待验项见 [验收状态](acceptance.md)。

## 领域数据与事件

| 对象            | 必要字段/规则                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------- |
| CaptureSnapshot | captureId、revision、sourceKind、blocks、localeHint、可选几何信息；来源元数据由本机适配层生成 |
| TextBlock       | blockId、原文、保护片段、可选 polygon；OCR 保留识别文本与用户修订文本的区别                   |
| TranslationTask | taskId、snapshot/revision、engine/model、accountId、术语/提示词版本、状态                     |
| AskSession      | sessionId、所有者、固定上下文、模型/账户、OMP 会话引用与展示投影（消息与压缩权威在 OMP）      |
| ModelCall       | callId、taskId、purpose（translation/ask/compaction）、实际后端、价格快照、用量状态           |
| AppEvent        | sequence、事件类型、目标资源 ID/revision、payload；只允许所属窗口订阅                         |
| OperationError  | 稳定错误码、可操作提示、能否主动重试；保留脱敏诊断，避免原始 provider 错误泄露密钥            |

来源隔离不能只依赖可复用的 PID/窗口标题；使用本次捕获生成的随机 scope ID。应用服务建立窗口→快照/会话的归属表。固定操作转移或复制明确的快照归属；关闭旧卡片后的事件不得误投新窗。

取消、内容 revision 与计费是不同状态：取消立即禁止后续 UI 覆盖，网络取消不能保证上游停止计费；后台仍处理可获得的最终 usage。重复终态按 callId 幂等更新。固定窗切换内容必须新建快照，不能覆盖仍被 Ask 引用的原快照。

## 前后端命令边界

命令类别限于 capture、translate、task.cancel、reader.pin/close、ask、settings、accounts、usage；不暴露任意 HTTP、SQL、文件读写或 shell。捕获由 Rust 快捷键回调记录原焦点，不能依赖 WebView 获得焦点后再找原选区。

Rust 领域类型为 schema 源头；W0 比较类型生成工具与 schema 校验方式，确定后在 CI 检查 TS 类型漂移。命令先验窗口身份/权限，再验参数、归属和 revision。订阅恢复先拿后台状态快照，再续接事件，避免重开窗口再次发起翻译。

辅助进程使用私有继承管道或带当前用户 ACL 的等价通道，协议握手含版本和实例标识，限制消息长度/队列。图像用有长度与所有权的受控句柄/共享内存传递，禁止前端传任意磁盘路径给 OCR。句柄无论成功、超时或崩溃都要回收，具体实现 W0 验证。

## 存储与迁移

规划桌面数据根为 `%LOCALAPPDATA%\LingoSofa`，实施前核对应用标识和现有路径冲突；禁止沿用旧助手目录并发写入。设置、账户元数据、迁移收据与可选用量历史采用版本化 SQLite，凭证字段保存用户范围 DPAPI 密文，OMP 通过受控存储适配读写并原子提交刷新结果；默认不建内容历史。SQLite 操作由专用执行边界串行化，不跨网络 await 持锁。

设置更改和默认账户引用使用事务提交；删除仍被引用的账户需先选择新默认值。设置页保留未保存稿，后台 revision 不符时提示冲突，不能静默覆盖其他窗口的更新。关闭并重启必须恢复已保存的引擎、语言、账户、模型、主题和快捷键。

用量历史关闭时只保留进程内统计，启动后明确提示只统计本会话；崩溃前的请求无法恢复时也不能显示为已核实零消耗。开启历史时发送前登记 unknown，最终结果替换同一 callId；关掉历史清除已有历史。迁移先备份、校验、去重和事务提交收据，再显示成功，重复导入不能重置用户后续选择。旧正文会话不迁移，旧 OAuth 凭据默认重新登录；旧文件不删除。

## 建议代码组织

- `apps/desktop`：React/TS、Tauri 入口与命令/事件适配。
- `crates/core`：领域类型、翻译与术语/保护规则；无平台 I/O。
- `crates/app-services`：任务、会话、账户、配置、用量及端口定义。
- `crates/omp-client`：受限 worker 生命周期、IPC、事件映射与认证/会话协调；不实现 LLM provider。
- `apps/omp-worker`：TS 受限 OMP SDK wrapper，provider、认证与会话/压缩；随包运行。
- Rust 免 Key 翻译适配放在应用服务对应边界，不经过 OMP。
- `crates/platform-windows`：系统接口与 DPAPI，unsafe/COM 封装集中审查。
- `crates/selection-helper`、`crates/ocr-worker`：独立进程入口与受控协议。
- `crates/storage`：SQLite、schema 迁移、备份和事务。

这是实施组织建议，没有要求立即建立全部 crate。先证明依赖单向、接口可测试，再按实际边界拆包。旧 TS 包和 Bridge 已删除；新 OMP worker 是桌面内部模块，Bun/OMP 及匹配的 Windows native addon 是明确的分发依赖。
