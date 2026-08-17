"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import {
  type HealthCheckRepairStep,
  HealthCheckRepairStepStatus,
} from "@closedloop-ai/loops-api/compute-target";
import { AlertCircle, Loader2, Wrench } from "lucide-react";
import {
  SystemCheckStatusBadge,
  SystemCheckStatusTone,
} from "./system-check-status-badge";

/**
 * The System Check Repair affordance (ISS-5389), split into a control and a
 * result panel so both the pre-loop dialog and the compute-target settings card
 * mount the same thing.
 *
 * Presentational only — it neither fetches nor decides what is repairable; the
 * surface hands it the gateway's own answer. Two rules it does enforce:
 *
 *  1. The button is never offered when it would do nothing: no repairable row,
 *     or a gateway too old to know the operation, and it renders nothing.
 *  2. The panel is the narration of a RUN, not a standing verdict. It appears
 *     only once a repair is in flight, has produced steps, or has errored. Why a
 *     given failing row is beyond Repair belongs on that row in
 *     `SystemCheckResults`, next to the remediation copy for that exact failure.
 */

export type SystemCheckRepairButtonVariant = "default" | "secondary";

export type SystemCheckRepairButtonProps = {
  /** How many failing rows the gateway said it can actually repair. */
  repairableCount: number;
  /** False when the gateway build predates Repair. */
  isSupported: boolean;
  isRepairing: boolean;
  /**
   * True while the surface is running its own check. Repair and Re-check both
   * write the same health-check result, so whichever landed last would silently
   * win; each control blocks while the other is in flight.
   */
  isCheckRunning?: boolean;
  /**
   * Solid in the pre-loop dialog, where Repair genuinely is the next action.
   * `secondary` on the settings card, where a solid button would be the loudest
   * thing on a page whose subject is not this one collapsed sub-panel.
   */
  variant?: SystemCheckRepairButtonVariant;
  onRepair: () => void;
  className?: string;
};

export function SystemCheckRepairButton({
  repairableCount,
  isSupported,
  isRepairing,
  isCheckRunning = false,
  variant = "default",
  onRepair,
  className,
}: Readonly<SystemCheckRepairButtonProps>) {
  if (!isRepairControlVisible({ isSupported, repairableCount })) {
    return null;
  }

  return (
    <Button
      className={cn("shrink-0 gap-1.5", className)}
      disabled={isRepairing || isCheckRunning}
      onClick={onRepair}
      size="sm"
      variant={variant}
    >
      {isRepairing ? (
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
      ) : (
        <Wrench aria-hidden="true" className="size-3.5" />
      )}
      {isRepairing ? "Repairing…" : getRepairLabel(repairableCount)}
    </Button>
  );
}

export type SystemCheckRepairPanelProps = {
  /** Steps the gateway ran, in the order it ran them. */
  steps?: HealthCheckRepairStep[];
  isRepairing?: boolean;
  /** Message from a repair that never reached the gateway, or that it rejected. */
  errorMessage?: string | null;
  /**
   * True when this result came from a repair that was already running — a second
   * press joined it rather than starting a second one.
   */
  joinedInFlight?: boolean;
  className?: string;
};

export function SystemCheckRepairPanel({
  steps,
  isRepairing = false,
  errorMessage = null,
  joinedInFlight = false,
  className,
}: Readonly<SystemCheckRepairPanelProps>) {
  const hasSteps = Boolean(steps && steps.length > 0);

  // Nothing has been run, so there is nothing to narrate. Notably NOT keyed off
  // "are there unrepairable rows" — that verdict would otherwise greet the user
  // above the check results before they had touched anything.
  if (!(isRepairing || hasSteps || errorMessage)) {
    return null;
  }

  return (
    <section
      aria-label="Repair"
      className={cn(
        "space-y-2 rounded-lg border border-border bg-muted/30 p-3",
        className
      )}
    >
      {isRepairing && (
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
          Running the fixes this gateway can apply, then re-checking.
        </p>
      )}

      {errorMessage && (
        <Alert variant="error">
          <AlertCircle aria-hidden="true" />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {joinedInFlight && (
        <p className="text-muted-foreground text-sm">
          A repair was already running. This shows that run&apos;s result.
        </p>
      )}

      {hasSteps && (
        <ul className="space-y-1.5">
          {steps?.map((step) => (
            <RepairStepRow key={`${step.action}-${step.label}`} step={step} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RepairStepRow({ step }: Readonly<{ step: HealthCheckRepairStep }>) {
  return (
    <li className="space-y-0.5">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="min-w-0 flex-1">{step.label}</span>
        <SystemCheckStatusBadge
          label={REPAIR_STEP_STATUS_LABELS[step.status] ?? step.status}
          tone={getRepairStepTone(step.status)}
        />
      </div>
      {step.detail && (
        <p className="break-words text-muted-foreground text-xs">
          {step.detail}
        </p>
      )}
    </li>
  );
}

function getRepairStepTone(
  status: HealthCheckRepairStep["status"]
): SystemCheckStatusTone {
  if (status === HealthCheckRepairStepStatus.Succeeded) {
    return SystemCheckStatusTone.Success;
  }
  if (status === HealthCheckRepairStepStatus.Failed) {
    return SystemCheckStatusTone.Danger;
  }
  return SystemCheckStatusTone.Neutral;
}

/**
 * Canonical wording for each terminal step state. "Skipped" deliberately reads
 * as a decision, not a shrug — the gateway skipped it because a root fault made
 * it impossible, and the step's own `detail` says which one.
 */
const REPAIR_STEP_STATUS_LABELS: Record<HealthCheckRepairStepStatus, string> = {
  [HealthCheckRepairStepStatus.Succeeded]: "fixed",
  [HealthCheckRepairStepStatus.Failed]: "failed",
  [HealthCheckRepairStepStatus.Skipped]: "not run",
};

/**
 * "Repair 1 failure" reads unambiguously where a bare "Repair 1" does not, and
 * says the SAME noun as the header badge beside it on the settings card, which
 * counts failing rows ("1 failure"). One row cannot be a failure and an issue at
 * once; with one noun the two numbers read as "1 of the 3" rather than as two
 * unrelated tallies (ISS-5435 review).
 */
function getRepairLabel(repairableCount: number): string {
  return `Repair ${repairableCount} failure${repairableCount === 1 ? "" : "s"}`;
}

/**
 * Whether the Repair control renders anything at all.
 *
 * Exported because a caller must NOT infer this from "did I hand over a node":
 * a surface that passes `<SystemCheckRepairButton />` still gets nothing on
 * screen when the gateway is too old or has nothing to fix. A footer that
 * reorders itself around a node rendering nothing would demote its own primary
 * action, and hide a control the user does need, for a button that is not there.
 */
export function isRepairControlVisible({
  isSupported,
  repairableCount,
}: Readonly<{ isSupported: boolean; repairableCount: number }>): boolean {
  return isSupported && repairableCount > 0;
}
