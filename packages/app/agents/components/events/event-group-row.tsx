"use client";

import { AgentStatusBadge } from "@repo/app/agents/components/session-status-badges";
import type {
  SessionEvent,
  SessionEventGroup,
} from "@repo/app/agents/lib/session-types";
import { formatDateTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import { Button } from "@repo/design-system/components/ui/button";
import type { JsonValue } from "@repo/design-system/components/ui/types";
import { cn } from "@repo/design-system/lib/utils";
import { ChevronRight } from "lucide-react";
import { useState } from "react";

type EventGroupRowProps = {
  group: SessionEventGroup;
  defaultExpanded?: boolean;
};

export function EventGroupRow({
  group,
  defaultExpanded = false,
}: EventGroupRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const first = group.events[0];
  const statuses = group.events.reduce<
    SessionEventGroup["events"][number]["status"][]
  >((sequence, event) => {
    if (sequence.at(-1) !== event.status) {
      sequence.push(event.status);
    }
    return sequence;
  }, []);
  const isMultiEvent = group.events.length > 1;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border/80 bg-card shadow-sm",
        isMultiEvent && "border-l-2 border-l-cyan-500/40"
      )}
    >
      <button
        aria-expanded={expanded}
        className={cn(
          "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/35",
          isMultiEvent && "bg-cyan-500/[0.03] hover:bg-cyan-500/[0.06]"
        )}
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90"
          )}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-medium text-sm">{group.title}</p>
            {first?.toolName ? (
              <span className="font-mono text-[11px] text-muted-foreground">
                {first.toolName}
              </span>
            ) : null}
            {isMultiEvent ? (
              <span className="font-mono text-[11px] text-muted-foreground">
                {group.events.length} events
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>{formatDateTimeOrFallback(first.createdAt)}</span>
            {group.durationLabel ? <span>{group.durationLabel}</span> : null}
            {first.agentLabel ? <span>{first.agentLabel}</span> : null}
            {first.project ? <span>{first.project}</span> : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {statuses.map((status, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: status transition sequence can repeat values, so position is part of the identity (migrated from @repo/design-system in PR A2).
            <div className="flex items-center gap-1" key={`${status}-${index}`}>
              {index > 0 ? (
                <span className="text-[10px] text-muted-foreground">→</span>
              ) : null}
              <AgentStatusBadge status={status} />
            </div>
          ))}
        </div>
      </button>

      {expanded ? (
        <div className="border-border/70 border-t bg-muted/15 px-4 py-3">
          {isMultiEvent ? (
            <div className="mb-3 font-medium text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
              {group.events.length} grouped events
            </div>
          ) : null}
          <div className="space-y-3">
            {group.events.map((event) => (
              <div
                className="rounded-lg border border-border/70 bg-background/70 p-3"
                key={event.id}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <AgentStatusBadge status={event.status} />
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {event.eventType}
                  </span>
                  <span className="font-medium text-sm">{event.title}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {formatDateTimeOrFallback(event.createdAt)}
                  </span>
                </div>
                {event.summary ? (
                  <p className="mt-2 text-muted-foreground text-sm">
                    {event.summary}
                  </p>
                ) : null}
                {event.metadata?.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {event.metadata.map((item) => (
                      <Button
                        className="h-auto px-2 py-1 font-normal text-[11px]"
                        key={`${event.id}-${item.label}`}
                        variant="outline"
                      >
                        <span className="text-muted-foreground">
                          {item.label}
                        </span>
                        <span className="font-mono">{item.value}</span>
                      </Button>
                    ))}
                  </div>
                ) : null}
                {event.detail ? <EventDetailPanel event={event} /> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EventDetailPanel({ event }: Readonly<{ event: SessionEvent }>) {
  const detail = event.detail;
  if (!detail) {
    return null;
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border/70 bg-muted/10 p-3">
      {detail.summary ? (
        <div className="space-y-2">
          <p className="font-medium text-sm">{detail.summary.headline}</p>
          {detail.summary.bullets?.length ? (
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground text-sm">
              {detail.summary.bullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {detail.fields.length ? (
        <dl className="grid gap-2 md:grid-cols-2">
          {detail.fields.map((field) => (
            <div
              className="rounded-md border border-border/60 bg-background/80 p-2"
              key={`${event.id}-${field.key}`}
            >
              <dt className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.08em]">
                {field.label}
              </dt>
              <dd className="mt-1 break-words font-mono text-foreground text-xs">
                {formatJsonValue(field.value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function formatJsonValue(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value, null, 2);
}
