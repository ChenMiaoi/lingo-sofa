# 开发与检查

## 工具与入口

使用 Bun 1.3.14、Node.js 24、cargo-nextest 0.9.149。Rust 版本与检查组件由 `rust-toolchain.toml` 固定。Nextest 可从[官方预编译包](https://nexte.st/docs/installation/pre-built-binaries/)安装，也可运行：

```sh
cargo install cargo-nextest --version 0.9.149 --locked
bun install --frozen-lockfile
npm run dev
```

Windows x64 需要 Visual Studio C++ Build Tools 和 WebView2，使用 MSVC 工具链。开发入口会准备 worker、选区助手与 OCR 资源，再启动前端与桌面应用。Windows 构建阶段下载固定官方 PP-OCRv5 mobile 模型和 ONNX Runtime 1.31.0 CPU，按编译内置清单校验 SHA-256；缓存位于 `.cache/ocr-assets`。安装版识别不联网、不依赖 Python 或系统 OCR 语言包。模型、字典、DLL 与许可证均为打包必需项。见 [Windows OCR](windows-ocr.md)。

拉取更新后先执行 `bun install --frozen-lockfile` 同步工作区依赖。开发入口会检查桌面依赖，缺失时提示安装命令；只有本次启动的前端服务监听成功后才会打开桌面应用。端口 1420 被占用、前端启动失败或超时会中止启动。Windows 开发会话由系统作业对象约束，按 Ctrl+C 或终端强制结束后仍会回收本次启动的前端、桌面及其子进程。

| 命令                             | 用途                                                                 |
| -------------------------------- | -------------------------------------------------------------------- |
| `npm run check`                  | lint、格式、类型、TS 与 Rust 回归、Clippy、worker/前端/桌面构建      |
| `npm run test:sdk`               | 源码 SDK 探针                                                        |
| `npm run test:sdk -- --packaged` | 独立编译 SDK 探针                                                    |
| `npm run test:runtime:packaged`  | 独立 worker 的完整 Rust 运行时检查                                   |
| `npm run build -- --debug`       | 准备全部资源并生成调试安装包                                         |
| `npm run bundle -- --debug`      | 使用已构建的调试产物，只进行打包                                     |
| `bun scripts/render-ui.ts`       | 在 `.cache/ui-preview/component-preview.html` 生成当前组件的静态预览 |

静态预览使用固定样文，不能代替原生窗口或真实模型验收。

## macOS

安装 Xcode Command Line Tools。Intel Mac 使用本机 x64 工具链；Apple Silicon 使用 arm64，不依赖 Rosetta。执行检查与构建的命令与上表相同。

调试应用输出至 `target/debug/bundle/macos/LingoSofa.app`，磁盘映像位于 `target/debug/bundle/dmg/`。省略 `--debug` 则使用 `target/release/bundle/`。本地固定开发签名与无会员发布限制见 [macOS 应用代码签名](macos-signing.md)。未配置 Apple 凭证的普通本地包不具备正式分发签名、公证。

macOS 使用与当前架构匹配的 Bun worker 和 OMP 原生模块。数据位于 `~/Library/Application Support/LingoSofa`。凭证使用 AES-256-GCM 加密，随机主密钥保存在当前用户的 macOS 钥匙串，账户标识作为认证附加数据。删除钥匙串主密钥后需要重新配置账户；Windows 的 DPAPI 凭证数据库不能直接跨系统迁移。

运行时测试使用临时钥匙串和独立测试构建，不修改默认钥匙串，不读取个人凭证；测试结束删除临时钥匙串。生产应用不会启用 `test-keychain` feature。主密钥只在当前进程内缓存；首次并发访问只读取一次。拒绝或取消钥匙串后，本次启动缓存失败，不反复弹出授权，重新打开后可再次尝试。开发时先执行 `npm run signing:setup`，再通过 `npm run dev` 启动，可在重编译后保持固定签名身份；直接 Cargo 构建不经过该入口。当前发布不要求会员；需要 Apple 官方分发签名与公证时再配置 Developer ID。不通过放宽模型凭证访问控制消除提示。

选区由独立 Accessibility 辅助进程通过 `AXSelectedText`、`AXSelectedTextRange` 和 `AXBoundsForRange` 读取，标准范围不可用时尝试 Chromium 的 Text Marker 选区接口，并在当前焦点节点的有限父链中查找选区。密码输入框不会沿父链取文。读取前，助手按 Electron/Chromium 的无障碍接口请求准备 AX 树，并在来源窗口不变的前提下有界重试，等待默认自动模式下的编辑器提供选区；不会启动 VoiceOver、模拟复制或修改系统授权。需要在“系统设置 → 隐私与安全性 → 设备控制和数据访问”（旧版称“辅助功能”）允许系统提示的应用；从 Warp 等终端启动开发版时，macOS 可能将授权归属该终端，即使主程序与助手已经固定签名。首次取文缺少权限会请求系统显示授权引导；启动应用本身不请求该权限。授权后重新启动开发进程。来源应用必须提供相应属性；未授权或不支持时显示提示，可改用输入或剪贴板翻译，不模拟复制或修改系统权限。不修改来源应用设置，也不要求用户将 VS Code 的 `editor.accessibilitySupport` 强制设为 `on`；按其默认 `auto` 模式验收。显式关闭无障碍支持或未实现选区接口的应用仍可能无法取文。权限归属验收请使用 `npm run app:local -- --launch` 构建并经 Launch Services 启动的完整 LingoSofa 应用，不能以终端下的裸开发进程替代。待验范围见 [兼容与验收状态](acceptance.md)。

## 运行时测试与计时

源码和独立 worker 各执行完整的运行时测试集合，使用固定版本 Nextest，最多并行 2 项，每项运行于独立进程，不增加失败重试。脚本另外执行 Cargo 文档测试，以保留 rustdoc 覆盖。设置 `LINGOSOFA_TEST_THREADS=1` 可取得串行基线；只接受 `1` 或 `2`。测试 worker 的冷启动预算为 30 秒，和请求、模型任务及总执行期限分别计时；桌面应用保持 15 秒启动预算。测试编译完成后开始计算 360 秒执行期限。

`.cache/runtime-tests/source.json`、`packaged.json` 记录每项测试的套件、名称、状态和耗时，以及 worker 准备、编译、执行和文档测试的分阶段耗时。脚本输出最慢 10 项测试，并保存 JUnit XML 和 Cargo 编译时间图。报告缺失、数量不符、重复结果、失败、非零退出或关键宿主崩溃测试未执行时不能判为通过。SDK 报告位于 `.cache/sdk-tests/`。

比较性能时使用相同机器、相同测试集合和相同缓存条件，顺序运行对照组，记录重复测量及并发设置。测试执行时间不能直接代表整条 CI 的时间。

## 构建与打包复用

`npm run build` 准备 worker、选区助手和前端，再构建并打包桌面应用。Windows 安装包输出在 `target/debug/bundle/nsis/` 或 `target/release/bundle/nsis/`。

完成 `npm run check` 后，可用 `npm run bundle -- --debug` 复用桌面二进制、前端、worker、选区助手和原生 addon。该命令只调用独立打包入口，不重新构建；输入缺失时失败。修改源码后应重新构建或执行完整检查。省略 `--debug` 会要求已有 release 产物。

worker 和独立 SDK 探针共用 Bun 构建 API，支持 Windows 原生路径以及路径中的空格和中文。开发与打包入口直接用 Node.js 调用已安装的 Vite/Tauri CLI。编译后的程序不会自动加载工作目录的 `.env`、`bunfig.toml`、`tsconfig.json` 或 `package.json`，运行配置由宿主显式提供；`npm test` 包含独立程序的路径、CLI 启动与配置隔离回归。

## CI

CI 在 Windows x64、macOS 26 Apple Silicon 和 macOS 26 Intel 执行完整检查、两种 SDK 探针、独立 worker 运行时测试和原生打包。检查分成单独步骤，便于观察各阶段耗时；最后复用已有调试产物打包。

Rust 缓存按 runner 标签区分，采用 action 默认的依赖缓存策略，不缓存工作区 crate。CI 摘要记录是否精确命中；false 仍可能恢复前缀匹配的部分缓存，应结合恢复日志和编译时间图判断。Nextest 单独安装固定版本的预编译工具。

CI 上传 SDK/运行时 JSON、JUnit XML 和 Cargo 编译时间图供排查。运行报告、性能数据、产物哈希和生成的预览保留在 `.cache/` 或 CI artifacts，不提交到 `docs/`；提交或 PR 中说明检查结果与限制。

## 真实模型验证

常规检查使用模拟服务，不读取 `.env`。以下命令显式读取被忽略的本机 `.env` 中的 `API_KEY`，会产生真实供应商用量，使用隔离配置，不设置日常桌面账户：

```sh
npm run verify:live
npm run verify:live:dual
```

CI 不加载 `.env`，不执行付费模型调用。报告与截图不得包含密钥或私人内容；自动检查不替代跨应用、真实输入法、多显示器和安装的人工验收。

## 应用更新发布

更新入口、自动检查间隔、签名配置与草稿发布步骤见[应用更新](updates.md)。本地开发构建不安装更新，普通 CI 打包无需 updater 私钥；仅发布打包步骤使用仓库外的签名凭证。
