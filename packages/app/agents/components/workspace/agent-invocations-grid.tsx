"use client";

import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { SESSION_LIST_MAX_OFFSET } from "@repo/api/src/types/agent-session-list-limits";
import { ReadSource } from "@repo/api/src/types/read-source";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  EMPTY_TABLE_GROUPING,
  TableSavedViewScope,
} from "@repo/design-system/components/ui/table-toolbar-model";
import type { SavedViewCollection } from "@repo/design-system/lib/table-saved-views";
import { useState } from "react";
import { z } from "zod";
import {
  useFavoriteArtifacts,
  useToggleFavoriteArtifact,
} from "../../../documents/hooks/use-artifact-favorites";
import { useOptionalAuthSnapshot } from "../../../shared/auth/use-auth-snapshot";
import { useCoarseNow } from "../../../shared/hooks/use-coarse-now";
import { usePersistedSavedViews } from "../../../shared/hooks/use-persisted-saved-views";
import {
  DateRange,
  getStableUtcDateWindowForRange,
} from "../../../shared/lib/format-utils";
import type { AgentSessionQueryFilters } from "../../data-source/agent-sessions-data-source";
import { useAgentSessionsDataSourceOptional } from "../../data-source/provider";
import { useAgentSessionsPageData } from "../../hooks/use-agent-sessions";
import {
  adaptAgentComponentSessions,
  type SessionHrefTarget,
} from "../../lib/agent-component-session-adapter";
import { SESSION_DURATION_TICK_MS } from "../../lib/session-duration";
import { DEFAULT_SESSION_FACET_FILTERS } from "../../lib/session-filter-adapter";
import { toSessionSortRuleParams } from "../../lib/session-sort-group";
import { SessionsListReadState } from "../../lib/sessions-list-read-state";
import { SessionsListSurfaceV2 } from "../sessions/sessions-list-surface-v2";
import {
  resolveSessionsListSorts,
  type SessionsListViewState,
} from "../sessions/sessions-list-view-state";
import {
  deserializeSessionsListViewState,
  serializeSessionsListViewState,
} from "../sessions/sessions-list-view-state-serialization";
import { SESSIONS_SUMMARY_CARD_IDS } from "../sessions/sessions-summary-card-visibility";
import { AgentDetailPagedSessions } from "./agent-detail-pagination";

/** Uses the complete server cohort; a cursor page never becomes a filter universe. */
export function AgentInvocationsGrid(props: AgentInvocationsGridProps) {
  const source = useAgentSessionsDataSourceOptional();
  const auth = useOptionalAuthSnapshot();
  if (!source?.supportsComponentScope) {
    return <AgentDetailPagedSessions {...props} />;
  }
  return (
    <ScopedInvocationsGrid
      {...props}
      key={`${source.scope}:${auth?.orgId ?? ""}:${auth?.userId ?? ""}:${props.component.slug}`}
    />
  );
}

function ScopedInvocationsGrid({
  component,
  getSessionHref,
}: AgentInvocationsGridProps) {
  const auth = useOptionalAuthSnapshot();
  const views = usePersistedSavedViews({
    keyPrefix: "agent-invocations:views:",
    persistKey:
      auth?.orgId && auth.userId
        ? `${auth.orgId}:${auth.userId}:${component.slug}`
        : undefined,
    parse: parseInvocationViews,
    onPersistError: () => toast.error("Failed to save view"),
  });
  if (!views.restored) {
    return (
      <Skeleton
        aria-label="Loading component details…"
        className="h-40 w-full"
        role="status"
      />
    );
  }
  return (
    <InvocationGridContent
      component={component}
      getSessionHref={getSessionHref}
      views={views}
    />
  );
}

