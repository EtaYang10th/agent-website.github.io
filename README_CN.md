# ETA — Edge Thin Agent

纯浏览器端 AI Agent 客户端 — 无需安装任何东西，不需要后端、Docker、Python。打开 HTML 文件即可使用。

## 功能特性

- **零安装** — 纯前端应用，完全在浏览器中运行。不需要服务器、Docker、Python、Node.js。用任意现代浏览器打开 `Edge_Thin_Agent.html` 即可。
- **多模型切换** — 随时切换模型（Claude、GPT 等）。支持从 API 提供商获取可用模型列表，也可手动添加自定义模型。
- **Agent 联网搜索** — 内置联网 Agent：支持 Google（SerpAPI）、Brave 搜索、arXiv、Semantic Scholar、GitHub 搜索和网页抓取。每次查询最多 20 轮自动搜索。
- **对话树** — 支持对话分支、编辑重发、回退。可在不同分支间自由切换。
- **知识库缓存区** — 右侧面板缓存搜索结果、上传文件和抓取的网页。Agent 按需读取。
- **文件上传** — 支持图片（内联显示）、PDF、DOCX、PPTX、XLSX 及各种文本/代码文件。
- **Markdown + 数学公式** — 完整的 Markdown 渲染，代码高亮（highlight.js），LaTeX 数学公式（KaTeX）。
- **思维链模型** — 支持 `<think>` 标签解析，思考过程可折叠显示。
- **上下文压缩** — 对话超过 12 万字符时，自动调用 LLM 总结压缩，保持在上下文限制内。
- **明暗主题** — 在设置中切换深色/浅色界面。
- **中英双语 UI** — 在设置中切换中文/英文界面。
- **导出** — 单对话导出为 Markdown，全部对话导出为 JSON。
- **余额查询** — 查询 API 提供商的剩余额度。
- **调试面板** — 实时显示 Agent 循环日志，拦截 console 输出。
- **数据隐私** — 所有数据存储在浏览器本地（localStorage）。除了你配置的 API 端点外，不会向任何地方发送数据。

## 快速开始

1. 克隆或下载本仓库。
2. 用浏览器打开 `Edge_Thin_Agent.html`。
3. 首次使用？会弹出配置引导 — 填入 Base URL 和 API Key 即可。
4. 开始聊天！

> **注意：** 配置保存在浏览器 localStorage 中。如果把文件夹移到新位置，会重新弹出配置引导让你填写密钥。也可以编辑 `js/env.js` 预填密钥（该文件已加入 .gitignore，不会被提交）。

## 所需 API 密钥

详见 `js/env.js.example`，其中列出了所有需要的密钥及申请网址。

## 许可证

MIT
