# SuperRun Agent Guide

## Project intent

- This repository is building a local coding agent CLI in the style of Claude Code.
- The current stage is still early, but the repository now has a working chat slice instead of only a minimal CLI entry.
- Prioritize small, composable steps over broad architecture rewrites.

## Current implementation

- Runtime: Node.js + TypeScript + ESM.
- CLI entry: `src/index.ts` calls Commander setup from `src/cli.ts`.
- Current command shape: `superrun [prompt]`.
- `src/cli.ts` loads `.env`, supports single-turn prompt mode and interactive multi-turn chat mode, exposes `--mode <default|strict>` and `--approvals <ask|allow-all|reject>`, renders TTY sessions through the current Ink-based interactive shell, and wires local slash commands for settings, history browsing, filtered session browsing, session management, runtime mode switching, command approval switching, inline/external system prompt editing, and local `@file` suggestion support while typing.
- `src/agent/loop.ts` manages session state, message history, system prompt assembly, lightweight history truncation, per-turn model calls, and a mode-aware tool-calling loop.
- `src/prompts/system.ts` centralizes the base system prompt used for each session.
- `src/config/settings.ts` persists the default system prompt profile used across runs.
- `src/config/paths.ts` centralizes where local config and session files are stored.
- `src/llm/types.ts` defines the shared chat message, tool call, chat options, and client interface types.
- `src/llm/router.ts` currently routes all requests to a single OpenAI-compatible client.
- `src/llm/openai_compatible.ts` implements a working OpenAI-compatible chat completion adapter, including basic streaming, proxy support, and function-call parsing.
- `src/utils/env.ts` validates `OPENAI_API_KEY` and reads base URL, model, and timeout settings from the environment.
- `src/session/store.ts` persists multiple saved sessions, tracks the active session, derives session titles and previews, and restores sessions across CLI runs.
- `src/tools/run_command.ts` implements the default-mode command tool with workspace scoping, timeout/output bounds, command classification, interactive approval handoff, and pre/post hook integration.
- `src/tools/list_files.ts` implements the first strict-mode local read-only tool for repository structure inspection under the workspace root.
- `src/tools/workspace.ts` centralizes workspace-relative path validation shared by local tools.
- `src/ui/tui.ts` contains lightweight terminal formatting helpers and command/help rendering used by the interactive flows.
- `src/ui/tty-prompt.ts` retains the older imperative TTY composer path used by tests and transitional utilities while the main interactive loop moves behind Ink.
- `src/ui/composer-state.ts` centralizes the shared composer state machine used by both the Ink renderer and the legacy imperative prompt path.
- `src/ui/input-events.ts` normalizes Ink key/input payloads into semantic composer and overlay events so the UI stops depending on library-specific key flags.
- `src/ui/file-reference.ts` handles workspace file indexing plus `@file` query parsing, escape handling, validation, and matching.
- `src/ui/session-picker.ts` models the paged `/sessions` picker state, navigation, and view data for TTY mode.
- `src/ui/mode-picker.ts` provides the option list shown by the `/mode` picker in TTY mode.
- `src/ui/external-editor.ts` opens an external text editor (resolved from `VISUAL`/`EDITOR` env vars) so users can edit the system prompt in a temp file, diffing before/after to detect changes.
- `src/ui/interactive-renderer.tsx` provides a React + Ink-based renderer that manages the interactive TTY surface: log lines, prompt input, overlay pickers, Windows-aware backspace/delete handling, and real-time file-suggestion updates.
- `src/ui/text-width.ts` re-exports terminal display-width utilities from `terminal_format` for measuring multi-byte/wide character widths.
- `src/ui/ink/interactive-shell.tsx` is the top-level Ink React component that composes the full interactive shell: header, log lines, overlay picker, composer prompt with suggestions and error display, and status bar.
- `src/agent/mode.ts` defines the agent mode enum (`default` | `strict`), parsing helpers, and mode summary strings used throughout the agent loop and UI.
- `src/tools/types.ts` defines TypeScript types for the command policy system: approval modes, risk categories, command assessment, hooks, and tool execution context.
- `src/tools/command_policy.ts` implements risk assessment for shell commands, classifying them as high-risk, network, write, or read using regex pattern matching.
- `src/tools/command_hooks.ts` runs pre/post command hooks from `SUPERRUN_PRE_COMMAND_HOOK` / `SUPERRUN_POST_COMMAND_HOOK` env vars; hooks can return JSON actions to allow or block execution.
- `src/tools/shell.ts` provides a cross-platform shell wrapper that returns PowerShell arguments on Windows and sh/bash on Unix, abstracting shell differences for `run_command`.
- `src/tools/index.ts` is the tool system entry point: exports tool definitions and routes tool calls based on the active agent mode.
- `test/` contains focused tests for env parsing, system prompt settings and external editing, session store behavior, picker rendering, command policy and hooks, semantic input normalization, interactive renderer behavior, provider reasoning-content passthrough, history handling, and interactive CLI behavior using a local mock OpenAI-compatible server.

