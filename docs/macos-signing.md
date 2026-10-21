# macOS 应用代码签名

应用代码签名决定 macOS 如何识别更新前后的程序，和 Tauri 更新包签名是两套机制。固定证书与 `com.lingosofa.desktop` 标识可保持应用的 designated requirement 稳定；它不取消首次钥匙串授权，也不能绕过屏幕录制、辅助功能等系统权限。

## 本地开发

没有 Apple Developer 会员时，可创建本机专用的自签名代码签名证书。需要 Xcode Command Line Tools 和 OpenSSL 3 或更新版本（例如 Homebrew 提供的 `openssl`）。执行一次：

```sh
npm run signing:setup
npm run signing:verify
npm run dev
```

`signing:setup` 重复执行会复用现有证书，不轮换身份。证书及私钥保存在 `~/Library/Application Support/LingoSofa/CodeSigning/development.keychain-db`，随机钥匙串密码及证书指纹保存在同目录；目录权限为 `0700`，密码和配置文件为 `0600`。临时 PEM 与 P12 在导入后删除。请妥善备份整个目录，不要提交到仓库或打包进应用。

开发入口会签署 worker、原生模块和辅助程序，并通过 Cargo runner 在每次主程序重编译后、执行前签名，固定主程序标识为 `com.lingosofa.desktop`。Intel 和 Apple Silicon 使用相同机制。签名凭证不传给模型 worker。直接执行 `cargo run`、`cargo build` 或 `tauri dev` 不经过该入口，不能保证使用固定签名。

`signing:verify` 在 `.cache/` 中编译并执行两个不同版本的无凭证测试程序，经过实际 Cargo runner 签名，检查两者的证书身份要求一致，并验证签名 runner 使用进程替换，退出后不会遗留阻挡热更新的旧应用。它不读取个人模型凭证或修改登录钥匙串。

从旧的临时签名切换过来，首次读取现有凭证仍可能要求一次钥匙串授权；选择“始终允许”后，后续相同证书与标识的开发构建可沿用授权。拒绝后本次进程不会反复请求，重启后可再次尝试。当前运行的开发进程需要退出并重新执行 `npm run dev`，已有 watcher 不会自动采用新的 Cargo runner。

专用钥匙串只允许系统签名工具访问签名私钥，不修改模型凭证的访问控制，不加入系统信任根，也不关闭 Gatekeeper。自签名证书仅用于本机开发，不能用于公开分发或 Apple 公证。删除、遗失或更换证书会改变应用身份；将来改用 Developer ID 也可能需要重新授权一次。

## 以应用身份验收系统权限

```sh
npm run app:local -- --launch
```

此入口构建完整的本地调试 `.app`，依次签署包内 worker、原生模块、取词与 OCR 辅助程序，最后签署外层应用并验证嵌套签名，通过 Launch Services 打开 `target/debug/bundle/macos/LingoSofa.app`。不要求 Apple Developer 会员。启动前请退出已有的开发进程，避免单实例机制继续使用旧版本。

辅助功能权限应授予 LingoSofa；无需授权 VS Code 等来源应用，也不修改其配置。终端启动的 `npm run dev` 仍可能归属终端，它主要用于热更新开发；验收面向用户的权限流程必须使用完整应用。相同路径、证书与标识用于保持后续构建的应用身份；首次从旧进程身份切换到该应用时仍可能需要系统授权。OCR 的屏幕录制权限独立于划词的辅助功能权限。

## 无会员发布

当前发布流程不要求 Apple Developer 会员、Developer ID 证书或 Apple 公证凭证，继续通过 `vX.Y.Z` 和 `vX.Y.Z-rcN` 标签发布。更新包仍使用独立的 Tauri updater 签名校验完整性，不取消更新签名验证。

本机固定开发证书不会上传到 GitHub 或随安装包分发。公开 macOS 包尚无 Apple Developer ID 签名与公证，系统首次打开时可能显示开发者验证提示；不能将本机签名验证视为公开发布包的系统信任验收。也不能保证公开包跨版本升级时沿用本机开发版的钥匙串授权。

将来需要正式分发签名时，再独立配置 Developer ID 与公证。参考 [Tauri macOS 签名指南](https://v2.tauri.app/distribute/sign/macos/)、[Apple designated requirement 说明](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements) 与 [Bun 签名指南](https://bun.sh/guides/runtime/codesign-macos-executable)。
