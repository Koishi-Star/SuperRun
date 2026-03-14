import type {
  CommandApprovalDecision,
  CommandApprovalMode,
  CommandCategory,
  WorkspaceEditAssessment,
  WorkspaceEditChangeSummary,
} from "../tools/types.js";

export type SessionEvent =
  | {
      timestamp: string;
      kind: "approval_requested";
      approvalKind: "command" | "workspace_edit";
      summary: string;
      subject: string;
      category?: CommandCategory;
      tool?: WorkspaceEditAssessment["tool"];
      path?: string;
    }
  | {
      timestamp: string;
      kind: "approval_decided";
      approvalKind: "command" | "workspace_edit";
      summary: string;
      subject: string;
      decision: CommandApprovalDecision;
      modeBefore: CommandApprovalMode;
      modeAfter: CommandApprovalMode;
      category?: CommandCategory;
      tool?: WorkspaceEditAssessment["tool"];
      path?: string;
    }
  | {
      timestamp: string;
      kind: "approval_mode_changed";
      from: CommandApprovalMode;
      to: CommandApprovalMode;
      source: "slash_command" | "approval_decision";
    }
  | {
      timestamp: string;
      kind: "workspace_edit_applied";
      tool: WorkspaceEditAssessment["tool"];
      path: string;
      summary: string;
      approvalMode: CommandApprovalMode;
      autoApproved: boolean;
      changeSummary: WorkspaceEditChangeSummary;
    }
  | {
      timestamp: string;
      kind: "tool_notice";
      level: "info" | "warning" | "error";
      message: string;
    };

export function createSessionEventTimestamp(): string {
  return new Date().toISOString();
}

export function formatWorkspaceEditChangeSummary(
  summary: WorkspaceEditChangeSummary,
): string {
  return `changed ${summary.changedLines}, added ${summary.addedLines}, removed ${summary.removedLines}`;
}

export function formatSessionEvent(event: SessionEvent): string {
  const timestamp = formatEventTimestamp(event.timestamp);

  switch (event.kind) {
    case "approval_requested":
      return `${timestamp} Approval requested for ${event.approvalKind === "command" ? "command" : "workspace edit"}: ${event.summary} (${event.subject})`;
    case "approval_decided":
      return `${timestamp} Approval decision: ${event.decision} for ${event.approvalKind === "command" ? "command" : "workspace edit"} (${event.modeBefore} -> ${event.modeAfter}) on ${event.subject}`;
    case "approval_mode_changed":
      return `${timestamp} Approvals changed: ${event.from} -> ${event.to} for this session.`;
    case "workspace_edit_applied":
      return `${timestamp} Applied ${event.tool} to ${event.path} under ${event.approvalMode}: ${formatWorkspaceEditChangeSummary(event.changeSummary)}${event.autoApproved ? " (auto-approved)." : "."}`;
    case "tool_notice":
      return `${timestamp} ${event.level.toUpperCase()}: ${event.message}`;
    default:
      return `${timestamp} Unknown event.`;
  }
}

function formatEventTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }

  return parsed.toISOString().replace("T", " ").slice(0, 16);
}
