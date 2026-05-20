# 架构全景

本文档描述 Reasonix MCP Server 的整体架构、数据流和模块职责。

---

## 系统边界

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              宿主 Agent                                  │
│  (Kimi Code / Cursor / Claude Code / 任何 MCP 兼容客户端)                │
│                                                                         │
│  职责：需求分析、任务拆解、模型选择、进度监控、结果审查、最终决策           │
│  输入：用户需求                                                        │
│  输出：通过 / 要求修改 / 取消任务                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼  JSON-RPC 2.0 over stdio
┌─────────────────────────────────────────────────────────────────────────┐
│                         Reasonix MCP Server                             │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │   MCP 协议层  │  │   状态管理层  │  │   进程管理层  │  │  配置加载层  │ │
│  │  (Server)    │  │  (State)     │  │  (Worker)    │  │  (Config)   │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼  独立子进程 spawn
┌─────────────────────────────────────────────────────────────────────────┐
│                            Reasonix Worker                               │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │  DeepSeek API │  │   工具执行层  │  │  对话历史管理 │                  │
│  │  (Chat Completions)│  │  (16 Tools)  │  │  (Resume)    │                  │
│  └──────────────┘  └──────────────┘  └──────────────┘                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 三层职责

### Layer 1: MCP 协议层 (`src/server/index.mjs`)

这是宿主 Agent 与 Reasonix 之间的唯一通信通道。

- **JSON-RPC 2.0 解析**：从 stdin 读取按行分隔的 JSON 消息，解析为 MCP 请求/通知
- **工具注册**：向宿主暴露 6 个 MCP 工具的 schema（`tools/list`）
- **请求分发**：根据 method 和 tool name 路由到对应的 handler
- **响应构造**：将 handler 结果封装为 MCP `content` 格式返回
- **生命周期管理**：处理 `initialize`、`shutdown`、`exit` 等 MCP 标准消息

关键设计决策：**所有响应必须走 stdout，所有日志必须走 stderr**。MCP 协议把 stdout 作为唯一的通信通道，任何 stdout 污染都会导致协议解析失败。

### Layer 2: 状态管理层 (`src/core/state.mjs` + `src/core/config.mjs`)

**Config 加载策略**：

优先级从高到低：
1. 环境变量 (`DEEPSEEK_API_KEY`, `REASONIX_LOG_LEVEL` 等)
2. Server 本地 TOML (`.reasonix/config.toml` 与 server 同级)
3. 项目根目录 TOML (向上遍历找到 `.reasonix` 标记目录)
4. 代码内默认值

自写 TOML 解析器的原因：我们只需要处理 `key = value` 和 `[section]` 两种语法，引入一个完整的 TOML 库是过度设计。

**State 持久化策略**：

每个任务对应一个 JSON 文件 `.reasonix/jobs/<jobId>.json`。写入采用原子操作：

```
write data to   <jobId>.json.<pid>.tmp
rename          <jobId>.json.<pid>.tmp → <jobId>.json
```

`rename` 在操作系统层面是原子操作。这意味着：
- 写入过程中进程崩溃 → tmp 文件残留，原文件不受影响
- 永远不会留下半残的 JSON

### Layer 3: 执行引擎层 (`src/worker/index.mjs` + `src/tools/registry.mjs`)

**Worker 执行循环**：

```
1. 读取 job 配置，初始化 messages 数组
2. 根据 mode 过滤可用工具（review 模式去掉所有写工具）
3. 调用 DeepSeek Chat Completions API
4. 如果 AI 返回 tool_calls：
   a. 将 tool_calls 加入 messages
   b. 逐个执行工具，将结果加入 messages
   c. 保存完整 history（用于续跑）
   d. 回到步骤 3
5. 如果 AI 返回最终答案：
   a. 将答案加入 messages
   b. 构建 result 对象（output, touchedFiles, messagesCount, estimatedTokens）
   c. 写入状态文件，标记 completed
   d. 进程退出
```

**工具集设计**：

16 个工具覆盖了文件操作的全场景：

- **读**：`read_file`（支持 head/tail/range 分段读）、`get_file_info`
- **写**：`write_file`、`edit_file`（SEARCH/REPLACE）、`multi_edit`（原子批量编辑）
- **搜**：`search_files`（按文件名）、`search_content`（按内容 grep）、`glob`
- **目录**：`list_directory`、`directory_tree`、`create_directory`、`delete_directory`
- **文件管理**：`move_file`、`copy_file`（拒绝覆盖）、`delete_file`
- **命令**：`run_command`（spawnSync，60s 默认超时）
- **委派**：`delegate_task`（同步阻塞式子 Worker 调用）

---

## 数据流：一次完整任务

```
用户："把 src/utils.ts 中的 formatDate 函数重构为支持时区参数"
  │
  ▼
宿主 Agent (Kimi Code)
  • 分析：单文件修改，范围明确 → model: flash
  • 构造 prompt，调用 reasonix_start_task
  │
  ▼
MCP Server
  • 生成 jobId (task-xxx)
  • 创建 job 状态文件（status: queued）
  • spawn Worker 进程
  • 立即返回 { job_id, status: "queued" }
  │
  ▼
Worker 进程
  • 加载 job，status → running
  • 初始化 messages：[system prompt, user prompt + 上下文]
  • 调用 DeepSeek API
  • AI 决定：先 read_file 看当前代码
  • 执行 read_file，结果回传
  • AI 决定：edit_file 修改函数签名和实现
  • 执行 edit_file，结果回传
  • AI 决定：run_command 运行测试验证
  • 执行 run_command，测试通过
  • AI 输出最终总结
  • 写入状态文件（status: completed, result: {...}）
  • 进程退出
  │
  ▼
宿主 Agent
  • 轮询 reasonix_get_status → status: completed
  • 调用 reasonix_get_result → 获取 output 和 touchedFiles
  • 审查修改内容
  • 决策：通过 / 要求修改
```

---

## 进程关系图

```
主进程 (Server)
├── Worker A (task-abc123) ── DeepSeek API
│   └── Child Worker A1 (delegate subtask) ── DeepSeek API
├── Worker B (task-def456) ── DeepSeek API
└── ...
```

- Server 进程是长期运行的（跟随宿主 Agent 生命周期）
- 每个 Worker 是短期进程（任务完成后退出）
- Worker 之间完全隔离，不共享内存
- Server 通过 `activeWorkers` Map 跟踪当前活跃的 Worker PID，支持 cancel 和 cleanup

---

## 错误处理策略

| 错误场景 | 处理策略 |
|----------|----------|
| Worker 进程崩溃（非零退出码） | Server 捕获 exit 事件，更新状态为 failed，记录 stderr |
| Worker spawn 失败 | 更新状态为 failed，记录错误信息 |
| DeepSeek API 超时/报错 | Worker 更新状态为 failed，记录 API 错误 |
| Server 重启时 Worker 仍在跑 | 启动时扫描状态文件，将 running/queued 任务标记为 orphaned |
| 磁盘写入失败 | 原子写入保证不会留下半残文件；失败时状态保持上一次有效值 |
| SEARCH 文本不唯一 | edit_file 拒绝执行，返回错误让 AI 调整策略 |
