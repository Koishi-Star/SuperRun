# SuperRun

Open-source coding agent CLI inspired by Claude Code, with a long-term goal of supporting the workflows people expect from tools like OpenClaw while being safer and easier to integrate.

一个受 Claude Code 启发的开源 coding agent CLI。长期目标是支持 OpenClaw 一类工具常见的操作方式，同时在安全边界和接入能力上做得更稳、更易集成。

## Table of Contents

- [English](#english)
- [中文](#中文)
- [License](#license)

## English

### Overview

SuperRun is an early-stage local coding agent CLI built with Node.js and TypeScript.

The direction is practical:

- open-source and hackable
- inspired by the interaction model of Claude Code
- designed to support the operational surface users expect from OpenClaw-style agents
- stricter and safer by default when tool execution is introduced
- easier to connect to OpenAI-compatible providers and local deployment setups

This repository is still at a thin vertical-slice stage. Right now it can send a prompt to an OpenAI-compatible chat endpoint and stream the assistant response back to the terminal.

### Current Status

- Runtime: Node.js + TypeScript + ESM
- Current command shape: `superrun <prompt>`
- Provider support: OpenAI-compatible chat completion endpoint
- Streaming output: supported
- Multi-turn chat: not implemented yet
- Tool execution: not implemented yet

### Goals

- build an open-source coding agent CLI inspired by Claude Code
- support the core operation patterns that users want from OpenClaw-style tools
- improve safety boundaries before adding local tool execution
- keep provider integration simple and configurable
- evolve in small, usable end-to-end steps

### Quick Start

#### Requirements

- Node.js 20+
- An OpenAI-compatible API endpoint
- A valid API key

#### Install

```bash
npm install
```

#### Configure

Copy `.env.example` to `.env` and fill in your values:

```env
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
OPENAI_TIMEOUT_MS=120000
```

#### Run

```bash
npm run build
npm run dev -- "Explain this repository"
```

### Environment Variables

- `OPENAI_API_KEY`: required API key
- `OPENAI_BASE_URL`: optional base URL for an OpenAI-compatible endpoint
- `OPENAI_MODEL`: optional default model name
- `OPENAI_TIMEOUT_MS`: optional request timeout in milliseconds

### Project Structure

- `src/cli.ts`: CLI argument parsing and stdout streaming
- `src/agent/loop.ts`: message assembly and main single-call agent loop
- `src/llm/types.ts`: shared chat contracts
- `src/llm/router.ts`: provider routing
- `src/llm/openai_compatible.ts`: OpenAI-compatible adapter
- `src/utils/env.ts`: environment validation and config loading

### Roadmap

- add conversation state for multi-turn chat
- centralize prompt assembly in the agent loop
- improve CLI flags and invalid-usage handling
- add focused tests for env loading, routing, and message assembly
- add a narrow, safer tool interface only after chat is stable

## 中文

### 项目简介

SuperRun 是一个早期阶段的本地 coding agent CLI，使用 Node.js、TypeScript 和 ESM 构建。

这个项目的方向很明确：

- 做一个开源版本的 Claude Code 风格 coding agent
- 支持用户期待中的 OpenClaw 类工具操作方式
- 在真正引入本地工具执行前，先把安全边界做严
- 让接入 OpenAI-compatible 服务和自部署接口更简单
- 采用小步可运行的方式逐步推进，而不是先堆抽象

目前仓库还处于最小可用纵切阶段。现在已经可以把 prompt 发到 OpenAI-compatible 的 chat 接口，并将模型输出流式打印到终端。

### 当前状态

- 运行时：Node.js + TypeScript + ESM
- 当前命令形式：`superrun <prompt>`
- 已支持：OpenAI-compatible chat completion
- 已支持：流式输出
- 未支持：多轮对话
- 未支持：工具调用

### 目标

- 构建一个受 Claude Code 启发的开源 coding agent CLI
- 覆盖 OpenClaw 类工具的核心操作模式
- 在加入本地命令和文件操作前先把安全设计做好
- 让 provider 接入保持简单、清晰、可配置
- 每一步都优先做成可运行的垂直切片

### 快速开始

#### 环境要求

- Node.js 20+
- 一个 OpenAI-compatible API 服务
- 有效的 API Key

#### 安装依赖

```bash
npm install
```

#### 配置环境变量

将 `.env.example` 复制为 `.env`，再填写实际值：

```env
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
OPENAI_TIMEOUT_MS=120000
```

#### 运行

```bash
npm run build
npm run dev -- "解释一下这个仓库"
```

### 环境变量说明

- `OPENAI_API_KEY`：必填，API Key
- `OPENAI_BASE_URL`：可选，OpenAI-compatible 服务地址
- `OPENAI_MODEL`：可选，默认模型名
- `OPENAI_TIMEOUT_MS`：可选，请求超时时间，单位毫秒

### 目录结构

- `src/cli.ts`：CLI 参数解析与终端输出
- `src/agent/loop.ts`：消息组装与主循环
- `src/llm/types.ts`：共享消息与客户端类型
- `src/llm/router.ts`：模型路由层
- `src/llm/openai_compatible.ts`：OpenAI-compatible 适配器
- `src/utils/env.ts`：环境变量校验与配置读取

### 开发路线

- 增加多轮会话状态
- 把 prompt 组装逻辑集中到 agent loop
- 补全更清晰的 CLI flags 与错误提示
- 为 env、router、message assembly 增加聚焦测试
- 等多轮聊天稳定后，再引入更窄、更安全的工具接口

## License

This project is licensed under the Apache License 2.0. See [LICENSE](./LICENSE).
