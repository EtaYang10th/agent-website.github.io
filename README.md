# ETA — Edge Thin Agent

A pure browser-based AI Agent client — no installation, no backend, no Docker, no Python required. Just open the HTML file and start chatting.

## Features

- **Zero Setup** — Pure frontend, runs entirely in the browser. No server, no Docker, no Python, no Node.js. Just open `index.html` in any modern browser.
- **Multi-Model Support** — Switch between models (Claude, GPT, etc.) on the fly. Fetch available models from your API provider or add custom ones.
- **Agent Web Search** — Built-in agent with internet access: Google (SerpAPI), Brave Search, arXiv, Semantic Scholar, GitHub search, and webpage scraping. Up to 20 rounds of autonomous search per query.
- **Conversation Tree** — Branch, edit, and rewind conversations. Navigate between branches with ease.
- **Knowledge Buffer** — Right-side panel for caching search results, uploaded files, and fetched web pages. The agent reads from it on demand.
- **File Upload** — Supports images (inline), PDF, DOCX, PPTX, XLSX, and various text/code files.
- **Markdown + Math** — Full Markdown rendering with syntax highlighting (highlight.js) and LaTeX math (KaTeX).
- **Thinking Models** — Supports `<think>` tag parsing for chain-of-thought models, with collapsible thinking blocks.
- **Context Compression** — Automatically summarizes long conversations (>120k chars) via LLM to stay within context limits.
- **Dark / Light Theme** — Toggle between dark and light UI in Settings.
- **Bilingual UI** — Switch between Chinese and English interface in Settings.
- **Export** — Export single conversations as Markdown or all conversations as JSON.
- **Balance Check** — Query your API provider's remaining balance.
- **Debug Panel** — Real-time agent loop logs with console interception.
- **Data Privacy** — All data stored locally in your browser (localStorage). Nothing is sent anywhere except your configured API endpoint.

## Quick Start

1. Clone or download this repository.
2. Open `index.html` in your browser.
3. First time? A setup dialog will appear — enter your Base URL and API Key.
4. Start chatting!

> **Note:** Config is saved to browser localStorage. If you move the folder to a new location, the setup dialog will appear again for you to re-enter your keys. Optionally, fill `js/env.js` to auto-populate keys (this file is git-ignored).

## Required API Keys

See `js/env.js.example` for the full list of keys and where to apply for them.

## License

MIT
