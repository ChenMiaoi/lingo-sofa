# 应用更新

在 **设置 → 关于与更新** 查看当前版本、检查更新、下载和安装。也可在输入框输入 `/settings updates`。

自动检查默认开启：启动约 20 秒后检查，应用运行期间每 6 小时检查一次；手动检查也会推迟下一次后台检查。关闭后仍可手动检查，开关保存在本机 `updates.sqlite`。后台检查不会下载、安装或弹出窗口；有新版本时，设置入口和更新分类显示提示。

点击“下载更新”后显示进度，下载完成并通过签名校验后显示“安装并重启”。安装前请保存输入草稿；翻译、Ask 或压缩任务运行时不能安装。下载或安装失败可重新尝试，检查失败不会冒充“已是最新版本”。尚无公开版本时显示“尚未发布可用更新”。开发构建可检查，但不安装更新。

## 发布配置

客户端从本仓库 GitHub Releases 的 `latest.json` 读取版本元数据，仅选择比当前版本更新且支持当前平台的安装包，下载后由 Tauri updater 校验签名及签名中的版本。原文、输入草稿、模型凭证不参与更新请求。更新查询与安装行为见 [隐私说明](privacy.md)。

发布工作流 `.github/workflows/release.yml` 接受 `vX.Y.Z` 与 `vX.Y.Z-rcN` 标签，例如 `v0.1.1`、`v0.1.2-rc1`。标签须与根 `package.json`、Cargo workspace 和 Tauri 配置的版本一致（RC 版本也需包含 `-rcN`）；其他后缀、缺位版本及版本不匹配会在构建前拒绝。

流程先创建未公开草稿，并行检查、构建 Windows x64、macOS Apple Silicon 和 Intel，再由单独发布任务校验全部安装包与版本绑定签名，统一生成 `latest.json` 后公开 Release。任一平台失败会保留草稿；修复后可重跑失败任务，或在该标签上手动运行工作流。已公开版本不可覆盖；不要移动已发布标签。

正式版作为正式 Release 发布；RC 自动标为 GitHub Pre-release，不会替换客户端使用的 `/releases/latest/download/latest.json` 正式版入口。两类 Release 都包含自身标签对应的更新清单。

仓库需要配置以下 Actions secrets：

- `TAURI_SIGNING_PRIVATE_KEY`：与 `tauri.conf.json` 内公钥匹配的 updater 私钥内容。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码，无密码时留空。

发布不要求 Apple Developer 会员或公证凭证。本机固定开发签名仍可使用，见 [macOS 应用代码签名](macos-signing.md)。

私钥必须保存在仓库外并备份；不要提交、打印或放入打包资源。更换公钥会使已安装客户端无法验证新密钥签署的更新，必须规划迁移。签名凭证只传给发布打包步骤，不传给模型 worker 或前端构建。

普通开发构建不生成 updater 签名包；发布工作流通过 `tauri.release.conf.json` 启用签名产物。Tauri updater 签名不同于 Windows 代码签名或 Apple Developer 签名、公证；当前发布包尚无 Apple Developer ID 签名、公证或 Windows 代码签名，系统分发信任仍须另行配置和验收。

## 验收边界

自动回归覆盖自动检查开关持久化、检查间隔与并发保护、HTTP 404 和网络/格式错误区分、UI 动作与下载进度、任务运行时禁用安装、设置返回草稿保留。仍需使用真实发布包分别验证三平台从旧版本更新到新版本、签名拒绝、安装目录权限、安装失败恢复和重启。发布工作流成功与安装验收须分别记录；首次安装、跨版本替换和系统信任提示仍以实际设备验收为准。
