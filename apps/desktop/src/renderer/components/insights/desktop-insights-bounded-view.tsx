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
import { TablePagination } from "@closedloop-ai/design-system/components/ui/table-pagination-v2";
import { SESSION_MESH_V1_FEATURE_FLAG_KEY } from "@repo/api/src/types/session-mesh-flag";
import { resolveTotalPages } from "@repo/api/src/utils/math";
import { SyncedSessionsTable } from "@repo/app/agents/components/sessions/synced-sessions-table";
import { refetchAsUser } from "@repo/app/agents/hooks/read-initiator";
import { useAgentSessions } from "@repo/app/agents/hooks/use-agent-sessions";
import { SessionMeshInsightsCard } from "@repo/app/insights/components/session-mesh-insights-card";
import { useSessionMeshInsights } from "@repo/app/insights/hooks/use-session-mesh-insights";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { desktopSessionDetailHref } from "../../shared-agent-sessions/session-hrefs";
import { PageShell } from "../layout/page-shell";
import {
  INSIGHTS_PAGE_DESCRIPTION,
  INSIGHTS_PAGE_TITLE,
} from "./insights-view-constants";

const PAGE_SIZE = 25;

/**
 * Bounded Desktop Insights surface. Local full-history aggregate scans can
 * block the Electron renderer on large histories, so this view starts with a
 * paged list-only query and keeps aggregate analysis out of the click path.
 */
export function DesktopInsightsBoundedView() {
  const sessionMeshEnabled = useFeatureFlagEnabled(
    SESSION_MESH_V1_FEATURE_FLAG_KEY
  );
  const [page, setPage] = useState(0);
  const [meshScope, setMeshScope] = useState<"me" | "org">("me");
  const [meshPeriod, setMeshPeriod] = useState<"7" | "30" | "90" | "all">("30");
  const sessionsQuery = useAgentSessions({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const items = sessionsQuery.data?.items ?? [];
  const total = sessionsQuery.data?.total ?? 0;
  const totalPages = resolveTotalPages(total, PAGE_SIZE);
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, total);

  useEffect(() => {
    if (!sessionsQuery.isLoading && page >= totalPages) {
      setPage(totalPages - 1);
    }
  }, [page, sessionsQuery.isLoading, totalPages]);

  const handleRefresh = () => {
    refetchAsUser(sessionsQuery.refetch).catch(() => undefined);
  };

  // FEA-3989: one page subtitle (INSIGHTS_PAGE_DESCRIPTION) instead of a
  // subtitle plus a card heading plus a card paragraph all restating "recent
  // synced session activity". The Refresh control moves to the PageShell header;
  // the sessions list + pagination render directly as PageShell children so the
  // shell owns the 24px vertical rhythm (no competing space-y wrapper).
  return (
    <PageShell
      actions={
        <Button
          disabled={sessionsQuery.isFetching}
          onClick={handleRefresh}
          type="button"
          variant="outline"
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      }
      description={INSIGHTS_PAGE_DESCRIPTION}
      title={INSIGHTS_PAGE_TITLE}
    >
      {sessionMeshEnabled ? (
        <DesktopSessionMeshInsights
          onPeriodChange={setMeshPeriod}
          onScopeChange={setMeshScope}
          period={meshPeriod}
          scope={meshScope}
        />
      ) : null}
      <Card>
        <CardContent className="space-y-4">
          <InsightsSessionsContent
            isError={sessionsQuery.isError}
            isLoading={sessionsQuery.isLoading}
            items={items}
          />
          <div className="flex flex-col gap-3 border-border/70 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="shrink-0 text-[var(--muted-foreground)] text-xs uppercase tracking-[0.18em]">
              {from.toLocaleString()}-{to.toLocaleString()} of{" "}
              {total.toLocaleString()}
            </div>
            {/* ISS-11412: the v2 pager stays mounted on a single page by
                design, so a settled one-page (or empty) list shows it with
                both boundaries locked. With no data yet (first load, a page
                still loading, an error with nothing retained) `total` is only
                the 0 default, and the pager stays out as it did before. */}
            {sessionsQuery.data ? (
              <TablePagination
                className="justify-start sm:justify-end"
                onPageChange={setPage}
                page={page}
                totalPages={totalPages}
              />
            ) : null}
          </div>
        </CardContent>
      </Card>
    </PageShell>
  );
}

function DesktopSessionMeshInsights({
  onPeriodChange,
  onScopeChange,
  period,
  scope,
}: {
  onPeriodChange: (value: "7" | "30" | "90" | "all") => void;
  onScopeChange: (value: "me" | "org") => void;
  period: "7" | "30" | "90" | "all";
  scope: "me" | "org";
}) {
  const sessionMeshQuery = useSessionMeshInsights(true, scope, period);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Select
          onValueChange={(value) => onScopeChange(value as "me" | "org")}
          value={scope}
        >
          <SelectTrigger aria-label="Metrics scope" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="me">My metrics</SelectItem>
            <SelectItem value="org">Organization</SelectItem>
          </SelectContent>
        </Select>
        <Select
          onValueChange={(value) =>
            onPeriodChange(value as "7" | "30" | "90" | "all")
          }
          value={period}
        >
          <SelectTrigger aria-label="Metrics period" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">7 days</SelectItem>
            <SelectItem value="30">30 days</SelectItem>
            <SelectItem value="90">90 days</SelectItem>
            <SelectItem value="all">All retained</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <SessionMeshInsightsCard
        data={sessionMeshQuery.data}
        isError={sessionMeshQuery.isError}
        isLoading={sessionMeshQuery.isLoading}
      />
    </div>
  );
}

function InsightsSessionsContent({
  isError,
  isLoading,
  items,
}: Readonly<{
  isError: boolean;
  isLoading: boolean;
  items: Parameters<typeof SyncedSessionsTable>[0]["items"];
}>) {
  if (isLoading) {
    return (
      <div className="rounded-md border border-border/70 p-5 text-[var(--muted-foreground)] text-sm">
        Loading recent sessions...
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-md border border-border/70 p-5 text-[var(--destructive)] text-sm">
        Recent sessions are temporarily unavailable.
      </div>
    );
  }

  return (
    <SyncedSessionsTable
      emptyState={
        <div className="py-10 text-center text-[var(--muted-foreground)] text-sm">
          No synced sessions found.
        </div>
      }
      getSessionHref={desktopSessionDetailHref}
      items={items}
    />
  );
}
