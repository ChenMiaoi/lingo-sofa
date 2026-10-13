# LingoSofa

统一双语翻译与 Pi 助手。技术方案见 [项目规划](docs/lingo-sofa-plan.md)，协作规范见 [AGENTS.md](AGENTS.md)。

## 开发

使用 Node.js 24 和 npm。首次安装使用 `npm ci`。

```sh
npm run check
```

提交前执行上述命令，依次检查 lint、format、TypeScript 类型和测试。使用 `npm run format` 自动格式化；使用 `npm run test:watch` 在开发时运行测试。

当前仅完成工程初始化，`src/index.ts` 是空入口，尚无业务代码和测试。测试脚本允许此阶段没有测试文件；添加测试后会自动执行，失败时返回非零状态。测试文件使用 `*.test.ts` 命名。

GitHub Actions 在 push 和 pull request 时安装锁定依赖并执行相同检查。
