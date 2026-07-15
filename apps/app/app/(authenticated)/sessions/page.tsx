"use client";

import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";
import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import { DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY } from "@repo/api/src/types/agent-session";
import { AgentSessionsListContent } from "@repo/app/agents/components/sessions/agent-sessions-list";
import { useAgentSessions } from "@repo/app/agents/hooks/use-agent-sessions";
import { ACTIVE_RUNS_FEATURE_FLAG_KEY } from "@repo/app/agents/lib/active-runs";
import {
  DATE_RANGE_LABELS,
  type DateRange,
  getStartDateForRange,
} from "@repo/app/shared/lib/format-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { Clock3Icon, FolderGit2Icon, HistoryIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Header } from "@/app/(authenticated)/components/header";
import { ActiveRunsSection } from "@/app/(authenticated)/sessions/active-runs-section";
import {
  clampSessionsPageIndex,
  readSessionsPageIndex,
  useSessionsHistoryScroll,
  useSessionsPageReset,
  writeSessionsPageParam,
} from "@/app/(authenticated)/sessions-route-state";

const PAGE_SIZE = 25;

export default function SessionsPage() {
  const navigation = useNavigation();
  const pathname = usePath();
  const searchParams = useSearchParamsValue();
  const selectedUserId = searchParams.get("userId");
  const [dateRange, setDateRange] = useState<DateRange>("30d");
  const [harness, setHarness] = useState("all");
  const [status, setStatus] = useState("all");
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(
    null
  );
  const urlPageIndex = readSessionsPageIndex(searchParams);
  const { effectivePageIndex, markPageOverride, markPageReset } =
    useSessionsPageReset({
      urlPageIndex,
    });

  const filters = useMemo(
    () => ({
      startDate: getStartDateForRange(dateRange),
      harness: harness === "all" ? undefined : harness,
      status: status === "all" ? undefined : status,
      userId: selectedUserId ?? undefined,
      limit: PAGE_SIZE,
      offset: effectivePageIndex * PAGE_SIZE,
    }),
    [dateRange, effectivePageIndex, harness, selectedUserId, status]
  );

  const sessionsQuery = useAgentSessions(filters);
  const total = sessionsQuery.data?.total;
  const totalPages = Math.max(1, Math.ceil((total ?? 0) / PAGE_SIZE));
  const replacePage = useCallback(
    (nextPage: number) => {
      const nextParams = new URLSearchParams(searchParams.toString());
      writeSessionsPageParam(nextParams, nextPage);
      const qs = nextParams.toString();
      navigation.replace(qs ? `${pathname}?${qs}` : pathname, {
        scroll: false,
      });
    },
    [navigation, pathname, searchParams]
  );
  const resetPageForQueryDomainChange = () => {
    markPageReset();
    replacePage(0);
  };
  useEffect(() => {
    if (total === undefined) {
      return;
    }

    const clampedPageIndex = clampSessionsPageIndex({
      pageIndex: effectivePageIndex,
      pageSize: PAGE_SIZE,
      total,
    });
    if (clampedPageIndex === effectivePageIndex) {
      return;
    }

    markPageOverride(clampedPageIndex);
    replacePage(clampedPageIndex);
  }, [effectivePageIndex, markPageOverride, replacePage, total]);
  useSessionsHistoryScroll({
    scrollKey: `sessions:page:${effectivePageIndex}`,
    container: scrollContainer,
    restoreWhen: !sessionsQuery.isLoading,
  });

  return (
    <FeatureFlagged flag={DESKTOP_AGENT_SESSION_SYNC_FEATURE_FLAG_KEY}>
      <div className="flex min-h-0 flex-1 flex-col">
        <Header breadcrumbs={[{ label: "Sessions" }]} />
        <div
          className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6"
          ref={setScrollContainer}
        >
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h1 className="font-semibold text-2xl tracking-tight">
                Sessions
              </h1>
              <p className="text-muted-foreground">
                Synced agent-session history from your connected compute
                targets.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Select
                onValueChange={(value) => {
                  setDateRange(value as DateRange);
                  resetPageForQueryDomainChange();
                }}
                value={dateRange}
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(DATE_RANGE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                onValueChange={(value) => {
                  setHarness(value);
                  resetPageForQueryDomainChange();
                }}
                value={harness}
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Harness" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All harnesses</SelectItem>
                  <SelectItem value="claude">Claude</SelectItem>
                  <SelectItem value="codex">Codex</SelectItem>
                  <SelectItem value="cursor">Cursor</SelectItem>
                  <SelectItem value="copilot">Copilot</SelectItem>
                  <SelectItem value="opencode">OpenCode</SelectItem>
                </SelectContent>
              </Select>
              <Select
                onValueChange={(value) => {
                  setStatus(value);
                  resetPageForQueryDomainChange();
                }}
                value={status}
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value={SESSION_STATUS.ACTIVE}>Active</SelectItem>
                  <SelectItem value={SESSION_STATUS.COMPLETED}>
                    Completed
                  </SelectItem>
                  <SelectItem value={SESSION_STATUS.ERROR}>Failed</SelectItem>
                  <SelectItem value={SESSION_STATUS.ABANDONED}>
                    Abandoned
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {selectedUserId ? (
            <div className="flex items-center gap-2">
              <Badge variant="secondary">User filtered</Badge>
              <span className="text-muted-foreground text-sm">
                Showing sessions for the selected user.
              </span>
            </div>
          ) : null}

          <FeatureFlagged flag={ACTIVE_RUNS_FEATURE_FLAG_KEY}>
            <ActiveRunsSection />
          </FeatureFlagged>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-2">
                    <HistoryIcon className="h-4 w-4" />
                    Session History
                  </CardTitle>
                  <CardDescription>
                    Review status, duration, token usage, and cost for past
                    sessions.
                  </CardDescription>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Button
                    disabled={effectivePageIndex === 0}
                    onClick={() =>
                      replacePage(Math.max(0, effectivePageIndex - 1))
                    }
                    variant="outline"
                  >
                    Previous
                  </Button>
                  <span className="text-muted-foreground text-sm">
                    Page {effectivePageIndex + 1} of {totalPages}
                  </span>
                  <Button
                    disabled={effectivePageIndex + 1 >= totalPages}
                    onClick={() =>
                      replacePage(
                        effectivePageIndex + 1 < totalPages
                          ? effectivePageIndex + 1
                          : effectivePageIndex
                      )
                    }
                    variant="outline"
                  >
                    Next
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <AgentSessionsListContent
                getSessionHref={(item) => `/sessions/${item.id}`}
                isLoading={sessionsQuery.isLoading}
                items={sessionsQuery.data?.items ?? []}
              />
            </CardContent>
          </Card>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FolderGit2Icon className="h-4 w-4" />
                  Working Directory Hints
                </CardTitle>
              </CardHeader>
              <CardContent className="text-muted-foreground text-sm">
                Session rows preserve the working directory and repository
                context captured by the desktop monitor so you can tell which
                codebase a session was running against.
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock3Icon className="h-4 w-4" />
                  Near-Real-Time Sync
                </CardTitle>
              </CardHeader>
              <CardContent className="text-muted-foreground text-sm">
                New sessions appear after the desktop sync pipeline forwards the
                latest local agent-monitor data through the relay.
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </FeatureFlagged>
  );
}
