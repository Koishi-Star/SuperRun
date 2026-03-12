# SuperRun

SuperRun is an early-stage local coding agent CLI built with Node.js and TypeScript.
The project is inspired by Claude Code style interaction, but is currently focused on a thin, usable vertical slice instead of broad architecture.

## Current Status

What works today:

- single-turn prompt execution
- interactive multi-turn chat
- streaming assistant output
- OpenAI-compatible chat completion provider
- lightweight TUI in real terminal sessions
- focused tests for env parsing, agent history, and CLI interaction

What does not exist yet:

- tool calling
- session persistence across runs
- multiple providers
- advanced TUI

## Conversation Model

Multi-turn chat is implemented with a session object in [`src/agent/loop.ts`](./src/agent/loop.ts).
The base prompt is defined centrally in [`src/prompts/system.ts`](./src/prompts/system.ts).

The current request shape is:

1. a base `system` prompt
2. prior `user` and `assistant` turns from the current session
3. the current `user` prompt

That is the correct structure for the current stage.
The default base system prompt currently lives in [`src/prompts/system.ts`](./src/prompts/system.ts):

```ts
You are a helpful coding assistant. Be accurate, concise, and practical.
```

What is still basic is not the existence of the system prompt, but its quality and configurability.

## Requirements

- Node.js 20+
- an OpenAI-compatible API endpoint
- a valid API key

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file in the project root.

Example:

```env
OPENAI_API_KEY=your_api_key_here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
OPENAI_TIMEOUT_MS=120000
```

Environment variables:

- `OPENAI_API_KEY`: required
- `OPENAI_BASE_URL`: optional, defaults to `https://api.openai.com/v1`
- `OPENAI_MODEL`: optional, defaults to `gpt-4o-mini`
- `OPENAI_TIMEOUT_MS`: optional, defaults to `120000`

## Usage

Build:

```bash
npm run build
```

Single-turn prompt:

```bash
npm run dev -- "Explain this repository"
```

Interactive multi-turn mode:

```bash
npm run dev --
```

Run compiled output directly:

```bash
node dist/index.js "Explain this repository"
node dist/index.js
```

## Interactive Commands

In interactive mode, these local commands are supported:

- `/help`
- `/clear`
- `/exit`

The current session history lives in memory only.
Once the process exits, the conversation is gone.

## PowerShell Examples

Single turn:

```powershell
npm run dev -- "Explain src/agent/loop.ts"
```

Interactive:

```powershell
npm run dev --
```

Pipe multiple lines:

```powershell
@"
My name is Ada.
What is my name?
/exit
"@ | npm run dev --
```

## Development Commands

Build:

```bash
npm run build
```

Test:

```bash
npm test
```

## Project Structure

- `src/cli.ts`: CLI entry behavior, single-turn mode, interactive mode, TUI wiring
- `src/agent/loop.ts`: session state, message history, prompt assembly
- `src/prompts/system.ts`: central base system prompt definition
- `src/llm/types.ts`: shared message and client types
- `src/llm/router.ts`: current provider routing
- `src/llm/openai_compatible.ts`: OpenAI-compatible adapter
- `src/utils/env.ts`: env validation and config loading
- `src/ui/tui.ts`: lightweight terminal UI helpers
- `test/`: focused tests for current behavior

## Near-Term Priorities

- improve the base system prompt and make it easier to override
- add lightweight history truncation
- decide whether sessions should be optionally persisted
- expand the TUI carefully without introducing heavy dependencies
- add tools only after chat behavior is stable

## License

This project is licensed under the Apache License 2.0.
See [LICENSE](./LICENSE).
