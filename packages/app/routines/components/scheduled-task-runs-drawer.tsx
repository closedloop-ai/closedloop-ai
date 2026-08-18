"use client";

import type {
  CascadeAttempt,
  RunRecord,
  ScheduledTask,
} from "@repo/crewd/model";
import { resolveModel } from "@repo/crewd/model";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@repo/design-system/components/ui/sheet";
import { CheckIcon } from "lucide-react";
import { formatDateTimeOrFallback } from "../../shared/lib/date-utils";
import { runStatusChip } from "../lib/scheduled-task-row";

/**
 * Read-only run-history drawer for one scheduled task (FEA-3854). Lists the
 * task's recent `RunRecord`s most-recent-first, each expanded into its cascade
 * trail — the ordered `attempts`, each a `(harness, model)` step (FEA-3855) with
 * its outcome and duration, and a marker on the attempt that produced the result.
 * Read-only: no run-now / cancel (those live on the list row).
 */

const ATTEMPT_OUTCOME_LABEL: Record<CascadeAttempt["outcome"], string> = {
  success: "produced the result",
  failed: "failed",
  timeout: "timed out",
  skipped: "skipped",
};

export function ScheduledTaskRunsDrawer({
  task,
  runs,
  open,
  onOpenChange,
}: {
  /** The task whose history is shown, or null when the drawer is closed. */
  task: ScheduledTask | null;
  runs: RunRecord[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        className="flex w-full flex-col gap-0 sm:max-w-md"
        side="right"
      >
        <SheetHeader>
          <SheetTitle className="truncate">
            {task ? task.name : "Run history"}
          </SheetTitle>
          <SheetDescription>
            {task
              ? "Recent runs and the steps each one tried."
              : "Select a routine to see its run history."}
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-auto px-4 pb-4">
          {runs.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground text-sm">
              No runs yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {runs.map((run) => (
                <RunHistoryItem key={run.id} run={run} />
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function RunHistoryItem({ run }: { run: RunRecord }) {
  const chip = runStatusChip(run);
  return (
    <li className="rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          {formatDateTimeOrFallback(run.startedAt)}
        </span>
        <Chip variant={chip.variant}>{chip.label}</Chip>
      </div>
      {run.summary ? <p className="mt-1.5 text-sm">{run.summary}</p> : null}
      {run.error ? (
        <p className="mt-1.5 text-destructive text-xs">{run.error}</p>
      ) : null}
      {run.attempts.length > 0 ? (
        <ol className="mt-2.5 flex flex-col gap-1.5">
          {run.attempts.map((attempt, index) => (
            <CascadeAttemptRow
              attempt={attempt}
              // biome-ignore lint/suspicious/noArrayIndexKey: cascade attempts are an ordered positional list with no id, and two attempts can share a harness — position is part of the identity.
              key={`${run.id}:${index}:${attempt.harness}`}
            />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function CascadeAttemptRow({ attempt }: { attempt: CascadeAttempt }) {
  const produced = attempt.outcome === "success";
  return (
    <li className="flex items-center gap-2 text-xs">
      {produced ? (
        <CheckIcon aria-hidden className="size-3.5 shrink-0 text-success" />
      ) : (
        <span aria-hidden className="w-3.5 shrink-0" />
      )}
      <span className="min-w-0 truncate">
        <span className="font-medium">{attempt.harness}</span>
        <span className="text-muted-foreground">
          {" · "}
          {attempt.model ?? resolveModel({ harness: attempt.harness })}
        </span>
      </span>
      <span className="text-muted-foreground">
        {ATTEMPT_OUTCOME_LABEL[attempt.outcome]}
      </span>
      <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
        {formatAttemptDuration(attempt.durationMs)}
      </span>
    </li>
  );
}

function formatAttemptDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}
