# junior-mem 设计方案

> 创建: 2026-04-21 | 更新: 2026-04-22 | 状态: Phase 0-2 已实现

## 一、设计动机

现有 memory 系统是纯手动策展（用户显式要求才写入），导致大量对话信息未沉淀。
同时，主流记忆方案（claude-mem / MemPalace / mem0）本质是 logging + retrieval，
缺少真正的生命周期管理（退出、更新、强化）和用户反馈闭环。

junior-mem 在 hooks 捕获 + 夜间 agent team 整合的基础上，实现：
1. 类生物记忆的完整生命周期
2. Web 端用户反馈 → RL 校准的知识质量闭环
3. 轻量架构（SQLite + FTS5 + Bash + Node）

## 二、核心设计原则

1. **类生物记忆**: 白天经历 → staging 暂存 → 夜间整合 → 长期记忆
2. **生命周期管理**: 创建 → 活跃 → 强化/更新/降级 → 归档 → 删除
3. **强化而非重复**: 重复出现的知识提升重要性，不重复记录
4. **退出机制**: TTL 过期未引用的知识自动降级归档
5. **多 Agent 制衡**: Scanner 提议 → Challenger 挑战 → Auditor 裁决 → Validator 校验 → 执行
6. **人机闭环**: 用户通过 Web UI 对整合结果打分 → 反馈注入下次 Scanner prompt → RL 效果
7. **轻量优先**: SQLite + FTS5 主存储，Markdown 为导出格式，无外部向量库依赖
8. **渐进合并**: knowledge/ 先独立运行，稳定后再打通 memory/

## 三、系统架构

```
┌──────────────┐     ┌──────────┐     ┌─────────────┐     ┌──────────┐
│ Conversation │────►│ Observe  │────►│ Consolidate │────►│ Retrieve │
│              │     │ (hook)   │     │  (nightly)  │     │  (MCP)   │
└──────────────┘     └──────────┘     └──────┬──────┘     └──────────┘
                                              │
                                     ┌────────▼────────┐
                                     │  Report + Review │
                                     │  (Web UI)        │
                                     └────────┬─────────┘
                                              │ feedback
                                              ▼
                                     ┌──────────────────┐
                                     │ Next Consolidate  │
                                     │ (RL calibration)  │
                                     └──────────────────┘
```

## 四、目录结构

```
~/.claude/knowledge/
├── knowledge.db                       # SQLite 主存储（+ FTS5 全文索引）
├── active/                            # 从 SQLite 自动导出的 Markdown（人类可读）
├── archive/                           # 已废弃知识
├── staging/                           # hooks 捕获的原始观察（JSONL）
│   └── processed/                     # 已整合完的 staging 文件
├── consolidation/                     # 每日整合记录
│   └── YYYY-MM-DD/
│       ├── state.json                 # 各 stage 完成状态（断点续跑）
│       ├── 01-proposals.json ~ 04-approved.json
│       ├── 05-entries.json            # Executor 输出的实际 entries（含真实 knowledge ID）
│       └── report.md
├── config.json                        # 模型/软上限/cron 配置
└── state.json                         # 全局状态

junior-mem/                            # 插件目录
├── .claude-plugin/plugin.json
├── .claude-hooks/hooks.json
├── .mcp.json
├── commands/
│   ├── init.md                        # /junior-mem:init
│   ├── review.md                      # /junior-mem:review
│   └── uninstall.md                   # /junior-mem:uninstall
├── scripts/
│   ├── observe.sh + observe.jq        # Stop hook: transcript → staging JSONL
│   ├── knowledge-mcp.cjs             # MCP stdio 服务器: SQLite + FTS5
│   ├── consolidate.sh                 # 5 阶段整合流水线 + RL feedback 消费
│   ├── report-server.cjs             # Web UI: 报告展示 + feedback 提交
│   ├── init.sh / uninstall.sh / test.sh
├── package.json                       # better-sqlite3
└── auto-digest-design.md              # 本文档
```

## 五、数据模型

### 5.1 knowledge 表

```sql
CREATE TABLE knowledge (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'knowledge',      -- knowledge|feedback|project|reference|env_config
  importance INTEGER NOT NULL DEFAULT 1,        -- 1-5
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',              -- JSON array
  source TEXT NOT NULL DEFAULT 'auto',          -- auto|explicit|consolidation
  status TEXT NOT NULL DEFAULT 'active',        -- active|deprecated
  created TEXT NOT NULL DEFAULT '',
  last_accessed TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  -- Feedback / RL fields
  feedback_rating TEXT,                         -- good|normal|bad|NULL
  feedback_comment TEXT,
  feedback_at TEXT,
  feedback_consumed INTEGER NOT NULL DEFAULT 0  -- 0=未消费, 1=已被consolidate消费
);
```

### 5.2 consolidation_ops 表

