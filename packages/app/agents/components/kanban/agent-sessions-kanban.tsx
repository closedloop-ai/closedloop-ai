"use client";

import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";
import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Input } from "@repo/design-system/components/ui/input";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { Clock3Icon, Columns3Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { useAgentSessions } from "../../hooks/use-agent-sessions";
import { DegradedState } from "../shared/degraded-state";

const KANBAN_LIMIT = 25;
const KANBAN_QUERY_FILTERS = {
  limit: KANBAN_LIMIT,
  offset: 0,
} as const;

const KanbanColumnId = {
  Abandoned: "abandoned",
  Active: "active",
  AwaitingInput: "awaiting-input",
  Completed: "completed",
  Failed: "failed",
} as const;

type KanbanColumnId = (typeof KanbanColumnId)[keyof typeof KanbanColumnId];

type KanbanColumnDefinition = {
  id: KanbanColumnId;
  title: string;
};

const KANBAN_COLUMNS: KanbanColumnDefinition[] = [
  { id: KanbanColumnId.AwaitingInput, title: "Awaiting Input" },
  { id: KanbanColumnId.Active, title: "Active" },
  { id: KanbanColumnId.Completed, title: "Completed" },
  { id: KanbanColumnId.Failed, title: "Failed" },
  { id: KanbanColumnId.Abandoned, title: "Abandoned" },
];

export type AgentSessionsKanbanProps = {
  getSessionHref?: (item: AgentSessionListItem) => string;
};

/**
 * Shared package-only kanban body derived from the existing list hook. Awaiting
 * Input is a client projection from active/waiting rows with awaiting input.
 */
export function AgentSessionsKanban({
  getSessionHref,
}: Readonly<AgentSessionsKanbanProps>) {
  const [search, setSearch] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const activeSessionsQuery = useAgentSessions({
    ...KANBAN_QUERY_FILTERS,
    status: SESSION_STATUS.ACTIVE,
  });
  const completedSessionsQuery = useAgentSessions({
    ...KANBAN_QUERY_FILTERS,
    status: SESSION_STATUS.COMPLETED,
  });
  // Send the canonical cloud value ("error"). The cloud HTTP source filters
  // `artifact.status === "error"`; the desktop-local source canonicalizes the
  // requested value through its "error"→"failed" alias map so the same query
  // returns the Failed column on both sources. The "failed" literal previously
  // matched zero rows on the cloud source.
  const failedSessionsQuery = useAgentSessions({
    ...KANBAN_QUERY_FILTERS,
    status: SESSION_STATUS.ERROR,
  });
  const abandonedSessionsQuery = useAgentSessions({
    ...KANBAN_QUERY_FILTERS,
    status: SESSION_STATUS.ABANDONED,
  });
  const sessionQueries = [
    activeSessionsQuery,
    completedSessionsQuery,
    failedSessionsQuery,
    abandonedSessionsQuery,
  ];
  const sessions = useMemo(
    () => [
      ...(activeSessionsQuery.data?.items ?? []),
      ...(completedSessionsQuery.data?.items ?? []),
      ...(failedSessionsQuery.data?.items ?? []),
      ...(abandonedSessionsQuery.data?.items ?? []),
    ],
    [
      activeSessionsQuery.data?.items,
      abandonedSessionsQuery.data?.items,
      completedSessionsQuery.data?.items,
      failedSessionsQuery.data?.items,
    ]
  );
  const columns = useMemo(
    () => groupKanbanSessions(sessions, search),
    [sessions, search]
  );
  const selectedSession = sessions.find(
    (item) => item.id === selectedSessionId
  );

  if (sessionQueries.some((query) => query.isLoading)) {
    return <Skeleton className="h-[520px] w-full" />;
  }

  if (sessionQueries.some((query) => query.isError)) {
    return (
      <DegradedState message="Kanban sessions are temporarily unavailable from the sessions list." />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="font-semibold text-2xl tracking-tight">
            Agent Sessions
          </h1>
          <p className="text-muted-foreground">Recent sessions by status.</p>
        </div>
        <Input
          aria-label="Search sessions"
          className="max-w-sm"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search sessions"
          value={search}
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-5">
        {KANBAN_COLUMNS.map((column) => (
          <KanbanColumn
            getSessionHref={getSessionHref}
            items={columns[column.id]}
            key={column.id}
            onSelectSession={setSelectedSessionId}
            selectedSessionId={selectedSessionId}
            title={column.title}
          />
        ))}
      </div>
      {selectedSession ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {selectedSession.name ?? selectedSession.externalSessionId}
            </CardTitle>
            <CardDescription>Selected session details</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm md:grid-cols-3">
            <div>
              <div className="text-muted-foreground">Repository</div>
              <div className="font-medium">
                {selectedSession.repositoryFullName ?? "Unknown repository"}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Model</div>
              <div className="font-medium">
                {selectedSession.model ?? "Unknown model"}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Updated</div>
              <div className="font-medium">
                {formatRelativeTime(selectedSession.updatedAt)}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export function groupKanbanSessions(
  items: AgentSessionListItem[],
  search: string
): Record<KanbanColumnId, AgentSessionListItem[]> {
  const normalizedSearch = search.trim().toLowerCase();
  const grouped: Record<KanbanColumnId, AgentSessionListItem[]> = {
    [KanbanColumnId.Abandoned]: [],
    [KanbanColumnId.Active]: [],
    [KanbanColumnId.AwaitingInput]: [],
    [KanbanColumnId.Completed]: [],
    [KanbanColumnId.Failed]: [],
  };

  for (const item of items) {
    if (normalizedSearch && !matchesSearch(item, normalizedSearch)) {
      continue;
    }
    const columnId = classifyKanbanColumn(item);
    if (columnId) {
      grouped[columnId].push(item);
    }
  }
  return grouped;
}

function KanbanColumn({
  getSessionHref,
  items,
  onSelectSession,
  selectedSessionId,
  title,
}: Readonly<{
  title: string;
  items: AgentSessionListItem[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  getSessionHref?: (item: AgentSessionListItem) => string;
}>) {
  return (
    <Card className="min-h-[320px]">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span>{title}</span>
          <Badge variant="secondary">{items.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.length === 0 ? (
          <EmptyState
            className="py-8"
            description="No sessions in this state."
            icon={Clock3Icon}
            title="Empty"
          />
        ) : (
          items.map((item) => (
            <SessionCard
              getSessionHref={getSessionHref}
              item={item}
              key={item.id}
              onSelectSession={onSelectSession}
              selected={selectedSessionId === item.id}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function SessionCard({
  getSessionHref,
  item,
  onSelectSession,
  selected,
}: Readonly<{
  item: AgentSessionListItem;
  selected: boolean;
  onSelectSession: (sessionId: string) => void;
  getSessionHref?: (item: AgentSessionListItem) => string;
}>) {
  const title =
    item.name ?? item.externalSessionId ?? `Session ${item.id.slice(0, 8)}`;
  const href = getSessionHref?.(item);
  const cardClassName = `w-full rounded-md border p-3 text-left transition hover:border-primary ${
    selected ? "border-primary bg-muted/50" : ""
  }`;
  const titleNode = href ? (
    <a className="font-medium text-sm hover:underline" href={href}>
      {title}
    </a>
  ) : (
    <div className="font-medium text-sm">{title}</div>
  );
  const content = (
    <>
      <div className="mb-2 flex items-start gap-2">
        <Columns3Icon className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <div className="min-w-0">
          {titleNode}
          <div className="truncate text-muted-foreground text-xs">
            {item.repositoryFullName ?? item.worktreePath ?? "Unknown location"}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="outline">{item.harness}</Badge>
        <span className="text-muted-foreground">
          {formatRelativeTime(item.updatedAt)}
        </span>
      </div>
    </>
  );

  if (href) {
    return (
      <article className={cardClassName}>
        {content}
        <button
          className="mt-3 text-muted-foreground text-xs hover:text-foreground"
          onClick={() => onSelectSession(item.id)}
          type="button"
        >
          Show details
        </button>
      </article>
    );
  }

  return (
    <button
      className={cardClassName}
      onClick={() => onSelectSession(item.id)}
      type="button"
    >
      {content}
    </button>
  );
}

function classifyKanbanColumn(
  item: AgentSessionListItem
): KanbanColumnId | null {
  const status = item.status.toLowerCase();
  if (
    (status === "active" || status === "waiting") &&
    item.awaitingInputSince
  ) {
    return KanbanColumnId.AwaitingInput;
  }
  if (status === "active") {
    return KanbanColumnId.Active;
  }
  if (status === "completed") {
    return KanbanColumnId.Completed;
  }
  if (status === "failed" || status === "error") {
    return KanbanColumnId.Failed;
  }
  if (status === "abandoned") {
    return KanbanColumnId.Abandoned;
  }
  return null;
}

function matchesSearch(
  item: AgentSessionListItem,
  normalizedSearch: string
): boolean {
  return [
    item.name,
    item.externalSessionId,
    item.repositoryFullName,
    item.worktreePath,
    item.model,
  ].some((value) => value?.toLowerCase().includes(normalizedSearch));
}
