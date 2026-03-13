export type CommandApprovalMode = "ask" | "allow-all" | "reject";

export type CommandCategory =
  | "read"
  | "write"
  | "execute"
  | "network"
  | "high-risk";

export type CommandAssessment = {
  command: string;
  cwd: string;
  category: CommandCategory;
  summary: string;
  reasons: string[];
  approvalRequired: boolean;
};

export type CommandApprovalDecision = "once" | "always" | "reject";

export type CommandApprovalRequest = {
  assessment: CommandAssessment;
  approvalMode: CommandApprovalMode;
};

export type CommandHookEvent =
  | {
      stage: "before";
      approvalMode: CommandApprovalMode;
      assessment: CommandAssessment;
    }
  | {
      stage: "after";
      approvalMode: CommandApprovalMode;
      assessment: CommandAssessment;
      result: {
        exitCode: number | null;
        timedOut: boolean;
        truncated: boolean;
      };
    };

export type CommandHookResult = {
  action?: "allow" | "block";
  message?: string;
};

export type CommandPolicyContext = {
  getMode: () => CommandApprovalMode;
  setMode: (mode: CommandApprovalMode) => void;
  requestApproval?: (
    request: CommandApprovalRequest,
  ) => Promise<CommandApprovalDecision>;
  runHook?: (event: CommandHookEvent) => Promise<CommandHookResult | void>;
};

export type ToolExecutionContext = {
  commandPolicy?: CommandPolicyContext;
};
