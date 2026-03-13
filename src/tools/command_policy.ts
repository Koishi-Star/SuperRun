import type {
  CommandApprovalRequest,
  CommandAssessment,
  CommandCategory,
  CommandHookEvent,
  CommandHookResult,
  CommandPolicyContext,
} from "./types.js";

export const COMMAND_APPROVAL_MODES = ["ask", "allow-all", "reject"] as const;

type CommandRule = {
  category: CommandCategory;
  summary: string;
  reason: string;
  pattern: RegExp;
};

const HIGH_RISK_RULES: CommandRule[] = [
  {
    category: "high-risk",
    summary: "High-risk command with output redirection",
    reason: "shell redirection can overwrite files.",
    pattern: /(?:^|[^\S\r\n])\d*>>?\s*/i,
  },
  {
    category: "high-risk",
    summary: "High-risk command with tee-style output capture",
    reason: "tee-style output capture can write files.",
    pattern: /\|\s*tee\b/i,
  },
  {
    category: "high-risk",
    summary: "High-risk destructive delete command",
    reason: "recursive or direct deletion can remove workspace data.",
    pattern:
      /\b(?:rm|del|erase|rmdir|rd|remove-item)\b(?:[^\r\n]|$)*(?:\s+-r|\s+-rf|\s+\/s|\s+-recurse|\s+-force|\s+\/q)?/i,
  },
  {
    category: "high-risk",
    summary: "High-risk download-and-execute command",
    reason: "downloaded scripts piped into a shell are especially risky.",
    pattern:
      /\b(?:curl|wget|Invoke-WebRequest|iwr|irm)\b[^\r\n|]*(?:\||;|&&)\s*(?:bash|sh|zsh|fish|pwsh|powershell(?:\.exe)?|cmd(?:\.exe)?)\b/i,
  },
];

const NETWORK_RULES: CommandRule[] = [
  {
    category: "network",
    summary: "Network command",
    reason: "network commands can exfiltrate data or fetch untrusted content.",
    pattern: /\b(?:curl|wget|Invoke-WebRequest|iwr|irm)\b/i,
  },
];

const WRITE_RULES: CommandRule[] = [
  {
    category: "write",
    summary: "Workspace write command",
    reason: "file-modifying commands can change the workspace.",
    pattern:
      /\b(?:move-item|rename-item|copy-item|set-content|add-content|out-file|new-item|clear-content|set-item|touch|mkdir|mktemp|cp|mv|install)\b/i,
  },
  {
    category: "write",
    summary: "Git write command",
    reason: "git state-changing commands can rewrite repository state.",
    pattern:
      /\bgit\s+(?:add|am|apply|bisect|checkout|cherry-pick|clean|clone|commit|fetch|merge|pull|push|rebase|reset|restore|revert|stash|switch|tag|worktree)\b/i,
  },
  {
    category: "write",
    summary: "Package-management write command",
    reason: "package-manager commands can change dependencies or scripts.",
    pattern:
      /\b(?:npm|pnpm|yarn|bun)\s+(?:add|create|dlx|exec|install|link|publish|remove|run\s+prepare|set|uninstall|unlink|update|upgrade)\b/i,
  },
  {
    category: "write",
    summary: "In-place file edit command",
    reason: "in-place editors modify files directly.",
    pattern: /\b(?:sed\b[^\r\n]*\s-i(?:\s|$)|perl\b[^\r\n]*\s-pi(?:\s|$))\b/i,
  },
];

const READ_RULES: CommandRule[] = [
  {
    category: "read",
    summary: "Read-only git status command",
    reason: "git status inspects repository state without modifying it.",
    pattern: /\bgit\s+status\b/i,
  },
  {
    category: "read",
    summary: "Read-only git diff command",
    reason: "git diff inspects repository state without modifying it.",
    pattern: /\bgit\s+diff\b/i,
  },
  {
    category: "read",
    summary: "Read-only search command",
    reason: "search and listing commands are inspection-oriented.",
    pattern:
      /\b(?:cat|type|Get-Content|ls|dir|find|rg|ripgrep|fd|tree|pwd|Get-ChildItem|Select-String)\b/i,
  },
];

