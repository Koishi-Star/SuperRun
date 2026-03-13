# SuperRun

SuperRun is an early-stage local coding agent CLI built with Node.js and TypeScript.
The project is inspired by Claude Code style interaction, but is currently focused on a thin, usable vertical slice instead of broad architecture.

## Current Status

What works today:

- single-turn prompt execution
- interactive multi-turn chat
- streaming assistant output
- OpenAI-compatible chat completion provider
- process-level agent modes with `default` and opt-in `strict`
- guarded command execution in default mode
- a keyboard-driven `/mode` picker in TTY sessions
- persistent system prompt profiles managed from the interactive UI
- multi-session storage with switching and deletion commands
- simple history truncation that keeps the most recent 10 turns
- simple session stats based on turn count and character count
- lightweight TUI in real terminal sessions
- live `@file` suggestions in the TTY prompt, with arrow-key selection and Tab insertion
- local TTY validation that blocks unresolved `@file` references before they reach the model
- strict-mode specialized tool support, with `list_files` as the first read-only tool
- focused tests for env parsing, agent history, and CLI interaction

What does not exist yet:

- structured file-writing/editing support
- a second strict-mode file-reading tool
- multiple providers
- advanced approval/policy controls for command execution
- advanced TUI

## Conversation Model

Multi-turn chat is implemented with a session object in [`src/agent/loop.ts`](./src/agent/loop.ts).
The base prompt is defined centrally in [`src/prompts/system.ts`](./src/prompts/system.ts).

The current request shape is:

1. a base `system` prompt
2. prior `user` and `assistant` turns from the current session, truncated to the most recent 10 turns
3. the current `user` prompt

That is the correct structure for the current stage, with a mode-aware tool-calling loop now available.
In `default` mode the model can use `run_command`.
In opt-in `strict` mode the model sees only the narrow specialized tools such as `list_files`.
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

Interactive multi-turn mode in strict mode:

```bash
npm run dev -- --mode strict
```

Run compiled output directly:

```bash
node dist/index.js "Explain this repository"
node dist/index.js
```

## Interactive Commands

In interactive mode, these local commands are supported:

- `/help`
- `/mode [default|strict]`
- `/settings`
- `/session`
- `/sessions`
- `/new`
- `/switch <id>`
- `/delete [id]`
- `/system`
- `/system reset`
- `/clear`
- `/exit`

Mode behavior:

- `default`: enables guarded `run_command` for inspection, build, lint, and test flows
- `strict`: hides command execution and exposes only the specialized strict-mode tools

TTY input helpers:

- type `/mode` and press Enter to open the mode picker
- type `@` followed by part of a path to see matching files under the prompt
- use `Up` and `Down` to choose a match, then press `Tab` to insert it
- unresolved `@token` references stay local to the composer and are not sent to the model
- use `@@` when you need a literal `@` in the TTY composer

The current conversation now works with multiple saved sessions:

- each saved session lives under `sessions/<id>.json`
- the session index tracks the last active session
- the CLI loads the last active session on startup when one exists
- `/new` starts a fresh saved session
- `/switch <id>` loads another saved session
- `/delete [id]` removes the current or specified saved session

The system prompt is different:

- it can be changed at runtime from the interactive UI
- it is persisted across runs in a local settings file
- changing it clears the current conversation so the new behavior starts cleanly

The current session metadata uses simple stats:

- history turns kept: 10
- history size: counted by characters, not tokens

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
- `src/agent/loop.ts`: session state, prompt assembly, history truncation, and session stats
- `src/config/settings.ts`: persisted system prompt settings
- `src/session/store.ts`: multi-session storage, index management, and active-session selection
- `src/prompts/system.ts`: central base system prompt definition
- `src/llm/types.ts`: shared message and client types
- `src/llm/router.ts`: current provider routing
- `src/llm/openai_compatible.ts`: OpenAI-compatible adapter
- `src/tools/list_files.ts`: workspace-scoped file listing tool
- `src/utils/env.ts`: env validation and config loading
- `src/ui/tui.ts`: lightweight terminal UI helpers
- `test/`: focused tests for current behavior

## Near-Term Priorities

- improve the base system prompt itself and make profiles easier to manage
- improve multi-session UX with better hints, renaming, and previews
- phase the current imperative TTY composer toward a heavier Ink-based TUI shell
- add tools only after chat behavior is stable

## License

This project is licensed under the Apache License 2.0.
See [LICENSE](./LICENSE).
