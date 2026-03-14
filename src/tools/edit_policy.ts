import type {
  CommandApprovalDecision,
  CommandApprovalMode,
  WorkspaceEditAssessment,
  WorkspaceEditPolicyContext,
} from "./types.js";

export type WorkspaceEditAuthorizationResult = {
  approvalModeBefore: CommandApprovalMode;
  approvalModeAfter: CommandApprovalMode;
  prompted: boolean;
  decision: "auto" | CommandApprovalDecision;
};

export async function authorizeWorkspaceEdit(
  assessment: WorkspaceEditAssessment,
  policy: WorkspaceEditPolicyContext | undefined,
): Promise<WorkspaceEditAuthorizationResult> {
  const approvalMode = policy?.getMode() ?? "allow-all";

  if (approvalMode === "reject") {
    throw new Error(
      `${assessment.tool} rejected by policy: approvals are set to reject for workspace edits.`,
    );
  }

  if (
    !assessment.approvalRequired ||
    approvalMode === "allow-all" ||
    approvalMode === "crazy_auto"
  ) {
    return {
      approvalModeBefore: approvalMode,
      approvalModeAfter: approvalMode,
      prompted: false,
      decision: "auto",
    };
  }

  const requestApproval = policy?.requestApproval;
  if (!requestApproval) {
    throw new Error(
      `${assessment.tool} requires approval. Re-run in the Ink TTY shell or switch approvals to allow-all or crazy_auto.`,
    );
  }

  const decision = await requestApproval({
    assessment,
    approvalMode,
  });

  return handleWorkspaceEditDecision(decision, policy, approvalMode, assessment.tool);
}

function handleWorkspaceEditDecision(
  decision: CommandApprovalDecision,
  policy: WorkspaceEditPolicyContext | undefined,
  approvalMode: CommandApprovalMode,
  toolName: WorkspaceEditAssessment["tool"],
): WorkspaceEditAuthorizationResult {
  if (decision === "reject") {
    throw new Error(`${toolName} rejected by user.`);
  }

  if (decision === "always" && approvalMode !== "allow-all") {
    policy?.setMode("allow-all");
  }

  return {
    approvalModeBefore: approvalMode,
    approvalModeAfter: policy?.getMode() ?? approvalMode,
    prompted: true,
    decision,
  };
}
