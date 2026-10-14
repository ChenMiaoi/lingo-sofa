# LingoSofa

统一双语翻译与 Pi 助手：保留网页或 Discord 原文，就地显示译文，围绕用户预览的内容提问。浏览器扩展、Vencord 插件和可选本地 Pi Bridge 分别构建。

目前提供可构建、可自动验证的开发版本，已完成真实 DeepSeek、本机 MV3/Native Bridge 和原 Discord 验证，尚未完成全部 Windows/macOS 客户端发布验收。详见 [验收记录](docs/acceptance.md) 和 [兼容性清单](docs/compatibility.md)。

## 开发与验证

使用 Node.js 24 和 npm，依赖固定在单一锁文件中。

```sh
npm ci
npm run check
npm run test:e2e
npm run verify:vencord
npm run benchmark
```

`check` 包含 lint、格式、类型、单元/集成测试、三个应用构建与 MV3 产物审计。首次运行浏览器测试前执行 `npx playwright install chromium`。Vencord 验证下载锁定的上游源码到 `.cache/vencord` 并集成构建，不修改已安装的 Discord。基准测试仅使用合成页面和本地模拟模型。

真实供应商验收为显式操作：在被 Git 忽略的 `.env` 中配置 `API_KEY` 后执行 `npm run package:native --workspace @lingo-sofa/pi-bridge` 和 `npm run verify:real`。它使用临时浏览器 profile 和合成文本发起 5 次真实模型请求，查询一次余额，临时注册 Native Host 并在退出时清理；不会记录密钥或余额金额。目前脚本支持 macOS/Linux，Windows 尚待实现。详见 [真实验收记录](docs/real-provider-acceptance.md)。

## 浏览器扩展

1. 执行 `npm run build`。
2. 在 Chrome/Edge 扩展管理页启用开发者模式，加载 `apps/browser-extension/.output/chrome-mv3` 目录。
3. 打开扩展设置，填写模型、端点和自己的 API Key，点击授权并保存。默认只在浏览器会话保留密钥。
4. 在普通网页点击“在页面中打开控制”，从页边入口翻译整页，或悬停正文只翻译一段。选区译文也直接显示在对应段落下方。暂停保留完成的译文，恢复原文移除译文，收起控件继续阅读。
5. 自动模式需要逐网站添加并保存授权。问答必须先预览文章或选中文本。

可使用 `npm run zip --workspace @lingo-sofa/browser-extension` 生成带版本的 Chrome ZIP；发布前仍需完成真机矩阵验收和第三方许可交付。

默认模型为官方当前 `deepseek-flash`（DeepSeek-V4.1-Flash），验收使用此模型。Pi 目录含计价；费用按请求开始时的官方峰/谷费率估算，预算预留按峰时上限，详见 [价格记录](docs/compatibility.md#已选择的真实验收模型与价格)。

浏览器直连目前使用 DeepSeek 或 OpenAI 兼容端点，其他 Pi provider 使用 Bridge。授权范围、内容边界和清理行为见 [隐私说明](docs/privacy.md)。Firefox、PDF、移动端和跨域 iframe 尚不支持。

## 本地 Pi Bridge

Bridge 不随扩展自动安装。以下操作仅用于决定使用本地模式的用户。

```sh
npm run build --workspace @lingo-sofa/pi-bridge
npm run init --workspace @lingo-sofa/pi-bridge
npm run pair --workspace @lingo-sofa/pi-bridge
```

默认配置位于 `~/.config/lingo-sofa/config.json`，可用 `LINGO_SOFA_HOME` 指定目录。编辑其中 `settings.model` 的 provider、模型及端点，设置预算，按需填写 `allowedExtensions`。API Key 可通过启动进程的 `LINGO_SOFA_API_KEY` 环境变量提供，或在 Discord 的 Provider 页面配置。该页面保存的模型和 Key 位于本地助手目录中的 `provider.json`（仅当前用户可读写），启动时优先读取；不要提交密钥或配对文件。

```sh
npm run start --workspace @lingo-sofa/pi-bridge
```

服务只监听 `127.0.0.1`，默认端口 43187。配对令牌有效期一小时；重新配对后需重启服务；桌面 Discord 自动读取助手生成的 `discord-connection.json`，无需填写端口或令牌。`usePiAuth: true` 可显式复用 Pi 认证文件；默认不读取 Pi CLI 认证。`shareUsage` 默认关闭；开启仅共享用量元数据，会话正文仍隔离。`shareBudget` 也默认关闭，独立控制是否跨前端合并预算；两端显示执行端计算的预算状态。正文缓存始终按上下文隔离。`settings.persistUsage` 控制是否写入 `usage.json`，保留期为 `settings.retentionDays`。

浏览器接入还需要 Native Messaging host：

```sh
npm run package:native --workspace @lingo-sofa/pi-bridge
npm run install:native --workspace @lingo-sofa/pi-bridge -- YOUR_EXTENSION_ID
```

将同一扩展 ID 加入 Bridge 的 `allowedExtensions`，重启 Bridge，并在扩展设置选择本地模式。安装脚本注册用户级 Native Messaging manifest，Windows 还注册 HKCU 项；不会安装 Discord。保留当前 checkout 和 native host 路径，移动目录后需要更新注册。安装不会覆盖已有 manifest；更新前应核对并移除旧注册。

卸载时关闭 Bridge，移除 `com.lingosofa.bridge.json` 用户级 manifest，Windows 同时移除对应 Chrome/Edge 的 HKCU NativeMessagingHosts 项；不再需要配置时删除 `LINGO_SOFA_HOME` 目录。密钥若由系统环境管理，也应在对应环境中清理。

## Discord / Vencord

执行 `npm run build --workspace @lingo-sofa/discord-vencord`，产物是 `apps/discord-vencord/dist/lingoSofa/index.tsx`。将整个 `lingoSofa` 目录放入自行维护的 Vencord checkout 的 `src/userplugins/` 后，按该宿主的构建流程使用。

非官方客户端修改需要用户自行决定并明确授权安装。构建验证脚本不修改 Discord；本次已按用户明确授权在原客户端完成验收，见 [Discord 验收记录](docs/discord-acceptance.md)。插件提供消息菜单/悬浮翻译入口、下方译文、频道自动模式、选中消息问答。插件设置仅显示供应商、模型和 API Key；支持 Pi 目录中的多个供应商及自定义 OpenAI 兼容端点。桌面端自动连接本地 Bridge，连接描述文件只包含端口和短期令牌，不含模型 Key；旧版助手需升级后使用自动连接。所有频道均可手动翻译，自动双语由频道内开关授权，目标语言也在悬浮入口设置。悬浮面板只保留目标语言、当前供应商的模型切换、频道自动翻译开关；预算和用量仍由 Bridge/网页端管理。

## 文档

- [技术设计与里程碑](docs/lingo-sofa-plan.md)
- [架构和协议](docs/architecture.md)
- [隐私与凭证](docs/privacy.md)
- [版本、平台与限制](docs/compatibility.md)
- [验收证据及剩余发布条件](docs/acceptance.md)
- [内嵌双语与轻量入口](docs/ui-design.md)
- [入口设计探索](docs/ui-exploration.md)
- [发布准备与环境依赖](docs/release-readiness.md)
- [依赖许可具体缺项](docs/dependency-license-review.md)
- [协作与提交规范](AGENTS.md)

项目原创材料暂采用 [商业专有 LICENSE](LICENSE)，依赖保留各自授权，见 [第三方许可清单](THIRD_PARTY_NOTICES.md)。Vencord 集成分发仍需单独核对 GPL 条件；当前开发产物尚未完成公开发行的许可交付。