export function parseCommandApprovalMode(
  value: string | null | undefined,
): (typeof COMMAND_APPROVAL_MODES)[number] {
  const normalized = value?.trim().toLowerCase() ?? "ask";
  if (normalized === "ask" || normalized === "allow-all" || normalized === "reject") {
    return normalized;
  }

  throw new Error(
    `Invalid approval mode: ${value}. Use "ask", "allow-all", or "reject".`,
  );
}

export function getCommandApprovalSummary(
  mode: (typeof COMMAND_APPROVAL_MODES)[number],
): string {
  if (mode === "allow-all") {
    return "allow-all (auto-approve file edits and command execution for this session)";
  }

  if (mode === "reject") {
    return "reject (deny file edits and command execution)";
  }

  return "ask (prompt before file edits or non-read-only command execution)";
}

export function classifyCommand(
  command: string,
  cwd: string,
): CommandAssessment {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) {
    throw new Error("run_command must not be empty.");
  }

  if (/[\r\n]/.test(normalizedCommand)) {
    throw new Error("run_command must be a single-line command.");
  }

  for (const rule of HIGH_RISK_RULES) {
    if (rule.pattern.test(normalizedCommand)) {
      return buildAssessment(normalizedCommand, cwd, rule, true);
    }
  }

  for (const rule of NETWORK_RULES) {
    if (rule.pattern.test(normalizedCommand)) {
      return buildAssessment(normalizedCommand, cwd, rule, true);
    }
  }

  for (const rule of WRITE_RULES) {
    if (rule.pattern.test(normalizedCommand)) {
      return buildAssessment(normalizedCommand, cwd, rule, true);
    }
  }

  for (const rule of READ_RULES) {
    if (rule.pattern.test(normalizedCommand)) {
      return buildAssessment(normalizedCommand, cwd, rule, false);
    }
  }

  return {
    command: normalizedCommand,
    cwd,
    category: "execute",
    summary: "General shell execution",
    reasons: [
      "this command does not match a read-only rule and may execute arbitrary programs.",
    ],
    approvalRequired: true,
  };
}

export async function authorizeCommand(
  assessment: CommandAssessment,
  policy: CommandPolicyContext | undefined,
): Promise<void> {
  const approvalMode = policy?.getMode() ?? "allow-all";

  if (approvalMode === "reject") {
    throw new Error(
      `run_command rejected by policy: approvals are set to reject for ${assessment.category} commands.`,
    );
  }

  if (!assessment.approvalRequired || approvalMode === "allow-all") {
    await runHookOrThrow(policy, {
      stage: "before",
      approvalMode,
      assessment,
    });
    return;
  }

  const requestApproval = policy?.requestApproval;
  if (!requestApproval) {
    throw new Error(
      `run_command requires approval for ${assessment.category} commands. Re-run in a TTY or switch approvals to allow-all.`,
    );
  }

  const decision = await requestApproval({
    assessment,
    approvalMode,
  });
  if (decision === "reject") {
    throw new Error(
      `run_command rejected by user: ${assessment.summary.toLowerCase()}.`,
    );
  }

  if (decision === "always") {
    policy?.setMode("allow-all");
  }

  await runHookOrThrow(policy, {
    stage: "before",
    approvalMode: policy?.getMode() ?? approvalMode,
    assessment,
  });
}

export async function runAfterCommandHook(
  policy: CommandPolicyContext | undefined,
  event: Extract<CommandHookEvent, { stage: "after" }>,
): Promise<void> {
  await runHookOrThrow(policy, event);
}

function buildAssessment(
  command: string,
  cwd: string,
  rule: CommandRule,
  approvalRequired: boolean,
): CommandAssessment {
  return {
    command,
    cwd,
    category: rule.category,
    summary: rule.summary,
    reasons: [rule.reason],
    approvalRequired,
  };
}

async function runHookOrThrow(
  policy: CommandPolicyContext | undefined,
  event: CommandHookEvent,
): Promise<void> {
  const result = await policy?.runHook?.(event);
  if (result?.action === "block") {
    throw new Error(result.message || "run_command blocked by hook.");
  }
}
