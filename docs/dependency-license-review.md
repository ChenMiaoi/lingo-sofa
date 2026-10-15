# 依赖许可文本审查

日期：2026-10-14。本机候选包保守检查锁文件中 122 个已安装非开发依赖，最初 6 个包没有独立 LICENSE/NOTICE。此清单是运行依赖的超集，不代表浏览器中包含所有这些包。校验值和许可声明不是公开分发许可结论。

`data-uri-to-buffer@4.0.1` 的完整 MIT 文本实际位于 README；已从 npm 元数据对应 gitHead 的 [上游 README](https://raw.githubusercontent.com/TooTallNate/node-data-uri-to-buffer/85cd8c854aefbf1bb636789d80364cfac8ea1583/README.md) 提取完整版权和许可段，保留在 `third-party/licenses/`。来源记录保存原 README 和提取文本的 SHA-256；候选生成器验证文本后按包名和版本加入许可清单，不将它继续计为缺文本。

## 尚未解决的具体项目

| 依赖                                          | npm 声明   | 核对结果与下一步                                                                                                                       |
| --------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `@aws-sdk/credential-provider-http@3.972.76`  | Apache-2.0 | 本地包无完整根许可；需确认对应源码与父仓库许可、NOTICE 的适用范围                                                                      |
| `@aws-sdk/credential-provider-login@3.972.81` | Apache-2.0 | 同上；不能将任意最新仓库文本当作精确版本的许可交付                                                                                     |
| `@aws-sdk/nested-clients@3.997.48`            | Apache-2.0 | 同上；保留独立版本检查，不能因其他 AWS 包带 LICENSE 就自动清除问题                                                                     |
| `proxy-agent-negotiate@1.1.0`                 | MIT        | 对应 tag 的根目录及 packages/negotiate 未发现完整许可文件；需上游明确完整版权文本和包适用范围                                          |
| `standardwebhooks@1.1.1`                      | MIT        | npm 对应 gitHead 的 JavaScript package.json 声明 MIT，仓库根 LICENSE 为 Apache-2.0；需要上游明确该库实际适用文本，不能自动用根文件替代 |

AWS 父仓库 [LICENSE 快照](https://raw.githubusercontent.com/aws/aws-sdk-js-v3/d6adfcb7baa396dd42060a74382b6aa2a1cbf0b5/LICENSE) 可取得，但本次未确认该源码 revision 与上述三包的对应关系。Proxy 的 [指定发布 tag](https://github.com/TooTallNate/proxy-agents/tree/proxy-agent-negotiate%401.1.0/packages/negotiate) 保留为核对入口。Standard Webhooks 的 [JS 元数据](https://raw.githubusercontent.com/standard-webhooks/standard-webhooks/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/libraries/javascript/package.json) 与 [根 LICENSE](https://raw.githubusercontent.com/standard-webhooks/standard-webhooks/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/LICENSE) 来自同一固定 commit。

这 5 项仍进入 `release-review.json.licenseIssues`。之后需根据实际 bundle/Bridge 依赖闭包和供应商内嵌 notices 逐项核对；明确不进入某个发行物的包可以从该发行物的清单排除，但不能为了通过审查直接从锁文件总清单删掉。原创材料现采用 GPL-3.0-or-later；Vencord 组合分发所需的对应源码和第三方声明仍须独立交付。