function InvocationGridContent({
  component,
  getSessionHref,
  views,
}: AgentInvocationsGridProps & { views: InvocationViewsStore }) {
  const source = useAgentSessionsDataSourceOptional();
  const isLocal = source?.scope === ReadSource.Local;
  const [view, setView] = useState(() => restoreInvocationView(views));
  const [pageSize, setPageSize] = useState(50);
  const query = useAgentSessionsPageData(
    invocationSessionFilters(component.slug, view, pageSize)
  );
  const favorites = useFavoriteArtifacts({ enabled: !isLocal });
  const toggleFavorite = useToggleFavoriteArtifact();
  const list = query.data?.list;
  const now = useCoarseNow(SESSION_DURATION_TICK_MS);
  const rows = adaptAgentComponentSessions(component, list?.items ?? [], {
    now,
  });
  return (
    <SessionsListSurfaceV2
      className="min-h-96"
      controlledView={{
        value: view,
        onChange: setView,
        totalRows: list?.total,
        readState: invocationReadState(
          query.isPending,
          query.isError,
          list !== undefined
        ),
      }}
      favorites={
        isLocal
          ? undefined
          : {
              favoriteIds: new Set(
                favorites.data?.map((artifact) => artifact.id) ?? []
              ),
              isUnavailable: !favorites.isSuccess,
              onChange: (row, favorited) =>
                toggleFavorite.mutate({
                  artifactId: row.id,
                  isFavorite: !favorited,
                }),
            }
      }
      getSessionHref={getSessionHref}
      hiddenSummaryCards={hiddenInvocationMetrics}
      isError={query.isError}
      isPending={query.isPending}
      maxOffset={SESSION_LIST_MAX_OFFSET}
      maxSortRules={isLocal ? 1 : undefined}
      onPageSizeChange={(size) => {
        setPageSize(size);
        setView((current) => ({ ...current, page: 0 }));
      }}
      onResetView={() => {
        views.selectView(null);
        setView(createInvocationView());
      }}
      onRetry={() => {
        query.refetch();
      }}
      pageInfo={list?.pageInfo}
      pageSize={pageSize}
      rows={rows}
      savedViews={{
        activeViewId: views.activeViewId,
        onApply: (id) => {
          views.selectView(id);
        },
        views: views.views.flatMap((saved) => {
          const value = deserializeSessionsListViewState(saved.arrangement);
          return value
            ? [
                {
                  id: saved.id,
                  name: saved.name,
                  scope: TableSavedViewScope.Personal,
                  value,
                },
              ]
            : [];
        }),
        onSave: (name, value) => {
          views.createView(name, serializeSessionsListViewState(value));
        },
      }}
      usage={query.data?.usage}
    />
  );
}

export function invocationSessionFilters(
  slug: string,
  view: SessionsListViewState,
  pageSize: number
): AgentSessionQueryFilters {
  return {
    ...view.facets,
    ...getStableUtcDateWindowForRange(view.dateRange),
    componentSlug: slug,
    limit: pageSize,
    offset: view.page * pageSize,
    sorts: toSessionSortRuleParams(resolveSessionsListSorts(view)),
  };
}

function createInvocationView(): SessionsListViewState {
  return {
    dateRange: DateRange.AllTime,
    facets: DEFAULT_SESSION_FACET_FILTERS,
    grouping: EMPTY_TABLE_GROUPING,
    page: 0,
    scopeUserId: null,
    sortBy: "updated",
    sortDir: "desc",
    visibleColumnIds: new Set(["owner", "status", "updated"]),
    hiddenSummaryCardIds: hiddenInvocationMetrics,
  };
}

function invocationReadState(
  pending: boolean,
  error: boolean,
  hasData: boolean
): SessionsListReadState {
  if (pending) {
    return SessionsListReadState.Loading;
  }
  if (error && !hasData) {
    return SessionsListReadState.Error;
  }
  return SessionsListReadState.Settled;
}

function parseInvocationViews(
  raw: unknown
): SavedViewCollection<
  ReturnType<typeof serializeSessionsListViewState>
> | null {
  const parsed = invocationViewsSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const views: SavedViewCollection<
    ReturnType<typeof serializeSessionsListViewState>
  >["views"] = [];
  for (const saved of parsed.data.views) {
    const value = deserializeSessionsListViewState(saved.arrangement);
    if (!value) {
      return null;
    }
    views.push({
      ...saved,
      arrangement: serializeSessionsListViewState(value),
    });
  }
  return { views, activeViewId: parsed.data.activeViewId };
}

type AgentInvocationsGridProps = {
  component: AgentComponentDetail;
  getSessionHref?: (session: SessionHrefTarget) => string;
};

const hiddenInvocationMetrics = new Set<string>(SESSIONS_SUMMARY_CARD_IDS);
const invocationViewsSchema = z.object({
  activeViewId: z.string().nullable(),
  views: z.array(
    z.object({
      id: z.string(),
      name: z.string().min(1),
      arrangement: z.unknown(),
    })
  ),
});

function restoreInvocationView(
  views: InvocationViewsStore
): SessionsListViewState {
  const active = views.views.find((view) => view.id === views.activeViewId);
  return (
    deserializeSessionsListViewState(active?.arrangement) ??
    createInvocationView()
  );
}

type InvocationViewsStore = ReturnType<
  typeof usePersistedSavedViews<
    ReturnType<typeof serializeSessionsListViewState>
  >
>;
