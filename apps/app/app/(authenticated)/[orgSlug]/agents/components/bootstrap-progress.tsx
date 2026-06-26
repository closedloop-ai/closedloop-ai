"use client";

import { useAgents } from "@repo/app/agents/hooks/use-agents";
import {
  type BootstrapState,
  BootstrapStatus,
} from "@repo/app/agents/hooks/use-bootstrap-agents";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Link } from "@repo/navigation/link";
import { AlertCircleIcon, CheckCircle2Icon, Loader2Icon } from "lucide-react";
import { useOrgSlug } from "@/hooks/use-org-slug";

type BootstrapProgressProps = {
  state: BootstrapState;
  onDismiss: () => void;
  fromOnboarding?: boolean;
};

export function BootstrapProgress({
  state,
  onDismiss,
  fromOnboarding,
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

  if (fromOnboarding) {
    return <OnboardingCompletion onDismiss={onDismiss} />;
  }

  return (
    <div className="rounded-md border bg-muted/30 px-4 py-3">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <CheckCircle2Icon className="mt-0.5 h-5 w-5 shrink-0 text-success" />
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

function OnboardingCompletion({
  onDismiss,
}: {
  readonly onDismiss: () => void;
}) {
  const orgSlug = useOrgSlug();
  const { data } = useAgents();
  const agents = data?.agents ?? [];

  return (
    <div className="rounded-md border border-success/20 bg-success/5 px-4 py-4">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <CheckCircle2Icon className="mt-0.5 h-5 w-5 shrink-0 text-success" />
          <div className="space-y-3">
            <div>
              <p className="font-medium text-sm">Your agents are ready!</p>
              <p className="text-muted-foreground text-xs">
                Review your agents — enable, disable, or edit their prompts.
              </p>
            </div>

            {agents.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {agents.map((agent) => (
                  <Badge key={agent.id} variant="secondary">
                    {agent.name}
                  </Badge>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button onClick={onDismiss} size="sm">
                Review Agents
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={`/${orgSlug}/my-tasks`}>
                  Create your first feature
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
