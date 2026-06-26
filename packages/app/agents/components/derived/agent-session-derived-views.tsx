"use client";

import type {
  SyncedAgentSessionAgent,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import { Card, CardContent } from "@repo/design-system/components/ui/card";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  type AgentSessionAnalyticsTab,
  AgentSessionDetailAnalyticsTabs,
  hasVisibleTelemetry,
} from "../detail/agent-session-detail-analytics-tabs";

export type AgentSessionDerivedViewsProps = {
  agents: SyncedAgentSessionAgent[];
  defaultTab?: AgentSessionAnalyticsTab;
  events: SyncedAgentSessionEvent[];
  isError?: boolean;
  isLoading?: boolean;
};

/**
 * Composition shell for session-derived workflow, tool, subagent, and error
 * views. Ownership of the actual derivation remains in detail analytics
 * modules so the session detail path has one source of truth.
 */
export function AgentSessionDerivedViews({
  agents,
  defaultTab,
  events,
  isError = false,
  isLoading = false,
}: Readonly<AgentSessionDerivedViewsProps>) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="space-y-3 p-6">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="p-6 text-muted-foreground text-sm">
          Agent-derived views are temporarily unavailable.
        </CardContent>
      </Card>
    );
  }

  if (agents.length === 0 && !hasVisibleTelemetry(events)) {
    return (
      <Card>
        <CardContent className="p-6 text-muted-foreground text-sm">
          No agent-derived views are available for this session.
        </CardContent>
      </Card>
    );
  }

  return (
    <AgentSessionDetailAnalyticsTabs
      agents={agents}
      defaultTab={defaultTab}
      events={events}
    />
  );
}
