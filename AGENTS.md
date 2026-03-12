# SuperRun Agent Guide

## Project intent

- This repository is building a local coding agent CLI in the style of Claude Code.
- The current stage is still early, but the repository now has a working chat slice instead of only a minimal CLI entry.
- Prioritize small, composable steps over broad architecture rewrites.

## Current implementation

- Runtime: Node.js + TypeScript + ESM.
- CLI entry: `src/index.ts` calls Commander setup from `src/cli.ts`.
- Current command shape: `superrun [prompt]`.
- `src/cli.ts` loads `.env`, supports single-turn prompt mode and interactive multi-turn chat mode, and now provides a lightweight terminal UI in TTY sessions.
- `src/agent/loop.ts` manages session state, message history, system prompt assembly, and per-turn model calls.
- `src/prompts/system.ts` centralizes the base system prompt used for each session.
- `src/llm/types.ts` defines the shared chat message, chat options, and client interface types.
- `src/llm/router.ts` currently routes all requests to a single OpenAI-compatible client.
- `src/llm/openai_compatible.ts` implements a working OpenAI-compatible chat completion adapter, including basic streaming and proxy support.
- `src/utils/env.ts` validates `OPENAI_API_KEY` and reads base URL, model, and timeout settings from the environment.
- `src/ui/tui.ts` contains the lightweight terminal UI helpers used in TTY interactive sessions.
- `test/` contains focused tests for env parsing, agent loop history handling, and interactive CLI multi-turn behavior using a local mock OpenAI-compatible server.

## Project progress

- Done: single-turn prompts, interactive multi-turn chat, streaming responses, centralized system prompt assembly, lightweight TTY UI, and focused tests for the current slice.
- Not done yet: history truncation, prompt override/configuration, session persistence across runs, multi-provider routing, and tool execution.
- Current maturity: the chat loop is usable for local experiments, but the agent still behaves like a chat CLI rather than a full coding agent.

## Working rules

- Keep the codebase simple and readable. This project is still defining its base abstractions.
- Preserve ESM-style imports with `.js` extensions in TypeScript source where needed.
- Do not introduce heavy frameworks or complex dependency trees unless clearly justified.
- Prefer explicit types and small modules over clever abstractions.
- When modifying code, add concise comments for the changed logic so the intent remains easy to follow.
- When adding a new subsystem, wire it through the CLI end-to-end in the smallest usable form first.

## Expected architecture direction

- `src/cli.ts`: parse user input and flags.
- `src/utils/env.ts`: validate environment variables and config loading.
- `src/llm/types.ts`: shared model/message/types contracts.
- `src/llm/router.ts`: choose provider/model implementation.
- `src/llm/openaiComptale.ts`: provider adapter implementation.
- `src/agent/loop.ts`: main agent loop, prompt assembly, tool call orchestration, and final response handling.

## Priorities for upcoming work

1. Improve prompt handling by making the centralized system prompt easier to override and evolve.
2. Add lightweight history truncation so long chats do not grow without bound.
3. Expand the lightweight TUI carefully with session metadata, transient status states, and clearer error surfacing.
4. Decide whether sessions should be in-memory only or optionally persisted across CLI runs.
5. Add router-level coverage once a second provider or selection rule exists.
6. Only after chat behavior is stable, introduce a narrow tool interface for local command execution or file operations.

## Implementation preferences

- Favor a thin vertical slice that can actually run over partially building every layer.
- Keep prompts and model-facing message construction centralized rather than scattered across files.
- If tool use is added later, start with a narrow tool interface and strict execution boundaries.
- Avoid fake abstractions for future multi-provider support until at least one provider is working.

## Verification

- Use `npm run build` after meaningful TypeScript changes.
- Use `npm run dev -- "<prompt>"` for manual CLI checks.
- If you add environment handling, document required variables near the code that reads them.

## Notes

- The placeholder assistant output in `src/cli.ts` has already been replaced by a real model call.
- Multi-turn chat and centralized system prompt assembly are already in place.
- The project now has a small `node:test` suite executed via `npm test`.
