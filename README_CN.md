<div align="center">

# junior-mem

**Claude Code 的持久化知识管理插件 — 观察、沉淀、检索。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)]()
[![Built for Claude Code](https://img.shields.io/badge/built%20for-Claude%20Code-orange.svg)](https://docs.anthropic.com/en/docs/claude-code)

🇨🇳 中文 · 🇺🇸 [English](README.md)

**快速开始** · **工作原理** · **MCP 工具** · **配置说明** · **架构总览** · **常见问题**

</div>

---

<table>
<tr>
<td>

### 🤔 为什么做 junior-mem？

我们都是 "junior" —— 我们的能力水平很难和 AI 放在同一标尺上衡量，而日常工作中大量内容也是模块化、重复性的。

当 Claude Code 内置的 memory 已经积累了不错的上下文时，外部记忆插件就显得 **过于庞大臃肿** —— 特别是在上下文窗口空间本就有限的情况下。

**junior-mem 取了一个折中：**

- 🤖 **机器可读** — 结构化的知识，Claude 可以搜索和检索
- 📓 **人类友好** — 同时也是个人的记录与学习日志
- 🪶 **轻量级** — 没有重型基础设施，只需 SQLite + FTS5
- 🎯 **人在回路** — 内置反馈与 RL 机制，知识质量由 *你* 来塑造，而非完全由机器决定

</td>
</tr>
</table>

---

## 快速开始

在 Claude Code 中执行两条命令即可安装：

```bash
/plugin marketplace add Vicar-c/junior-mem
/plugin install junior-mem
```

然后初始化：

```bash
/junior-mem:init
```

搞定。junior-mem 会自动：
- 🪝 通过 **Stop hook** 在每次会话结束后捕获观察记录
- 🧠 注册一个提供 5 个知识工具的 **MCP server**
- ⏰ 设置 **每日 cron 定时任务** 来沉淀新的观察

无需手动管理知识 —— 像往常一样工作，让 junior-mem 自己学习什么是有价值的。

---

## 核心特性

- 🧠 **自动知识捕获** — Stop hook 在每次会话后自动提取观察记录，零配置
- 🔄 **5 阶段沉淀管线** — Scanner → Challenger → Auditor → Validator → Executor，全流程由 LLM 驱动
- 🔍 **FTS5 + SQLite 存储** — 基于 BM25 排序的全文搜索，无需外部数据库
- 🛠️ **5 个 MCP 工具** — 在 Claude Code 中直接搜索、检索、写入和管理知识
- 💬 **反馈闭环** — 通过 Web UI 对沉淀结果评分，校准未来的提取偏好
- 📝 **Markdown 导出** — 从 SQLite 自动生成人类可读的知识文件
- 🪶 **轻量设计** — 极小占用，面向不需要重型记忆方案的开发者

---

## 工作原理

junior-mem 遵循一个 **5 阶段知识生命周期**：

```
┌──────────────┐     ┌──────────┐     ┌─────────┐     ┌─────────────┐     ┌──────────┐
│ Conversation │────►│ Observe  │────►│ Stage   │────►│ Consolidate │────►│ Retrieve │
│   (对话)     │     │ (hook)   │     │ (jsonl) │     │  (每夜沉淀)  │     │  (MCP)   │
└──────────────┘     └──────────┘     └─────────┘     └─────────────┘     └──────────┘
```

### 1. 观察（自动）

Claude Code 的 Stop hook 在每次会话结束后，从对话记录中提取观察。观察以 JSONL 文件暂存于 `~/.claude/knowledge/staging/`。

### 2. 沉淀（每夜凌晨 3 点）

一个 5 阶段的 LLM 管线每日运行，处理暂存的观察：

| 阶段 | 角色 | 职责 |
|:----:|:----:|:----:|
| 🔍 **Scanner** | 分析师 | 分析暂存观察，提议创建/更新/废弃操作 |
| ⚔️ **Challenger** | 质检员 | 审查提议质量，检测重复和矛盾 |
| ⚖️ **Auditor** | 仲裁者 | 综合提议和质疑，解决冲突 |
| 🛡️ **Validator** | 守卫 | 检查副作用，执行预算约束 |
| ✅ **Executor** | 执行者 | 将批准的操作写入 SQLite，导出 Markdown |

### 3. 检索（按需）

MCP server 提供工具，Claude Code 可在任意对话中调用，查找和使用已存储的知识。

### 4. 反馈闭环（可选）

运行 `/junior-mem:review` 打开 Web UI，对沉淀结果进行评分：

| 评分 | 效果 |
|:----:|:----:|
| 👍 **好** | 提升相似内容的提取优先级 |
| 😐 **一般** | 无变化 |
| 👎 **差** | 降低相似内容的提取优先级 |

你的反馈会校准未来的沉淀决策 —— junior-mem 会学习你真正看重哪类知识。

---

## MCP 工具

初始化后，以下工具会自动在 Claude Code 中可用：

| 工具 | 说明 | 示例 |
|:----:|:----:|:----:|
| `knowledge_search` | 基于 BM25 排序的全文搜索 | 搜索 "HTTP 超时模式" |
| `knowledge_get` | 按 ID 获取完整知识条目 | 获取条目 `k20260421-001` |
| `knowledge_relevant` | 查找与任务相关的知识 | "我要加缓存失效逻辑" |
| `knowledge_write` | 创建、更新或废弃条目 | 手动添加一条编码规范 |
| `knowledge_stats` | 查看知识库统计信息 | 条目数、存储用量、上次沉淀时间 |

---

## 配置

配置存储在 `~/.claude/knowledge/config.json`，在 `/junior-mem:init` 期间设置：

| 配置项 | 默认值 | 说明 |
|:------:|:------:|:----:|
| `model_cheap` | `claude-haiku-4-5-20251001` | 用于提取和分类的模型 |
| `model_strong` | `claude-opus-4-7` | 用于沉淀和质量审查的模型 |
| `soft_limit` | `200` | 活跃条目目标上限（触发裁剪） |
| `consolidation_time` | `0 3 * * *` | 每夜沉淀的 cron 时间 |

---

## 架构

```
~/.claude/knowledge/
├── knowledge.db          # SQLite + FTS5（主存储）
├── active/               # Markdown 导出（人类可读）
├── staging/              # 原始观察 JSONL 文件
├── consolidation/        # 每日报告和操作日志
│   └── YYYY-MM-DD/
│       ├── report.md     # 人类可读的沉淀报告
│       └── ops.jsonl     # 操作日志
└── config.json           # 用户配置

junior-mem/
├── commands/             # 斜杠命令
│   ├── init.md           #   /junior-mem:init
│   ├── review.md         #   /junior-mem:review
│   └── uninstall.md      #   /junior-mem:uninstall
├── scripts/
│   ├── knowledge-mcp.cjs # MCP stdio 服务（SQLite + FTS5）
│   ├── observe.sh        # Stop hook：提取观察
│   ├── observe.jq        # JQ 过滤器，解析对话记录
│   ├── consolidate.sh    # 5 阶段沉淀管线
│   ├── report-server.cjs # 反馈评审 Web UI
│   ├── init.sh           # 安装向导
│   ├── uninstall.sh      # 完整卸载
│   └── test.sh           # 手动测试工具
├── .claude-plugin/plugin.json
├── .claude-hooks/hooks.json
└── .mcp.json
```

---

## 系统要求

| 要求 | 版本 | 备注 |
|:----:|:----:|:----:|
| **Claude Code** | 最新版 | 需支持插件功能 |
| **Node.js** | >= 18 | 用于 MCP server 和脚本 |
| **SQLite** | 含 FTS5 | 通过 better-sqlite3 内置 |
| **jq** | 任意版本 | 用于对话记录解析 |

---

## 常见问题

<details>
<summary><strong>MCP 工具没有出现</strong></summary>

- 运行 `/junior-mem:init` 注册 MCP server
- 初始化后重启 Claude Code
- 检查插件目录下是否存在 `.mcp.json`

</details>

<details>
<summary><strong>沉淀任务没有运行</strong></summary>

- 检查 cron：`crontab -l | grep consolidate`
- 手动运行：`KNOWLEDGE_DIR=~/.claude/knowledge bash scripts/consolidate.sh`
- 查看日志：`~/.claude/knowledge/consolidation/`

</details>

<details>
<summary><strong>/junior-mem:review 端口冲突</strong></summary>

- 使用其他端口：手动启动时加 `--port 19877`
- 结束占用进程：`lsof -i :19876` 然后 `kill <PID>`

</details>

<details>
<summary><strong>想从头开始</strong></summary>

运行 `/junior-mem:uninstall` 删除所有数据、cron 任务和插件本身。

</details>

---

## 手动命令

```bash
# 查看状态
KNOWLEDGE_DIR=~/.claude/knowledge bash scripts/test.sh status

# 立即执行沉淀
KNOWLEDGE_DIR=~/.claude/knowledge bash scripts/consolidate.sh

# 填充测试数据
KNOWLEDGE_DIR=~/.claude/knowledge bash scripts/test.sh seed
```

---

## 贡献

欢迎贡献！请：

1. Fork 本仓库
2. 创建功能分支
3. 进行修改
4. 提交 Pull Request

---

## 许可证

本项目基于 **MIT License** 授权。详见 [LICENSE](LICENSE) 文件。

---

<div align="center">

**Built for Claude Code** · **Powered by SQLite + FTS5** · **Made with Bash & JavaScript**

</div>
