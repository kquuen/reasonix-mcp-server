# Reasonix MCP Server

**让 AI Agent 拥有异步执行臂** — 通过 MCP 协议将编码任务异步委托给 DeepSeek，实现规划与执行的解耦。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

---

## 为什么要做这个

现有的 AI 编码助手（如 Kimi Code、Cursor 等）在面临复杂任务时有一个根本矛盾：**规划者就是执行者**。宿主 Agent 既要做架构分析、拆解任务，又要逐行改代码、运行测试。这不仅消耗宿主自身的 token，还会让上下文变得臃肿，最终导致"越改越偏"。

我设计的 Reasonix MCP Server 要解决这个问题：**让宿主专注规划与审核，让独立的 Worker 专注落地执行。**

宿主 Agent 通过 MCP 协议向 Reasonix 下发任务，Worker 在独立进程中自主完成读文件、改代码、跑测试的全流程。宿主只需要轮询进度、审查结果。两者通过 DeepSeek API 形成能力互补。

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│  宿主 Agent (Kimi Code / Cursor / 其他 MCP 客户端)            │
│  ─────────────────────────────────────                       │
│  • 需求分析 → 任务拆解 → 复杂度判断                            │
│  • 调用 reasonix_start_task 下发任务                          │
│  • 轮询 reasonix_get_status 查看进度                          │
│  • 通过 reasonix_get_result 获取结果并审查                     │
│  • 必要时 reasonix_review_changes 做对抗性代码审查              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼  MCP stdio 协议 (JSON-RPC 2.0)
┌─────────────────────────────────────────────────────────────┐
│  Reasonix MCP Server (src/server/index.mjs)                 │
│  ─────────────────────────────────────                       │
│  • 协议网关：解析 MCP 消息，调度到对应工具                      │
│  • 进程管理：spawn / kill Worker，平台感知的信号处理            │
│  • 状态守护：孤儿任务回收，Server 重启后自动标记失败任务           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼  独立子进程
┌─────────────────────────────────────────────────────────────┐
│  Worker (src/worker/index.mjs)                              │
│  ─────────────────────────────────────                       │
│  • DeepSeek Chat API 调用                                    │
│  • 工具循环：AI 决策 → 工具执行 → 结果回传 → 下一轮              │
│  • 16 个文件操作工具 + delegate_task 子任务委派                │
│  • 三种执行模式：task / review(只读) / subtask(限定范围)        │
└─────────────────────────────────────────────────────────────┘
```

---

## 七大设计亮点

### 🔥 1. 零运行时依赖

整个 Server 基于 Node.js 原生 API 构建 — `node:fs` 做文件操作，`node:child_process` 做进程管理，`global.fetch` 调用 API。**没有任何 npm 依赖**。

这不是为了炫技。依赖越少，不可控的崩溃点越少。你不需要担心某个 transitive dependency 被投毒、某个 package 突然删库。生产环境部署只需要 Node.js 本身。

### 🔥 2. 进程级任务隔离

**每个编码任务都是一个独立的 Worker 进程。** 如果某个任务陷入死循环、耗尽内存、或者调用了一个有问题的命令，它只会杀死自己，不会影响 Server 和其他任务。

Windows 下用 `taskkill /T /F` 做树级清理，POSIX 下先 `SIGTERM` 再 `SIGKILL`，平台感知的设计让终止操作总是有效。

> 崩溃隔离比崩溃恢复更重要 — 这是我从一开始就坚持的原则。

### 🔥 3. 原子状态持久化

任务状态不是存在内存里，而是写到磁盘上的 JSON 文件。而且我使用了 **`先写临时文件 → 再原子重命名`** 的方式：

```js
const tmp = `${filePath}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(data));
fs.renameSync(tmp, filePath);   // 原子操作，不会留下半残文件
```

这意味着即使进程在写入中途被 `kill -9`，也不会留下损坏的 JSON。Server 重启后，会自动扫描所有状态文件，把之前还在 `running` 的任务标记为 `orphaned`（孤儿）并附带错误信息。

**状态不会丢，进度不会乱。**

### 🔥 4. 模型分层调度

我在宿主 Agent 和 DeepSeek 之间设计了一个**复杂度路由层**。宿主根据任务特征选择模型：

| 场景 | 模型 | 原因 |
|------|------|------|
| 简单/范围明确的修复 | `deepseek-v4-flash` | 快、省 token |
| 复杂跨文件重构 | `deepseek-v4-pro` | 强推理能力，处理依赖关系 |

这不是简单的"传个参数"。宿主 Agent 和 Worker Agent 形成**能力互补** — 宿主负责规划与审核（调用方），Reasonix 负责执行与落地（被调用方）。两者的分工边界清晰，各自做自己最擅长的事。

### 🔥 5. 三种执行模式的语义区分

我为 Worker 设计了三种执行模式，每种模式加载不同的工具子集和系统提示词约束：

