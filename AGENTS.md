# SuperRun Agent Guide

## Project intent

- This repository is building a local coding agent CLI in the style of Claude Code.
- The current stage is still early, but the repository now has a working chat slice instead of only a minimal CLI entry.
- Prioritize small, composable steps over broad architecture rewrites.

## Current implementation

- Runtime: Node.js + TypeScript + ESM.
- CLI entry: `src/index.ts` calls Commander setup from `src/cli.ts`.
- Current command shape: `superrun [prompt]`.
- `src/cli.ts` loads `.env`, supports single-turn prompt mode and interactive multi-turn chat mode, provides a lightweight terminal UI in TTY sessions, and wires local slash commands for settings and session management.
- `src/agent/loop.ts` manages session state, message history, system prompt assembly, lightweight history truncation, and per-turn model calls.
- `src/prompts/system.ts` centralizes the base system prompt used for each session.
- `src/config/settings.ts` persists the default system prompt profile used across runs.
- `src/config/paths.ts` centralizes where local config and session files are stored.
- `src/llm/types.ts` defines the shared chat message, chat options, and client interface types.
- `src/llm/router.ts` currently routes all requests to a single OpenAI-compatible client.
- `src/llm/openai_compatible.ts` implements a working OpenAI-compatible chat completion adapter, including basic streaming and proxy support.
- `src/utils/env.ts` validates `OPENAI_API_KEY` and reads base URL, model, and timeout settings from the environment.
- `src/session/store.ts` persists multiple saved sessions, tracks the active session, and restores it across CLI runs.
- `src/ui/tui.ts` contains the lightweight terminal UI helpers used in TTY interactive sessions.
- `test/` contains focused tests for env parsing, system prompt settings, session store behavior, history handling, and interactive CLI behavior using a local mock OpenAI-compatible server.

## Project progress

- Done: single-turn prompts, interactive multi-turn chat, streaming responses, centralized system prompt assembly, persistent system prompt settings, lightweight history truncation, multi-session persistence across runs, active session restore, lightweight TTY UI, and focused tests for the current slice.
- Not done yet: session rename, richer `/sessions` previews, search/filter for larger session lists, multi-provider routing, and tool execution.
- Current maturity: the chat loop is usable for local experiments and saved-session workflows, but the agent still behaves like a chat CLI rather than a full coding agent.

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

1. Improve multi-session UX by adding session rename support and making `/sessions` show human-friendly previews instead of raw ids only.
2. Decide the minimum session metadata model for that UX slice: manual titles only, or titles plus derived preview text and timestamps.
3. Expand the lightweight TUI carefully with session metadata, transient status states, and clearer error surfacing.
4. Refine prompt handling so the centralized system prompt is easier to evolve without confusing saved sessions.
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
- Saved multi-session workflows are already in place, including active-session restore between runs.
- System prompt overrides are already persisted locally and reset the current conversation when changed.
- The project now has a small `node:test` suite executed via `npm test`.
