import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";

type CommandLabels = {
  /** Short noun for default/team variant. */
  noun: string;
  /** Active progress label (e.g., "Plan generating"). */
  progress: string;
  /** Completion past-tense (e.g., "Plan generated"). */
  completed: string;
  /** Failed past-tense (e.g., "Plan failed"). */
  failed: string;
};

// `Partial<>` is intentional: forward-compat with new LoopCommand values added
// in upstream `@closedloop-ai/loops-api`. Unknown commands fall through to the
// safe fallback in `getCommandLabels`. Known commands should be added explicitly.
const COMMAND_LABELS: Partial<Record<LoopCommand, CommandLabels>> = {
  [LoopCommand.Plan]: {
    noun: "Plan",
    progress: "Plan generating",
    completed: "Plan generated",
    failed: "Plan failed",
  },
  [LoopCommand.Execute]: {
    noun: "Code",
    progress: "Code executing",
    completed: "Code executed",
    failed: "Code failed",
  },
  [LoopCommand.Chat]: {
    noun: "Chat",
    progress: "Chatting",
    completed: "Chat completed",
    failed: "Chat failed",
  },
  [LoopCommand.Explore]: {
    noun: "Explore",
    progress: "Exploring",
    completed: "Explored",
    failed: "Explore failed",
  },
  [LoopCommand.RequestChanges]: {
    noun: "Changes",
    progress: "Applying changes",
    completed: "Changes applied",
    failed: "Changes failed",
  },
  [LoopCommand.RequestPrdChanges]: {
    noun: "PRD changes",
    progress: "Applying PRD changes",
    completed: "PRD changes applied",
    failed: "PRD changes failed",
  },
  [LoopCommand.Bootstrap]: {
    noun: "Bootstrap",
    progress: "Bootstrapping",
    completed: "Bootstrapped",
    failed: "Bootstrap failed",
  },
  [LoopCommand.Decompose]: {
    noun: "Decompose",
    progress: "Decomposing",
    completed: "Decomposed",
    failed: "Decompose failed",
  },
  [LoopCommand.EvaluatePrd]: {
    noun: "PRD eval",
    progress: "Evaluating PRD",
    completed: "PRD evaluated",
    failed: "PRD eval failed",
  },
  [LoopCommand.GeneratePrd]: {
    noun: "PRD",
    progress: "PRD generating",
    completed: "PRD generated",
    failed: "PRD failed",
  },
  [LoopCommand.EvaluatePlan]: {
    noun: "Plan eval",
    progress: "Evaluating plan",
    completed: "Plan evaluated",
    failed: "Plan eval failed",
  },
  [LoopCommand.EvaluateCode]: {
    noun: "Code eval",
    progress: "Evaluating code",
    completed: "Code evaluated",
    failed: "Code eval failed",
  },
};

/** Lookup with safe fallback for forward-compat with upstream LoopCommand additions. */
export function getCommandLabels(command: LoopCommand): CommandLabels {
  const entry = COMMAND_LABELS[command];
  if (entry) {
    return entry;
  }
  return {
    noun: command,
    progress: command,
    completed: command,
    failed: `${command} failed`,
  };
}

/** Distinguish CANCELLED, TIMED_OUT, and FAILED. Same red X icon, different label. */
export function terminalLabel(
  status: LoopStatus,
  command: LoopCommand
): string {
  const labels = getCommandLabels(command);
  if (status === LoopStatus.Cancelled) {
    return `${labels.noun} cancelled`;
  }
  if (status === LoopStatus.TimedOut) {
    return `${labels.noun} timed out`;
  }
  return labels.failed;
}

/** Single source of truth for "is this a local desktop loop". */
export function deriveIsLocal(loop: {
  computeTarget?: unknown | null;
}): boolean {
  return loop.computeTarget != null;
}
