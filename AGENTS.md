# SuperRun Agent Guide

## Project intent

- This repository is building a local coding agent CLI in the style of Claude Code.
- The current stage is still early, but the repository now has a working chat slice instead of only a minimal CLI entry.
- Prioritize small, composable steps over broad architecture rewrites.

## Current implementation

- Runtime: Node.js + TypeScript + ESM.
- CLI entry: `src/index.ts` calls Commander setup from `src/cli.ts`.
- Current command shape: `superrun [prompt]`.
- `src/cli.ts` loads `.env`, supports single-turn prompt mode and interactive multi-turn chat mode, exposes `--mode <default|strict>`, provides a lightweight terminal UI in TTY sessions, and wires local slash commands for settings, history browsing, filtered session browsing, session management, runtime mode switching, and transitional `@file` suggestion support while typing.
- `src/agent/loop.ts` manages session state, message history, system prompt assembly, lightweight history truncation, per-turn model calls, and a mode-aware tool-calling loop.
- `src/prompts/system.ts` centralizes the base system prompt used for each session.
- `src/config/settings.ts` persists the default system prompt profile used across runs.
- `src/config/paths.ts` centralizes where local config and session files are stored.
- `src/llm/types.ts` defines the shared chat message, tool call, chat options, and client interface types.
- `src/llm/router.ts` currently routes all requests to a single OpenAI-compatible client.
- `src/llm/openai_compatible.ts` implements a working OpenAI-compatible chat completion adapter, including basic streaming, proxy support, and function-call parsing.
- `src/utils/env.ts` validates `OPENAI_API_KEY` and reads base URL, model, and timeout settings from the environment.
- `src/session/store.ts` persists multiple saved sessions, tracks the active session, derives session titles and previews, and restores sessions across CLI runs.
- `src/tools/run_command.ts` implements the default-mode command tool with workspace scoping, timeout/output bounds, and a conservative blocklist for obviously state-changing commands.
- `src/tools/list_files.ts` implements the first strict-mode local read-only tool for repository structure inspection under the workspace root.
- `src/tools/workspace.ts` centralizes workspace-relative path validation shared by local tools.
- `src/ui/tui.ts` contains the lightweight terminal UI helpers used in TTY interactive sessions, including command help, the `/sessions` picker, and history workflows.
- `src/ui/tty-prompt.ts` implements the current imperative TTY composer, including local `@file` validation and suggestion rendering.
- `src/ui/composer-state.ts` centralizes the current TTY composer state machine so the same behavior can later migrate behind a heavier TUI shell.
- `src/ui/file-reference.ts` handles workspace file indexing plus `@file` query parsing, escape handling, validation, and matching.
- `src/ui/session-picker.ts` models the paged `/sessions` picker state, navigation, and view data for TTY mode.
- `src/ui/session-picker-controller.ts` handles keyboard-driven `/sessions` picker interaction, including raw-mode lifecycle and cancel/confirm behavior.
- `src/ui/mode-picker.ts` and `src/ui/mode-picker-controller.ts` provide the keyboard-driven `/mode` picker used in TTY mode.
- `test/` contains focused tests for env parsing, system prompt settings, session store behavior, session picker rendering and interaction, tool orchestration, provider reasoning-content passthrough, history handling, and interactive CLI behavior using a local mock OpenAI-compatible server.

## Project progress

- Done: single-turn prompts, interactive multi-turn chat, streaming responses, centralized system prompt assembly, persistent system prompt settings, lightweight history truncation, multi-session persistence across runs, active session restore, session rename, session switching by id/index/title, richer `/sessions` previews, saved history viewing, `/sessions [query]` filtering, a paged keyboard-driven TTY `/sessions` picker, a keyboard-driven TTY `/mode` picker, process-level agent modes (`default` and opt-in `strict`), guarded `run_command` in default mode, strict-mode-only specialized tools, provider `reasoning_content` passthrough across tool rounds, lightweight TTY UI, and a stabilized TTY composer that blocks unresolved `@file` references locally instead of leaking them into model prompts.
- Not done yet: structured file writing/editing, stronger command approval/policy controls, the second strict-mode read-only tool for file content inspection, prompt/version handling for evolving system prompts, richer TTY session actions beyond switching, multi-provider routing, and the phased migration from the current imperative TTY composer toward a heavier Ink-based TUI shell.
- Current maturity: the chat loop is now viable as an early coding agent because default mode can inspect and verify work through commands, but write-path design and command policy hardening are still intentionally incomplete.

## Working rules

- Keep the codebase simple and readable. This project is still defining its base abstractions.
- Preserve ESM-style imports with `.js` extensions in TypeScript source where needed.
- Do not introduce heavy frameworks or complex dependency trees unless clearly justified.
- Prefer explicit types and small modules over clever abstractions.
- When modifying code, add concise comments for the changed logic so the intent remains easy to follow.
- When adding a new subsystem, wire it through the CLI end-to-end in the smallest usable form first.
- A heavier TUI is now justified when it replaces brittle hand-rolled terminal state management. Prefer phased introduction over a one-shot rewrite.

## Expected architecture direction

- `src/cli.ts`: parse user input and flags.
- `src/utils/env.ts`: validate environment variables and config loading.
- `src/llm/types.ts`: shared model/message/types contracts.
- `src/llm/router.ts`: choose provider/model implementation.
- `src/llm/openai_compatible.ts`: provider adapter implementation.
- `src/agent/loop.ts`: main agent loop, prompt assembly, tool call orchestration, and final response handling.

## Priorities for upcoming work

1. Continue stabilizing the TTY composer and begin the phased migration toward an Ink-based heavier TUI shell, starting with render-only surfaces and keeping non-TTY flows unchanged.
2. Design the write path explicitly instead of letting it leak through ad hoc shell usage. Keep command execution and file editing as separate capabilities.
3. Harden default-mode command policy with clearer allow/deny behavior, better surfaced failures, and room for future approval hooks.
4. Add the second strict-mode read-only tool, likely line-bounded file reading, so strict mode remains useful without command access.
5. Refine prompt handling so the centralized system prompt can evolve without confusing older saved sessions.

## Implementation preferences

- Favor a thin vertical slice that can actually run over partially building every layer.
- Keep prompts and model-facing message construction centralized rather than scattered across files.
- Keep the default coding-agent path centered on command execution plus explicit policy, while preserving narrow specialized tools for strict mode.
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
