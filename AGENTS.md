# SuperRun Agent Guide

## Project intent
- This repository is building a local coding agent CLI in the style of Claude Code.
- The current stage is very early: only a minimal CLI entry exists.
- Prioritize small, composable steps over broad architecture rewrites.

## Current implementation
- Runtime: Node.js + TypeScript + ESM.
- CLI entry: `src/index.ts` calls Commander setup from `src/cli.ts`.
- Current command shape: `miko <prompt>`.
- `src/cli.ts` only prints the user prompt and a placeholder assistant response.
- `src/agent/loop.ts`, `src/llm/router.ts`, `src/llm/openaiComptale.ts`, `src/llm/types.ts`, and `src/utils/env.ts` are present but effectively empty.

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
1. Replace the placeholder response in `src/cli.ts` with a real call into `src/agent/loop.ts`.
2. Define minimal shared LLM types before adding provider-specific logic.
3. Implement environment parsing for API keys and model selection.
4. Add one working provider path end-to-end before supporting multiple providers or tools.
5. Add basic error messages for missing config, provider failures, and invalid CLI usage.

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
- There is mojibake in the placeholder assistant output in `src/cli.ts`; treat it as temporary placeholder text and replace it when touching that flow.
- No test suite exists yet. If behavior becomes non-trivial, add focused tests around parsing, env validation, and agent loop behavior.
