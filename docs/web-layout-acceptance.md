# 公开网页翻译排版验收

日期：2026-10-18。环境：Windows、Node.js 24.15.0、Chromium 156.0.8078.4、Playwright 1.64.0；加载实际构建的 MV3 扩展。

## 范围与方法

新增 11 个公开页面，其中 10 个完成检查，Stack Overflow 返回 HTTP 403，未验收。另复测已有 LLVM 论坛和文档样例。

每个新增页面使用独立临时浏览器配置，授权仅限该页面来源及本地测试服务。模型由本地服务返回长度相近的固定中文，保留 Markdown、链接与代码保护标记；不调用真实供应商。这验证排版和恢复行为，不评价翻译质量。

检查 1440 × 1000 与 390 × 1000 视口，滚动到页面中段，再返回主要阅读区域；等待当前可见内容的翻译请求完成后截图。检查视口内确有译文、译文未被直接父容器裁剪、页面没有因翻译增加横向宽度，以及标题和元数据的提取边界。宽度同时与移除译文后的同一已加载页面比较，避免延迟加载影响初始基线。

恢复原文后检查所有译文节点已移除，原始代码、链接地址和输入值保持不变。保留原始节点引用；响应式重建后的节点还需在当前内容中找到相同值。代码检查包括开放 Shadow DOM：MDN 会在初始化时把示例从普通 DOM 移入其中。封闭 Shadow DOM、跨来源 iframe 和登录后界面不在本次范围内。

## 页面结果

| 页面                                                                                                                                                   | 结果               | 主要检查                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------ |
| [Hacker News](https://news.ycombinator.com/)                                                                                                           | 通过               | 标题独立译文；保留域名、投票、作者、时间和导航               |
| [GitHub LLVM 仓库](https://github.com/llvm/llvm-project)                                                                                               | 通过               | README 标题与正文；保留文件路径、文件列表和提交时间          |
| [GitHub TypeScript Issue #9998](https://github.com/microsoft/TypeScript/issues/9998)                                                                   | 通过               | 讨论标题、正文和评论；活动记录不挤占布局，390px 页面不被撑宽 |
| [MDN Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)                                                | 通过               | 段落、列表、内联代码和动态示例；原文恢复                     |
| [Python 控制流教程](https://docs.python.org/3/tutorial/controlflow.html)                                                                               | 通过               | 章节标题、段落、列表、代码块与标题定位符                     |
| [Rust Book：Ownership](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html)                                                                  | 通过               | 章节标题、正文和代码；保留书籍菜单与侧栏                     |
| [Linux 内核内存分配文档](https://docs.kernel.org/core-api/memory-allocation.html)                                                                      | 通过               | Sphinx 标题、正文、代码与侧栏边界                            |
| [Wikipedia：LLVM](https://en.wikipedia.org/wiki/LLVM)                                                                                                  | 通过               | 文章标题、正文和信息框标签；保留姓名、版本等值及编辑入口     |
| [The Guardian 国际首页](https://www.theguardian.com/international)                                                                                     | 通过               | 新闻卡片标题、混合长短内容与窄屏换行                         |
| [Python Discourse](https://discuss.python.org/latest)                                                                                                  | 通过               | 动态主题列表、桌面与手机布局重建、数量与分类元数据           |
| [Stack Overflow：排序数组问题](https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array) | 未验收             | HTTP 403；记录访问结果并跳过                                 |
| [LLVM Discourse](https://discourse.llvm.org/latest)                                                                                                    | 通过，既有样例复测 | 紧凑标题、前缀、分类、数量、主题颜色和恢复                   |
| [LLVM Programmer’s Manual](https://llvm.org/docs/ProgrammersManual.html)                                                                               | 通过，既有样例复测 | 99 个代码块、803 个链接、29 个输入控件恢复后一致             |

## 本轮修复与回归

- 区分文章内部的标题区域和全站横幅，补上文章标题；忽略仅供读屏的 CSS 隐藏文字。
- Hacker News 单独提取新闻标题，避免把域名、作者、投票和导航串进译文。
- 保留 GitHub 文件列表和活动元数据。多列活动记录不再因追加译文占用额外一列；评论正文与评论内列表继续翻译。
- Wikipedia 信息框保留数据值，标题定位符和编辑链接不参与翻译；Sphinx 和 mdBook 的菜单、侧栏保持原样。
- `tests/web.test.ts` 覆盖上述提取边界；`forum.test.ts` 和论坛浏览器 fixture 覆盖紧凑渲染、真正公式、文字前缀、动态更新与完整恢复。

`npm run check` 通过：233 项测试通过、1 项平台条件跳过，lint、格式、类型及全部构建通过。本次 17 项相关浏览器回归中，16 项通过、1 项因 Stack Overflow HTTP 403 跳过；包含内嵌翻译与选区、Discord 深浅主题，以及 1,000 段 / 100 次 SPA 更新。

## 复现与证据

先构建扩展，再显式启用联网测试。PowerShell：

```powershell
npm run build --workspace @lingo-sofa/browser-extension
$env:LINGO_SOFA_PUBLIC_ACCEPTANCE = '1'
npm run test:e2e -- tests/e2e-browser/public-layout.spec.ts tests/e2e-browser/forum-layout.spec.ts tests/e2e-browser/public-page.spec.ts
```

未设置环境变量时，公开网页测试默认跳过；论坛本地 fixture 继续运行。HTTP 错误和页面不可达会记录为 `unavailable`，不能计为兼容性通过；布局断言失败会令测试失败。

逐页 JSON、原始页面、翻译后的宽窄屏和中段截图保存在被 Git 忽略的 `.cache/public-layout/`；LLVM 论坛与文档截图在 `.cache/ui/`。这些是当日页面和当前构建的证据。网站结构、内容、响应式行为或访问策略变化后需重新验证，不能据此认定全部页面或完整无限滚动已兼容。
