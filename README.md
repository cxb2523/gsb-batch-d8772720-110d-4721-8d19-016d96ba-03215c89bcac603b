<p align="center">
  <a href="https://www.bright.cn/">
    <img src="https://mintlify.s3.us-west-1.amazonaws.com/brightdata/logo/light.svg" width="300" alt="Bright Data 标志">
  </a>
</p>

<div align="center">
  <img src="https://img.shields.io/badge/python-3.10+-blue"/>
  <img src="https://img.shields.io/badge/License-MIT-blue"/>
</div>

---

# 🚀 GEO AI 智能体团队

GEO 智能体团队使用 [CrewAI](https://crewai.com) 自动执行 AI 驱动的网页内容审核。输入一个 URL，系统即可访问网页、提取标题、使用[搭载 Google 搜索工具的 Gemini](https://ai.google.dev/gemini-api/docs/google-search) 生成并总结相关查询、通过 [Bright Data 搜索引擎 API](https://www.bright.cn/products/serp-api) 获取 Google AI 概览、比较结果，并在 Markdown 文件中输出可执行的页面级优化建议。

<img src="https://github.com/bright-cn/geo-ai-agent/blob/main/GEO%20diagram.png"/>

---

## 🤖 了解你的智能体团队

`ai-content-optimization-agent` 团队由六个 AI 智能体组成，每个智能体都有独特的角色、目标和工具。这些智能体协同完成 `config/tasks.yaml` 中定义的一系列任务，利用各自的综合能力实现复杂目标。`config/agents.yaml` 文件描述了团队中每个智能体的功能和配置。

## 🛠️ 安装

确保你的系统已安装 **Python >=3.10 <3.14**。

本项目使用 [`uv`](https://docs.astral.sh/uv/) 管理依赖项和软件包。如果尚未安装，请先安装 `uv`：

```bash
pip install uv
```

接下来，进入你的项目目录并安装项目依赖项：

```bash
cd geo-ai-agent
uv sync
```

---

## 🔑 环境配置

本项目需要四个环境变量才能运行：
- **`GEMINI_API_KEY`**：你的 Gemini API 密钥。
- **`MODEL`**：用于驱动智能体团队的 Gemini 模型名称（例如 `gemini/gemini-2.5-flash`）。
- **`BRIGHT_DATA_API_KEY`**：你的 [Bright Data API 密钥](https://docs.brightdata.com/api-reference/authentication)。
- **`BRIGHT_DATA_ZONE`**：你想连接的 [Bright Data 控制面板中的网络解锁器区域](https://docs.brightdata.com/scraping-automation/web-unlocker/quickstart)名称。

直接在终端中定义这些变量，或将它们放入项目根目录下的 `.env` 文件中：
```
geo-ai-agent/
├── ...
├── .env # <---
└── src/
    └── ai_content_optimization_agent/
        └── ...
```
按以下方式填写 `.env` 文件：
```
GEMINI_API_KEY="<YOUR_GEMINI_API_KEY>"
MODEL="<CHOSEN_GEMINI_MODEL>"
BRIGHT_DATA_API_KEY="<BRIGHT_DATA_API_KEY>"
BRIGHT_DATA_ZONE="<YOUR_BRIGHT_DATA_ZONE>"
```

## ▶️ 运行项目
激活由 `uv sync` 命令创建的 `.venv`：
```bash
 source .venv/bin/activate
```
或者，在 Windows 上：
```powershell
.venv/Scripts/activate
```

激活虚拟环境后，在项目根目录运行以下命令，启动你的 AI 智能体团队：

```bash
crewai run
```

此命令会初始化 `ai-content-optimization-agent` 团队，根据 CrewAI 配置文件中的定义组建智能体并为其分配任务。

☑️ 此应用程序将生成一个 `output/report.md` 文件，以及其他包含智能体中间数据和结果的 `ouput/*.md` 文件。

---

### ⚙️ 自定义
- 🔧 更新 `MODEL` 环境变量，以更改此智能体团队使用的 Gemini 模型。
- 🧑💻 编辑 `src/ai_content_optimization_agent/config/agents.yaml` 以修改智能体定义。 
- 📋 编辑 `src/ai_content_optimization_agent/config/tasks.yaml` 以修改分配给智能体的任务定义。 
- 🛠️ 更新 `src/ai_content_optimization_agent/crew.py` 以集成其他 AI 模型，或添加你自己的逻辑和工具。
- ⚡ 编辑 `src/ai_content_optimization_agent/main.py`，为你的智能体和任务添加自定义输入。

---

## 💬 支持

如需有关 `ai-content-optimization-agent` 团队或 CrewAI 的支持、咨询或反馈：

- ☀️ 查看 Bright Data 的[搜索引擎 API 文档](https://docs.brightdata.com/scraping-automation/serp-api/introduction)
- 📖 查看 CrewAI 的[文档](https://docs.crewai.com)
- 🐙 通过 [GitHub 仓库](https://github.com/joaomdmoura/crewai)联系 CrewAI
- 💬 [加入 Discord](https://discord.com/invite/X4JWnZnxPb)
- 💡 [与 CrewAI 文档对话](https://chatg.pt/DWjSBZn)

---

✨ 让我们借助 Bright Data 和 CrewAI 的强大能力与简洁体验，共同创造奇迹。
