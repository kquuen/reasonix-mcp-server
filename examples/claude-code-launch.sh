#!/bin/bash
# Claude Code 启动脚本 — 带 Reasonix MCP Server
# 用法: ./claude-code-launch.sh

REASONIX_DIR="/path/to/reasonix-mcp-server"

cd "$REASONIX_DIR" || exit 1

claude --mcp-server "node ${REASONIX_DIR}/src/server/index.mjs"
