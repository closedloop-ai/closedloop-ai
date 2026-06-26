import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Card,
  CardContent,
} from "@closedloop-ai/design-system/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@closedloop-ai/design-system/components/ui/select";
import { TablePagination } from "@closedloop-ai/design-system/components/ui/table-pagination";
import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { AgentSessionDerivedViews } from "@repo/app/agents/components/derived/agent-session-derived-views";
import {
  AgentSessionAnalyticsTab,
  type AgentSessionAnalyticsTab as AgentSessionAnalyticsTabValue,
} from "@repo/app/agents/components/detail/agent-session-detail-analytics-tabs";
import {
  useAgentSessionDetail,
  useAgentSessions,
} from "@repo/app/agents/hooks/use-agent-sessions";
import { RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { PageShell } from "../layout/page-shell";

const PAGE_SIZE = 25;

type DesktopDerivedTelemetryViewProps = {
  defaultTab: AgentSessionAnalyticsTabValue;
  description: string;
  title: string;
};

export function WorkflowsView() {
  return (
    <DesktopDerivedTelemetryView
      defaultTab={AgentSessionAnalyticsTab.Orchestration}
      description="Per-session orchestration, tool flow, and agent effectiveness drill-downs"
      title="Workflows"
    />
  );
}

export function ToolsView() {
  return (
    <DesktopDerivedTelemetryView
      defaultTab={AgentSessionAnalyticsTab.ToolFlow}
      description="Per-session tool execution flow and captured tool telemetry"
      title="Tools"
    />
  );
}

export function SubAgentsView() {
  return (
    <DesktopDerivedTelemetryView
      defaultTab={AgentSessionAnalyticsTab.Effectiveness}
      description="Per-session subagent roles, outcomes, and collaboration patterns"
      title="SubAgents"
    />
  );
}

function DesktopDerivedTelemetryView({
  defaultTab,
  description,
  title,
}: Readonly<DesktopDerivedTelemetryViewProps>) {
  const [page, setPage] = useState(0);
  const sessionsQuery = useAgentSessions({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const sessions = sessionsQuery.data?.items ?? [];
  const total = sessionsQuery.data?.total ?? sessions.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, total);
  const [requestedSessionId, setRequestedSessionId] = useState<string | null>(
    null
  );

  useEffect(() => {
    if (!(sessionsQuery.isLoading || total === 0) && page >= totalPages) {
      setPage(totalPages - 1);
    }
  }, [page, sessionsQuery.isLoading, total, totalPages]);

  const selectedSession = requestedSessionId
    ? sessions.find((session) => session.id === requestedSessionId)
    : undefined;
  const selectedSessionId = selectedSession?.id ?? "";
  const detailQuery = useAgentSessionDetail(selectedSessionId);
  const handleRefresh = () => {
    sessionsQuery.refetch();
    if (selectedSessionId) {
      detailQuery.refetch();
    }
  };
  const content = renderDerivedContent({
    defaultTab,
    detailQuery,
    selectedSession,
    selectedSessionId,
    sessions,
    sessionsQuery,
  });

  return (
    <PageShell description={description} title={title}>
      <div className="space-y-4">
        <Card>
          <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-end md:justify-between">
            <div className="min-w-0 flex-1 space-y-2">
              <label
                className="font-medium text-[var(--foreground)] text-sm"
                htmlFor={`${title.toLowerCase()}-session-selector`}
              >
                Session
              </label>
              <Select
                disabled={sessions.length === 0}
                onValueChange={setRequestedSessionId}
                value={selectedSessionId}
              >
                <SelectTrigger
                  aria-label={`${title} session`}
                  className="w-full md:max-w-xl"
                  id={`${title.toLowerCase()}-session-selector`}
                >
                  <SelectValue
                    placeholder={sessionSelectorPlaceholder(sessionsQuery)}
                  />
                </SelectTrigger>
                <SelectContent>
                  {sessions.map((session) => (
                    <SelectItem key={session.id} value={session.id}>
                      {sessionLabel(session)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between md:max-w-xl">
                <div className="shrink-0 text-[var(--muted-foreground)] text-xs uppercase tracking-[0.18em]">
                  {from.toLocaleString()}-{to.toLocaleString()} of{" "}
                  {total.toLocaleString()}
                </div>
                <TablePagination
                  className="justify-start sm:justify-end"
                  onPageChange={setPage}
                  page={page}
                  totalPages={totalPages}
                />
              </div>
            </div>
            <Button
              aria-label={`Refresh ${title} sessions`}
              disabled={sessionsQuery.isFetching || detailQuery.isFetching}
              onClick={handleRefresh}
              size="sm"
              type="button"
              variant="outline"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </CardContent>
        </Card>

        {content}
      </div>
    </PageShell>
  );
}

function sessionSelectorPlaceholder(
  sessionsQuery: ReturnType<typeof useAgentSessions>
): string {
  if (sessionsQuery.isLoading) {
    return "Loading sessions...";
  }
  if (sessionsQuery.isError) {
    return "Sessions unavailable";
  }
  return "Select a session";
}

function sessionLabel(session: AgentSessionListItem): string {
  return session.name ?? session.externalSessionId;
}

function renderDerivedContent({
  defaultTab,
  detailQuery,
  selectedSession,
  selectedSessionId,
  sessions,
  sessionsQuery,
}: {
  defaultTab: AgentSessionAnalyticsTabValue;
  detailQuery: ReturnType<typeof useAgentSessionDetail>;
  selectedSession: AgentSessionListItem | undefined;
  selectedSessionId: string;
  sessions: readonly AgentSessionListItem[];
  sessionsQuery: ReturnType<typeof useAgentSessions>;
}): ReactNode {
  if (sessionsQuery.isError) {
    return (
      <AgentSessionDerivedViews
        agents={[]}
        defaultTab={defaultTab}
        events={[]}
        isError
      />
    );
  }

  if (sessionsQuery.isLoading && sessions.length === 0) {
    return (
      <AgentSessionDerivedViews
        agents={[]}
        defaultTab={defaultTab}
        events={[]}
        isLoading
      />
    );
  }

  if (sessions.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-[var(--muted-foreground)] text-sm">
          No sessions are captured yet.
        </CardContent>
      </Card>
    );
  }

  if (selectedSessionId === "") {
    return (
      <Card>
        <CardContent className="p-6 text-[var(--muted-foreground)] text-sm">
          Select a session from the current page to inspect derived telemetry.
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      {selectedSession ? (
        <p className="text-[var(--muted-foreground)] text-sm">
          Showing derived telemetry for{" "}
          <span className="font-medium text-[var(--foreground)]">
            {selectedSession.name ?? selectedSession.externalSessionId}
          </span>
          .
        </p>
      ) : null}
      <AgentSessionDerivedViews
        agents={detailQuery.data?.agents ?? []}
        defaultTab={defaultTab}
        events={detailQuery.data?.events ?? []}
        isError={detailQuery.isError}
        isLoading={
          detailQuery.isLoading ||
          detailQuery.isFetching ||
          selectedSessionId === ""
        }
      />
    </>
  );
}
