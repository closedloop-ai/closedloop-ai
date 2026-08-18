"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Progress } from "@repo/design-system/components/ui/progress";
import { Separator } from "@repo/design-system/components/ui/separator";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import {
  CheckIcon,
  CircleCheckIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  type ComputeStep,
  computeSteps,
  deriveImportState,
  ImportPhase,
  type ImportState,
  importHarnesses,
  simulate,
  TICK_MS,
} from "../mock";
import { ClosedloopMark } from "./closedloop-mark";
import { HarnessProgressList } from "./harness-progress";
import { PhaseStepper } from "./phase-stepper";

// One monotonic tick drives the whole flow (see `simulate`). Two cycles
// alternate — a clean success run and a mid-import stall/failure — so both
// outcomes play hands-off. `restart` jumps back to a fresh success run and
// backs the failure state's Retry / Continue actions.
function useImportSimulation(): { state: ImportState; restart: () => void } {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(
      () => setTick((current) => current + 1),
      TICK_MS
    );
    return () => window.clearInterval(id);
  }, []);

  const restart = useCallback(() => setTick(0), []);
  const { progress, failed } = simulate(tick);
  return { state: deriveImportState(progress, failed), restart };
}

type LightStepState = "done" | "active" | "pending";

// The scan phase has no counts yet, so it reads as discovery. It uses the SAME
// four-column grid as the import rows (marker, label, bar, count) so when scan
// flips to import only the content fills in — the columns never shift.
const ScanningActivity = () => (
  <div className="flex flex-col gap-3">
    {importHarnesses.map((harness) => (
      <div
        className="grid grid-cols-[1rem_9rem_1fr_auto] items-center gap-3"
        key={harness.id}
      >
        <span
          aria-hidden="true"
          className="size-1.5 justify-self-center rounded-full bg-muted-foreground/40"
        />
        <span className="truncate text-muted-foreground text-sm">
          {harness.label}
        </span>
        <Skeleton className="h-1.5 w-full rounded-full" />
        <Skeleton className="h-3 w-16 rounded" />
      </div>
    ))}
  </div>
);

function computeStepState(
  step: ComputeStep,
  active: ComputeStep | null
): LightStepState {
  const index = computeSteps.findIndex((entry) => entry.step === step);
  const activeIndex = active
    ? computeSteps.findIndex((entry) => entry.step === active)
    : computeSteps.length;
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
    return <CheckIcon className="size-4 text-success" />;
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-4 items-center justify-center"
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          state === "active"
            ? "animate-[pulse_1.6s_ease-in-out_infinite] bg-primary"
            : "bg-muted-foreground/40"
        )}
      />
    </span>
  );
};

// Compute has its own light checklist so it never rests on the finished import
// list: a one-line "imported" summary, then the maintenance/insights sub-steps
// with the current one live.
const ComputeActivity = ({ state }: { state: ImportState }) => (
  <div className="flex flex-col gap-4">
    <div className="flex items-center gap-2 text-muted-foreground text-sm">
      <CheckIcon className="size-4 text-success" />
      <span>
        Imported {state.grandTotal.toLocaleString()} sessions from{" "}
        {importHarnesses.length} tools
      </span>
    </div>
    <ul className="flex flex-col gap-2.5">
      {computeSteps.map((entry) => {
        const stepState = computeStepState(entry.step, state.computeStep);
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
          </li>
        );
      })}
    </ul>
  </div>
);

// The privacy line lives in the footer through every phase, so the Ready state
// just celebrates the count rather than repeating the on-device reassurance.
const ReadyActivity = ({ state }: { state: ImportState }) => (
  <Alert variant="success">
    <CircleCheckIcon />
    <AlertDescription>
      <span className="font-medium text-success-foreground">
        {state.grandTotal.toLocaleString()} sessions
      </span>{" "}
      imported from {importHarnesses.length} tools.
    </AlertDescription>
  </Alert>
);

