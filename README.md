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
3. 打开扩展设置，在 Provider 面板选择供应商与模型、填写 API Key 并保存；标准模型地址自动填充，自定义兼容接口才填写地址。直连 Key 只在浏览器会话保留，本地助手模式的 Key 仅保存在 Bridge。
4. 在普通网页点击“在页面中打开控制”，页边面板只保留目标语言、当前供应商模型、网站自动翻译，布局与 Discord 一致。悬停正文可只翻译一段；选区译文也就地显示。暂停保留完成的译文，扩展弹窗的“关闭翻译”恢复原文。
5. 自动开关识别当前网站；首次缺少权限时会打开扩展页面，由用户点击“允许并开启自动翻译”，无需填写网址。问答与用量在辅助入口；设置首页只显示 Provider，术语与历史保留在“用量与高级”。

可使用 `npm run zip --workspace @lingo-sofa/browser-extension` 生成带版本的 Chrome ZIP；发布前仍需完成真机矩阵验收和第三方许可交付。

默认模型为官方当前 `deepseek-flash`（DeepSeek-V4.1-Flash），验收使用此模型。Pi 目录含计价；费用按请求开始时的官方峰/谷费率估算，详见 [价格记录](docs/compatibility.md#已选择的真实验收模型与价格)。

浏览器直连目前使用 DeepSeek 或 OpenAI 兼容端点，其他 Pi provider 使用 Bridge。授权范围、内容边界和清理行为见 [隐私说明](docs/privacy.md)。Firefox、PDF、移动端和跨域 iframe 尚不支持。

## 本地 Pi Bridge

首次需要安装一次本地助手；安装后，网页与 Discord 的本地模式自动启动并连接同一个后台服务，不再手动开终端或每小时重新配对。新浏览器配置默认本地模式；已有明确选择的直连模式保留，直连不使用共享助手。

```sh
npm run build --workspace @lingo-sofa/pi-bridge
npm run install:service --workspace @lingo-sofa/pi-bridge
```

默认目录为 `~/.config/lingo-sofa`，可通过 `LINGO_SOFA_HOME` 指定。安装把 Bridge 及运行依赖复制到当前用户的助手目录，记录固定的 Node 24 路径。安装后不依赖源码目录，Node 路径变化时重新安装。安装保留已有配置、Provider 和用量，不自动清除未知消耗。新的助手配置默认持久化用量，已有 `settings.persistUsage` 选择保持不变。

Provider 可在任一端的设置页面配置一次，模型和 Key 保存在助手目录中的 `provider.json`（仅当前用户可读写），两端共用。也可使用服务启动环境的 `LINGO_SOFA_API_KEY`；不会自动读取聊天内容或其他应用凭证。`usePiAuth` 默认为关闭；显式启用才读取指定的 Pi 认证文件。

服务只监听本机 `127.0.0.1`。端口与服务实例凭据由本地组件管理，用户无须填写；凭据随服务退出失效、重启重新生成。连接信息与安装文件不含模型 Key。至少一端连接就保持服务运行；最后一端断开后等待 60 秒，没有在途任务后保存元数据并退出。崩溃连接最长在 45 秒后过期，再开始退出等待。macOS 关窗口不等于退出应用。详见 [后台服务生命周期](docs/service-lifecycle.md)。

浏览器还需要注册 Native Messaging host：

```sh
npm run package:native --workspace @lingo-sofa/pi-bridge
npm run install:native --workspace @lingo-sofa/pi-bridge -- YOUR_EXTENSION_ID
```

该命令同时安装服务启动入口、添加扩展白名单，并注册用户级 Native Messaging manifest；Windows 使用 HKCU。安装不会覆盖已有 manifest，更新前核对并移除自己的旧注册。浏览器、Native Host、Bridge 与 Discord 插件需一起升级；旧 `pairing.json` 和 `discord-connection.json` 不再用于新连接机制。

`shareUsage` 默认关闭；开启仅共享用量元数据，会话正文仍隔离。本地不设置预算上限，余额/配额由供应商判断。旧 `shareBudget` 等字段仅兼容读取，不执行。正文缓存保持上下文隔离。后台恢复不重发已发送请求，未知用量如实保留，不按免费处理，也不拦截后续请求。`settings.persistUsage` 控制元数据持久化，`settings.retentionDays` 控制保留期。

卸载时关闭 Bridge，移除 `com.lingosofa.bridge.json` 用户级 manifest，Windows 同时移除对应 Chrome/Edge 的 HKCU NativeMessagingHosts 项；不再需要配置时删除 `LINGO_SOFA_HOME` 目录。密钥若由系统环境管理，也应在对应环境中清理。

## Discord / Vencord

执行 `npm run build --workspace @lingo-sofa/discord-vencord`，产物是 `apps/discord-vencord/dist/lingoSofa/index.tsx`。将整个 `lingoSofa` 目录放入自行维护的 Vencord checkout 的 `src/userplugins/` 后，按该宿主的构建流程使用。

非官方客户端修改需要用户自行决定并明确授权安装。构建验证脚本不修改 Discord；本次已按用户明确授权在原客户端完成验收，见 [Discord 验收记录](docs/discord-acceptance.md)。插件提供消息菜单/悬浮翻译入口、下方译文、频道自动模式、选中消息问答。插件设置仅显示供应商、模型和 API Key；支持 Pi 目录中的多个供应商及自定义 OpenAI 兼容端点。桌面端在插件启用时自动启动或连接本地服务，停用时释放连接；连接描述文件不含模型 Key。所有频道均可手动翻译，自动双语由频道内开关授权，目标语言也在悬浮入口设置。悬浮面板只保留目标语言、当前供应商的模型切换、频道自动翻译开关；预算和用量仍由 Bridge/网页端管理。

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

浏览器本地助手模式的 Provider 配置与模型切换需更新 Native Host 和 Bridge，并在 `allowedExtensions` 中授权该扩展 ID。网页只收到当前模型/可选模型等阅读状态，完整配置和 Key 操作仅允许扩展界面；Native 调用仍要求短期令牌、来源白名单与 Host 校验。

OpenAI 在本地助手模式支持 **ChatGPT 订阅登录 / API Key** 两种方式，网页与 Discord 共用 Bridge 的登录状态。订阅用量按实际 Tokens 展示 **API 等值费用**，并非订阅账单实扣；详情见 [OAuth 与计价](docs/oauth.md)。
