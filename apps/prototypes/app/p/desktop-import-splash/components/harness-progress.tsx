import { Progress } from "@repo/design-system/components/ui/progress";
import { cn } from "@repo/design-system/lib/utils";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import type {
  HarnessProgress as HarnessProgressType,
  StepState,
} from "../mock";

const stateDotClasses: Record<StepState, string> = {
  done: "bg-success",
  active: "bg-primary animate-[pulse_1.6s_ease-in-out_infinite]",
  pending: "bg-muted-foreground/40",
  error: "bg-destructive",
};

const HarnessMarker = ({ state }: { state: StepState }) => {
  if (state === "done") {
    return <CheckIcon className="size-4 text-success" />;
  }
  if (state === "error") {
    return <TriangleAlertIcon className="size-4 text-destructive" />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 justify-self-center rounded-full",
        stateDotClasses[state]
      )}
    />
  );
};

const HarnessRow = ({ harness }: { harness: HarnessProgressType }) => {
  const isPending = harness.state === "pending";
  const isError = harness.state === "error";
  return (
    <li className="grid grid-cols-[1rem_9rem_1fr_auto] items-center gap-3">
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

export const HarnessProgressList = ({
  harnesses,
}: {
  harnesses: readonly HarnessProgressType[];
}) => (
  <ul className="flex flex-col gap-3">
    {harnesses.map((harness) => (
      <HarnessRow harness={harness} key={harness.id} />
    ))}
  </ul>
);
