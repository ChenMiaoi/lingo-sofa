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
4. **Windows 组合安装包**：Windows x64 runner 获取已汇总的产物，重新构建嵌入助手清单的 Vencord，并关闭上游更新入口。固定 revision 的 Vencord Installer CLI 从源码编译；预编译宿主、Windows 助手、对应源码与许可证一起封装为 Inno Setup EXE。在临时 Discord Canary 资源目录验证实际助手安装和上游补丁安装、重复安装及数据保留，再运行更新/恢复回归测试，重新生成包含 EXE 的完整校验清单。
5. **发布**：必须等待 Windows 组合安装 job 成功，下载 `release-complete` 的完整产物，复核全部校验值，再通过 `gh release create --verify-tag` 上传附件并公开 Release。GitHub CLI 先创建草稿、上传附件，再公开，避免正常运行时暴露尚未上传完整的下载集合。

| 系统 / 芯片         | Runner             |
| ------------------- | ------------------ |
| macOS Apple Silicon | `macos-15`         |
| macOS Intel         | `macos-15-intel`   |
| Linux ARM64         | `ubuntu-24.04-arm` |
| Linux x64           | `ubuntu-24.04`     |
| Windows x64         | `windows-2022`     |

工作流会核对 runner 的实际系统和架构，避免把一种架构的可执行文件贴上另一种标签。不支持的平台不会假装有可用下载。

## Release 附件

- `LingoSofa-Setup-<version>-win32-x64.exe`：包含 LingoSofa 的预编译 Vencord、上游 CLI 安装器、Windows 助手及对应源码/许可证。
- `windows-release.json`：组合包版本、固定下载 URL、SHA-256 和上游源码 revision。运行时检查以 GitHub Release API 的最新正式版本与资产 digest 为准，不接受 renderer 提供任意 URL 或执行参数。

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

在 Windows x64 上，已汇总客户端和助手产物后执行：

```sh
npm run package:windows -- .cache/release-assets .cache/release-assets
```

构建需要 Node 24、Git 和 Go；Inno Setup 6.7.3 编译工具包从固定 NuGet URL 下载并按内置 SHA-256 校验，只解压到项目缓存，不安装到系统。也可用 `LINGO_SOFA_ISCC` 指定已有编译器。Node 安装缺少 LICENSE 时，按助手打包约定用 `LINGO_SOFA_NODE_LICENSE` 指定同版本官方许可证。组合安装 smoke test 不修改真实 Discord；本机运行时需先退出 Discord Canary，防止上游按分支名查找进程影响正在使用的 Canary。

## 打包耗时诊断

助手打包、助手验收、Windows 组合打包与 Windows 安装验收会自动输出 `[timing]` 日志，无需额外开关。每个阶段先输出 `start`，结束时输出 `elapsed=...ms`，结束时还会输出 `total`（有清理阶段的脚本包含清理时间）。耗时使用单调时钟；阶段开始日志可用于定位失败或停滞位置；`elapsed` 只表示耗时，不表示验收成功。

- `package-assistant`：依赖暂存、运行时复制、逐文件校验、归档压缩、发布清单生成和暂存清理。
- `verify-assistant`：归档路径检查、解压、安装、删除解压目录、授权入口、服务启动、共享协议验收、服务停止和临时文件清理。
- `package-windows`：助手归档校验与解压、Vencord 构建、Go 安装器构建、源码归档、载荷校验、直接安装验收、Inno 工具准备、EXE 编译压缩、EXE 安装验收和最终校验清单。
- `verify-windows-direct` / `verify-windows-exe`：首次安装、重复安装、重启观察程序构建、EXE 成功安装、失败路径、结果校验与临时安装目录清理。

组合打包的阶段包含其子验收脚本的耗时，分析时不能把父子耗时相加。比较优化前后结果时应使用相同 runner、版本和缓存状态，并保留完整验收；本机 Windows 结果不能直接当作 GitHub runner 的耗时。

普通 CI 不构建组合安装包。需要测量完整 Windows 流程时，可手动运行 `Windows packaging profile` 工作流；可选的 `revision` 输入用于指定基线或优化提交。它使用与 Release 相同的 `windows-2022` runner、Node 和 Go 配置，从指定提交构建助手与源码归档，再执行完整组合安装验收。工作流仅有只读权限，不创建 tag、不上传安装包、不发布 Release；计时记录保留在 Actions 日志中。
