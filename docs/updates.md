# 应用更新

在 **设置 → 关于与更新** 查看当前版本、检查更新、下载和安装。也可在输入框输入 `/settings updates`。

自动检查默认开启：启动约 20 秒后检查，应用运行期间每 6 小时检查一次；手动检查也会推迟下一次后台检查。关闭后仍可手动检查，开关保存在本机 `updates.sqlite`。后台检查不会下载、安装或弹出窗口；有新版本时，设置入口和更新分类显示提示。

点击“下载更新”后显示进度，下载完成并通过签名校验后显示“安装并重启”。安装前请保存输入草稿；翻译、Ask 或压缩任务运行时不能安装。下载或安装失败可重新尝试，检查失败不会冒充“已是最新版本”。尚无公开版本时显示“尚未发布可用更新”。开发构建可检查，但不安装更新。

## 发布配置

客户端从本仓库 GitHub Releases 的 `latest.json` 读取版本元数据，仅选择比当前版本更新且支持当前平台的安装包，下载后由 Tauri updater 校验签名及签名中的版本。原文、输入草稿、模型凭证不参与更新请求。更新查询与安装行为见 [隐私说明](privacy.md)。

发布工作流 `.github/workflows/release.yml` 在推送 `v*` 标签后，为 Windows x64、macOS Apple Silicon 和 Intel 构建草稿 Release。各平台顺序上传以合并同一个 `latest.json`。版本标签必须与根 `package.json`、Cargo workspace 和 Tauri 配置一致。正式发布前应检查三平台安装包、签名文件和 manifest 均已上传，再人工发布草稿；未发布的草稿不会被客户端发现。

仓库需要配置以下 Actions secrets：

- `TAURI_SIGNING_PRIVATE_KEY`：与 `tauri.conf.json` 内公钥匹配的 updater 私钥内容。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码，无密码时留空。

私钥必须保存在仓库外并备份；不要提交、打印或放入打包资源。更换公钥会使已安装客户端无法验证新密钥签署的更新，必须规划迁移。签名凭证只传给发布打包步骤，不传给模型 worker 或前端构建。

普通开发构建不生成 updater 签名包；发布工作流通过 `tauri.release.conf.json` 启用签名产物。Tauri updater 签名不同于 Windows 代码签名或 Apple Developer 签名、公证；系统分发签名仍需单独配置，不能将 updater 签名视为已完成系统信任验收。

## 验收边界

自动回归覆盖自动检查开关持久化、检查间隔与并发保护、HTTP 404 和网络/格式错误区分、UI 动作与下载进度、任务运行时禁用安装、设置返回草稿保留。仍需使用真实发布包分别验证三平台从旧版本更新到新版本、签名拒绝、安装目录权限、安装失败恢复和重启。仓库尚无公开版本或 Actions signing secrets 时，仅本地配置就绪不代表更新分发已经启用。