// Failure is graceful: what imported is still usable, so the state names what
// stalled and offers a way forward rather than trapping the user on a dead bar.
const FailedActivity = ({
  state,
  onContinue,
  onRetry,
}: {
  state: ImportState;
  onContinue: () => void;
  onRetry: () => void;
}) => {
  const stalled = state.perHarness.find((harness) => harness.state === "error");
  return (
    <div className="flex flex-col gap-4">
      <Alert variant="error">
        <TriangleAlertIcon />
        <AlertTitle>Some sessions couldn't be read</AlertTitle>
        <AlertDescription>
          {stalled
            ? `We hit a problem reading your ${stalled.label} sessions and stopped after ${state.processed.toLocaleString()} of ${state.grandTotal.toLocaleString()}. `
            : `We stopped after ${state.processed.toLocaleString()} of ${state.grandTotal.toLocaleString()} sessions. `}
          You can keep going with what imported, or try again.
        </AlertDescription>
      </Alert>
      <HarnessProgressList harnesses={state.perHarness} />
      <div className="flex flex-wrap gap-2">
        {/* Continue keeps the partial import and proceeds to the dashboard. */}
        <Button onClick={onContinue} size="sm" type="button">
          Continue to dashboard
        </Button>
        {/* Retry discards the partial import and re-runs it from scratch. */}
        <Button onClick={onRetry} size="sm" type="button" variant="outline">
          <RotateCcwIcon />
          Retry import
        </Button>
      </div>
    </div>
  );
};

const SplashActivity = ({
  state,
  onContinue,
  onRetry,
}: {
  state: ImportState;
  onContinue: () => void;
  onRetry: () => void;
}) => {
  if (state.phase === ImportPhase.Scanning) {
    return <ScanningActivity />;
  }
  if (state.phase === ImportPhase.Failed) {
    return (
      <FailedActivity onContinue={onContinue} onRetry={onRetry} state={state} />
    );
  }
  if (state.phase === ImportPhase.Ready) {
    return <ReadyActivity state={state} />;
  }
  if (
    state.phase === ImportPhase.Finishing ||
    state.phase === ImportPhase.Computing
  ) {
    return <ComputeActivity state={state} />;
  }
  return <HarnessProgressList harnesses={state.perHarness} />;
};

export const ImportSplash = () => {
  const { state, restart } = useImportSimulation();

  // Continue keeps the partial import and moves on; Retry re-runs from scratch.
  // Both restart the looping demo here (no real dashboard or importer), but they
  // are distinct product actions, wired through distinct props.
  const handleContinue = useCallback(() => restart(), [restart]);
  const handleRetry = useCallback(() => restart(), [restart]);

  // The "may be slow" reassurance only applies while work is actually running —
  // not once it has finished (Ready) or given up (failed).
  const workInFlight = !(state.failed || state.phase === ImportPhase.Ready);

  return (
    <main className="flex h-svh w-full items-center justify-center bg-background p-6">
      <Card className="w-full max-w-xl">
        <CardHeader>
          {/* aria-live carries only the phase headline (a handful of
              announcements) — the churning session count lives on the progress
              bar's aria-valuenow, not in a live region. */}
          <CardTitle aria-live="polite" className="text-lg tracking-tight">
            {state.headline}
          </CardTitle>
          <CardDescription>{state.detail}</CardDescription>
          <CardAction>
            <ClosedloopMark className="size-6 text-foreground" />
          </CardAction>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <Progress
              aria-label="Overall import progress"
              className={cn(
                "h-2",
                state.failed &&
                  "[&>[data-slot=progress-indicator]]:bg-destructive"
              )}
              value={state.overallPct}
            />
            <div className="flex items-center justify-between text-muted-foreground text-xs tabular-nums">
              <span>{Math.floor(state.overallPct)}%</span>
              <span
                className={cn(
                  state.phase === ImportPhase.Importing
                    ? "text-foreground"
                    : "text-muted-foreground"
                )}
              >
                {state.processed.toLocaleString()} /{" "}
                {state.grandTotal.toLocaleString()} sessions
              </span>
            </div>
          </div>

          <PhaseStepper activeStep={state.activeStep} failed={state.failed} />

          <Separator />

          <SplashActivity
            onContinue={handleContinue}
            onRetry={handleRetry}
            state={state}
          />
        </CardContent>

        <CardFooter className="flex-wrap justify-between gap-x-4 gap-y-1.5 border-t">
          <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <ShieldCheckIcon className="size-3.5 text-success" />
            Computed on this device · 0 bytes uploaded
          </span>
          {workInFlight ? (
            <span className="text-muted-foreground text-xs">
              The app may be slow until this finishes.
            </span>
          ) : null}
        </CardFooter>
      </Card>
    </main>
  );
};
