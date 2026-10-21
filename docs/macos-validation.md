# macOS 本机验证

验证环境：macOS 27.0.1、Apple Silicon arm64、Bun 1.3.14、Node.js 24.1.0、Rust 1.98.1。

## 开发与构建

安装 Xcode Command Line Tools、Bun 1.3.14、Node.js 24 和 cargo-nextest 0.9.149。仓库通过 `rust-toolchain.toml` 固定 Rust 与检查组件。Intel Mac 使用本机 x64 工具链；Apple Silicon 使用 arm64，不依赖 Rosetta。

```sh
bun install --frozen-lockfile
npm run check
npm run test:sdk
npm run test:sdk -- --packaged
npm run test:runtime:packaged
# 复用上面检查生成的产物，只进行打包
npm run bundle -- --debug
npm run dev
npm run build -- --debug
```

应用和磁盘映像分别输出至 `target/debug/bundle/macos/LingoSofa.app` 和 `target/debug/bundle/dmg/`；省略 `--debug` 则输出到 `target/release/bundle/`。当前包未签名、公证，不作为正式发布包。

macOS 使用与当前架构匹配的 Bun worker 和 OMP 原生模块。数据位于 `~/Library/Application Support/LingoSofa`。凭证使用 AES-256-GCM 加密，随机主密钥保存在当前用户的 macOS 钥匙串，账户标识作为认证附加数据。不要删除钥匙串主密钥后继续使用旧凭证数据库；丢失主密钥后需要重新配置账户。Windows 继续使用 DPAPI，凭证数据库不能直接跨系统迁移。

运行时测试使用临时钥匙串和独立测试构建，不修改默认钥匙串，不读取个人凭证。离线测试条目仅包含随机生成的夹具密钥；真实模型测试条目只信任本次构建的验证程序。测试结束删除临时钥匙串。生产应用不会启用 `test-keychain` feature。

## 选区与界面

macOS 选区通过独立 Accessibility 辅助进程读取 `AXSelectedText`、`AXSelectedTextRange` 和 `AXBoundsForRange`，监视来源焦点、文本、选区范围及位置变化。未授予辅助功能权限时返回明确提示，不模拟复制，也不修改系统权限。需要在“系统设置 → 隐私与安全性 → 辅助功能”中允许应用；源码运行可能需要允许辅助进程或启动它的终端。来源应用必须提供这些属性；不支持时可用输入或剪贴板翻译。

已验证原生应用启动、悬浮入口、菜单、输入面板、Enter 提交、Esc 返回和未配置账户提示。Retina 选区坐标转换有回归测试。跨应用选区、真实键盘全局快捷键、多显示器布局仍需人工验收；自动化事件未能验证全局快捷键触发，注册逻辑与持久化由测试覆盖。

## 结果与限制

源码与独立编译 worker 的运行时检查覆盖真实 IPC、应用服务、凭证篡改和账户绑定、宿主崩溃、后代进程回收、并发上限、取消、会话压缩和用量恢复。运行时报告检查关键宿主测试确实执行，避免平台条件导致零测试通过。报告输出到 `.cache/runtime-tests/` 和 `.cache/sdk-tests/`。

2026-10-21 更新本机 `.env` 的 `API_KEY` 后，原先的 HTTP 401 认证失败已消除。真实 DeepSeek V4.1 Flash 验证全部通过：SDK 翻译和追问、压缩前后上下文保留、Rust 宿主与独立 worker 的排队执行、流式取消、双路并发饱和、凭证加密重启读取和用量账本恢复。双路场景的 worker 与账本并发峰值均为 2；排队取消没有发起模型调用，运行中取消没有自动重发。取消请求的供应商计费情况仍未知。

验证同时修正了 worker 将 macOS 凭证来源误标为 DPAPI 的报告字段，统一返回平台无关的 `rust-vault`，并通过实网断言检查。完整 `npm run check` 已重新通过。报告经过密钥扫描后保存：[SDK 实网](validation/macos/sdk-live.json)、[排队实网](validation/macos/queued-live.json)、[双路实网](validation/macos/dual-live.json)。复现命令：

```sh
npm run verify:live
npm run verify:live:dual
```

CI 使用 Windows x64、macOS 26 Apple Silicon（`macos-26`）和 macOS 26 Intel（`macos-26-intel`）三组本机 runner，执行完整检查、SDK 源码与独立编译检查、独立 worker 运行时测试及原生应用打包，并保留测试报告。本机 arm64 已运行验证，另通过 `cargo check --locked --target x86_64-apple-darwin --workspace --all-targets` 检查 Intel 目标；Windows 与 Intel 的实际运行结果以远端 CI 为准。CI 不加载 `.env`，不进行付费模型调用，也不替代跨应用人工验收。

CI 的逐项计时、有限并行、构建复用和缓存观察见 [CI 耗时与优化验证](ci-performance.md)。
