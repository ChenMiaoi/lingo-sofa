# 正式桌面实现

2026-10-21。本文描述现有代码；[总方案](lingo-sofa-plan.md) 与 Windows 设计文档还包括未实现目标。

界面沿用 v3 的阅读与 Ask 工作流，按后续确认改为中性灰黑、半透明表面。设置参考 oh-my-pi 的紧凑列表组织：左侧名称、右侧当前值、弱化说明，保留桌面分类子页；模型、服务商与凭证使用对齐的设置行。设置首页默认聚焦首项，支持方向键选择与 Enter 打开，Esc 逐级返回。输入、Ask 与继续追问共用本机斜杠命令解析，导航命令直达设置子页，配置命令复用模型选择与偏好服务接口；未知命令不回退到模型调用。`/model` 在 launcher 内打开键盘模型选择器，按已配置服务商读取全部目录分页后在本机搜索；Esc 返回原命令，确认后复用 `select_model`。无凭证时使用同一浮层中的服务商选择、模型选择和密码输入步骤，调用 `save_provider` 成功后再选择模型，失败保留原默认模型；模型选择器不依赖设置导航。`/new` 通过 `new_session` 重置 Service 会话并递增桌面 epoch，清理原文、结果和草稿后返回 Input，阻止旧选区任务回填。语言与置顶以字段补丁在 Service actor 中合并、持久化并确认，避免前端轮询间隔内连续命令覆盖彼此。Ask、输入、菜单与设置使用 Windows 原生 Acrylic，CSS 提供灰黑底色与细边框；系统未提供背景效果时仍可读取文字。输入面板为 620 × 324，编辑区随内容增长并在上限内滚动，不再使用固定的大文本框。[交互设计原型](design/desktop-v3/DESIGN-NOTES.md)保留阅读与 Ask 的设计约束，配色以当前实现为准。

```text
React → Tauri commands → Service actor → scheduler → Host → private pipes → Bun/OMP
                           ├─ SQLite settings
                           ├─ DPAPI credentials
                           └─ SQLite usage ledger
```

`crates/core` 不引用 Windows、Tauri、Node 或网络。`omp-client` 封装 Windows Job、IPC、凭证和账本；`app-services` 在专用线程拥有 Host，窗口线程只发送有界命令、读取无密钥快照。模型任务通过业务队列调度，保留优先级、TTL、会话串行、revision 淘汰和全局 2 个调用上限；压缩预留 2 个名额。

当前 UI 显示一个阅读会话。重新翻译取消旧任务并新建会话，追问复用当前会话。取消不代表零费用，断线不自动重发。压缩通过相同业务队列执行。状态每 120ms 拉取，只有当前会话的流式文本进入结果；隐藏再打开不重复发请求。

手动输入复用 Ask 的深色 launcher，输入模式支持多行原文和明确的翻译/新问题动作，结果复用 Ask 回答区域。`submit_new_question` 将新问题与继续追问区分，在同一准入命令内强制新会话；不继承之前的原文或翻译指令。选区和剪贴板翻译仍使用轻量译文浮层。

`apps/omp-worker/src/worker.ts` 是唯一生产入口，通过 SDK ModelRegistry 与认证元数据提供服务商、分页模型目录和原生协议。当前开放 API Key + 原生聊天协议的服务商；默认模型可切换，未保存选择时沿用 `deepseek/deepseek-flash`。模型目录读取随包 SDK 数据，不主动查询所有服务商接口；目录存在不代表账户已获授权，凭证与模型权限仍以实际请求结果为准。受限 SDK 禁用工具、项目资源、扩展发现、自动压缩、重试和回退。多个服务商的 API Key 在 Rust vault 中独立保存；worker 握手只请求 Host 允许的账户标识，模型启用后仅将所选服务商凭证放入 SDK 内存认证存储。SDK 原生流式调用仍经过统一的并发准入、用量终态提交与取消通道，网络目的地限定为所选 SDK 模型地址且拒绝重定向。切换默认模型或修改凭证结束旧 worker 和会话，后续请求使用持久化选择；不自动回退至其他服务商。进程环境被清理，不读取开发 `.env`。模拟 HTTP、假 OAuth 和故障入口仅在 `tests/fixtures`。

Tauri 命令检查 `main` 窗口身份，不开放任意 URL、SQL、文件或进程执行；前端仅拥有拖动权限，CSP 禁止供应商网络访问。输出使用普通 React 文本渲染。剪贴板快捷键仅在按下时读取文本。桌面快捷键模块独立管理三项组合，保存于 `shortcuts.sqlite`；先验证和注册新组合，再提交 SQLite，成功后更新路由并释放旧组合。失败会撤销新注册并保留原设置；启动时逐项注册和报告，未启用项不影响其他入口。旧组合若释放失败也不再分发动作。默认 Alt+Shift+Space 唤出输入面板，重复唤出保留草稿；所有按键展示来自当前注册状态。

desktop v3 的边缘入口、译文浮层、Ask、输入和设置由 Rust Shell 控制窗口尺寸、位置和焦点。Alt+Shift+S 启动独立 `selection-helper.exe`，通过 UIA 只读取前台应用的非密码选区及矩形。首帧限时 1800ms，后续心跳限时 900ms；助手挂起时由 Job 回收。原窗口移动、选区变化或失效时收起译文并取消任务；已经主动打开的 Ask 保留原文，停止依赖旧锚点。几何计算有纯函数回归；应用兼容性按验收记录逐项说明，混合 DPI 尚未完成。OCR 尚未接入。

取文会先验证焦点至来源窗口的祖先路径（最多 32 层），再沿该路径查找 TextPattern；拒绝密码或无法验证的路径，不扫描文档后代。已验证记事本、独立 VS Code 与 Discord 消息正文；浏览器未通过，混合 DPI 仍未验收。

数据根为 `%LOCALAPPDATA%/LingoSofa`：`credentials.sqlite` 保存用户范围 DPAPI 密文与 CAS revision；`settings.sqlite` 保存语言、置顶及独立的默认模型选择；`usage.sqlite` 保存不含正文/密钥的调用账本。原文、译文和会话仅驻内存。账本发送前写入、终态幂等、崩溃恢复为未知，不推算价格；独占控制防止两个 Host 互相覆盖。

worker 延迟启动，退出或父进程崩溃时由 Job 回收；重建不重放。应用不暴露本地 HTTP Bridge。Bun 编译 worker 和匹配 native addon 作为资源随 NSIS 分发。native addon 较大，不能宣称已完成轻量资源指标。

与规划的差距：尚无同一服务商多账户、免 Key 引擎、OAuth UI、自定义服务地址、历史清除界面、OCR、内容历史、窗口位置恢复；UIA 和多屏 DPI 仍需原生专项验收。桌面数据不导入旧助手或 W0 账户。

参考：[Tauri 配置](https://v2.tauri.app/reference/config/)、[快捷键](https://v2.tauri.app/plugin/global-shortcut/)、[剪贴板](https://v2.tauri.app/plugin/clipboard/)。
