"use client";

import {
  MY_TASKS_RECENCY_EMPTY_BODY,
  MY_TASKS_RECENCY_EMPTY_TITLE,
  MY_TASKS_RECENCY_SHOW_ALL_LABEL,
} from "@repo/app/my-tasks/lib/my-tasks-recency-window";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { ClockIcon } from "lucide-react";

type MyTasksRecencyEmptyStateProps = {
  /** Drops the recency window and re-reads the full assigned history. */
  readonly onShowAll: () => void;
};

/**
 * The My Tasks board with a recency window in force and nothing inside it
 * (FEA-1626).
 *
 * "There is nothing assigned to you" and "everything assigned to you fell
 * outside the window" are two different facts and must not share a screen.
 * Someone back from three months of leave, or whose assigned work sits in an
 * archived project, still has all of it — answering them with "Your queue is
 * clear" plus cards asking them to write a PRD is the board lying about their
 * data. So this state names the bound, names BOTH exclusions, and carries the
 * way back out.
 *
 * Prop-driven and lives here rather than beside the page's default empty state
 * so its copy and escape hatch get an isolated story: the real path to it needs
 * the flag on, an actually-empty windowed result, and no removed chip, which is
 * not a state review or QA can reach by hand.
 *
 * Built on the catalog `EmptyState`, the same component the queue-clear state
 * uses. These two are alternate branches of one zero-state slot, so hand-rolled
 * markup here would make removing or re-adding the recency chip jump the state's
 * position, change its type scale, and grow or lose an icon.
 */
export function MyTasksRecencyEmptyState({
  onShowAll,
}: MyTasksRecencyEmptyStateProps) {
  return (
    <EmptyState
      action={
        <Button onClick={onShowAll} variant="outline">
          {MY_TASKS_RECENCY_SHOW_ALL_LABEL}
        </Button>
      }
      description={MY_TASKS_RECENCY_EMPTY_BODY}
      icon={ClockIcon}
      title={MY_TASKS_RECENCY_EMPTY_TITLE}
    />
  );
}
