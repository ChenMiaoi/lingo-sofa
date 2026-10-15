# 一体化安装与分发

## 三类交付物

- 浏览器：Chrome/Edge MV3 ZIP，商店发行后由商店安装。目前开发者解压加载。
- Discord：`lingoSofa` Vencord userplugin 目录的压缩包，包含 renderer 与 native 两部分。它需要集成到自定义 Vencord 构建，不能当作 Discord 官方插件或直接导入普通 Vencord。
- 共享本地助手：按系统/架构生成 `lingo-sofa-assistant-<version>-<platform>-<arch>.tar.gz`，含 Node 24、Bridge、运行依赖、Native Host、安装程序与逐文件 SHA-256。不要求用户安装 Node，也不依赖源码目录。

本地助手在同一电脑、同一系统用户下共用。账户与默认模型共享，内容会话按客户端/来源隔离。浏览器 Native Host 与 Discord native 只是不同连接入口；单实例与最后客户端离线退出规则见 [服务生命周期](service-lifecycle.md)。不同电脑不共用本地进程。

## 用户安装

Discord 启用 LingoSofa 时先检查已安装助手；不存在时，从插件构建中固定的版本地址下载适配系统的安装包，验证固定 SHA-256，拒绝路径穿越、链接与特殊文件，再调用包内 Node 安装，完成后自动启动服务。下载/安装状态及失败重试在插件设置中显示。已安装时直接复用，不在网络故障或配置损坏时覆盖安装，也不自动重放模型请求。插件停用时不再启动助手；已开始的下载/文件安装可能完成，但不会因此启动服务。

浏览器扩展受沙箱限制，首次需用户运行本地安装程序：

1. 在设置页“共享本地助手”打开发布页，下载适合系统和芯片的助手包。
2. 复制设置页显示的扩展 ID。
3. 关闭浏览器和 Discord，等待后台退出（最后断线后约 60 秒，异常断线还需租约过期时间）。解压，macOS 双击 `Install.command`，Windows 双击 `Install.cmd`；Linux 可在终端运行 `sh Install.command`。粘贴扩展 ID。安装脚本会使用包内 Node，不需执行 npm。
4. 重新打开浏览器，点击“检测连接”。

先从 Discord 安装的用户仍需运行一次安装程序授权浏览器扩展。再次安装会合并扩展白名单、保留账户/配置/用量，不覆盖其他来源的 Native Host 注册。新浏览器配置档或不同商店的扩展 ID 需要分别授权。命令行可一次传入多个 ID：`runtime/node install.mjs ID1 ID2`（Windows 用 `runtime/node.exe`）。仅 Discord 使用可不传 ID。

安装使用用户目录 `~/.config/lingo-sofa`（或 `LINGO_SOFA_HOME`），无需系统级常驻服务。升级前需关闭连接客户端，安装器拒绝替换正在运行的助手。失败可重试；异常进程中断遗留 `.installer-lock` 时，确认无安装器运行后移除此锁目录。不会删除账户和历史，也不会自动杀死未知进程。

## Vencord 是否能省掉

当前 UI 依赖 Vencord 的消息组件、菜单、React 与 native IPC。Discord 官方 Apps/Bots/Activities 不能直接代替这些消息界面注入点。若省掉 Vencord，需要重新实现并维护另一套客户端修改层，或将产品改成官方机器人/活动的交互方式。

可以自动准备包含 LingoSofa 的 Vencord 构建，再交给官方安装器安装：

```sh
npm run setup:discord
# 关闭 Discord 后，显式选择安装自定义 Vencord：
npm run setup:discord -- --install
```

该开发安装入口复用固定 Vencord revision 的构建/类型检查流程，再调用上游 `pnpm inject`；上游安装器会下载其官方安装程序，并让用户选择目标客户端。没有执行 `--install` 时不改已安装 Discord。安装结果应以上游界面为准，再重启并启用 LingoSofa；只启动安装器不代表安装成功。开发流程仍需要 Node、npm 和网络；面向普通用户的签名 Vencord 组合安装器尚未交付，不能把 userplugin 压缩包宣称为这样的安装器。