记录每次整合的操作明细，供 report-server 展示和 feedback 关联。

```sql
CREATE TABLE consolidation_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,                   -- 实际写入的 knowledge ID（非 proposal_id）
  operation TEXT NOT NULL,                      -- create|reinforce|update|deprecate|reject
  title TEXT,
  body TEXT,                                    -- 完整知识内容
  reasoning TEXT,                               -- JSON: {scanner, challenger, auditor}
  source_observations TEXT,                     -- JSON: 来源的 staging turns
  importance_before INTEGER,
  importance_after INTEGER,
  tags TEXT,
  type TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 5.3 FTS5 虚拟表

```sql
CREATE VIRTUAL TABLE fts USING fts5(
  title, body, tags,
  content='knowledge', content_rowid='rowid'
);
-- 自动通过 trigger 与 knowledge 表同步
-- 搜索策略: FTS5 BM25 (英文/混合词) + LIKE (CJK 子串匹配)
```

### 5.4 Index

```sql
CREATE INDEX idx_knowledge_type ON knowledge(type);
CREATE INDEX idx_knowledge_importance ON knowledge(importance);
CREATE INDEX idx_knowledge_status ON knowledge(status);
CREATE INDEX idx_consol_ops_date ON consolidation_ops(date);
CREATE INDEX idx_feedback_unconsumed ON knowledge(feedback_rating)
  WHERE feedback_rating IS NOT NULL AND feedback_consumed = 0;
