# SuperRun Agent Guide

## Project intent

- This repository is building a local coding agent CLI in the style of Claude Code.
- The current stage is very early: only a minimal CLI entry exists.
- Prioritize small, composable steps over broad architecture rewrites.

## Current implementation

- Runtime: Node.js + TypeScript + ESM.
- CLI entry: `src/index.ts` calls Commander setup from `src/cli.ts`.
- Current command shape: `miko <prompt>`.
- `src/cli.ts` loads `.env`, accepts a single prompt argument, and streams the assistant response to stdout.
- `src/agent/loop.ts` builds a minimal system+user message list and performs a single model call.
- `src/llm/types.ts` defines the shared chat message, chat options, and client interface types.
- `src/llm/router.ts` currently routes all requests to a single OpenAI-compatible client.
- `src/llm/openai_compatible.ts` implements a working OpenAI-compatible chat completion adapter, including basic streaming and proxy support.
- `src/utils/env.ts` validates `OPENAI_API_KEY` and reads base URL, model, and timeout settings from the environment.

## Working rules

- Keep the codebase simple and readable. This project is still defining its base abstractions.
- Preserve ESM-style imports with `.js` extensions in TypeScript source where needed.
- Do not introduce heavy frameworks or complex dependency trees unless clearly justified.
- Prefer explicit types and small modules over clever abstractions.
- When adding a new subsystem, wire it through the CLI end-to-end in the smallest usable form first.

## Expected architecture direction

- `src/cli.ts`: parse user input and flags.
- `src/utils/env.ts`: validate environment variables and config loading.
- `src/llm/types.ts`: shared model/message/types contracts.
- `src/llm/router.ts`: choose provider/model implementation.
- `src/llm/openaiComptale.ts`: provider adapter implementation.
- `src/agent/loop.ts`: main agent loop, prompt assembly, tool call orchestration, and final response handling.

## Priorities for upcoming work

1. Add conversation state so the CLI can support multi-turn exchanges instead of a single request/response.
2. Centralize prompt assembly in `src/agent/loop.ts` so system instructions and future tool messages stay in one place.
3. Tighten CLI UX with explicit flags for model/provider overrides and clearer invalid-usage handling.
4. Add focused tests for env validation, router behavior, and agent loop message assembly.
5. Only after multi-turn chat is stable, introduce a narrow tool interface for local command execution or file operations.

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
- No test suite exists yet. If behavior becomes non-trivial, add focused tests around parsing, env validation, and agent loop behavior.