参考：[Vencord 自定义插件](https://docs.vencord.dev/installing/custom-plugins/)、[Vencord 安装](https://docs.vencord.dev/installing/)、[浏览器 Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)。

## 构建分发候选

正式的 GitHub 自动发布入口是版本 tag，见 [Release CI](release-ci.md)。下面的命令只在本地生成候选，不公开发布。

```sh
npm run package:distribution
```

生成 `.cache/distribution/<version>/<platform>-<arch>/`：助手包与校验清单、固定该清单的 Vencord 插件包、浏览器 ZIP、安装说明、发行待验收记录。此命令构建本机平台，不伪装成跨平台编译。可额外传其他 runner 的清单以合并平台：

```sh
npm run package:distribution -- /absolute/output /absolute/windows-manifest.json
```

打包流程会实际验证安装后的 Bridge：在临时助手目录安装，删除解压目录，再用包内 Node 启动，检查浏览器/Discord 两种来源的认证连接及租约；不发送模型请求。可通过 `npm run verify:assistant -- /absolute/assistant.tar.gz` 单独验证。CI 在三个系统 runner 上配置同样检查；只有实际运行结果才能计为该平台验收。

也可单独构建：

```sh
npm run build --workspace @lingo-sofa/pi-bridge
npm run package:native --workspace @lingo-sofa/pi-bridge
npm run package:assistant --workspace @lingo-sofa/pi-bridge
LINGO_SOFA_RELEASE_MANIFEST=/absolute/assistant-release.json npm run build --workspace @lingo-sofa/discord-vencord
```

发布顺序：先在 `v<version>` GitHub Release 上传各平台清单对应的助手归档，再分发固定这些 SHA-256 的插件/自定义宿主。同版本归档不得替换成不同字节；更新需新版本及新插件。普通源码构建未指定清单时禁用自动下载，显示该平台尚无固定安装包，允许用户自行安装助手后重试。不能仅填写下载 URL 而跳过 SHA-256。

构建需使用官方自带完整运行环境的 Node 24 发行版；依赖外置 libnode/OpenSSL 的构建会被拒绝。

本安装器是自带运行环境的归档与双击入口，尚不是已签名/公证的 `.pkg`/`.exe` 图形安装包。macOS 系统可能阻止未签名文件运行；不提供绕过系统保护的自动操作。Windows/macOS/Linux 需要各自真机验收。Node 完整许可随包提供，第三方依赖许可交付与 Vencord 组合分发条件仍须解决，见 [发布准备](release-readiness.md) 和 [许可审查](dependency-license-review.md)。本命令不上传、签名、公证、提交商店或修改已安装 Discord。

## 卸载

1. 关闭浏览器和 Discord，等待本地助手完成任务并退出，规则见 [后台生命周期](service-lifecycle.md)。
2. 移除不再使用的浏览器扩展或禁用 LingoSofa Vencord 插件。移除单个入口不会自动删除其他客户端仍需使用的共享助手。
3. 若所有客户端都不再需要助手，移除自己安装的 `com.lingosofa.bridge.json` Native Messaging 注册。macOS 位于用户的 `~/Library/Application Support/<浏览器>/NativeMessagingHosts/`，Linux 位于用户的 `~/.config/<浏览器>/NativeMessagingHosts/`；浏览器目录分别对应 Chrome、Chrome for Testing、Chromium 或 Edge。Windows 还需移除 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.lingosofa.bridge` 与 `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.lingosofa.bridge` 中由本项目创建的注册项。
4. 删除 `~/.config/lingo-sofa`，或 `LINGO_SOFA_HOME` 指定的助手目录。这会同时删除助手、已保存账户与用量；需要保留的数据应先备份。通过环境变量单独设置的密钥也需在对应环境中自行移除。
