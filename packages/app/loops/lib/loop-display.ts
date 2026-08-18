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
  [LoopCommand.Manual]: {
    noun: "Manual",
    progress: "Running",
    completed: "Completed",
    failed: "Failed",
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
  [LoopCommand.EvaluateFeature]: {
    noun: "Issue eval",
    progress: "Evaluating issue",
    completed: "Issue evaluated",
    failed: "Issue eval failed",
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

/** How many leading id characters to show when falling back to a short id. */
const SHORT_LOOP_ID_LENGTH = 8;

/** Short leading slice of a loop id, e.g. `3f2a91b4`, for disambiguation. */
export function shortLoopId(id: string): string {
  return id.slice(0, SHORT_LOOP_ID_LENGTH);
}

/**
 * Human-readable identity for a loop, used where a loop must be named on its
 * own (the loop-detail breadcrumb). Mirrors how branch/artifact detail
 * breadcrumbs name their record so several open loop tabs stay distinguishable
 * and the label never reads a generic placeholder.
 *
 * Leads with the command noun (which survives the header's tail truncation and
 * distinguishes a Plan loop from a Code loop on the same artifact), then the
 * artifact it implements (the FEA/PRD title) when loaded — e.g.
 * `Plan: FEA-3979 title`. A document-less loop has no title to append, so the
 * bare noun would collide across every chat/manual loop in the org; append a
 * short id in that case (`Chat 3f2a91b4`). `getCommandLabels` always returns a
 * non-empty noun (its fallback echoes the raw command), so an empty noun only
 * arises for a blank/whitespace command — fall back to a short id there too.
 *
 * `artifactTitle` is the loaded document/artifact title when the loop targets
 * one (`loop.documentId`); it may be absent for document-less loops. Callers
 * that gate a document fetch on `loop.documentId` should hold their loading
 * placeholder until the fetch settles rather than passing an empty title while
 * the artifact loads, so the crumb does not flash the bare noun.
 */
export function getLoopBreadcrumbLabel(
  loop: { command: LoopCommand; id: string },
  artifactTitle?: string | null
): string {
  const noun = getCommandLabels(loop.command).noun.trim();
  const trimmedTitle = artifactTitle?.trim();
  if (noun && trimmedTitle) {
    return `${noun}: ${trimmedTitle}`;
  }
  if (noun) {
    return `${noun} ${shortLoopId(loop.id)}`;
  }
  return `Loop ${shortLoopId(loop.id)}`;
}
