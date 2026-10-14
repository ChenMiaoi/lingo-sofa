# 发布准备与环境依赖

日期：2026-10-14。当前阶段是本地候选产物审查；不自动上传、签名、安装或公开发布。

## 可复现的本机流程

1. `npm ci`，然后 `npm run check`、`npm run test:e2e`、`npm run verify:vencord`。
2. 审查变更并提交，保持工作区干净。
3. `npm run prepare:release` 构建三端并打包本机 Native Host，生成 `.cache/releases/lingo-sofa-0.1.0-<platform>-<arch>-<revision>/`。固定 Vencord checkout 的 LICENSE 必须已由宿主验证取得；Node 安装根目录必须提供其完整 LICENSE。
4. 检查 `release-review.json` 的版本、源码 revision、运行时、依赖许可清单和未决问题；执行 `npm run verify:release -- <候选目录>` 核对所有 SHA-256、许可文件、版本和额外文件。该清单明确标为 `publicReleaseReady: false`。
5. 浏览器单独 ZIP 可通过 `npm run zip --workspace @lingo-sofa/browser-extension` 生成；它是开发验收产物，不能跳过下述发行条件。

候选目录包括实际 MV3、Native Host、供本地 Vencord 构建的插件、文档、原项目许可证、已取得的完整依赖许可/NOTICE、当前 Node 运行时的完整许可，以及准确对应 Git revision 的 `source.tar`。不包含 Discord/Vencord 二进制、API Key、配对令牌、测试 profile 或自动安装器。Native Host 是 stdio 转发程序，需要从源码配置并运行独立的 Node 24 Bridge；此目录不是自包含的 Bridge 安装包。

许可清单保守收集锁文件中所有已安装的非开发依赖，覆盖运行依赖的超集；它不能证明每个包都出现在浏览器 bundle。Pi 1.2.0 未随 npm 包提供的根 LICENSE 从固定上游版本保留；data-uri-to-buffer 4.0.1 的 README 中完整许可段也按固定来源提取。两者均校验来源记录中的 SHA-256。收集缺少根许可文本的包时不会假定其声明等同于完整许可，会在报告中留下问题。嵌入供应商代码与 NOTICE 仍需审查。

## 本机可完成与已取得的证据

| 项目                       | 本机方法 / 状态                                                               |
| -------------------------- | ----------------------------------------------------------------------------- |
| 构建、协议、模型故障与恢复 | `check`、MV3 E2E、Bridge 集成测试，含过期令牌和版本拒绝                       |
| DeepSeek 真调用与峰/谷计价 | 已通过；脚本 `verify:real` 显式使用 `.env` 并产生真实费用，不在默认检查中执行 |
| 原 Discord 与两端同 Bridge | 已通过选中内容、默认统计/预算隔离、取消、100 次频道切换；见客户端记录         |
| 新 UI                      | 实际 MV3 浅/深色、窄/宽布局与键盘 E2E，截图人工检查；见 UI 设计记录           |
| 本机 Native                | macOS arm64 SEA 与真实 stdio relay；Apple ad-hoc 签名仅用于本机，不能称已公证 |
| 发布包与许可整理           | 生成版本/revision、源码、许可和 SHA-256 的本地审查包；公开发布仍有条件        |

## 必须依赖额外环境或决定的项目

| 项目                                     | 需要什么                                                          | 通过条件                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Windows native / Chrome / Edge / Discord | Windows 真机或独立 CI runner                                      | 打包及 stdio、HKCU 注册/卸载，客户端加载、恢复和隐私记录；CI 配置存在但未运行结果不能计入证据 |
| Edge macOS                               | 安装并使用 Edge                                                   | 实际扩展安装、权限授予/撤销、自动站点、Native Host 连接；本机当前未安装                       |
| 常用 Chrome 用户 profile                 | 用户自己的浏览器 profile 或专门的人工验收 profile                 | 通过真实安装入口核对权限、后台恢复和 Native Host；Chrome for Testing 不替代日常 profile       |
| 多账号与真实长频道                       | 用户授权的额外账号、测试消息与长频道                              | 切换后无上下文/预算混用，虚拟列表卸载/重挂载无旧译文或重复请求；不能读取其他账号 token        |
| 屏幕阅读器                               | 可观察的 VoiceOver/NVDA 验收                                      | 记录焦点顺序、标签、展开状态、运行/失败通知与朗读结果；键盘 E2E 不能代替                      |
| 真实网站兼容矩阵                         | 普通文章、SPA、动态长页面的授权测试目标                           | 布局/链接/输入交互不被破坏，选区不扩大，不支持区域明确降级                                    |
| 第三方许可与组合分发                     | 核对实际依赖闭包、嵌入 notices；明确商业插件与 GPL 宿主的分发安排 | 解决报告问题并交付相应许可、版权及必要源码；商业 LICENSE 不能重新许可宿主                     |
| 正式 macOS 分发与商店                    | 发行身份、签名/公证与商店审核环境                                 | 独立签名验证、安装/更新/卸载、隐私声明与审核通过                                              |

以上每项应记录系统/客户端版本、步骤、实际结果和失败处理，再更新 [总验收记录](acceptance.md)。环境不可用时保持待验收，不以模拟、跨编译或已配置 CI 替代。

## 本次产物核验

本机候选包已实际构建和完整性验证：版本 0.1.0，darwin/arm64，Node 24.1.0；122 个依赖条目。首次候选 147 项 SHA-256 全部通过，发现 6 个缺文本项；补齐 README 中的完整 MIT 文本后剩余 5 项，具体原因见 [依赖许可审查](dependency-license-review.md)。报告继续为 `publicReleaseReady: false`，没有上传、商店提交或公证。每个候选目录名含其准确 Git revision，后续修改后必须生成新候选，不能将旧包称为对应新提交。
