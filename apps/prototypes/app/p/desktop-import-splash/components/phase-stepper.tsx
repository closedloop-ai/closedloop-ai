import { cn } from "@repo/design-system/lib/utils";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { type PhaseStep, phaseSteps, type StepState } from "../mock";

// The step's position in `phaseSteps` decides done/active/pending relative to
// the currently active step. When the run failed, the active step reads "error"
// instead of "active".
function stateForStep(
  step: PhaseStep,
  activeStep: PhaseStep,
  failed: boolean
): StepState {
  const index = phaseSteps.findIndex((entry) => entry.step === step);
  const activeIndex = phaseSteps.findIndex(
    (entry) => entry.step === activeStep
  );
  if (index < activeIndex) {
    return "done";
  }
  if (index === activeIndex) {
    return failed ? "error" : "active";
  }
  return "pending";
}

const dotClasses: Record<StepState, string> = {
  done: "border-transparent bg-primary text-primary-foreground",
  active: "border-primary bg-primary/10 text-primary",
  pending: "border-border bg-muted text-muted-foreground",
  error: "border-transparent bg-destructive text-destructive-foreground",
};

const labelClasses: Record<StepState, string> = {
  done: "text-foreground",
  active: "text-foreground",
  pending: "text-muted-foreground",
  error: "text-destructive",
};

function dotContent(index: number, state: StepState) {
  if (state === "done") {
    return <CheckIcon className="size-4" />;
  }
  if (state === "error") {
    return <TriangleAlertIcon className="size-4" />;
  }
  return (
    <span
      className={cn(
        "flex size-full items-center justify-center rounded-full",
        state === "active" &&
          "animate-[pulse_1.6s_ease-in-out_infinite] bg-primary/15"
      )}
    >
      {index + 1}
    </span>
  );
}

const StepDot = ({ index, state }: { index: number; state: StepState }) => (
  <span
    className={cn(
      "flex size-7 shrink-0 items-center justify-center rounded-full border font-semibold text-xs tabular-nums transition-colors",
      dotClasses[state]
    )}
  >
    {dotContent(index, state)}
  </span>
);

export const PhaseStepper = ({
  activeStep,
  failed = false,
}: {
  activeStep: PhaseStep;
  failed?: boolean;
}) => (
  <ol aria-label="Import progress steps" className="flex items-center gap-1">
    {phaseSteps.map((entry, index) => {
      const state = stateForStep(entry.step, activeStep, failed);
      const isLast = index === phaseSteps.length - 1;
      return (
        <li className="flex flex-1 items-center gap-1" key={entry.step}>
          <div className="flex min-w-0 items-center gap-2.5">
            <StepDot index={index} state={state} />
            <span
              aria-current={state === "active" ? "step" : undefined}
              className={cn(
                "truncate font-medium text-sm transition-colors",
                labelClasses[state]
              )}
            >
              {entry.label}
            </span>
          </div>
          {isLast ? null : (
            <span
              aria-hidden="true"
              className={cn(
                "h-px flex-1 rounded-full transition-colors",
                state === "done" ? "bg-primary/50" : "bg-border"
              )}
            />
          )}
        </li>
      );
    })}
  </ol>
);
