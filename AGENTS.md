# SuperRun Agent Guide

## Project intent

- This repository is building a local coding agent CLI in the style of Claude Code.
- The current stage is still early, but the repository now has a working chat slice instead of only a minimal CLI entry.
- Prioritize small, composable steps over broad architecture rewrites.

## Current implementation

- Runtime: Node.js + TypeScript + ESM.
- CLI entry: `src/index.ts` calls Commander setup from `src/cli.ts`.
- Current command shape: `superrun [prompt]`.
- `src/cli.ts` loads `.env`, supports single-turn prompt mode and interactive multi-turn chat mode, provides a lightweight terminal UI in TTY sessions, and wires local slash commands for settings, history browsing, filtered session browsing, and session management.
- `src/agent/loop.ts` manages session state, message history, system prompt assembly, lightweight history truncation, per-turn model calls, and a narrow tool-calling loop.
- `src/prompts/system.ts` centralizes the base system prompt used for each session.
- `src/config/settings.ts` persists the default system prompt profile used across runs.
- `src/config/paths.ts` centralizes where local config and session files are stored.
- `src/llm/types.ts` defines the shared chat message, tool call, chat options, and client interface types.
- `src/llm/router.ts` currently routes all requests to a single OpenAI-compatible client.
- `src/llm/openai_compatible.ts` implements a working OpenAI-compatible chat completion adapter, including basic streaming, proxy support, and function-call parsing.
- `src/utils/env.ts` validates `OPENAI_API_KEY` and reads base URL, model, and timeout settings from the environment.
- `src/session/store.ts` persists multiple saved sessions, tracks the active session, derives session titles and previews, and restores sessions across CLI runs.
- `src/tools/list_files.ts` implements the first local read-only tool for repository structure inspection under the workspace root.
- `src/ui/tui.ts` contains the lightweight terminal UI helpers used in TTY interactive sessions, including command help, the `/sessions` picker, and history workflows.
- `test/` contains focused tests for env parsing, system prompt settings, session store behavior, session picker interaction, tool orchestration, history handling, and interactive CLI behavior using a local mock OpenAI-compatible server.

## Project progress

- Done: single-turn prompts, interactive multi-turn chat, streaming responses, centralized system prompt assembly, persistent system prompt settings, lightweight history truncation, multi-session persistence across runs, active session restore, session rename, session switching by id/index/title, richer `/sessions` previews, saved history viewing, `/sessions [query]` filtering, a narrow TTY `/sessions` picker, the first `list_files` function call, lightweight TTY UI, and focused tests for the current slice including picker interaction coverage and tool orchestration.
- Not done yet: richer TTY session actions beyond switching, prompt/version handling for evolving system prompts, additional local tools such as file reading, multi-provider routing, and write/command execution boundaries.
- Current maturity: the chat loop is solid for local experiments and saved-session workflows, but the agent still behaves like a chat-first CLI rather than a full coding agent with tools.

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
- `src/llm/openai_compatible.ts`: provider adapter implementation.
- `src/agent/loop.ts`: main agent loop, prompt assembly, tool call orchestration, and final response handling.

## Priorities for upcoming work

1. Expand the lightweight TUI carefully beyond the current `/sessions` picker with clearer saved-session actions, transient status states, and better error surfacing.
2. Add the second read-only local tool, likely line-bounded file reading, on top of the new `list_files` slice.
3. Refine prompt handling so the centralized system prompt can evolve without confusing older saved sessions.
4. Add router-level coverage once a second provider or selection rule exists.
5. Only after read-only tool behavior is stable, introduce stricter write/command execution boundaries.

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
- Session titles, previews, rename, history inspection, and `/sessions [query]` filtering are already in place for the current saved-session UX slice.
- System prompt overrides are already persisted locally and reset the current conversation when changed.
- The project now has a small `node:test` suite executed via `npm test`.
