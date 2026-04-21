# Auto-Digest 知识管理系统 — 完整设计方案

> 创建: 2026-04-21 | 状态: Phase 0+1 已实现，未接入

## 一、设计动机

现有 memory 系统是纯手动策展（用户显式要求才写入），导致大量对话信息未沉淀。
同时，主流记忆方案（claude-mem / MemPalace / mem0）本质是 logging + retrieval，
缺少真正的生命周期管理（退出、更新、强化）。
本方案在 hooks 捕获 + 夜间 agent team 整合的基础上，实现类生物记忆的完整生命周期。

参考项目分析:
- **claude-mem** (https://github.com/thedotmack/claude-mem): 6 个生命周期 hook + Worker HTTP 服务 + SQLite + Chroma 向量库。架构: SessionStart(依赖检查→worker启动→上下文注入) → UserPromptSubmit(session初始化) → PostToolUse(观察捕获) → Stop(AI压缩) → SessionEnd(清理)。3层检索: search(压缩索引) → timeline(时间线上下文) → get_observations(完整详情)。
- **MemPalace**: 4 层记忆栈 + hybrid BM25+vector search + closet index layer + AAAK dialect 压缩

## 二、核心设计原则

1. **类生物记忆**: 白天经历 → staging 暂存 → 夜间整合 → 长期记忆
2. **生命周期管理**: 创建 → 活跃 → 强化/更新/降级 → 归档 → 删除
3. **强化而非重复**: 重复出现的知识提升重要性，不重复记录
4. **退出机制**: TTL 过期未引用的知识自动降级归档
5. **多 Agent 制衡**: Scanner 提议 → Challenger 挑战 → Auditor 裁决 → Validator 校验 → 执行
6. **渐进合并**: knowledge/ 先独立运行，稳定后再打通 memory/
7. **零外部依赖**: 纯 Bash + jq + Markdown，无需 Node.js/SQLite/Chroma

## 三、与现有 memory/ 的关系

```
memory/    = 手动策展的高可信知识，权重最高，当前不做任何自动变更
knowledge/ = 自动管理的知识，有完整生命周期管理
冲突时 memory/ 优先
Phase 2+ 可将 knowledge/ 高价值条目提升到 memory/
```

## 四、目录结构

```
~/.claude/knowledge/
├── knowledge.db                       # SQLite 主存储（+ FTS5 全文索引）
├── knowledge.db-wal                   # WAL 日志
├── active/                            # 从 SQLite 自动导出的 Markdown（人类可读）
│   ├── k20260421-001.md
│   └── ...
├── archive/                           # 已废弃知识（status=deprecated，仍在 SQLite 中）
├── staging/                           # hooks 捕获的原始观察（JSONL）
│   ├── <session_id>.jsonl
│   └── processed/                     # 已整合完的 staging 文件
├── consolidation/                     # 每日整合记录
│   ├── 2026-04-21/
│   │   ├── state.json                 # 各 stage 完成状态（断点续跑）
│   │   ├── 01-proposals.json
│   │   ├── 02-challenges.json
│   │   ├── 03-decisions.json
│   │   ├── 04-approved.json
│   │   └── report.md
│   └── latest → 2026-04-22/
├── INDEX.md                           # 知识索引（自动生成）
├── config.json                        # 模型/软上限/cron 配置
├── state.json                         # 全局状态
└── access_log.jsonl                   # 访问日志
```

## 五、每条知识的元数据格式

```yaml
---
id: "k20260421-001"
type: knowledge           # knowledge | feedback | project | reference | env_config
status: active            # active | reinforced | updated | deprecated | merged
importance: 3             # 1-5, 重复出现 +1, 上限 5
created: "2026-04-21"
last_accessed: "2026-04-28"
access_count: 7
source: auto              # auto | explicit | consolidation
supersedes: null          # 被本条替代的旧知识 ID
superseded_by: null       # 替代本条的新知识 ID
ttl_days: 90              # 超过此天数未引用则 deprecated
ttl_deadline: "2026-07-21" # 绝对过期日期
tags: ["cpp", "http", "coding-standards"]
---

正文内容...
```

## 六、已确认的设计决策

### 6.1 捕获机制

- **粒度**: 每 Turn 捕获（每个 user-Claude 交换一条记录）
- **触发方式**: Stop hook 统一提取（不使用 UserPromptSubmit + PostToolUse 组合）
- **数据来源**: 读取对话 transcript JSONL (~/.claude/projects/-root/<session_id>.jsonl), 用 jq 提取
- **文件格式**: JSONL, 每行一条 turn 观察
- **存储位置**: knowledge/staging/YYYY-MM-DD_HHMMSS.jsonl

staging JSONL 格式:
```jsonl
{"turn":1,"role":"user","text":"帮我分析 UserProfileServer","ts":"2026-04-21T14:30:05","session":"abc123"}
{"turn":1,"role":"assistant_summary","tools":["Read","Edit"],"files":["UserProfileServer.cpp"],"key_actions":["修改了 getUserProfile 方法"],"ts":"2026-04-21T14:32:10"}
{"turn":2,"role":"user","text":"编译一下","ts":"2026-04-21T14:35:12"}
{"turn":2,"role":"assistant_summary","tools":["Bash"],"commands":["make -j20"],"key_actions":["编译通过"],"ts":"2026-04-21T14:36:45"}
```

### 6.2 Importance 初始值

- 默认新建: importance = 1, source = "auto"
- 用户显式"记住/记下来" 但 memory/ 未收录: importance = 3, source = "explicit"
- 用户显式"记住" 且 memory/ 已收录: **不重复记录到 knowledge/**
- 判断时机: consolidation Scanner 阶段

### 6.3 TTL 分类型策略

| 类型 | 默认 TTL | 理由 |
|------|----------|------|
| feedback | 180 天 | 用户纠正记录, 衰减慢 |
| knowledge | 90 天 | 通用知识 |
| project | 60 天 | 项目动态信息, 变化快 |
| reference | 365 天 | 外部系统引用, 稳定 |
| env_config | 365 天 | 环境配置, 极少变但重要 |

TTL 续命规则: 每被引用一次 `ttl_deadline += ttl_days * 0.3`
(如 feedback 被引用一次延长 54 天)

### 6.4 生命周期流转

```
staging 捕获 → consolidation 整理
    ↓
active (importance=1, TTL 生效)
    ↓
    ├── 重复引用 → reinforced (importance++)
    ├── 新认知覆盖 → updated (supersedes 旧条目)
    ├── 长期未引用 + TTL 过期 → deprecated → archive
    └── archive 超过 30 天 → 删除
```

### 6.5 Consolidation 失败处理

- 从失败的 stage 接着跑(不重头开始)
- 通过 `consolidation/<date>/state.json` 跟踪各 stage 完成状态
- staging 数据不删除, 下次 consolidation 重试
- 连续 3 天失败时需发送告警

### 6.6 每日报告

每天一个文件夹 `consolidation/YYYY-MM-DD/`, 包含:
- `state.json`: 各 stage 完成状态
- `01-proposals.json` ~ `04-approved.json`: 各 stage 中间产物
- `report.md`: 详细报告, 必须包含:
  - 概要统计（staging 输入/操作数）
  - 变更明细表（创建/强化/更新/降级/拒绝, 各含原因）
  - 争议记录
  - 统计（总条目/平均 importance/预估 tokens）

report.md 示例:
```markdown
# 知识库整合报告 2026-04-21

## 概要
- staging 输入: 12 条观察
- 现有 active: 34 条知识
- 本次操作: +2 创建 / +1 强化 / +1 更新 / -1 降级 / 2 拒绝

## 变更明细

### 创建
| ID | 标题 | 类型 | 重要性 | 来源 |
|----|------|------|--------|------|
| k20260421-001 | ConfigMgr 双缓冲适用于高频热更新 | knowledge | 1 | auto |
| k20260421-002 | DCache 接入的双缓冲模式 | knowledge | 1 | auto |

### 强化
| ID | 标题 | 旧权重 | 新权重 | 原因 |
|----|------|--------|--------|------|
| feedback-cache-worker | ConfigMgr 模式... | 3 | 4 | 3天内第2次出现 |

### 更新
| ID | 字段 | 旧值 | 新值 | 原因 |
|----|------|------|------|------|
| mysql-env-linkmic | ttl_days | 90 | 180 | Auditor 裁定环境配置应更长 |

### 降级
| ID | 标题 | 原因 | 归档至 |
|----|------|------|--------|
| k20260115-003 | 旧版 leda 建表规范 | 超过 90 天未引用, 已被新规范替代 | archive/ |

### 被拒绝的提案
| 提案 | 操作 | 拒绝者 | 原因 |
|------|------|--------|------|
| P003 | update cpp-http-standards | Challenger | HTTP 超时 3s→5s 仅一次观察, 证据不足 |
| P005 | deprecate mysql-env | Auditor | 环境配置 TTL 应更长 |

## 争议记录
无争议（所有 Challenger 意见均被 Auditor 采纳）

## 统计
- 总 active 条目: 35 (+2 创建, -1 降级, 净增 +1)
- 总 archive 条目: 3
- 平均 importance: 2.4
- 预估上下文 tokens: ~2,300
```

### 6.7 与 memory/ 的整合策略 — 渐进合并

- **Phase 1（2-4 周）**: knowledge/ 独立运行, memory/ 不动
- **Phase 2（验证后）**: consolidation 可将 importance>=4 提升到 memory/（不自动删除）
- **Phase 3（稳定后）**: 统一生命周期管理

### 6.8 整合模型

- 使用 glm-4.7（比 glm-5.1 便宜）
- 脚本中通过环境变量 `ANTHROPIC_MODEL=glm-4.7` 指定

## 七、Agent Team 夜间整合架构

### 7.1 五阶段流水线

```
Stage 1: Scanner（提议者）
  输入: staging/*.jsonl + active/*.md
  输出: consolidation/<date>/01-proposals.json
  职责: 对每条 staging 观察提出操作建议（create/reinforce/update/deprecate）
  工具: Read, Glob, Grep

Stage 2: Challenger（挑战者）
  输入: 01-proposals.json + active/*.md
  输出: consolidation/<date>/02-challenges.json
  职责: 逐条审查提案, 输出反对意见
  挑战维度:
    - 不应合并（场景不同）
    - 不应升格（证据不足）
    - 不应降级（该类型 TTL 应更长）
    - 不应更新（单次观察不足以覆盖正式规范）
  工具: Read, Glob, Grep

Stage 3: Auditor（审核员）
  输入: 01-proposals.json + 02-challenges.json + active/*.md
  输出: consolidation/<date>/03-decisions.json
  职责:
    - 检查 proposals 之间是否有内部矛盾
    - 综合 proposals + challenges 做出裁决
    - 裁决结果: approved / modified / rejected
  工具: Read, Glob, Grep

Stage 4: Validator（校验者）
  输入: 03-decisions.json + active/*.md
  输出: consolidation/<date>/04-approved.json
  职责:
    - 模拟执行 decisions, 检查副作用
    - 创建: 是否与已有条目冲突
    - 删除: 是否有其他条目引用被删条目
    - 更新: 新内容是否自洽
    - 估算整合后总上下文 tokens 是否在预算内
  工具: Read, Glob, Grep

Stage 5: Main Agent（主控执行）
  输入: 04-approved.json
  输出: 实际文件变更 + report.md
  职责: 纯执行, 不做判断, 严格按 approved.json 操作
  操作:
    - 创建 active/ 新条目
    - 更新 active/ 现有条目（importance/tags/status/内容）
    - 降级: active/ → archive/
    - 清理: archive 超 30 天删除
    - 移动 staging/ → staging/processed/
    - 更新 INDEX.md + state.json
    - 生成 report.md
  工具: Read, Write, Edit, Glob, Grep, Bash
```

### 7.2 Agent 间数据流

```
staging/*.jsonl + active/*.md
        │
        ▼
  ┌──────────┐  proposals.json   ┌──────────────┐  challenges.json
  │ Scanner  │ ───────────────── │  Challenger   │ ─────────────────
  └──────────┘                   └──────────────┘
                                        │
                                        ▼
                                 ┌──────────────┐  decisions.json   ┌───────────┐
                                 │   Auditor    │ ───────────────── │ Validator │
                                 └──────────────┘                   └───────────┘
                                                                        │
                                                                        ▼ approved.json
                                                                 ┌──────────────┐
                                                                 │  Main Agent  │
                                                                 │  执行+报告    │
                                                                 └──────────────┘
```

### 7.3 执行脚本概要

```bash
#!/bin/bash
# ~/.claude/scripts/consolidate.sh
# cron: 0 3 * * * /root/.claude/scripts/consolidate.sh >> /root/.claude/knowledge/consolidation.log 2>&1

KNOWLEDGE="$HOME/.claude/knowledge"
CONSOLIDATION="$KNOWLEDGE/consolidation"
TODAY=$(date +%Y-%m-%d)
MODEL="glm-4.7"

mkdir -p "$CONSOLIDATION/$TODAY"

# 断点续跑: 检查 state.json, 跳过已完成的 stage
# ... (读取 state.json 判断当前 stage)

# Stage 1: Scanner
claude -p "你是知识库扫描器。[详细 prompt]" \
  --model "$MODEL" \
  --allowedTools "Read,Glob,Grep" \
  > "$CONSOLIDATION/$TODAY/01-proposals.json"

# Stage 2: Challenger
claude -p "你是知识库挑战者。[详细 prompt]" \
  --model "$MODEL" \
  --allowedTools "Read,Glob,Grep" \
  > "$CONSOLIDATION/$TODAY/02-challenges.json"

# Stage 3: Auditor
claude -p "你是知识库审核员。[详细 prompt]" \
  --model "$MODEL" \
  --allowedTools "Read,Glob,Grep" \
  > "$CONSOLIDATION/$TODAY/03-decisions.json"

# Stage 4: Validator
claude -p "你是知识库校验者。[详细 prompt]" \
  --model "$MODEL" \
  --allowedTools "Read,Glob,Grep" \
  > "$CONSOLIDATION/$TODAY/04-approved.json"

# Stage 5: Execute
claude -p "你是知识库执行者。[详细 prompt]" \
  --model "$MODEL" \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash" \
  > "$CONSOLIDATION/$TODAY/report.md"

# 清理: 更新 latest 软链接
ln -sfn "$CONSOLIDATION/$TODAY" "$CONSOLIDATION/latest"
```

### 7.4 state.json 格式（断点续跑）

```json
{
  "date": "2026-04-21",
  "stages": {
    "scanner": "completed",
    "challenger": "completed",
    "auditor": "failed",
    "validator": "pending",
    "executor": "pending"
  },
  "started_at": "2026-04-21T03:00:05",
  "failed_at": "2026-04-21T03:07:23",
  "failed_stage": "auditor",
  "error": "model timeout after 120s"
}
```

### 7.5 Hooks 配置（写入 ~/.claude/settings.json）

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "bash ~/.claude/hooks/observe.sh",
        "timeout": 30
      }]
    }],
    "SessionStart": [{
      "matcher": "startup",
      "hooks": [{
        "type": "command",
        "command": "bash ~/.claude/hooks/recall.sh",
        "timeout": 10
      }]
    }]
  }
}
```

## 八、待定事项

所有待定项已决策，当前无未决事项：

1. ~~report 文件夹保留策略~~ → 永久保留，磁盘开销可忽略
2. ~~staging/processed/ 清理周期~~ → 不主动清理，由 consolidate.sh 的 `post_exec_cleanup()` 移入 processed/，累积过大时手动清理
3. ~~首次启动策略~~ → 从零开始（init.sh 创建空目录），不迁移 memory/
4. ~~相似度匹配实现~~ → Phase 1 用 tag + 关键词加权（knowledge-mcp.cjs 已实现），Phase 2 按需加向量索引
5. ~~SessionStart hook 注入的上下文格式~~ → 改为 MCP 按需检索（knowledge_relevant），不做自动注入
6. ~~连续失败告警~~ → `handle_failure()` 追踪 `consecutive_failures`，>=3 时 log WARNING，暂不做主动通知

## 九、实施清单

### Phase 0: 基础设施
- [x] 创建目录结构 (knowledge/, hooks/, scripts/) → `init.sh` 交互式创建
- [x] 编写 observe.sh (Stop hook) → `scripts/observe.sh` + `observe.jq`（jq 过滤器）
- [ ] 编写 recall.sh (SessionStart hook) — 未实现，MCP 检索替代
- [ ] 更新 settings.json 添加 hooks 配置 — 未接入，通过 `claude plugin add` 安装时自动生效
- [ ] 验证 hooks 触发和 staging 写入 — 需安装后验证

### Phase 1: 夜间整合
- [x] 编写 consolidate.sh (5 阶段流水线) → `scripts/consolidate.sh`（断点续跑、config.json 读取模型）
- [x] 为每个 stage 编写详细 prompt → 内嵌于 consolidate.sh 各 stage 函数
- [x] 配置 cron 定时任务 → `init.sh` Step 3 可选配置
- [x] 验证断点续跑机制 → `read_stage_state()` + `update_stage_state()`
- [ ] 验证每日 report 生成 — 需有 staging 数据后运行验证

### Phase 1.5: MCP 检索 + SQLite（计划外）
- [x] 编写 knowledge-mcp.cjs（MCP stdio 服务器）→ 5 个工具: search/get/relevant/write/stats
- [x] 引入 SQLite + FTS5 全文检索（better-sqlite3）
- [x] 搜索策略: FTS5 BM25（英文/混合词）+ LIKE（CJK 子串匹配）
- [x] knowledge_write 工具: create/update/reinforce/deprecate/delete + 自动 Markdown 导出
- [x] MCP 通过 `.mcp.json` 注册（`${CLAUDE_PLUGIN_ROOT}` 路径）
- [x] 测试工具 `scripts/test.sh` — status/seed/observe/mcp-*/consolidate
- [x] 软上限从 50 提高到 1000

### Phase 1.6: 安装/卸载（计划外）
- [x] 编写 init.sh（交互式初始化向导）→ 模型选择、目录配置、cron 配置、依赖检查
- [x] 编写 uninstall.sh（完整卸载）→ 知识数据/cron/plugin 注册全清理

### Phase 2: 优化与桥接（未开始）
- [ ] 评估 Phase 1 运行数据（准确率、成本）
- [ ] 实现 importance>=4 提升到 memory/
- [ ] 优化相似度匹配（可选加向量索引）
- [ ] 实现 CLAUDE.md 的 knowledge/ 引用指令

## 十、当前实现状态（2026-04-21 更新）

### 代码位置
所有代码在 `/root/junior-mem/` 目录下，作为 Claude Code plugin 打包：

```
junior-mem/
├── .claude-plugin/plugin.json     # 插件元数据
├── .mcp.json                      # MCP 注册（knowledge server）
├── .claude-hooks/hooks.json       # Stop hook 注册
├── package.json                   # Node.js 依赖 (better-sqlite3)
├── node_modules/                  # npm 依赖
└── scripts/
    ├── observe.sh                 # Stop hook: transcript → staging JSONL
    ├── observe.jq                 # jq 过滤器: 提取 turn 级观察
    ├── knowledge-mcp.cjs          # MCP stdio 服务器: SQLite + FTS5
    ├── consolidate.sh             # 5 阶段整合流水线
    ├── init.sh                    # 交互式初始化向导
    ├── test.sh                    # 测试工具集
    └── uninstall.sh               # 完整卸载脚本
```

### 接入方式
```bash
# 安装
claude plugin add /root/junior-mem

# 初始化（交互式，配置模型/目录/cron）
bash /root/junior-mem/scripts/init.sh

# 卸载
bash /root/junior-mem/scripts/uninstall.sh
```

### 设计偏差说明
1. **recall.sh 未实现**：SessionStart hook 用 MCP 按需检索替代，无需 shell 脚本注入
2. **staging 文件命名**：使用 `<session_id>.jsonl` 而非 `<timestamp>.jsonl`，更便于调试
3. **元数据简化**：frontmatter 去掉了 `supersedes/superseded_by/ttl_days/ttl_deadline`，简化 Phase 1 实现
4. **插件化打包**：原设计散落在 `~/.claude/` 下，实际实现为独立 plugin 目录，通过 `claude plugin add` 安装
5. **SQLite 主存储**：原设计用 Markdown 文件存储，实际改为 SQLite + FTS5 全文检索，Markdown 降为导出格式
6. **软上限 50 → 1000**：引入 SQLite 后检索精度大幅提升，软上限从 50 提高到 1000

### SQLite Schema
```sql
-- 主存储
CREATE TABLE knowledge (
  id TEXT PRIMARY KEY,
  title TEXT, type TEXT, importance INTEGER,
  body TEXT, tags TEXT,        -- JSON array string
  source TEXT, status TEXT,
  created TEXT, last_accessed TEXT,
  access_count INTEGER
);

-- FTS5 全文检索（自动同步）
CREATE VIRTUAL TABLE fts USING fts5(
  title, body, tags,
  content='knowledge', content_rowid='rowid'
);

-- 搜索策略: FTS5 BM25 (英文/混合词) + LIKE (CJK 子串匹配)
```

### MCP 工具清单（v0.2.0）
| 工具 | 说明 |
|------|------|
| `knowledge_search` | FTS5 全文检索，支持 tag/type/importance 过滤 |
| `knowledge_get` | 按 ID 获取完整内容，自动更新 access_count |
| `knowledge_relevant` | 任务相关性检索（importance >= 2） |
| `knowledge_write` | 写入/修改/归档/删除，触发 Markdown 导出 |
| `knowledge_stats` | 统计：总数、按类型、平均 importance、DB 大小 |
