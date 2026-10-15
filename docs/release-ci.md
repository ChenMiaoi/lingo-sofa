# 按 Tag 自动发布 GitHub Release

`.github/workflows/release.yml` 在推送 `vMAJOR.MINOR.PATCH` tag 时自动运行，例如 `v0.1.0`。普通分支/PR 由 `ci.yml` 检查，版本 tag 使用专门的 Release 工作流，避免重复执行两套 CI。

## 发布步骤

1. 同步 `apps/*` 和 `packages/*` 的版本、内部依赖与 `package-lock.json`，提交需要发布的完整源码。根 workspace 的私有 `0.0.0` 元数据不参与版本比较。
2. 为该提交创建并推送版本 tag：

```sh
git tag -a v0.1.0 -m "LingoSofa v0.1.0"
git push origin v0.1.0
```

3. 在 GitHub Actions 中查看 Release 工作流。无需手动创建 Release，也无需配置个人访问令牌；发布 job 使用 GitHub 自动提供的 `GITHUB_TOKEN`，仅该 job 具有 `contents: write` 权限。

仅支持正式三段数字版本，不接受前导零、`-rc`、构建后缀或任意分支名。tag 必须与所有应用/共享包版本相同；组装产物时还会检查 checkout 正好对应 tag，且源码工作区干净。tag 所在提交必须已经包含本工作流和安装/打包代码。

## 流水线

1. **校验**：版本一致性、`npm run check`、浏览器 E2E 和固定 Vencord 宿主集成检查。任一失败均不会发布。
2. **各平台助手构建**：在对应系统/架构的 runner 原生打包，运行 Bridge/安装回归，并实际安装到临时目录；删除解压目录后检查包内 Node、服务启动、浏览器/Discord 共用实例与认证连接。不会发送模型请求。
3. **汇总客户端**：收齐全部平台安装包，验证每个平台版本、固定下载 URL 和 SHA-256，再生成统一 `assistant-release.json`。随后构建嵌入这份完整清单的 Discord userplugin、浏览器 ZIP、准确对应 tag 的源码归档和最终校验文件。最后再次审计 MV3 并验证含完整下载清单的 Vencord 构建。
4. **发布**：下载本次工作流的完整产物，复核全部校验值，再通过 `gh release create --verify-tag` 上传附件并公开 Release。GitHub CLI 先创建草稿、上传附件，再公开，避免正常运行时暴露尚未上传完整的下载集合。

| 系统 / 芯片         | Runner             |
| ------------------- | ------------------ |
| macOS Apple Silicon | `macos-15`         |
| macOS Intel         | `macos-15-intel`   |
| Linux ARM64         | `ubuntu-24.04-arm` |
| Linux x64           | `ubuntu-24.04`     |
| Windows x64         | `windows-2022`     |

工作流会核对 runner 的实际系统和架构，避免把一种架构的可执行文件贴上另一种标签。不支持的平台不会假装有可用下载。

## Release 附件

- 五个平台的 `lingo-sofa-assistant-<version>-<platform>-<arch>.tar.gz`：自带 Node、共享服务、Native Host 和安装入口。
- `lingo-sofa-browser-<version>.zip`：Chrome/Edge MV3 扩展。
- `lingo-sofa-vencord-<version>.tar.gz`：供自定义 Vencord 构建的 userplugin，包含全部平台后台的固定下载地址/校验值，不包含 Vencord 或 Discord 二进制。
- `lingo-sofa-source-<version>.tar.gz`：tag 对应提交的源码。
- `assistant-release.json`、`release.json`、`SHA256SUMS`、安装说明、Release 说明和项目许可/第三方声明。

安装包当前仍是未签名/未公证的开发包。工作流成功表示这些构建和自动检查通过，不表示已完成 [发布准备](release-readiness.md) 中的真机、签名、许可文本补齐及组合分发验收；Release 说明会保留这些状态。浏览器商店上架、Vencord 官方插件收录、安装到用户电脑均不在此工作流内。

## 失败与重跑

- 某个平台构建失败：不会执行汇总或发布。修复源码后应发布新版本；同一提交的外部网络暂时故障可直接重跑。
- 上传失败可能留下草稿：检查并删除该失败草稿后重跑，工作流不会自动覆盖既有 Release。
- 已公开的版本不可通过此流程覆盖。Discord 固定了归档的 SHA-256，替换同一 URL 的字节会导致安装校验失败；修复应使用新版本 tag。
- 不要移动已经发布的 tag。同一个 tag 的工作流串行运行，且不会自动取消正在进行的发布。

助手下载地址目前固定为 `ChenMiaoi/lingo-sofa` 的 GitHub Release；从 fork 发布前需同步修改下载地址配置，校验器会拒绝直接发布指向原仓库的 fork 产物。

## 本地验证

```sh
npm run release:validate -- v0.1.0
npm test -- tests/release-ci.test.ts
```

拥有全部 runner 生成的原生归档与平台 JSON 清单后，可以在对应 tag 的干净 checkout 中离线汇总（构建依赖应已由 `npm ci` 安装；Vencord 宿主验证仍可能需要网络）：

```sh
npm run release:assemble -- v0.1.0 /absolute/native-artifacts /absolute/empty-release-output
```

本地汇总不创建 tag、不推送、不公开 Release。
