<!-- English or Chinese is welcome. / 中文或英文均可。 -->

## Summary / 概述

<!-- Explain the problem and resulting behavior. A concrete before/after example helps.
说明解决的问题与改动后的行为，必要时提供改动前后的具体例子。 -->

## Related issues / 关联问题

<!-- Use "Closes #123" only when this PR fully resolves the issue. Otherwise use "Related to #123".
完整解决时使用 Closes #123，否则使用 Related to #123；无关联问题可注明。 -->

## Validation / 验证

<!-- Record actual commands/results and affected clients. Explain any checks not run.
填写实际执行的命令、结果和受影响客户端；未执行的检查请说明原因。

- npm run check: required before committing, including for documentation changes.
  提交前必须运行，包括文档改动。
- Run regression tests for changed behavior; shared code/protocol changes need consumer checks.
  行为变更需回归测试，共享代码或协议变更需验证相关消费端。
- For relevant changes, use browser E2E, verify:vencord, or packaged assistant verification.
  按改动范围执行浏览器 E2E、Vencord 或助手安装包验证。
- For documentation-only changes, check formatting, links and file references; no new code tests are needed.
  纯文档改动检查格式、链接和文件引用，不需新增代码测试。 -->

- `npm run check`:
- Relevant tests and affected clients / 相关测试与客户端：
- Manual checks, including OS/client versions / 人工验证与系统、客户端版本：
- Checks not run and why / 未执行的检查及原因：

## Screenshots / 截图

<!-- For visible UI changes, show before/after screenshots with synthetic content.
界面变更请提供使用模拟内容的前后对比；无界面变更可删除本节。 -->

## Compatibility and migration / 兼容性与迁移

<!-- Describe any need to upgrade clients, assistant or Native Host together, migrate settings,
or update dependency notices. Write "Not applicable" when there is no such impact.
如需同步升级客户端、助手或 Native Host，迁移配置或更新依赖声明，请在此说明；无影响可填“不适用”。 -->

## Checklist / 检查清单

- [ ] I followed the [contributor guidelines](https://github.com/ChenMiaoi/lingo-sofa/blob/main/AGENTS.md) and kept the change focused. / 已遵循贡献规范，改动范围聚焦。
- [ ] Regression coverage and documentation are updated where applicable; exceptions are explained above. / 已按需更新回归测试与文档，不适用的情况已说明。
- [ ] Examples, logs and attachments contain no credentials or private user content. / 示例、日志及附件不包含凭证或私人内容。
