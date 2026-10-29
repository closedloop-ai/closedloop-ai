"use client";

import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS } from "@repo/api/src/types/agent-component";
import type { AgentComponentSessionsPage } from "@repo/api/src/types/agent-component-detail-page";
import type { AgentComponentInvocationReadPage } from "@repo/api/src/types/agent-component-invocation";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Clock3Icon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useAgentComponentsDataSource } from "../../data-source/provider";
import { agentComponentKeys } from "../../hooks/use-agent-components";
import type { SessionHrefTarget } from "../../lib/agent-component-session-adapter";
import { DetailSessionsTab } from "./detail-sessions-tab";
import { InvocationEvidenceList } from "./invocation-evidence-list";

export function AgentDetailPagedSessions({
  component,
  getSessionHref,
}: {
  component: AgentComponentDetail;
  getSessionHref?: (session: SessionHrefTarget) => string;
}) {
  const source = useAgentComponentsDataSource();
  const sessionPage = source.sessionPage;
  return (
    <DetailCursorPages
      initialPage={{
        items: component.sessionsTab,
        total: component.sessions,
        nextCursor: component.sessionsTabNextCursor ?? null,
      }}
      loadPage={
        sessionPage
          ? (cursor) => sessionPage(component.slug, cursor)
          : undefined
      }
      queryKey={[
        ...agentComponentKeys.detail(source.scope, component.slug),
        "sessions-page",
      ]}
      renderPage={(page) => (
        <DetailSessionsTab
          component={component}
          getSessionHref={getSessionHref}
          sessions={page.items}
          sessionsTabTruncated={component.sessionsTabTruncated}
          usageSessions={component.usageSessions}
          versions={component.versions}
        />
      )}
    />
  );
}

export function AgentDetailPagedEvidence({
  component,
  getSessionHref,
}: {
  component: AgentComponentDetail & {
    invocationRows: AgentComponentInvocationReadPage;
  };
  getSessionHref?: (sessionId: string) => string | null;
}) {
  const source = useAgentComponentsDataSource();
  const invocationPage = source.invocationPage;
  return (
    <DetailCursorPages
      initialPage={component.invocationRows}
      loadPage={
        invocationPage
          ? (cursor) => invocationPage(component.slug, cursor)
          : undefined
      }
      queryKey={[
        ...agentComponentKeys.detail(source.scope, component.slug),
        "invocations-page",
      ]}
      renderPage={(page) => (
        <InvocationEvidenceList getSessionHref={getSessionHref} page={page} />
      )}
    />
  );
}

function DetailCursorPages<
  Page extends AgentComponentSessionsPage | AgentComponentInvocationReadPage,
>({
  initialPage,
  loadPage,
  queryKey,
  renderPage,
}: {
  initialPage: Page;
  loadPage?: (cursor: string) => Promise<Page>;
  queryKey: readonly unknown[];
  renderPage: (page: Page) => ReactNode;
}) {
  const [positions, setPositions] = useState<
    readonly { cursor?: string; offset: number }[]
  >([{ offset: 0 }]);
  const position = positions.at(-1) ?? { offset: 0 };
  const cursor = position.cursor;
  const query = useQuery({
    queryKey: [...queryKey, cursor ?? null],
    queryFn: () => {
      if (!(loadPage && cursor !== undefined)) {
        throw new Error(
          "A continuation read requires a page loader and cursor."
        );
      }
      return loadPage(cursor);
    },
    enabled: cursor !== undefined && loadPage !== undefined,
    throwOnError: false,
  });
  const page = cursor === undefined ? initialPage : query.data;
  const nextCursor = page?.nextCursor;
  const localEnd =
    position.offset + AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS;
  const hasLocalNext = page !== undefined && localEnd < page.items.length;
  const canAdvance =
    hasLocalNext || (loadPage !== undefined && Boolean(nextCursor));
  return (
    <div className="flex flex-col gap-3">
      {cursor !== undefined && query.isPending ? (
        <Skeleton
          aria-label="Loading component details…"
          className="h-40 w-full"
          role="status"
        />
      ) : null}
      {query.isError ? (
        <EmptyState
          action={
            <Button onClick={() => query.refetch()} variant="outline">
              Retry
            </Button>
          }
          description="The artifact could not be loaded. Try again in a moment."
          icon={Clock3Icon}
          size="compact"
          title="Component unavailable"
        />
      ) : null}
      {page
        ? renderPage({
            ...page,
            items: page.items.slice(position.offset, localEnd),
          })
        : null}
      {positions.length > 1 || canAdvance ? (
        <fieldset aria-label="Pagination" className="flex justify-end gap-2">
          <Button
            disabled={positions.length === 1 || query.isFetching}
            onClick={() => setPositions((current) => current.slice(0, -1))}
            size="sm"
            variant="outline"
          >
            Previous
          </Button>
          <Button
            disabled={!canAdvance || query.isFetching}
            onClick={() => {
              if (hasLocalNext) {
                setPositions((current) => [
                  ...current,
                  { ...position, offset: localEnd },
                ]);
              } else if (nextCursor) {
                setPositions((current) => [
                  ...current,
                  { cursor: nextCursor, offset: 0 },
                ]);
              }
            }}
            size="sm"
            variant="outline"
          >
            Next
          </Button>
        </fieldset>
      ) : null}
    </div>
  );
}