```

## 六、捕获机制

- **粒度**: 每 Turn 捕获（每个 user-Claude 交换一条记录）
- **触发方式**: Stop hook (`observe.sh`) 统一提取
- **数据来源**: 读取对话 transcript JSONL，用 jq (`observe.jq`) 提取
- **文件格式**: JSONL, 每行一条 turn 观察
- **去重**: 连续相同用户消息去重，assistant turn 后重置去重状态（允许隔轮重复）

## 七、Agent Team 夜间整合

### 7.1 执行方式

所有 agent 通过 `claude -p --bare --plugin-dir $PLUGIN_ROOT` 启动：
- `--bare`: 不持久化 session、跳过 hooks/LSP/auto-memory，无痕执行
- `--plugin-dir`: 加载插件目录，保留 MCP 工具和 skill 访问

agent 可自由使用会话中所有可用工具（文件工具、knowledge MCP、skill 等），不设 `--allowedTools` 白名单限制。

### 7.2 五阶段流水线

#### Stage 1: Scanner（知识提取扫描器）

职责：从 staging 观察中提炼持久、可复用的知识。

决策框架：
1. **Durability**: 30 天后还有用吗？
2. **Specificity**: 有具体可操作的结论吗？
3. **Uniqueness**: 近似已有→reinforce，部分重叠→update，全新→create
4. **Scope**: 一个条目 = 一个连贯主题

内容质量标准（content_draft）：
- 先写关键结论再展开，包含具体例子和代码片段
- 解释 WHY 不只是 WHAT
- 保持与源对话相同的语言
- 2-5 句话，简洁但自包含

工具使用：
- `knowledge_search`: PRIMARY dedup 工具，提 create 前必搜
- `knowledge_get`: 比对已有条目详情
- `knowledge_relevant`: 发现潜在重叠
- Read/Grep: 源代码验证，证据确认

输出：`01-proposals.json`

#### Stage 2: Challenger（质量质疑者）

职责：逐条 stress-test 每个 proposal。

质疑维度：
1. **Evidence & Grounding**: 单次随意提到 vs 确认模式？临时 workaround？
2. **Redundancy & Overlap**: 能否合并？reinforce 是否真的独立再出现？
3. **Scope & Granularity**: 太宽？太窄？标题是否准确？
4. **Action Appropriateness**: 每个 action 类型有具体质疑方向
5. **Content Quality**: content_draft 是否自包含？是否解释了 WHY？

工具使用：
- `knowledge_search`: 验证冗余性前必搜
- `knowledge_get`: 读取被 challenge 条目的完整内容
- Grep/Read: 验证 proposal 中的代码引用是否准确

输出：`02-challenges.json`，每个 proposal 都必须有 challenge（不允许跳过）

#### Stage 3: Auditor（裁决法官）

职责：综合 proposal 和 challenge 做最终裁决。

裁决标准：
- `create`: 默认批准除非 challenge 揭示明确问题
- `reinforce`: 批准除非再出现不独立
- `update`: 批准如果变更有事实依据
- `deprecate`: 批准除非条目仍活跃或类型需要更长 TTL

横向检查：重复 proposal 合并、矛盾检测、importance 通胀检测。

TTL 类型意识：

| 类型 | TTL | 说明 |
|------|-----|------|
| knowledge | 90d | 通用技术知识 |
| feedback | 180d | 用户纠正，衰减慢 |
| project | 60d | 项目动态，变化快 |
| reference | 365d | 外部系统引用 |
| env_config | 365d | 环境配置 |

工具使用：
- `knowledge_search`: 争议裁决的 tiebreaker
- `knowledge_get`: 修改前读目标条目完整内容
- `knowledge_stats`: 检查知识库整体健康状况

输出：`03-decisions.json`

#### Stage 4: Validator（预飞检查）

职责：模拟执行 decisions，捕获问题。

检查清单：
1. **Conflict Detection**: 标题碰撞、内容重叠、断链引用
2. **Integrity**: create 不能有 target_id、reinforce/update 必须有、importance 1-5、非空字段
3. **Token Budget**: 估算总 token 开销，~10K 上下文预算
4. **Action-Decision Consistency**: decision 和 action 是否匹配

工具使用：
- `knowledge_search`: 按标题和关键词搜索碰撞
- `knowledge_get`: 验证目标条目存在性和状态
- `knowledge_stats`: 准确的数据库统计

输出：`04-approved.json`（只含通过校验的 decision）

#### Stage 5: Executor（执行写入者）

职责：将 approved decisions 转化为高质量知识条目。不做判断，但负责内容准确性。

ID 生成规则：`k{YYYYMMDD}-{NNN}`（create 用新 ID，update/reinforce/deprecate 用已有 ID）

写作标准：自包含、精确值、先结论后细节、保持源语言、搜索友好。

工具使用：
- `knowledge_get`: 更新前读目标条目当前状态
- `knowledge_search`: 确认无碰撞
- Read/Grep: 核实 content_draft 中的代码引用

输出：`05-entries.json`（实际 entries）+ `report.md`

### 7.3 Agent 间数据流

```
staging/*.jsonl
       │
       ▼
 ┌──────────┐  proposals.json    ┌──────────────┐  challenges.json
 │ Scanner  │ ────────────────── │  Challenger   │ ────────────────
 └──────────┘                    └──────────────┘
      │ (feedback calibration)          │
      │                                 ▼
      │                          ┌──────────────┐  decisions.json   ┌───────────┐
      │                          │   Auditor    │ ───────────────── │ Validator │
      │                          └──────────────┘                   └───────────┘
      │                                                                │
      │                                                                ▼ approved.json
      │                                                         ┌──────────────┐
      │                                                         │   Executor   │
      │                                                         │ entries+report│
      │                                                         └──────────────┘
      │                                                                │
      ▼                                                                ▼
  write_consolidation_ops()                                     mcp_write()
  (写入 consolidation_ops 表)                                   (写入 knowledge 表)
```

### 7.4 Feedback 消费（RL）

在 Scanner 之后、Challenger 之前执行：

1. `read_unconsumed_feedback()`: 读取未消费 feedback（`feedback_consumed = 0`，最多 20 条）
2. `generateCalibrationText()`: 将 feedback 转为校准文本注入 Scanner prompt
   - 每条 feedback 展示：评分 + 知识正文摘要（≤200 字） + 用户原始评论
   - 不使用硬编码推断，由 Scanner 自行理解评论语义
3. `consume_feedback()`: 执行 importance 调整 + 标记 consumed
   - good → `importance = MIN(5, importance + 1)`
   - bad → `importance = MAX(1, importance - 1)`，若已是 1 则 `status = deprecated`
   - 标记 `feedback_consumed = 1`

校准文本格式示例：
```
1. [GOOD] "HTTP timeout patterns"
   Content: "项目中 HTTP 客户端超时统一设为 3s，重试 2 次..."
   User comment: "非常有用，这类配置细节就应该记下来"
```

防过拟合机制：
- consumed 标记防止同一条反复消费
- 最多注入 20 条
- 按 `feedback_at DESC` 排序（优先最近偏好）
- importance 上限 5

## 八、Web Report & Feedback

### 8.1 report-server.cjs

轻量 HTTP 服务，按需启动（`/junior-mem:review`），10 分钟空闲自动关闭。

API 端点：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/report/:date` | GET | 报告 HTML 页面 |
| `/api/dates` | GET | 可用报告日期（来自文件系统 + consolidation_ops 表） |
| `/api/report/:date` | GET | 指定日期的整合操作数据 JSON |
| `/api/feedback/:date` | GET | 指定日期已有 feedback（用于回显） |
| `/api/feedback` | POST | 提交 feedback → 写入 SQLite |

### 8.2 报告页面

每张 Card 展示一个整合操作，包含 5 个区域：

| 区域 | 内容 | 目的 |
|------|------|------|
| Header | 操作类型 + knowledge ID + importance | 快速识别 |
| 正文 | 完整知识内容 | 人类学习 |
| 来源观察 | 导致此操作的 staging turns | 理解上下文 |
| AI 推理链 | Scanner → Challenger → Auditor | 透明度 |
| Feedback | good/normal/bad + 评论 + submit | RL 闭环 |

设计原则：**只有用户实际反馈过的条目才进入夜间整合**，未阅读 = 不参与 RL。

## 九、生命周期流转

```
staging 捕获 → consolidation 整理
    ↓
active (importance=1, TTL 生效)
    ↓
    ├── 重复引用 → reinforced (importance++)
    ├── 新认知覆盖 → updated
    ├── 长期未引用 + TTL 过期 → deprecated
    └── feedback bad + importance=1 → deprecated
```

## 十、MCP 工具清单

| 工具 | 说明 |
|------|------|
| `knowledge_search` | FTS5 全文检索，BM25 排序，支持 tag/type/importance 过滤 |
| `knowledge_get` | 按 ID 获取完整内容，自动更新 access_count |
| `knowledge_relevant` | 任务相关性检索（importance >= 2） |
| `knowledge_write` | 写入/修改/归档/删除，upsert 保留 access_count，触发 Markdown 导出 |
| `knowledge_stats` | 统计：总数、按类型、平均 importance、DB 大小 |

### Upsert 安全机制

`knowledge_write` 的 upsert 路径保护 `access_count` 和 `last_accessed`：
- `last_accessed`: `COALESCE(NULLIF(excluded, ''), knowledge.last_accessed)` — 新值为空时保留旧值
- `access_count`: 新值 > 0 用新值，否则保留旧值 — 防止 consolidation 覆盖访问统计

## 十一、插件打包

```json
// .claude-plugin/plugin.json
{ "name": "junior-mem", "version": "0.1.0" }

// .claude-hooks/hooks.json — Stop hook 注册
// .mcp.json — knowledge MCP server 注册
```

安装：`claude plugin install` 或 `--plugin-dir`
初始化：`/junior-mem:init`（交互式向导，配置模型/目录/cron）
卸载：`/junior-mem:uninstall`

## 十二、已确认的设计决策

| # | 决策 | 结论 |
|---|------|------|
| 1 | 主存储 | SQLite + FTS5（Markdown 为导出格式） |
| 2 | SessionStart hook | MCP 按需检索替代，不自动注入 |
| 3 | 连续失败告警 | log WARNING，暂不做主动通知 |
| 4 | report 保留策略 | 永久保留 |
| 5 | staging 清理 | 由 consolidate.sh 移入 processed/，累积过大时手动清理 |
| 6 | Session 持久化 | `--bare` 模式，consolidate 不留 session 文件 |
| 7 | Agent 工具权限 | 不设 `--allowedTools`，自由使用会话中全部能力 |
| 8 | Feedback 粒度 | 对 consolidation 操作结果（knowledge 条目）打分 |
| 9 | 未反馈条目 | 不参与 RL 整合，只有实际反馈过的才消费 |
| 10 | consolidation_ops.knowledge_id | 从 executor entries 中回填真实 ID，不用 proposal_id |
| 11 | Feedback 消费时序 | Scanner 先读取 calibration → 之后才 consume |
| 12 | observe.jq 去重 | assistant turn 后重置 prev_text，允许隔轮重复 |

## 十三、实施清单

### Phase 0: 基础设施 ✅
- [x] 目录结构 (init.sh)
- [x] observe.sh + observe.jq (Stop hook)
- [x] 插件打包 (.claude-plugin, .mcp.json, hooks.json)

### Phase 1: 夜间整合 ✅
- [x] consolidate.sh (5 阶段流水线)
- [x] 详细 agent prompt（含 MCP 工具指引）
- [x] 断点续跑 (state.json)
- [x] Feedback 消费 + RL calibration
- [x] consolidation_ops 写入（真实 knowledge ID）
- [x] --bare 模式（无痕 session）

### Phase 1.5: MCP + SQLite ✅
- [x] knowledge-mcp.cjs (5 工具)
- [x] FTS5 BM25 + CJK LIKE
- [x] Upsert 安全（保留 access_count）
- [x] Feedback schema (feedback_rating/comment/at/consumed)
- [x] consolidation_ops 表

### Phase 1.6: 安装/卸载 ✅
- [x] init.sh（交互式向导）
- [x] uninstall.sh（完整清理）

### Phase 2: Web Report & Feedback ✅
- [x] report-server.cjs（HTTP 服务 + API）
- [x] 报告 HTML 页面（Card + 5 区域）
- [x] Feedback 提交（good/normal/bad + 评论）
- [x] /junior-mem:review skill
- [x] 日期下拉选择器
- [x] 已有 feedback 回显

### Phase 3: 优化与桥接（未开始）
- [ ] 评估整合质量（准确率、成本）
- [ ] 实现 importance>=4 提升到 memory/
- [ ] 可选加向量索引
- [ ] CLAUDE.md 的 knowledge 引用指令
