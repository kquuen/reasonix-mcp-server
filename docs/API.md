# API 文档

本文档详细描述 Reasonix MCP Server 暴露的 6 个 MCP 工具的接口规范。

---

## 工具列表

### `reasonix_start_task`

启动一个后台编码任务。

**参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | ✅ | 任务描述。需包含目标文件、期望结果、约束条件 |
| `model` | string | — | `"deepseek-v4-flash"` 或 `"deepseek-v4-pro"`。宿主 Agent 根据复杂度选择 |
| `cwd` | string | — | 工作目录（默认：项目根目录） |

**返回**：

```json
{
  "job_id": "task-abc123",
  "status": "queued",
  "model": "deepseek-v4-pro",
  "summary": "在 src/utils.ts 中给 formatDate 添加..."
}
```

---

### `reasonix_get_status`

查询任务实时进度。

**参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `job_id` | string | ✅ | 任务 ID |

**返回**：

```json
{
  "job_id": "task-abc123",
  "status": "running",
  "phase": "executing",
  "progress": {
    "pct": 45,
    "currentAction": "Editing src/main.ts",
    "touchedFiles": ["src/main.ts", "src/lib/helper.ts"],
    "messagesCount": 12,
    "toolCallsCount": 8
  },
  "elapsed_ms": 15200,
  "model": "deepseek-v4-pro",
  "parentId": null,
  "children": null
}
```

如果任务有子任务委派，`children` 会包含每个子任务的状态摘要。

---

### `reasonix_get_result`

获取任务最终结果。只能在任务完成后调用。

**参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `job_id` | string | ✅ | 任务 ID |

**返回**：

```json
{
  "job_id": "task-abc123",
  "status": "completed",
  "phase": "done",
  "model": "deepseek-v4-pro",
  "elapsed_ms": 45200,
  "summary": "Added error handling to database connection...",
  "output": "完整输出内容...",
  "touchedFiles": ["src/db/connection.ts", "src/db/config.ts"],
  "messagesCount": 24,
  "estimatedTokens": 8500,
  "canResume": true,
  "error": null,
  "completedAt": "2025-01-15T10:30:00Z"
}
```

如果任务还在运行中，返回错误提示先调用 `get_status`。

---

### `reasonix_cancel_task`

取消运行中的任务。会强制终止 Worker 进程。

**参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `job_id` | string | ✅ | 任务 ID |

**返回**：

```json
{
  "job_id": "task-abc123",
  "status": "cancelled",
  "terminated_after_ms": 15200
}
```

---

### `reasonix_review_changes`

对当前未提交的代码变更进行对抗性审查。

**设计说明**：这个工具在宿主 Agent 即将结束会话前被调用。它会收集 `git diff` 的输出，让 DeepSeek 以"安全审计员"的视角审查变更，输出 `ALLOW` 或 `BLOCK` 的明确结论。

**参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `focus` | string | — | 审查聚焦领域，如 `"race conditions"`、`"auth"`、`"data loss"` |

**返回**：

```json
{
  "verdict": "BLOCK",
  "reason": "Missing null check on user input before database query",
  "job_id": "task-review-xyz789",
  "output": "详细审查报告..."
}
```

审查是同步阻塞的（宿主等待 verdict），内部超时 5 分钟。

---

### `reasonix_resume_task`

从历史断点续跑任务。

**设计说明**：当一个已完成或失败的任务需要继续深入时，可以调用此工具。它会复制原任务的完整对话历史，追加新的指令，然后启动一个新的 Worker 继续执行。

**参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `job_id` | string | ✅ | 原任务 ID |
| `instruction` | string | — | 续跑指令，如 `"apply the top fix"`、`"dig deeper into root cause"` |
| `model` | string | — | 指定模型（默认与原任务相同） |

**返回**：

```json
{
  "job_id": "task-new456",
  "status": "queued",
  "model": "deepseek-v4-pro",
  "resumed_from": "task-abc123",
  "summary": "apply the top fix"
}
```

---

## Worker 工具集（内部使用）

以下 16 个工具由 Worker 调用，不直接暴露给宿主 Agent，但宿主 Agent 可以通过 `start_task` 的 prompt 间接驱动它们。

| 工具 | 功能 |
|------|------|
| `read_file` | 读取文件，支持 head/tail/range 分段 |
| `write_file` | 创建或覆盖文件，自动创建父目录 |
| `edit_file` | SEARCH/REPLACE 编辑，要求 SEARCH 唯一 |
| `multi_edit` | 原子批量 SEARCH/REPLACE，全部成功才写入 |
| `search_files` | 按文件名子串搜索 |
| `search_content` | 按内容正则搜索，返回 path:line: 格式 |
| `glob` | 简单 glob 匹配，支持 `*`、`**`、`?` |
| `list_directory` | 列出目录内容（非递归） |
| `directory_tree` | 递归目录树，自动跳过依赖目录 |
| `get_file_info` | 获取文件元信息（类型、大小、修改时间） |
| `run_command` | 运行 shell 命令，默认 60s 超时 |
| `create_directory` | 创建目录（递归） |
| `move_file` | 移动/重命名文件 |
| `copy_file` | 复制文件，拒绝覆盖已存在目标 |
| `delete_file` | 删除文件 |
| `delete_directory` | 删除目录（默认递归） |
| `delegate_task` | 委派子任务给子 Worker（同步阻塞） |
