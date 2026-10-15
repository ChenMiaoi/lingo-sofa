# 第三方许可清单

更新日期：2026-10-15。LingoSofa 原创材料 Copyright © 2026 LingoSofa contributors，采用 [GPL-3.0-or-later](LICENSE)；依赖、宿主及运行时保留各自授权。本文件是开发版本的许可清单，不能代替发行包中的完整第三方许可文本。

| 组件                 | 当前版本                                 | 许可与来源                                                                                                                             | 使用方式                                                     |
| -------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Pi AI / Coding Agent | 1.2.0                                    | MIT；[固定版本 LICENSE](https://github.com/earendil-works/pi/blob/v1.2.0/LICENSE)；Copyright (c) 2025 Mario Zechner                    | 浏览器 provider、Node Bridge 与 SDK                          |
| WXT                  | 0.21.4                                   | package.json 声明 MIT；[项目源码](https://github.com/wxt-dev/wxt)                                                                      | 浏览器构建工具                                               |
| Zod                  | 4.6.7                                    | MIT；安装包 `node_modules/zod/LICENSE`                                                                                                 | 协议与设置校验；浏览器构建去掉可选 JIT                       |
| KaTeX                | 0.19.0                                   | MIT；安装包 `node_modules/katex/LICENSE`                                                                                               | 仅生成 MathML；不携带字体文件/CSS，不使用 CLI                |
| React / React DOM    | 锁文件固定                               | MIT；安装包各自的 `LICENSE`                                                                                                            | 浏览器 UI；Discord 端使用宿主 React                          |
| Vencord              | 16ec4ea838899706019e7f472e45f055070abeb1 | GPL-3.0-or-later；[固定 revision LICENSE](https://github.com/Vendicated/Vencord/blob/16ec4ea838899706019e7f472e45f055070abeb1/LICENSE) | Discord 插件宿主；Windows 组合安装包包含构建及对应源码       |
| Vencord Installer    | 595991ca27520868af4f9c48adf0c53ee971f1f2 | GPL-3.0-or-later；[项目源码与 LICENSE](https://github.com/Vencord/Installer)                                                           | Windows 组合安装包从固定源码构建 CLI，随包交付源码和 LICENSE |
| Node.js              | 24.x；本机 24.1.0                        | [v24.1.0 完整 LICENSE](https://github.com/nodejs/node/blob/v24.1.0/LICENSE)                                                            | SEA Native Host 携带 Node 运行时与其第三方软件               |
| Playwright           | 1.64.0                                   | Apache-2.0；安装包 LICENSE / NOTICE                                                                                                    | 开发验收，不随浏览器扩展发行                                 |

发行前应根据实际产物的依赖闭包，随包保留对应的完整版权、许可与 NOTICE；核对 Pi 的传递依赖、SEA 中 Node 携带的组件，以及浏览器包中的 React/Zod/provider 代码。构建工具的声明许可不能替代产物审查。

LingoSofa 改为 GPL-3.0-or-later 不会改变第三方组件的原有许可。分发 Discord 集成时，仍须保留 Vencord 的版权与许可，并交付适用的对应源码和构建/安装说明；LingoSofa 的插件归档不包含 Vencord 或 Discord 二进制。

Windows 组合 EXE 同时携带 Vencord 和 Vencord Installer 的固定 revision 源码归档、各自完整 LICENSE，以及 LingoSofa 源码归档。对应构建和安装步骤见 `docs/release-ci.md`、`scripts/package-windows.mjs` 与 `scripts/windows/`。Inno Setup 仅用作构建工具，编译工具不进入用户安装内容；其安装引擎保留上游许可。
