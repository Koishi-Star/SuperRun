export type CommandApprovalMode =
  | "ask"
  | "allow-all"
  | "crazy_auto"
  | "reject";

export type CommandAuthorizationAction = "allow" | "ask" | "deny";

export type CommandCategory =
  | "read"
  | "execute"
  | "workspace-write"
  | "env-mutate"
  | "network"
  | "vcs-write"
  | "download-exec"
  | "destructive";

export type CommandAssessment = {
  command: string;
  cwd: string;
  category: CommandCategory;
  summary: string;
  reasons: string[];
  modeActions: {
    ask: CommandAuthorizationAction;
    allowAll: CommandAuthorizationAction;
    crazyAuto: CommandAuthorizationAction;
  };
};

export type CommandApprovalDecision = "once" | "always" | "reject";

export type CommandApprovalRequest = {
  assessment: CommandAssessment;
  approvalMode: CommandApprovalMode;
};

export type WorkspaceEditAssessment = {
  tool:
    | "write_file"
    | "replace_lines"
    | "insert_lines"
    | "delete_file"
    | "restore_deleted_file"
    | "purge_deleted_file"
    | "empty_delete_area";
  path: string;
  summary: string;
  reasons: string[];
  approvalRequired: boolean;
  diffPreview?: WorkspaceEditDiffPreview;
};

export type WorkspaceEditDiffPreviewLine = {
  kind: "context" | "add" | "remove";
  oldLineNumber: number | null;
  newLineNumber: number | null;
  text: string;
};

export type WorkspaceEditChangeSummary = {
  changedLines: number;
  addedLines: number;
  removedLines: number;
};

export type WorkspaceEditDiffPreview = {
  title: string;
  summary: string;
  changeSummary: WorkspaceEditChangeSummary;
  truncated: boolean;
  lines: WorkspaceEditDiffPreviewLine[];
};

export type WorkspaceEditApprovalRequest = {
  assessment: WorkspaceEditAssessment;
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

export type WorkspaceEditPolicyContext = {
  getMode: () => CommandApprovalMode;
  setMode: (mode: CommandApprovalMode) => void;
  requestApproval?: (
    request: WorkspaceEditApprovalRequest,
  ) => Promise<CommandApprovalDecision>;
};

export type ToolNotice = {
  level: "info" | "warning" | "error";
  message: string;
};

export type WorkspaceEditReviewEvent = {
  kind: "workspace_edit_review";
  tool: WorkspaceEditAssessment["tool"];
  path: string;
  summary: string;
  approvalMode: CommandApprovalMode;
  autoApproved: boolean;
  diffPreview: WorkspaceEditDiffPreview;
};

export type ToolTurnEvent =
  | {
      kind: "notice";
      level: ToolNotice["level"];
      message: string;
    }
  | WorkspaceEditReviewEvent;

export type ToolNoticeContext = {
  addNotice: (notice: ToolNotice) => void;
};

export type ToolTurnEventContext = {
  addEvent: (event: ToolTurnEvent) => void;
};

export type ToolExecutionContext = {
  commandPolicy?: CommandPolicyContext;
  workspaceEditPolicy?: WorkspaceEditPolicyContext;
  notices?: ToolNoticeContext;
  turnEvents?: ToolTurnEventContext;
};
