"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { AlertCircleIcon, CheckCircle2Icon, Loader2Icon } from "lucide-react";
import {
  type BootstrapState,
  BootstrapStatus,
} from "@/hooks/queries/use-bootstrap-agents";

type BootstrapProgressProps = {
  state: BootstrapState;
  onDismiss: () => void;
};

export function BootstrapProgress({
  state,
  onDismiss,
}: BootstrapProgressProps) {
  if (state.status === BootstrapStatus.Idle) {
    return null;
  }

  if (
    state.status === BootstrapStatus.Creating ||
    state.status === BootstrapStatus.Dispatched ||
    state.status === BootstrapStatus.Running
  ) {
    const message =
      state.status === BootstrapStatus.Running
        ? "Generating agents..."
        : "Starting bootstrap...";

    return (
      <div className="flex items-center gap-3 rounded-md border bg-muted/30 px-4 py-3">
        <Loader2Icon className="h-5 w-5 shrink-0 animate-spin text-primary" />
        <div>
          <p className="font-medium text-sm">{message}</p>
          <p className="text-muted-foreground text-xs">
            This may take several minutes depending on repository size.
          </p>
        </div>
      </div>
    );
  }

  if (state.status === BootstrapStatus.Error) {
    return (
      <div className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
        <AlertCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
        <div className="flex-1">
          <p className="font-medium text-destructive text-sm">
            Bootstrap failed
          </p>
          <p className="text-muted-foreground text-xs">{state.error}</p>
        </div>
        <Button onClick={onDismiss} size="sm" variant="ghost">
          Dismiss
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-md border bg-muted/30 px-4 py-3">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <CheckCircle2Icon className="mt-0.5 h-5 w-5 shrink-0 text-green-500" />
          <p className="font-medium text-sm">
            Bootstrap complete — agents have been created.
          </p>
        </div>
        <Button onClick={onDismiss} size="sm" variant="ghost">
          Dismiss
        </Button>
      </div>
    </div>
  );
}
