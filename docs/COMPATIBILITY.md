# 兼容性指南

本文档说明 Reasonix MCP Server 与各类宿主 Agent（编程工具）的兼容情况。

---

## 核心原则

Reasonix MCP Server 是一个**客户端无关的 MCP 服务器**。它只关心：

1. 宿主 Agent 是否支持 MCP 协议
2. 宿主 Agent 能否通过 stdio 启动一个子进程
3. 宿主 Agent 能否调用 `tools/list` 和 `tools/call`

**它不关心**你用的是哪个品牌、哪个版本的编程工具。只要满足上面三个条件，就能接入。

---

## MCP 协议版本

Reasonix MCP Server 实现的协议版本：**2024-11-05**

支持的消息类型：

| 消息 | 说明 |
|------|------|
| `initialize` | 协议握手，返回 serverInfo 和 capabilities |
| `notifications/initialized` | 客户端确认初始化完成 |
| `notifications/cancelled` | 客户端取消某个请求 |
| `tools/list` | 获取工具列表（6 个工具） |
| `tools/call` | 调用工具 |
| `shutdown` | 优雅关闭 |
| `exit` | 退出进程 |

不支持（未来可能添加）：
- `resources/list`、`resources/read` — 目前只暴露 tools
- `prompts/list`、`prompts/get` — 目前只暴露 tools
- `sampling/createMessage` — 不涉及

---

## 已验证的客户端

### ✅ Kimi Code

Kimi Code 内置 MCP 客户端，通过 `mcp.json` 配置文件接入。

**配置位置**：`~/.config/kimi/mcp.json`（或 Kimi Code 指定的配置路径）

**配置示例**：见 `examples/kimi-code-config.json`

**已知限制**：Kimi Code 目前只支持 stdio 传输层，不支持 SSE/WebSocket。

### ✅ VS Code + Cline 扩展

Cline 是 VS Code 上支持 MCP 的 AI 编程扩展。

**配置位置**：Cline 设置面板 → MCP Servers → 添加

**配置示例**：
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

### ✅ Cursor

Cursor 从 0.45+ 版本开始支持 MCP。

**配置位置**：`~/.cursor/mcp.json`

**配置示例**：
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

### ✅ Claude Code

Claude Code（Anthropic 官方 CLI 工具）支持 MCP。

**配置方式**：启动参数

```bash
claude --mcp-server "node /path/to/reasonix-mcp-server/src/server/index.mjs"
```

### ✅ 任何自定义 MCP 客户端

如果你自己写了一个 MCP 客户端，只要它能：

1. `spawn("node", ["/path/to/src/server/index.mjs"])` 启动子进程
2. 向子进程 stdin 写入 JSON-RPC 消息
3. 从子进程 stdout 读取 JSON-RPC 响应

就能与 Reasonix 通信。详见 [docs/API.md](API.md) 了解工具接口。

---

## 通用接入步骤（适用于任何客户端）

> **推荐方式：** `reasonix register` 一键自动检测并配置所有已安装的 MCP 客户端。详见 [README 快速开始](../README.md#快速开始--一键插拔)。

如果 `reasonix register` 未覆盖你的客户端，或者你偏好手动配置，步骤如下：

### Step 1: 准备环境

```bash
# 1. 克隆仓库
git clone https://github.com/kquuen/reasonix-mcp-server.git
cd reasonix-mcp-server

# 2. 确认 Node.js 版本
node --version   # 需要 >= 18.0.0

# 3. 配置 API Key
mkdir -p .reasonix
cp config.toml.example .reasonix/config.toml
# 编辑 config.toml，填入 DEEPSEEK_API_KEY
```

### Step 2: 在客户端中注册 MCP Server

所有客户端的配置本质上都一样 — 告诉它：

- **命令**：`node`
- **参数**：`["/absolute/path/to/reasonix-mcp-server/src/server/index.mjs"]`
- **环境变量**（可选）：`DEEPSEEK_API_KEY`

不同客户端只是配置文件的格式和位置不同。

### Step 3: 验证接入

重启客户端后，向 AI 发送类似这样的消息：

```
请用 reasonix_start_task 启动一个任务，帮我看一下 src 目录下有哪些文件
```

如果 AI 能调用 `reasonix_start_task` 并返回 `job_id`，说明接入成功。

---

## 常见问题

### Q: 我的客户端不在列表里，能用吗？

**A**: 检查你的客户端是否支持 MCP。如果支持，就能用。如果不在列表里，欢迎你接入后提 Issue 补充，我会更新文档。

### Q: 客户端能同时接入多个 MCP Server 吗？

**A**: 可以。MCP 协议设计就是支持多 Server 的。你可以同时接入 Reasonix（执行）、Playwright（浏览器）、PostgreSQL（数据库）等多个 Server。

### Q: 不同客户端调用同一个 Reasonix Server 会有冲突吗？

**A**: 不会。每个客户端启动的是独立的 Reasonix Server 进程，它们各自管理自己的 Worker 进程和状态文件。但如果你让两个客户端指向同一个 `.reasonix/jobs/` 目录，可能会出现状态文件竞争 — 建议不同客户端使用不同的工作目录。

### Q: Windows 上能用吗？

**A**: 可以。Server 和 Worker 都做了 Windows 兼容性处理（`windowsHide: true`、`taskkill /T /F` 等）。

### Q: 需要 npm install 吗？

**A**: 不需要。Reasonix 零运行时依赖，clone 下来直接 `node src/server/index.mjs` 就能跑。
