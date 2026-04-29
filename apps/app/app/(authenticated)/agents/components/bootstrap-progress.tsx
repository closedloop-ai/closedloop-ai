"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react";
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
    state.status === BootstrapStatus.Running ||
    state.status === BootstrapStatus.Ingesting
  ) {
    return (
      <div className="flex items-center gap-3 rounded-md border bg-muted/30 px-4 py-3">
        <Loader2Icon className="h-5 w-5 shrink-0 animate-spin text-primary" />
        <div>
          <p className="font-medium text-sm">
            {state.status === BootstrapStatus.Running
              ? "Generating agents..."
              : "Saving agents..."}
          </p>
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

  const { result } = state;
  const successRepos = result.repoSummaries.filter((r) => r.success);
  const failedRepos = result.repoSummaries.filter((r) => !r.success);
  const totalAgents = result.totalCreated + result.totalUpdated;

  return (
    <div className="rounded-md border bg-muted/30 px-4 py-3">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <CheckCircle2Icon className="mt-0.5 h-5 w-5 shrink-0 text-green-500" />
          <div>
            <p className="font-medium text-sm">
              Generated {totalAgents} agent{totalAgents !== 1 ? "s" : ""} from{" "}
              {successRepos.length} repositor
              {successRepos.length !== 1 ? "ies" : "y"}
            </p>
            {result.totalCreated > 0 && (
              <Badge className="mt-1 mr-1" variant="secondary">
                {result.totalCreated} new
              </Badge>
            )}
            {result.totalUpdated > 0 && (
              <Badge className="mt-1" variant="outline">
                {result.totalUpdated} updated
              </Badge>
            )}
          </div>
        </div>
        <Button onClick={onDismiss} size="sm" variant="ghost">
          Dismiss
        </Button>
      </div>

      {(successRepos.length > 0 || failedRepos.length > 0) && (
        <ul className="mt-2 space-y-1 pl-8">
          {successRepos.map((repo) => (
            <li className="flex items-center gap-2 text-sm" key={repo.fullName}>
              <CheckCircle2Icon className="h-3.5 w-3.5 text-green-500" />
              <span>{repo.fullName}</span>
              <span className="text-muted-foreground">
                — {repo.agentCount} agent{repo.agentCount !== 1 ? "s" : ""}
              </span>
            </li>
          ))}
          {failedRepos.map((repo) => (
            <li className="flex items-center gap-2 text-sm" key={repo.fullName}>
              <XCircleIcon className="h-3.5 w-3.5 text-destructive" />
              <span>{repo.fullName}</span>
              {repo.error && (
                <span className="text-muted-foreground">— {repo.error}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
