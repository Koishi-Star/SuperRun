import type {
  CommandApprovalDecision,
  CommandApprovalMode,
  WorkspaceEditAssessment,
  WorkspaceEditPolicyContext,
} from "./types.js";

export async function authorizeWorkspaceEdit(
  assessment: WorkspaceEditAssessment,
  policy: WorkspaceEditPolicyContext | undefined,
): Promise<void> {
  const approvalMode = policy?.getMode() ?? "allow-all";

  if (approvalMode === "reject") {
    throw new Error(
      `${assessment.tool} rejected by policy: approvals are set to reject for workspace edits.`,
    );
  }

  if (!assessment.approvalRequired || approvalMode === "allow-all") {
    return;
  }

  const requestApproval = policy?.requestApproval;
  if (!requestApproval) {
    throw new Error(
      `${assessment.tool} requires approval. Re-run in the Ink TTY shell or switch approvals to allow-all.`,
    );
  }

  const decision = await requestApproval({
    assessment,
    approvalMode,
  });

  handleWorkspaceEditDecision(decision, policy, approvalMode, assessment.tool);
}

function handleWorkspaceEditDecision(
  decision: CommandApprovalDecision,
  policy: WorkspaceEditPolicyContext | undefined,
  approvalMode: CommandApprovalMode,
  toolName: WorkspaceEditAssessment["tool"],
): void {
  if (decision === "reject") {
    throw new Error(`${toolName} rejected by user.`);
  }

  if (decision === "always" && approvalMode !== "allow-all") {
    policy?.setMode("allow-all");
  }
}
