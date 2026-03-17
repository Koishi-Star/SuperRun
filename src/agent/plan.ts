export const TASK_PLAN_STEP_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
] as const;

export type TaskPlanStepStatus = (typeof TASK_PLAN_STEP_STATUSES)[number];

export type TaskPlanStep = {
  id: string;
  title: string;
  details: string;
  status: TaskPlanStepStatus;
  note?: string;
};

export type TaskPlan = {
  id: string;
  title: string;
  sourcePrompt: string;
  createdAt: string;
  updatedAt: string;
  steps: TaskPlanStep[];
};

export type CreateTaskPlanOptions = {
  title: string;
  sourcePrompt: string;
  steps: Array<{
    title: string;
    details?: string;
    status?: TaskPlanStepStatus;
    note?: string;
  }>;
};

export type TaskPlanProgress = {
  completedSteps: number;
  inProgressSteps: number;
  blockedSteps: number;
  totalSteps: number;
  percent: number;
};

export function createTaskPlan(options: CreateTaskPlanOptions): TaskPlan {
  const timestamp = new Date().toISOString();
  const title = normalizePlanText(options.title);
  const sourcePrompt = options.sourcePrompt.trim();
  const steps = options.steps
    .map((step, index) => createTaskPlanStep(step, index))
    .filter((step): step is TaskPlanStep => step !== null);

  if (!title) {
    throw new Error("Task plan title must not be empty.");
  }

  if (!sourcePrompt) {
    throw new Error("Task plan source prompt must not be empty.");
  }

  if (steps.length === 0) {
    throw new Error("Task plan must include at least one step.");
  }

  return {
    id: createTaskPlanId(),
    title,
    sourcePrompt,
    createdAt: timestamp,
    updatedAt: timestamp,
    steps,
  };
}

export function updateTaskPlanStep(
  plan: TaskPlan,
  stepId: string,
  updates: {
    status?: TaskPlanStepStatus;
    note?: string | null;
  },
): TaskPlan {
  const normalizedStepId = stepId.trim();
  if (!normalizedStepId) {
    throw new Error("Task plan step id must not be empty.");
  }

  let found = false;
  const nextSteps = plan.steps.map((step) => {
    if (step.id !== normalizedStepId) {
      return { ...step };
    }

    found = true;
    const nextStatus = updates.status ?? step.status;
    const normalizedNote = normalizeOptionalPlanText(updates.note);
    return {
      ...step,
      status: nextStatus,
      ...(normalizedNote ? { note: normalizedNote } : {}),
    };
  });

  if (!found) {
    throw new Error(`Task plan step does not exist: ${normalizedStepId}`);
  }

  return {
    ...plan,
    steps: nextSteps,
    updatedAt: new Date().toISOString(),
  };
}

export function getTaskPlanProgress(plan: TaskPlan): TaskPlanProgress {
  const totalSteps = plan.steps.length;
  const completedSteps = plan.steps.filter((step) => step.status === "completed").length;
  const inProgressSteps = plan.steps.filter((step) => step.status === "in_progress").length;
  const blockedSteps = plan.steps.filter((step) => step.status === "blocked").length;
  return {
    completedSteps,
    inProgressSteps,
    blockedSteps,
    totalSteps,
    percent: totalSteps === 0 ? 0 : Math.round((completedSteps / totalSteps) * 100),
  };
}

export function getActiveTaskPlanStep(plan: TaskPlan): TaskPlanStep | null {
  return (
    plan.steps.find((step) => step.status === "in_progress") ??
    plan.steps.find((step) => step.status === "blocked") ??
    plan.steps.find((step) => step.status === "pending") ??
    null
  );
}

export function renderTaskPlanMarkdown(plan: TaskPlan): string {
  const progress = getTaskPlanProgress(plan);
  const lines = [
    `# ${plan.title}`,
    "",
    `Source prompt: ${plan.sourcePrompt}`,
    "",
    `Progress: ${progress.completedSteps}/${progress.totalSteps} completed (${progress.percent}%)`,
    "",
    "## Steps",
    ...plan.steps.flatMap((step) => {
      const itemLines = [`${renderTaskPlanCheckbox(step.status)} ${step.title}`];
      if (step.details) {
        itemLines.push(`  details: ${step.details}`);
      }
      if (step.note) {
        itemLines.push(`  note: ${step.note}`);
      }
      return itemLines;
    }),
    "",
    `Updated: ${plan.updatedAt}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function formatTaskPlanSummary(plan: TaskPlan): string {
  const progress = getTaskPlanProgress(plan);
  return `${progress.completedSteps}/${progress.totalSteps} completed`;
}

export function isTaskPlanStepStatus(value: unknown): value is TaskPlanStepStatus {
  return typeof value === "string" &&
    TASK_PLAN_STEP_STATUSES.includes(value as TaskPlanStepStatus);
}

export function parseTaskPlan(value: unknown): TaskPlan | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const id = normalizeOptionalPlanText(candidate.id);
  const title = normalizeOptionalPlanText(candidate.title);
  const sourcePrompt =
    typeof candidate.sourcePrompt === "string" ? candidate.sourcePrompt.trim() : "";
  const createdAt =
    typeof candidate.createdAt === "string" ? candidate.createdAt.trim() : "";
  const updatedAt =
    typeof candidate.updatedAt === "string" ? candidate.updatedAt.trim() : "";
  if (
    !id ||
    !title ||
    !sourcePrompt ||
    !createdAt ||
    !updatedAt ||
    !Array.isArray(candidate.steps)
  ) {
    return null;
  }

  const steps = candidate.steps
    .map((step, index) => parseTaskPlanStep(step, index))
    .filter((step): step is TaskPlanStep => step !== null);
  if (steps.length !== candidate.steps.length) {
    return null;
  }

  return {
    id,
    title,
    sourcePrompt,
    createdAt,
    updatedAt,
    steps,
  };
}

function createTaskPlanStep(
  step: CreateTaskPlanOptions["steps"][number],
  index: number,
): TaskPlanStep | null {
  const title = normalizePlanText(step.title);
  if (!title) {
    return null;
  }

  const details = normalizeOptionalPlanText(step.details);
  const note = normalizeOptionalPlanText(step.note);
  return {
    id: `step_${index + 1}`,
    title,
    details,
    status: step.status ?? "pending",
    ...(note ? { note } : {}),
  };
}

function parseTaskPlanStep(value: unknown, index: number): TaskPlanStep | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const id = normalizeOptionalPlanText(candidate.id) || `step_${index + 1}`;
  const title = normalizeOptionalPlanText(candidate.title);
  const details = normalizeOptionalPlanText(candidate.details);
  const note = normalizeOptionalPlanText(candidate.note);
  const status = isTaskPlanStepStatus(candidate.status) ? candidate.status : null;
  if (!title || !status) {
    return null;
  }

  return {
    id,
    title,
    details,
    status,
    ...(note ? { note } : {}),
  };
}

function renderTaskPlanCheckbox(status: TaskPlanStepStatus): string {
  switch (status) {
    case "completed":
      return "- [x]";
    case "in_progress":
      return "- [~]";
    case "blocked":
      return "- [!]";
    default:
      return "- [ ]";
  }
}

function createTaskPlanId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `plan_${timestamp}_${random}`;
}

function normalizePlanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeOptionalPlanText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : "";
}
