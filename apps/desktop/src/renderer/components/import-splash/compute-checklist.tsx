import { cn } from "@closedloop-ai/design-system/lib/utils";
import { CheckIcon } from "lucide-react";
import { SessionPopulationCount } from "../session-population-count";
import {
  type ComputeStep,
  computeSteps,
  type ImportSplashState,
} from "./import-splash-state";

type LightStepState = "done" | "active" | "pending";

// A compute sub-step is done once the reported phase has moved past it, active
// when it is the reported phase, pending otherwise.
//
// ISS-6241 (review): a null `activeStep` is TWO facts and only one of them is
// "finished", so the liveness bit decides which. With the pass reported INACTIVE
// it is the wind-down tail and every listed step reads done — the honest
// "wrapping up". With the pass still LIVE it means the main process named a
// phase this build has no sub-step for, so nothing here is finished; the steps
// stay pending — an indeterminate list rather than two check marks over work
// that is still running.
function computeStepState(
  step: ComputeStep,
  activeStep: ComputeStep | null,
  maintenanceActive: boolean
): LightStepState {
  if (activeStep === null) {
    return maintenanceActive ? "pending" : "done";
  }
  const index = computeSteps.findIndex((entry) => entry.step === step);
  const activeIndex = computeSteps.findIndex(
    (entry) => entry.step === activeStep
  );
  if (index < activeIndex) {
    return "done";
  }
  if (index === activeIndex) {
    return "active";
  }
  return "pending";
}

const ComputeStepDot = ({ state }: { state: LightStepState }) => {
  if (state === "done") {
    return <CheckIcon aria-hidden="true" className="size-4 text-success" />;
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-4 items-center justify-center"
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          state === "active" ? "bg-primary" : "bg-muted-foreground/40"
        )}
        data-ob-motion={state === "active" ? "" : undefined}
        style={
          state === "active"
            ? { animation: "ob-pulse 1.6s ease-in-out infinite" }
            : undefined
        }
      />
    </span>
  );
};

/**
 * The Compute stage's own checklist so it never rests on the finished import
 * list: a one-line "imported" summary, then the maintenance sub-steps (history
 * rebuild, artifact-link backfill) with the reported one live.
 */
export const ComputeChecklist = ({ state }: { state: ImportSplashState }) => {
  const toolCount = state.perHarness.filter(
    (harness) => harness.total > 0
  ).length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <CheckIcon aria-hidden="true" className="size-4 text-success" />
        <span>
          {/* ISS-5281: transcripts, not sessions — `total` is the source-file
              population the tracker counts, and one OpenCode source is a whole
              opencode.db holding an unknown number of sessions. */}
          Imported {state.total.toLocaleString()} transcripts
          {toolCount > 0
            ? ` from ${toolCount} ${toolCount === 1 ? "tool" : "tools"}`
            : ""}
        </span>
      </div>
      <ul className="flex flex-col gap-2.5">
        {computeSteps.map((entry) => {
          const stepState = computeStepState(
            entry.step,
            state.computeStep,
            state.maintenanceActive
          );
          return (
            <li className="flex items-center gap-2.5" key={entry.step}>
              <ComputeStepDot state={stepState} />
              <span
                className={cn(
                  "text-sm",
                  stepState === "pending"
                    ? "text-muted-foreground"
                    : "text-foreground"
                )}
              >
                {entry.label}
              </span>
              {/* ISS-6241: only the ACTIVE step, and only when the pass reported
                  a real population. A done step's count is noise, and a pending
                  step has not measured anything yet. */}
              {stepState === "active" && state.computeProgress ? (
                <SessionPopulationCount
                  processed={state.computeProgress.processed}
                  total={state.computeProgress.total}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
