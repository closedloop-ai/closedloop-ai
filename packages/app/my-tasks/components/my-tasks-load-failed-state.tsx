"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { TriangleAlertIcon } from "lucide-react";

type MyTasksLoadFailedStateProps = {
  onRetry: () => void;
};

/**
 * The degraded state both My Tasks views show when a task read fails
 * (FEA-3938 / ISS-4576).
 *
 * Shared for the same reason the pagination footer is: the list and the card
 * board must not drift into telling the user two different stories about the
 * same failure. It is rendered BEFORE either view's empty branches so a failed
 * read can never masquerade as "your queue is clear".
 */
export function MyTasksLoadFailedState({
  onRetry,
}: Readonly<MyTasksLoadFailedStateProps>) {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <EmptyState
        action={
          <Button onClick={onRetry} variant="outline">
            Try again
          </Button>
        }
        description="We couldn't load your tasks. Check your connection and try again."
        icon={TriangleAlertIcon}
        title="Couldn't load your tasks"
      />
    </div>
  );
}
