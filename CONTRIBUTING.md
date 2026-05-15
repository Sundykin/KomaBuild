# 贡献指南 | Contributing

感谢你对 Koma Studio 的关注！我们欢迎任何形式的贡献：bug 报告、功能建议、文档改进、代码 PR。

## 行为准则

请保持友善、专业、建设性。任何形式的骚扰、人身攻击或歧视都不会被接受。

## 开发环境

- Node.js >= 18
- npm >= 9
- macOS / Windows / Linux 桌面环境（用于 Electron 调试）

```bash
git clone https://github.com/M-JYuan/Koma.git
cd Koma
npm run install:all
npm run dev
```

## 提交流程

1. **Fork 仓库**，从 `main` 切出特性分支：`feat/xxx`、`fix/xxx`、`docs/xxx`
2. **保持小而聚焦的 commit**，每个 commit 只做一件事
3. **commit message 推荐使用 Conventional Commits**：
   - `feat(scope): 简述新功能`
   - `fix(scope): 修复内容`
   - `docs(scope): 文档变更`
   - `refactor(scope): 重构`
   - `test(scope): 测试`
4. **本地自检**：
   ```bash
   cd frontend && npm test
   npm run verify:all   # 在仓库根目录
   ```
5. **发起 PR**：填写 PR 模板，描述动机、变更内容、测试方式

## 代码规范

- TypeScript 优先；新代码不要引入 `any`
- 遵循现有目录结构（`frontend/src/components`、`store`、`services`、`providers` 等）
- UI 改动请尽量在 Electron 内验证（参见 `AGENTS.md`），不要只在普通浏览器里测
- 不引入未使用依赖；新增大型依赖请先在 issue 里讨论

## 报告 Bug / 提议功能

- Bug：使用 `Bug Report` issue 模板，提供复现步骤、期望/实际行为、运行环境
- 功能：使用 `Feature Request` issue 模板，描述场景和动机

## License

提交的贡献将以 GPL-3.0 协议授权（与本项目一致）。请确认你提交的代码原创、或来自兼容协议且已在 PR 中标注来源。
