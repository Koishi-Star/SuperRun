import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  editSystemPromptExternally,
  finalizeExternalSystemPromptEdit,
} from "../src/ui/external-editor.js";

test("finalizeExternalSystemPromptEdit treats newline-only churn as unchanged", () => {
  assert.deepEqual(
    finalizeExternalSystemPromptEdit("You are concise.", "You are concise.\n"),
    {
      status: "unchanged",
    },
  );
});

test("editSystemPromptExternally returns unchanged when the editor does not modify the file", async () => {
  await withEditorScript("unchanged", async () => {
    assert.deepEqual(
      await editSystemPromptExternally("You are concise."),
      {
        status: "unchanged",
      },
    );
  });
});

test("editSystemPromptExternally returns the updated prompt when the editor rewrites the file", async () => {
  await withEditorScript("updated", async () => {
    assert.deepEqual(
      await editSystemPromptExternally("You are concise."),
      {
        status: "updated",
        value: "You are a strict reviewer.",
      },
    );
  });
});

test("editSystemPromptExternally rejects empty prompt content", async () => {
  await withEditorScript("blank", async () => {
    await assert.rejects(
      () => editSystemPromptExternally("You are concise."),
      /System prompt must not be empty\./,
    );
  });
});

async function withEditorScript(
  mode: "unchanged" | "updated" | "blank",
  run: () => Promise<void>,
): Promise<void> {
  const tempDirectoryPath = await mkdtemp(
    path.join(os.tmpdir(), "superrun-external-editor-test-"),
  );
  const scriptPath = path.join(tempDirectoryPath, "editor.cjs");
  const previousEditor = process.env.EDITOR;
  const previousVisual = process.env.VISUAL;
  const previousMode = process.env.SUPERRUN_TEST_EDITOR_MODE;

  try {
    await writeFile(
      scriptPath,
      [
        'const fs = require("node:fs");',
        'const filePath = process.argv[2];',
        'const mode = process.env.SUPERRUN_TEST_EDITOR_MODE;',
        'if (mode === "updated") {',
        '  fs.writeFileSync(filePath, "You are a strict reviewer.\\n", "utf8");',
        '}',
        'if (mode === "blank") {',
        '  fs.writeFileSync(filePath, "\\n", "utf8");',
        '}',
      ].join("\n"),
      "utf8",
    );

    process.env.EDITOR = `"${process.execPath}" "${scriptPath}"`;
    delete process.env.VISUAL;
    process.env.SUPERRUN_TEST_EDITOR_MODE = mode;

    await run();
  } finally {
    if (previousEditor === undefined) {
      delete process.env.EDITOR;
    } else {
      process.env.EDITOR = previousEditor;
    }

    if (previousVisual === undefined) {
      delete process.env.VISUAL;
    } else {
      process.env.VISUAL = previousVisual;
    }

    if (previousMode === undefined) {
      delete process.env.SUPERRUN_TEST_EDITOR_MODE;
    } else {
      process.env.SUPERRUN_TEST_EDITOR_MODE = previousMode;
    }

    await rm(tempDirectoryPath, { recursive: true, force: true });
  }
}
