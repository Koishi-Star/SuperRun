import type {
  CommandAssessment,
  CommandApprovalMode,
  CommandAuthorizationAction,
  CommandCategory,
  CommandHookEvent,
  CommandPolicyContext,
} from "./types.js";

export const COMMAND_APPROVAL_MODES = [
  "ask",
  "allow-all",
  "crazy_auto",
  "reject",
] as const;

type CommandRule = {
  category: CommandCategory;
  summary: string;
  reason: string;
  pattern: RegExp;
  modeActions: {
    ask: CommandAuthorizationAction;
    allowAll: CommandAuthorizationAction;
    crazyAuto: CommandAuthorizationAction;
  };
};

const DENY_UNLESS_CRAZY_AUTO_RULES: CommandRule[] = [
  {
    category: "workspace-write",
    summary: "Shell output redirection writes files outside the edit tools",
    reason: "shell redirection can overwrite files.",
    pattern: /(?:^|[^\S\r\n])\d*>>?\s*/i,
    modeActions: denyUnlessCrazyAuto(),
  },
  {
    category: "workspace-write",
    summary: "tee-style output capture writes files outside the edit tools",
    reason: "tee-style output capture can write files.",
    pattern: /\|\s*tee\b/i,
    modeActions: denyUnlessCrazyAuto(),
  },
  {
    category: "destructive",
    summary: "Destructive shell command",
    reason: "recursive or direct deletion can remove workspace data.",
    pattern:
      /\b(?:rm|del|erase|rmdir|rd|remove-item)\b(?:[^\r\n]|$)*(?:\s+-r|\s+-rf|\s+\/s|\s+-recurse|\s+-force|\s+\/q)?/i,
    modeActions: denyUnlessCrazyAuto(),
  },
  {
    category: "download-exec",
    summary: "Download-and-execute command",
    reason: "downloaded scripts piped into a shell are especially risky.",
    pattern:
      /\b(?:curl|wget|Invoke-WebRequest|iwr|irm)\b[^\r\n|]*(?:\||;|&&)\s*(?:bash|sh|zsh|fish|pwsh|powershell(?:\.exe)?|cmd(?:\.exe)?)\b/i,
    modeActions: denyUnlessCrazyAuto(),
  },
];

const NETWORK_RULES: CommandRule[] = [
  {
    category: "network",
    summary: "Network fetch command",
    reason: "network commands can exfiltrate data or fetch untrusted content.",
    pattern: /\b(?:curl|wget|Invoke-WebRequest|iwr|irm)\b/i,
    modeActions: askUntilCrazyAuto(),
  },
];

const WORKSPACE_WRITE_RULES: CommandRule[] = [
  {
    category: "workspace-write",
    summary: "Workspace write command",
    reason: "file-modifying commands can change the workspace.",
    pattern:
      /\b(?:move-item|rename-item|copy-item|set-content|add-content|out-file|new-item|clear-content|set-item|touch|mkdir|mktemp|cp|mv)\b/i,
    modeActions: denyUnlessCrazyAuto(),
  },
  {
    category: "vcs-write",
    summary: "Git state-changing command",
    reason: "git state-changing commands can rewrite repository state.",
    pattern:
      /\bgit\s+(?:add|am|apply|bisect|checkout|cherry-pick|clean|clone|commit|fetch|merge|pull|push|rebase|reset|restore|revert|stash|switch|tag|worktree)\b/i,
    modeActions: askUntilCrazyAuto(),
  },
  {
    category: "env-mutate",
    summary: "Package or environment mutation command",
    reason: "package-manager commands can change dependencies or scripts.",
    pattern:
      /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:add|create|dlx|exec|install|link|publish|remove|run\s+prepare|set|uninstall|unlink|update|upgrade)|(?:(?:python|python3|py)\s+-m\s+pip|pip(?:3)?)\s+(?:install|uninstall|download|wheel)|(?:conda|mamba)\s+(?:create|install|remove|uninstall|update|upgrade)|uv\s+(?:pip\s+install|sync)|poetry\s+(?:add|install|remove|update))\b/i,
    modeActions: askUntilCrazyAuto(),
  },
  {
    category: "workspace-write",
    summary: "In-place file edit command",
    reason: "in-place editors modify files directly.",
    pattern: /\b(?:sed\b[^\r\n]*\s-i(?:\s|$)|perl\b[^\r\n]*\s-pi(?:\s|$))\b/i,
    modeActions: denyUnlessCrazyAuto(),
  },
];

const READ_RULES: CommandRule[] = [
  {
    category: "read",
    summary: "Read-only git status command",
    reason: "git status inspects repository state without modifying it.",
    pattern: /\bgit\s+status\b/i,
    modeActions: allowInAllModes(),
  },
  {
    category: "read",
    summary: "Read-only git diff command",
    reason: "git diff inspects repository state without modifying it.",
    pattern: /\bgit\s+diff\b/i,
    modeActions: allowInAllModes(),
  },
  {
    category: "read",
    summary: "Read-only search command",
    reason: "search and listing commands are inspection-oriented.",
    pattern:
      /\b(?:cat|type|Get-Content|ls|dir|find|rg|ripgrep|fd|tree|pwd|Get-ChildItem|Select-String)\b/i,
    modeActions: allowInAllModes(),
  },
];