## Project progress

- Done: single-turn prompts, interactive multi-turn chat, streaming responses, centralized system prompt assembly, persistent system prompt settings, lightweight history truncation, multi-session persistence across runs, active session restore, session rename, session switching by id/index/title, richer `/sessions` previews, saved history viewing, `/sessions [query]` filtering, Ink-owned `/sessions` `/mode` `/approvals` overlay pickers, process-level agent modes (`default` and opt-in `strict`), command approval modes (`ask`, `allow-all`, `reject`), guarded `run_command` in default mode, strict-mode-only specialized tools, provider `reasoning_content` passthrough across tool rounds, local `@file` validation/suggestions, a semantic Ink input layer, command risk classification via `command_policy.ts`, pre/post command hook execution via `command_hooks.ts`, cross-platform shell abstraction, external editor support for system prompt editing, and an Ink-rendered interactive shell that now drives the main TTY prompt loop.
- Not done yet: structured file writing/editing, a second strict-mode read-only tool for file content inspection, prompt/version handling for evolving system prompts, richer TTY session actions beyond switching, stronger long-term command policy/trust controls, multi-provider routing, fully retiring the remaining readline/legacy TTY fallbacks, and a broader visual polish pass for the Ink shell.
- Current maturity: the chat loop is now viable as an early coding agent because default mode can inspect and verify work through commands and can pause for approval before non-read-only shell execution, but write-path design and policy hardening are still intentionally incomplete.

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

1. Continue consolidating interactive TTY flows around the Ink shell by retiring the remaining readline/legacy TTY fallbacks and moving platform-specific key normalization behind one semantic input adapter.
2. Design the write path explicitly instead of letting it leak through ad hoc shell usage. Keep command execution and file editing as separate capabilities.
3. Harden default-mode command policy beyond the current heuristic classifier, approval modes, and hook points with clearer trust boundaries and better surfaced failures.
4. Add the second strict-mode read-only tool, likely line-bounded file reading, so strict mode remains useful without command access.
5. Build out the Ink shell layout and visual language only after the TTY lifecycle is fully owned by one runtime path.

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
- Command approvals, command hooks, and external-editor-based system prompt editing are already wired through the CLI.
- The current TTY shell is already running through Ink, and the main picker flows now render as Ink overlays instead of separate prompt systems.
- Remaining terminal-state boundaries are intentionally narrow: non-TTY readline fallback, no-UI command approval fallback, the legacy `tty-prompt` test helper, and the external-editor handoff used by `/editor`.
- `useInput` can emit a duplicate-key warning inside `node:test` even when runtime keys are unique; renderer tests disable live Ink input hooks to keep the suite signal clean.
- The project now has a small `node:test` suite executed via `npm test`.
