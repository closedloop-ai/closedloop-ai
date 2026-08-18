"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Input } from "@repo/design-system/components/ui/input";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { Clock3Icon, SearchIcon } from "lucide-react";
import { useState } from "react";
import { recentSessions, stats } from "../app-mock";
import { SessionsTable } from "./sessions-table";

const ALL_STATUSES = "all";

const STATUS_FILTERS = [
  { value: ALL_STATUSES, label: "All" },
  { value: "Running", label: "Running" },
  { value: "Merged", label: "Merged" },
  { value: "In review", label: "In review" },
  { value: "Needs input", label: "Needs input" },
] as const;

export const SessionsView = ({ empty = false }: { empty?: boolean }) => {
  const [status, setStatus] = useState<string>(ALL_STATUSES);
  const [query, setQuery] = useState("");

  // Zero state (r3706838798): no rows, so no filters or stats to pretend with.
  if (empty) {
    return (
      <div className="mx-auto w-full max-w-6xl p-5">
        <EmptyState
          className="min-h-[360px] rounded-xl border border-border/70 bg-card"
          description="Sessions appear here automatically as agents run on this Mac."
          icon={Clock3Icon}
          title="No sessions yet"
        />
      </div>
    );
  }

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = recentSessions.filter((session) => {
    const statusMatch =
      status === ALL_STATUSES || session.statusLabel === status;
    const queryMatch =
      normalizedQuery.length === 0 ||
      [session.name, session.repo, session.model].some((field) =>
        field.toLowerCase().includes(normalizedQuery)
      );
    return statusMatch && queryMatch;
  });

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-border border-b px-5 py-3">
        <ToggleGroup
          aria-label="Filter by status"
          onValueChange={(next) => {
            if (next) {
              setStatus(next);
            }
          }}
          size="sm"
          type="single"
          value={status}
          variant="outline"
        >
          {STATUS_FILTERS.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex items-center gap-2">
          <div className="relative">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
              size={14}
            />
            <Input
              aria-label="Filter sessions"
              className="h-8 w-56 pl-8 text-xs"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter sessions..."
              type="text"
              value={query}
            />
          </div>
          <Badge variant="outline">Local</Badge>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {stats.slice(0, 4).map((stat) => (
            <MetricCard
              delta={stat.delta}
              deltaLabel={stat.detail}
              deltaPolarity={stat.deltaPolarity}
              info={stat.info}
              key={stat.key}
              label={stat.label}
              unitLabel={stat.unitLabel}
              value={stat.value}
            />
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">All sessions</CardTitle>
          </CardHeader>
          <CardContent>
            <SessionsTable items={filtered} />
            {filtered.length === 0 ? (
              <p className="py-8 text-center text-muted-foreground text-sm">
                No sessions match the current filters.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
