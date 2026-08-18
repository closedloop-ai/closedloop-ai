import { Progress } from "@closedloop-ai/design-system/components/ui/progress";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import type { HarnessProgress, StepState } from "./import-splash-state";

const stateDotClasses: Record<StepState, string> = {
  done: "bg-success",
  active: "bg-primary",
  pending: "bg-muted-foreground/40",
  error: "bg-destructive",
};

const HarnessMarker = ({ state }: { state: StepState }) => {
  if (state === "done") {
    return <CheckIcon aria-hidden="true" className="size-4 text-success" />;
  }
  if (state === "error") {
    return (
      <TriangleAlertIcon
        aria-hidden="true"
        className="size-4 text-destructive"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 justify-self-center rounded-full",
        stateDotClasses[state]
      )}
      // The active dot pulses on the compositor so it keeps moving while the
      // main thread is blocked during the import.
      data-ob-motion={state === "active" ? "" : undefined}
      style={
        state === "active"
          ? { animation: "ob-pulse 1.6s ease-in-out infinite" }
          : undefined
      }
    />
  );
};

const HarnessRow = ({ harness }: { harness: HarnessProgress }) => {
  const isPending = harness.state === "pending";
  const isError = harness.state === "error";
  return (
    <li className="grid grid-cols-[1rem_8rem_1fr_auto] items-center gap-3">
      <HarnessMarker state={harness.state} />
      <span
        className={cn(
          "truncate font-medium text-sm",
          isPending ? "text-muted-foreground" : "text-foreground"
        )}
      >
        {harness.label}
      </span>
      <Progress
        aria-label={`${harness.label} import progress`}
        className={cn(
          "h-1.5",
          isPending && "opacity-50",
          isError && "[&>[data-slot=progress-indicator]]:bg-destructive"
        )}
        value={harness.pct}
      />
      <span
        className={cn(
          "text-right text-xs tabular-nums",
          isError ? "text-destructive" : "text-muted-foreground"
        )}
      >
        {harness.processed.toLocaleString()} / {harness.total.toLocaleString()}
      </span>
    </li>
  );
};

/** Per-harness import rows, driven by the real `ingest.byHarness` breakdown. */
export const HarnessProgressList = ({
  harnesses,
}: {
  harnesses: readonly HarnessProgress[];
}) => (
  <ul className="flex flex-col gap-3">
    {harnesses.map((harness) => (
      <HarnessRow harness={harness} key={harness.id} />
    ))}
  </ul>
);