export function isCommandApprovalMode(
  value: string | null | undefined,
): value is CommandApprovalMode {
  return COMMAND_APPROVAL_MODES.includes(
    (value?.trim().toLowerCase() ?? "") as CommandApprovalMode,
  );
}

export function parseCommandApprovalMode(
  value: string | null | undefined,
): (typeof COMMAND_APPROVAL_MODES)[number] {
  const normalized = value?.trim().toLowerCase() ?? "ask";
  if (isCommandApprovalMode(normalized)) {
    return normalized;
  }

  throw new Error(
    `Invalid approval mode: ${value}. Use "ask", "allow-all", "crazy_auto", or "reject".`,
  );
}

export function getCommandApprovalSummary(
  mode: (typeof COMMAND_APPROVAL_MODES)[number],
): string {
  if (mode === "crazy_auto") {
    return "crazy_auto (auto-approve file edits and even elevated-risk shell commands for this session)";
  }

  if (mode === "allow-all") {
    return "allow-all (auto-approve file edits and ordinary shell commands, but still gate elevated-risk commands)";
  }

  if (mode === "reject") {
    return "reject (deny file edits and command execution)";
  }

  return "ask (auto-run read-only commands and prompt before file edits or other shell commands)";
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

  for (const rule of DENY_UNLESS_CRAZY_AUTO_RULES) {
    if (rule.pattern.test(normalizedCommand)) {
      return buildAssessment(normalizedCommand, cwd, rule);
    }
  }

  for (const rule of NETWORK_RULES) {
    if (rule.pattern.test(normalizedCommand)) {
      return buildAssessment(normalizedCommand, cwd, rule);
    }
  }

  for (const rule of WORKSPACE_WRITE_RULES) {
    if (rule.pattern.test(normalizedCommand)) {
      return buildAssessment(normalizedCommand, cwd, rule);
    }
  }

  for (const rule of READ_RULES) {
    if (rule.pattern.test(normalizedCommand)) {
      return buildAssessment(normalizedCommand, cwd, rule);
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
    modeActions: {
      ask: "ask",
      allowAll: "allow",
      crazyAuto: "allow",
    },
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

  const action = getCommandAuthorizationAction(assessment, approvalMode);
  if (action === "deny") {
    throw new Error(buildPolicyDenialMessage(assessment));
  }

  if (action === "allow") {
    await runHookOrThrow(policy, {
      stage: "before",
      approvalMode,
      assessment,
    });
    return;
  }

  const requestApproval = policy?.requestApproval;
  if (!requestApproval) {
    if (approvalMode === "crazy_auto") {
      throw new Error("run_command entered an unreachable approval state under crazy_auto.");
    }

    throw new Error(buildApprovalRequiredMessage(assessment, approvalMode));
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
): CommandAssessment {
  return {
    command,
    cwd,
    category: rule.category,
    summary: rule.summary,
    reasons: [rule.reason],
    modeActions: rule.modeActions,
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

function allowInAllModes(): CommandRule["modeActions"] {
  return {
    ask: "allow",
    allowAll: "allow",
    crazyAuto: "allow",
  };
}

function askUntilCrazyAuto(): CommandRule["modeActions"] {
  return {
    ask: "ask",
    allowAll: "ask",
    crazyAuto: "allow",
  };
}

function denyUnlessCrazyAuto(): CommandRule["modeActions"] {
  return {
    ask: "deny",
    allowAll: "deny",
    crazyAuto: "allow",
  };
}

function getCommandAuthorizationAction(
  assessment: CommandAssessment,
  mode: Exclude<CommandApprovalMode, "reject">,
): CommandAuthorizationAction {
  if (mode === "crazy_auto") {
    return assessment.modeActions.crazyAuto;
  }

  if (mode === "allow-all") {
    return assessment.modeActions.allowAll;
  }

  return assessment.modeActions.ask;
}

function buildApprovalRequiredMessage(
  assessment: CommandAssessment,
  approvalMode: Exclude<CommandApprovalMode, "reject" | "crazy_auto">,
): string {
  if (approvalMode === "allow-all") {
    return `run_command requires interactive approval for ${assessment.category} commands. This elevated-risk command still stays gated under allow-all. Re-run in the Ink TTY shell to approve it, or switch approvals to crazy_auto.`;
  }

  const escalationTarget =
    assessment.modeActions.allowAll === "allow" ? "allow-all" : "crazy_auto";

  return `run_command requires approval for ${assessment.category} commands. Re-run in a TTY to approve it, or switch approvals to ${escalationTarget}.`;
}

function buildPolicyDenialMessage(assessment: CommandAssessment): string {
  switch (assessment.category) {
    case "download-exec":
      return "run_command blocked by policy: downloaded scripts cannot be piped straight into a shell outside crazy_auto. Download the script first, inspect it, then run it.";
    case "workspace-write":
      return "run_command blocked by policy: shell-based workspace writes must go through the explicit file edit tools unless approvals are set to crazy_auto.";
    case "destructive":
      return "run_command blocked by policy: destructive shell commands are disabled outside crazy_auto.";
    default:
      return `run_command blocked by policy: ${assessment.summary.toLowerCase()} is disabled outside crazy_auto.`;
  }
}
