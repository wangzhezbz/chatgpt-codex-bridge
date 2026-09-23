# Contributing to chatgpt_codex_bridge

感谢你帮助改进 chatgpt_codex_bridge。

## 开发环境

- Node.js 20+
- Chrome 或 Edge Chromium
- Codex 桌面版或 CLI
- 可用的 ChatGPT 网页会话（真实网页验收时需要）

```powershell
npm install
npm test
npm start
```

## 提交原则

1. 保持项目、GPT 会话和 Codex 线程作用域隔离。
2. 不要以“方便”为理由绕过版本、所有权或稳定消息标识检查。
3. 文件任务只有在捕获到真实产物后才能成功。
4. 恢复动作必须区分重新发送、重新收取和补收缺失附件。
5. 不要提交 Cookie、Token、真实聊天记录、本机路径或用户项目文件。

## Pull Request

- 说明问题、根因和行为变化。
- 为修复添加先失败、后通过的回归测试。
- 运行完整 `npm test`。
- 涉及扩展协议时，同步更新后端预期版本和扩展 manifest。
- 涉及 ChatGPT 页面选择器时，说明网页语言、浏览器版本和真实验收结果。

## 报告兼容问题

请提供 chatgpt_codex_bridge 版本、浏览器版本、ChatGPT 页面语言、Bridge 可见错误和任务类型。请先删除账号、项目和附件中的敏感内容。
