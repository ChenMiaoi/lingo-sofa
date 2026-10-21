# Windows 桌面验收状态

2026-10-21。当前实现为 Rust + Tauri 2 + React + 受限 OMP worker。本文集中记录验收状态；功能边界见 [当前架构](architecture.md)，后续门槛见 [阶段验收计划](windows-acceptance-plan.md)。W0 总体仍未关闭，已实现部分功能不代表 W0–W4 全部通过。

## 当前交付

| 范围                               | 状态与证据                                                                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord 选区、滚动收起、Ask 上下文 | 通过本机专项；只读取消息正文，没有发送消息，见 [详细验收](desktop-discord-acceptance.md)                                                                                |
| 记事本、开启可访问性的独立 VS Code | 已验证真实选区翻译、滚动收起和 Ask；见 [原生交互基线](validation/cross-app/native-interactions.json)                                                                    |
| 浏览器系统选区                     | **未通过，等待人工验收**；见 [手动步骤与离线样文](browser-manual-acceptance.md)                                                                                         |
| 输入翻译复用 Ask                   | 已实现多行输入、翻译与独立新问题；真实翻译 1 次、165 tokens，见 [用量证据](validation/input-panel/usage-summary.json)。真实中文输入法候选确认和新问题的真实调用仍待补齐 |
| 最新完整检查                       | lint、格式、类型、22 项 TS、50 项运行时 Rust、5 项桌面 Rust、Clippy 和构建通过；见 [源码回归](validation/shortcuts/source.json)                                         |
| 独立打包 worker                    | 最新 50 项回归通过；见 [打包回归](validation/discord/packaged.json)                                                                                                     |
| 安装包                             | 未签名的 Windows x64 调试 NSIS 开发包，未安装或发布；最新快捷键版本的路径与摘要见 [产物清单](validation/shortcuts/inputs-and-artifacts.json)                            |

以上只覆盖记录中的 Windows 开发环境，不代表干净机、多显示器或所有应用兼容性通过。

当前灰黑半透明界面与原生 Acrylic、长文本输入的检查见 [界面记录](validation/input-panel/acceptance.json)。真实中文 IME 验收曾被实体 Esc 中断，自动处理键回归通过不等于该真实场景通过；浏览器状态维持未通过。

全局输入面板默认使用 Alt+Shift+Space，选区和剪贴板默认分别使用 Alt+Shift+S、Alt+Shift+T。三项均可在设置中改键；冲突或保存失败保留原设置，启动时逐项报告注册状态。快捷键回归与原生验收见 [检查记录](validation/shortcuts/acceptance.json) 和 [原生观察](validation/shortcuts/native-ui.json)。

## 提交前检查

整次迁移已完成提交前核验：完整检查、源码与独立打包 SDK 探针、打包 worker 回归、锁文件复装、凭证扫描及文档引用检查均通过。依赖补丁改为零上下文的统一差异格式，修复 Git 空白检查；重新应用后 SDK 文件逐字节相同。具体命令与范围见 [检查记录](validation/precommit.json)。本次没有新增付费请求或重复交互验收，浏览器与真实中文输入法候选确认仍保持待验。

## 模型与系统链路基线

以下保留不同阶段的原始证据及其适用范围，不能将旧版本的测试数量、哈希和安装包当作最新交付结果。旧原型源码及重复的阶段叙述已移除，原始报告仍保留在 [早期证据目录](validation/evidence)。

| 范围                                                  | 结果与证据                                                                                                                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust → OMP IPC、Windows Job、DPAPI/SQLite、账本和队列 | 已迁入正式工程，故障与恢复回归见上述源码及打包报告                                                                                                                                                             |
| SDK 源码与打包探针                                    | 迁移基线各 12 项通过；使用本机模拟供应商和合成 OAuth，**不等于真实 OAuth 授权通过**，见 [源码](validation/desktop/sdk-source.json) 与 [打包](validation/desktop/sdk-packaged.json)                             |
| 真实 DeepSeek V4.1 Flash                              | 正式链路验证 DPAPI 加载、流式、运行中取消、排队取消、压缩、逐调用用量和账本重开；见 [真实调用报告](validation/desktop/deepseek-live.json)                                                                      |
| 全局双并发与压缩                                      | 上述真实场景共 7 次调用，其中 3 次压缩，峰值并发 2；排队取消没有 requestId，运行中取消保留 1 次未知用量，其余 6 次合计 32,437 tokens；未知部分不按零计                                                         |
| 初始验证失败                                          | [短上下文](validation/desktop/initial-short-context.json) 未达到正式压缩阈值；[固定调用数断言](validation/desktop/initial-merge-assertion.json) 遗漏短摘要调用。后续长会话与分段压缩回归已覆盖，未降低正式阈值 |
| 跨应用真实模型调用                                    | 记事本 / VS Code 基线 7 次、1,150 tokens；Discord 专项 3 次、493 tokens，均 reported，见 [跨应用用量](validation/cross-app/usage-summary.json) 与 [Discord 用量](validation/discord/usage-summary.json)        |

常规回归使用模拟服务，不读取真实密钥；只有明确的真实验证入口会读取被忽略的 `.env`，使用隔离 DPAPI profile，不配置日常桌面账户。金额尚未估算。

## 未通过与未完成

浏览器按手动清单逐项回填，不能用 DOM 检查或 Discord 结果替代。Discord 后续测试继续遵守只读边界，严禁发送任何消息。

真实 OAuth、第二供应商、免 Key 引擎、多账户、多显示器/混合 DPI、截图 OCR、历史清除、干净机安装/卸载、WebView2 缺失路径、常驻资源预算、完整依赖许可证审计及签名发布仍需专项验证或实现。OCR 候选与评测设计见 [OCR 方案](windows-ocr.md)，未运行的评测不记为通过。
