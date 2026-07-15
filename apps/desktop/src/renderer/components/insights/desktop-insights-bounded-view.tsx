import { SyncedSessionsTable } from "@repo/app/agents/components/sessions/synced-sessions-table";
import { useAgentSessions } from "@repo/app/agents/hooks/use-agent-sessions";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Card, CardContent } from "@closedloop-ai/design-system/components/ui/card";
import { TablePagination } from "@closedloop-ai/design-system/components/ui/table-pagination";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { desktopSessionDetailHashHref } from "../../shared-agent-sessions/session-hrefs";
import { PageShell } from "../layout/page-shell";

const PAGE_SIZE = 25;

/**
 * Bounded Desktop Insights surface. Local full-history aggregate scans can
 * block the Electron renderer on large histories, so this view starts with a
 * paged list-only query and keeps aggregate analysis out of the click path.
 */
export function DesktopInsightsBoundedView() {
  const [page, setPage] = useState(0);
  const sessionsQuery = useAgentSessions({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const items = sessionsQuery.data?.items ?? [];
  const total = sessionsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, total);

  useEffect(() => {
    if (!sessionsQuery.isLoading && page >= totalPages) {
      setPage(totalPages - 1);
    }
  }, [page, sessionsQuery.isLoading, totalPages]);

  const handleRefresh = () => {
    sessionsQuery.refetch().catch(() => undefined);
  };

  return (
    <PageShell
      description="Recent agent-session activity across your synced compute targets."
      title="Agent Monitoring"
    >
      <div className="space-y-4">
        <Card className="rounded-xl border-border/80 bg-card shadow-sm">
          <CardContent className="flex flex-col gap-3 p-5 md:flex-row md:items-center md:justify-between">
            <div className="space-y-1">
              <h2 className="font-medium text-[var(--foreground)] text-base">
                Recent session activity
              </h2>
              <p className="max-w-2xl text-[var(--muted-foreground)] text-sm">
                Showing synced sessions in bounded pages so large local
                histories remain responsive.
              </p>
            </div>
            <Button
              disabled={sessionsQuery.isFetching}
              onClick={handleRefresh}
              type="button"
              variant="outline"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </CardContent>
        </Card>

        <Card className="rounded-xl border-border/80 bg-card shadow-sm">
          <CardContent className="space-y-4 p-5">
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
              <TablePagination
                className="justify-start sm:justify-end"
                onPageChange={setPage}
                page={page}
                totalPages={totalPages}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </PageShell>
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
      getSessionHref={desktopSessionDetailHashHref}
      items={items}
    />
  );
}
