# 真实模型与 Native Bridge 验收

日期：2026-10-14；最后一次完整成功运行从 01:10:16 UTC 开始。本机 macOS 27.0.1 / Apple M4，Node 24.1.0，Chrome for Testing 156.0.8078.4，Pi 1.2.0。模型为用户指定的官方当前 `deepseek-flash`（DeepSeek-V4.1-Flash）。

## 可复现方式

构建扩展并打包本机 Native Host，在本地 `.env` 设置 `API_KEY`，再执行 `npm run verify:real`。该操作显式调用真实服务并产生用量；不属于 `npm run check` 或默认 CI。使用全新临时浏览器 profile、本地合成网页和临时 Bridge 配置，不读取用户网页或 Discord token。

仅对临时测试扩展预授予 DeepSeek 和本地网页权限；发行 manifest 保持可选 host permissions。Native Host manifest 注册在临时 user-data-dir 的 NativeMessagingHosts 子目录内，[Chrome 官方说明](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)定义此查找方式。退出时关闭浏览器与 Bridge、删除临时配置、配对信息和 profile，不修改用户的长期 Native Host 注册。

## 本次完整成功运行

| 场景                                     | 结果                                                    | 输入（含缓存）/输出/总 tokens | USD 估算          |
| ---------------------------------------- | ------------------------------------------------------- | ----------------------------- | ----------------- |
| 真正加载 MV3 后翻译网页                  | 显示中文，保留 `fetch()` 代码与原文；模型耗时 1,370ms   | 95 / 31 / 126                 | 0.0000657         |
| 浏览器 → Native Host → Bridge SDK 第一轮 | 中文翻译合成上下文                                      | 120 / 38 / 158                | 0.0000816         |
| 同一 SDK 会话第二轮                      | 回答 `fetch()`，成功携带所选上下文                      | 193 / 2 / 195                 | 0.0000603         |
| Pi provider 思考流                       | 收到 thinking_delta；output 含 reasoning 18，不重复计数 | 43 / 20 / 63                  | 0.0000369         |
| 官方非流式 API                           | HTTP 200、中文结果、原始 usage 存在                     | 16 / 1 / 17                   | 未由 adapter 统计 |
| 扩展后台余额查询                         | 返回 CNY 数据与更新时间                                 | 非模型请求                    | 不记录余额金额    |

SDK 会话汇总为 353 tokens、USD 估算 0.0001419、5 条消息；与两条请求之和一致，工具调用为 0。问答和翻译记录均带官方来源、2026-10-14 核对日期及采用的峰时费率。此次完整成功运行的缓存命中为 0，缓存单价与互斥桶计算由固定数据测试覆盖。

另一次 00:59 UTC 的真实翻译使用谷时快照，返回 93 input + 28 output = 121 tokens，估算 USD 0.00003075。真实流式请求与多个测试请求跨过 01:00 UTC 费率边界；单请求跨边界快照冻结另有回归测试。

## 验收边界

非流式验收直接调用官方 HTTP API，证明该端点能力；产品执行路径仍使用 Pi 流式 adapter。思考请求通过 Pi 独立 provider 验证，产品翻译和受限 SDK 默认关闭思考。示例结果只证明功能链路，不代表广泛语言质量评分。

费用均按公开单价估算，余额币种为 CNY，未进行汇率换算或供应商账单实扣对账。峰/谷时段、节假日、自定义价格与 SDK 跨时段累计测试见 `tests/pricing.test.ts`。真实 Discord 交互、常用 Chrome/Edge profile、Windows 和读屏验收以 [总验收记录](acceptance.md) 为准，不能由本脚本代替。
