# OpenAI 登录与订阅用量

更新：2026-10-15。OpenAI 认证说明已按 [官方注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) 和 [模型调用](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) 核对。

## 用户操作

网页选择“本地助手”，Discord 打开 LingoSofa 的 Provider 设置，选择 OpenAI。两端使用同一登录组件和同一 Bridge 状态。

- **ChatGPT 订阅**：点击“使用 ChatGPT 登录”，再点击授权链接，在 OpenAI 页面完成登录与授权。返回后显示已连接，选择模型并保存配置，才将翻译切到订阅模式。登录成功不会自动替换当前 DeepSeek/API Key 模型。
- **API Key**：切到 API Key，填写或保留该端点已有的 Key，保存配置。切换登录方式不自动把另一供应商的 Key 带过来。
- “取消登录”停止当前浏览器回调等待；“退出本机登录”移除 Bridge 的订阅凭据并清理旧会话。Pi 当前的 logout 不确认远端撤销，用户可在 ChatGPT 设置中管理授权。

资格、可调用模型和订阅额度由 OpenAI 决定，目录存在模型不代表账号一定拥有权限。真实授权必须由用户在 OpenAI 页面完成，不读取浏览器 Cookie 或自动导入其他工具的账号。

## 实现与存储

直接复用固定 Pi 1.2.0 的 `ModelRuntime.login("openai", "oauth", ...)`、原生 OAuth Provider、文件凭据存储和刷新。LingoSofa 只协调单次登录、状态、取消和 UI，不另写 PKCE、授权码交换或 refresh 协议。

Bridge 私有目录保存 `oauth-auth.json`（由 Pi 以 0600 保存访问/刷新凭据）及 `oauth-device-id`（0600 稳定设备 UUID），应用名为 LingoSofa。Pi 当前使用 `127.0.0.1:1455/auth/callback`；端口被其他登录占用会安全失败，不能另起监听抢占。登录最多等待五分钟；客户端关闭不取消另一端仍在使用的 Bridge，服务停止前会取消登录等待。

`POST /v1/oauth` 仅接受 start/status/cancel/logout。沿用 Bridge 的来源、Host、短期令牌和请求限制；浏览器仅可信扩展设置页可访问，普通网页/内容脚本不能启动登录或读取授权 URL。Native Host 转发同一接口；返回仅含连接状态、阶段、OpenAI 授权链接及脱敏错误，不返回访问令牌、刷新令牌、授权码或 PKCE verifier。两端每 1.5 秒更新已打开设置页的状态。

订阅仅允许 `provider=openai`、官方 `https://api.openai.com/v1`，通过 Responses API 使用独立 OAuth 文件。OpenAI 的 API Key 模式明确使用 API Key，不因旧 usePiAuth 配置而偷偷改用其他工具的订阅凭据；其他供应商的旧配置保持兼容。API Key 模式使用原 API Key 解析路径，不能把订阅令牌送到自定义端点。没有订阅凭据时明确要求重新登录，不偷偷回退到 API Key。登录期间禁止新模型任务；新账号登录成功及退出时清理旧上下文与结果缓存，用量账本保留。刷新由 Pi 的文件锁与串行凭据修改管理，正常刷新不清空会话。

## Tokens 与 API 等值费用

API Key 和订阅模式都使用供应商响应的实际 usage：输入、输出、缓存读取/写入分桶计价；推理 Tokens 已属于输出时不再重复加入。即使 Pi 对订阅调用返回零美元 cost，Bridge 也会按当前记录的 API 单价快照重算等值费用，并保留价格来源、采样时间和人民币汇率快照。

订阅记录标记 `billingMode=subscription`；翻译段落显示“API 等值 ¥…”，用量页和 Ask Pi 汇总同样明确为 API 等值。实际 Tokens 按 API 单价计算的金额计入本产品的费用记录；剩余额度单独展示。供应商 usage 或价格缺失时列为待计费，不覆盖已计费金额；本地译文缓存命中仍为本次未调用模型、零新增费用。

## 升级与验证边界

两端、Bridge 与 Native Host 应同步升级，以接受 `model.authMode`、OAuth 状态及可选 `billingMode`。旧配置缺少 authMode 时默认为 API Key；旧历史保持可读，不追算、不删改用量。

本地测试覆盖 Pi 原生登录调度、共享状态、0600 存储、串行刷新、取消与退出、来源/令牌拒绝、禁止订阅到自定义端点、Native 帧、普通网页拒绝 OAuth、两端相同组件的订阅/API Key 切换及窄屏深浅主题。模型 fixture 验证订阅零 cost 响应仍按实际 Tokens 与 API 目录价格折算，缓存/推理不重复相加。

### 本机部署记录（2026-10-15）

已将 94c1826 的产物同步到普通 Chrome（Miao 配置）的现有扩展、原 `/Applications/Discord.app` 使用的 Vencord、本机 Native Host 和 Bridge 私有运行快照。退出并重新打开两个原客户端后，Bridge 自动启动；状态接口确认两个客户端同时连接，Discord 恢复到 LingoSofa 的 `#lingo-sofa-acceptance`。

升级前已在本机私有备份目录保存配置、供应商凭据、用量、Native Host 和 Vencord 产物。升级后仍有 68 条记录，其中 6 条用量未知、已知合计 25,954 Tokens，与升级前一致。没有清除或补写历史用量，也没有为验收发起新的模型调用。

新版真实 OAuth 入口已启动，并在普通 Chrome 展示 OpenAI 官方登录页。用户随后决定暂不登录、以后自行验证；因此已取消本次回调等待，状态恢复为未连接、idle。当前 DeepSeek 配置保持不变。以后请从任一端 Provider 设置重新点击“使用 ChatGPT 登录”生成新授权链接，不复用本次已取消的页面。

真实账号的共享已登录状态、模型切换后的两端调用、订阅 Tokens 与人民币 API 等值费用展示仍待用户授权后验收。本次部署和自动化测试不能证明这些真实调用结果、账号订阅资格、模型可用性或最终账单金额。

同日修复原 Discord 设置页的 `useState` 渲染异常：Vencord 的 React 在插件模块加载后才就绪，共享登录组件改为渲染时获取宿主 React。已更新原客户端并实际打开 Provider 设置，确认 OpenAI 的订阅/API Key 切换、未连接状态和登录按钮正常显示；未发起授权或保存供应商变更。回归测试模拟组件工厂创建后 React 才就绪，并覆盖同一组件的状态同步及两种主题。
