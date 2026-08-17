/**
 * @file cascade-progress.tsx
 * @description FEA-3848 (PRD-556 M2) — the live cascade-attempt progress
 * display for an in-flight audit run.
 *
 * As the crewd harness cascade runs, the main process streams
 * {@link AuditProgressPayload} events over `audit.onProgress`. This component
 * renders the cascade trail those events describe: the ordered harness list from
 * the `start` phase, each harness's outcome as its `attempt` event lands, and
 * the harness still being tried shown as running. It is a small, presentational
 * building block (no IPC, no data fetching) so it can be reused by any surface
 * that has a cascade to visualize; the owning view drives it from the streamed
 * events.
 *
 * "Reuse the scheduler run-history components" (the PRD hint) was not available
 * on this branch, so this is the clean, self-contained equivalent.
 */

import type { CascadeAttempt, HarnessName } from "@repo/crewd/model";
import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleSlashIcon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react";

/** A single cascade outcome as a variant + label + icon, for the row badge. */
const OUTCOME_PRESENTATION: Record<
  CascadeAttempt["outcome"],
  { label: string; variant: "success" | "error" | "warning" | "muted" }
> = {
  success: { label: "Succeeded", variant: "success" },
  failed: { label: "Failed", variant: "error" },
  timeout: { label: "Timed out", variant: "warning" },
  skipped: { label: "Skipped", variant: "muted" },
};

/** The per-harness step state derived from the streamed events. */
type CascadeStepState =
  | { status: "pending" }
  | { status: "running" }
  | { status: "done"; attempt: CascadeAttempt };

type CascadeStep = {
  harness: HarnessName;
  state: CascadeStepState;
};

export type CascadeProgressProps = {
  /** The ordered cascade (from the `start` phase); empty until it arrives. */
  cascade: readonly HarnessName[];
  /** Attempts that have landed so far, in cascade order. */
  attempts: readonly CascadeAttempt[];
  /** True while the run is still in flight (drives the running/pending split). */
  running: boolean;
};

/**
 * Fold the cascade order + landed attempts into a per-harness step list. The
 * first harness with no attempt yet is "running" while the cascade is live —
 * but only if no earlier attempt already SUCCEEDED, because the cascade stops
 * on the first success and never tries the remaining harnesses (they stay
 * "pending", not falsely "running"). Later un-attempted harnesses are "pending".
 * At most one step is ever "running".
 */
function buildSteps(props: CascadeProgressProps): CascadeStep[] {
  const { cascade, attempts, running } = props;
  const succeeded = attempts.some((a) => a.outcome === "success");
  const steps: CascadeStep[] = [];
  let sawRunning = false;
  for (let index = 0; index < cascade.length; index += 1) {
    const harness = cascade[index];
    const attempt = attempts[index];
    if (attempt) {
      steps.push({ harness, state: { status: "done", attempt } });
      continue;
    }
    if (running && !succeeded && !sawRunning) {
      sawRunning = true;
      steps.push({ harness, state: { status: "running" } });
      continue;
    }
    steps.push({ harness, state: { status: "pending" } });
  }
  return steps;
}

function StepIcon({ state }: { state: CascadeStepState }) {
  if (state.status === "running") {
    return (
      <Loader2Icon
        aria-hidden
        className="size-4 animate-spin text-[var(--primary)]"
      />
    );
  }
  if (state.status === "pending") {
    return (
      <CircleDashedIcon
        aria-hidden
        className="size-4 text-[var(--muted-foreground)]"
      />
    );
  }
  const { outcome } = state.attempt;
  if (outcome === "success") {
    return (
      <CheckCircle2Icon aria-hidden className="size-4 text-[var(--success)]" />
    );
  }
  if (outcome === "skipped") {
    return (
      <CircleSlashIcon
        aria-hidden
        className="size-4 text-[var(--muted-foreground)]"
      />
    );
  }
  return (
    <XCircleIcon aria-hidden className="size-4 text-[var(--destructive)]" />
  );
}

function StepStatus({ state }: { state: CascadeStepState }) {
  if (state.status === "running") {
    return (
      <Badge variant="accent">
        <Loader2Icon aria-hidden className="animate-spin" />
        Running
      </Badge>
    );
  }
  if (state.status === "pending") {
    return <Badge variant="muted">Pending</Badge>;
  }
  const presentation = OUTCOME_PRESENTATION[state.attempt.outcome];
  return <Badge variant={presentation.variant}>{presentation.label}</Badge>;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/** The live cascade-attempt progress trail for an in-flight (or finished) run. */
export function CascadeProgress(props: CascadeProgressProps) {
  const steps = buildSteps(props);
  if (steps.length === 0) {
    return (
      <p className="text-[var(--muted-foreground)] text-sm">
        Starting the harness cascade…
      </p>
    );
  }
  return (
    <ol aria-label="Cascade attempts" className="flex flex-col gap-2">
      {steps.map((step) => (
        <li
          className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2"
          key={step.harness}
        >
          <div className="flex min-w-0 items-center gap-2">
            <StepIcon state={step.state} />
            <span className="font-medium text-[var(--foreground)] text-sm capitalize">
              {step.harness}
            </span>
            {step.state.status === "done" && step.state.attempt.note ? (
              <span className="truncate text-[var(--muted-foreground)] text-xs">
                {step.state.attempt.note}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {step.state.status === "done" ? (
              <span className="text-[var(--muted-foreground)] text-xs tabular-nums">
                {formatDuration(step.state.attempt.durationMs)}
              </span>
            ) : null}
            <StepStatus state={step.state} />
          </div>
        </li>
      ))}
    </ol>
  );
}