| 模式 | 工具权限 | 用途 |
|------|----------|------|
| **task** | 全部 16 个工具，读写权限 | 默认编码任务 |
| **review** | 只读工具（read/search/run_command） | 代码审查，防止审查过程中意外改文件 |
| **subtask** | 全部工具 + 范围约束提示词 | 子任务 Worker，限定不越界 |

这种权限隔离让不同场景下的 AI 行为更可预测、更安全。review 模式本质上是给 AI 戴上了"只读手铐"。

### 🔥 6. 对抗性代码审查

我在提交代码前加了一道**对抗性审查关卡**。不是让 AI 说"看起来不错"，而是让它扮演一个**"想找茬的安全审计员"** — 默认假设变更有问题，直到证据证伪。

提示词中定义了明确的攻击面优先级：
- 认证隔离、数据丢失、回滚安全
- 竞态条件、重试与幂等性缺口
- 空状态、超时、降级依赖行为
- 版本偏移、Schema 漂移、兼容性回退
- 可观测性缺口

每个 finding 必须回答四个问题：能出什么问题？为什么脆弱？影响多大？怎么降低风险？

输出采用严格的**紧凑合约**：第一行必须是 `ALLOW:` 或 `BLOCK:`，后续才是详情。这让审查结果可以被机器解析，宿主 Agent 可以直接据此决定通过或拦截。

> 审查的默认姿态应该是怀疑，而不是捧场。

### 🔥 7. 任务续跑与递归委派

我设计了两个让任务可扩展的机制：

**续跑（Resume）**：完整保存对话历史（包括工具调用和结果）。任务中断后，可以从断点继续，不用从头再来。这在长任务场景下非常关键 — 你不会因为一次网络抖动就损失几十轮的对话上下文。

**委派（Delegate）**：一个 Worker 可以把子问题拆给另一个 Worker，形成树状的任务结构。父任务可以通过 `get_status` 的 `children` 字段监控所有子任务的状态。这让 Reasonix 不仅能做单点修复，还能处理需要多步骤协作的复杂重构。

---

## 快速开始

### 1. 克隆与进入目录

```bash
git clone https://github.com/kquuen/reasonix-mcp-server.git
cd reasonix-mcp-server
```

### 2. 配置 API Key

方式 A — 配置文件（推荐）：

```bash
mkdir -p .reasonix
cp config.toml.example .reasonix/config.toml
# 编辑 .reasonix/config.toml，填入你的 DeepSeek API Key
```

方式 B — 环境变量：

```bash
export DEEPSEEK_API_KEY="sk-..."
```

### 3. 启动 Server

```bash
node src/server/index.mjs
```

Server 通过 stdio 监听 JSON-RPC 消息。

### 4. 宿主 Agent 接入

在 Kimi Code 等支持 MCP 的客户端中配置：

```json
{
  "mcpServers": {
    "reasonix": {
      "command": "node",
      "args": ["/path/to/reasonix-mcp-server/src/server/index.mjs"]
    }
  }
}
```

---

## MCP 工具速查

| 工具 | 功能 | 同步/异步 |
|------|------|-----------|
| `reasonix_start_task` | 启动后台编码任务 | 异步，立即返回 job_id |
| `reasonix_get_status` | 查询任务实时进度 | 同步 |
| `reasonix_get_result` | 获取任务最终结果 | 同步（任务完成后） |
| `reasonix_cancel_task` | 取消运行中的任务 | 同步 |
| `reasonix_review_changes` | 对抗性审查当前未提交的代码变更 | 同步（内部异步等待 Worker） |
| `reasonix_resume_task` | 从历史断点续跑任务 | 异步 |

详见 [docs/API.md](docs/API.md)。

---

## 项目结构

```
reasonix-mcp-server/
├── src/
│   ├── server/
│   │   └── index.mjs         ← MCP stdio 网关
│   ├── worker/
│   │   └── index.mjs         ← 后台任务执行器
│   ├── core/
│   │   ├── config.mjs        ← TOML + 环境变量配置加载
│   │   ├── state.mjs         ← 任务状态管理（原子写入）
│   │   └── review.mjs        ← 对抗性审查提示词与解析
│   └── tools/
│       └── registry.mjs      ← 16 个文件操作工具
├── docs/
│   ├── ARCHITECTURE.md       ← 架构全景
│   ├── DESIGN.md             ← 设计决策记录
│   └── API.md                ← 完整接口文档
├── examples/
│   └── kimi-code-config.json ← Kimi Code MCP 配置示例
├── config.toml.example       ← 配置模板
├── package.json
└── README.md
```

---

## 任务状态机

```
queued → running (initializing → executing → done)
                                      ↓ (error)
                                   failed
                                      ↓ (user)
                                cancelled
```

状态持久化到 `.reasonix/jobs/<jobId>.json`，Server 重启后自动回收孤儿任务。

---

## License

[MIT](LICENSE)
