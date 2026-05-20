# Reasonix MCP Server

**用便宜的模型干脏活，让贵的模型做大脑** — 一个基于 [MCP 协议](https://modelcontextprotocol.io) 的模型编排层，让宿主 Agent 负责规划，让 DeepSeek 负责落地执行。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

---

## 为什么要做这个

用 AI 编程助手写代码的时候，我遇到一个很现实的问题：**token 消耗太大了**。

强推理模型（如 GPT-4o、Kimi k1.5 等）做架构分析、拆解任务、审查代码都很出色。但问题是 — 它们每次执行具体动作（读文件、改代码、跑测试）都要带着完整的上下文去推理，一轮一轮下来，token 账单涨得很快。而且执行过程中上下文越来越臃肿，经常"越改越偏"。

与此同时，DeepSeek 的 API 价格要低得多，而且它的**缓存命中率特别高** — 重复出现的上下文 token 几乎不花钱。但它的工具调用能力和代码执行精准度，在复杂场景下不如顶级推理模型。

所以我做了这个 Reasonix MCP Server：**让强推理模型做它最擅长的事 — 全流程规划、任务拆解、结果审查；让 DeepSeek 做它性价比高的事 — 读文件、改代码、跑测试这些"脏活累活"**。通过模型分层调度，把强推理模型的 token 消耗压到最低，把 DeepSeek 的成本优势发挥到极致。

这就是一次**能力互补的编排**：强推理模型是大脑，DeepSeek 是手脚。

---

## 兼容性 — 任何支持 MCP 的客户端都能用

Reasonix MCP Server 是一个**标准的 MCP 服务器**，遵循 [Model Context Protocol](https://modelcontextprotocol.io) 规范，通过 **stdio 传输层** 与宿主 Agent 通信。

这意味着：**只要你的编程工具支持 MCP，就能接入 Reasonix。**

### 已验证兼容的客户端

| 客户端 | 配置方式 | 状态 |
|--------|----------|------|
| **Kimi Code** | `mcp.json` 配置文件 | ✅ 已验证 |
| **VS Code + Cline** | MCP 设置面板 | ✅ 协议兼容 |
| **Cursor** | `.cursor/mcp.json` | ✅ 协议兼容 |
| **Claude Code** | `CLAUDE.md` 或启动参数 | ✅ 协议兼容 |
| **任何自定义 MCP 客户端** | stdio 启动 | ✅ 协议兼容 |

### MCP 协议合规性

- ✅ JSON-RPC 2.0 over stdio
- ✅ MCP `initialize` / `tools/list` / `tools/call` 生命周期
- ✅ 标准 `shutdown` / `exit` 消息处理
- ✅ 无客户端专属硬编码（所有 tool description 均为通用表述）

> 如果你的客户端支持 MCP 但列表里没提到，欢迎提 Issue 补充。

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│  宿主 Agent (Kimi Code / VS Code+Cline / Cursor / Claude    │
│  Code / 任何 MCP 兼容客户端)                                  │
│  ─────────────────────────────────────                       │
│  • 需求分析 → 任务拆解 → 复杂度判断 → 选择模型 tier             │
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

### 🔥 4. 模型分层调度 — 省钱的精髓

这是整个设计的核心。**强推理模型做规划，DeepSeek 做执行；复杂任务用 pro，简单任务用 flash。**

具体编排逻辑：

| 环节 | 谁来做 | 为什么 |
|------|--------|--------|
| 需求分析、任务拆解、架构判断 | **宿主 Agent**（强推理模型） | 强推理能力，理解复杂业务逻辑 |
| 读文件、搜代码、改文件、跑测试 | **DeepSeek Worker** | 价格便宜，缓存命中率高，重复 token 几乎免费 |
| 结果审查、风险评估、最终决策 | **宿主 Agent**（强推理模型） | 综合判断能力强，不容易被忽悠 |

DeepSeek 内部也有分层：

| 场景 | 模型 | 原因 |
|------|------|------|
| 简单/范围明确的修复（加注释、修 typo、单文件重构） | `deepseek-v4-flash` | 更快、更便宜 |
| 复杂跨文件重构、依赖分析、类型修复 | `deepseek-v4-pro` | 推理深度足够处理复杂依赖 |

**成本对比（粗略估算）**：

- 一个中等复杂度的重构任务，如果全程用强推理模型执行，可能需要 50K~100K token
- 同样的任务，宿主只做规划和审查（约 5K~10K token），DeepSeek 做执行（约 20K~30K token，且大量命中缓存）
- **整体成本可以降到原来的 1/5 ~ 1/10**

而且因为 Worker 运行在独立进程中，宿主 Agent 的上下文始终保持干净 — 不会因为执行过程中的工具调用结果而膨胀。规划时的思路清晰，审查时的判断准确。

这不是简单的"传个参数调模型"。这是一个**有意识的成本架构设计**：把贵的能力用在刀刃上，把便宜的能力用在重复劳动上。

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

### 前置要求

- **Node.js >= 18.0.0**（需要原生 `fetch`）
- **DeepSeek API Key**（注册即送额度）
- **任意支持 MCP 的编程工具**（Kimi Code、VS Code+Cline、Cursor、Claude Code 等）

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

### 3. 启动 Server（手动测试）

```bash
node src/server/index.mjs
```

Server 通过 stdio 监听 JSON-RPC 消息。正常情况下你不需要手动启动 — 宿主 Agent 会自动 spawn 它。

### 4. 在宿主 Agent 中配置 MCP

**Kimi Code** — 编辑 `mcp.json`：

```json
{
  "mcpServers": {
    "reasonix": {
      "command": "node",
      "args": ["/path/to/reasonix-mcp-server/src/server/index.mjs"],
      "env": {
        "DEEPSEEK_API_KEY": "sk-your-api-key-here"
      }
    }
  }
}
```

**VS Code + Cline** — 在 Cline 设置中添加 MCP Server：

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

**Cursor** — 编辑 `~/.cursor/mcp.json`：

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

**Claude Code** — 启动时指定：

```bash
claude --mcp-server "node /path/to/reasonix-mcp-server/src/server/index.mjs"
```

> 配置完成后重启宿主 Agent，它会自动发现 `reasonix_start_task` 等 6 个工具。

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
│   │   └── index.mjs         ← MCP stdio 网关（客户端无关）
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
