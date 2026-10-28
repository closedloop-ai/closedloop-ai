import type {
  AgentSessionDetail,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import type {
  AgentStatus,
  EventFilterSelection,
  SessionEvent,
  SessionEventFacets,
  SessionEventGroup,
} from "@repo/app/agents/lib/session-types";
import { ensureDate } from "@repo/app/shared/lib/date-utils";
import {
  formatLocalCalendarGroupTitle,
  getLocalCalendarDateKey,
} from "./session-datetime-format";

export function buildEventData(
  session: AgentSessionDetail,
  agentNames: Map<string, string>
): {
  facets: SessionEventFacets;
  groups: SessionEventGroup[];
  activeFilters: EventFilterSelection;
} {
  // ISS-5073: parse each `createdAt` EXACTLY ONCE. The previous shape ran
  // `ensureDate` → `parseDateLocal` → date-fns `parseISO` on BOTH operands of
  // every sort comparison, then twice more in the mapping and grouping passes —
  // roughly 2·N·log₂N parses for an N-event session where N suffices.
  // Decorate-sort-undecorate: parse once per event, derive the normalized
  // timestamp, sort key, and group key from that single Date, sort on the
  // precomputed number, then unwrap.
  const decorated = session.events
    .map((event) => decorateSessionEvent(event, session.id, agentNames))
    .sort((left, right) => right.sortKey - left.sortKey);

  // ISS-5073 (#4366 review): the group LABEL is formatted once per GROUP — G
  // times, not N. `formatLocalCalendarGroupTitle` runs date-fns `format`, which
  // is meaningfully heavier than the `parseISO` this refactor removed, so
  // deriving it per entry would trade an O(G) cost for an O(N) one and spend
  // more than the parse saving on a single-day session with thousands of
  // events. Formatting it when the bucket is CREATED still reads the very same
  // `Date` that produced that entry's `groupKey`, so the key and the label can
  // never describe different days.
  const events: SessionEvent[] = [];
  const grouped = new Map<string, SessionEventGroup>();
  for (const entry of decorated) {
    events.push(entry.event);
    const bucket = grouped.get(entry.groupKey);
    if (bucket) {
      bucket.events.push(entry.event);
    } else {
      grouped.set(entry.groupKey, {
        id: entry.groupKey,
        title: formatLocalCalendarGroupTitle(entry.createdAtDate),
        events: [entry.event],
      });
    }
  }

  const groups = [...grouped.values()];

  return {
    facets: {
      statuses: [...new Set(events.map((event) => event.status))],
      eventTypes: [...new Set(events.map((event) => event.eventType))],
      toolNames: [
        ...new Set(
          events.map((event) => event.toolName).filter(Boolean) as string[]
        ),
      ],
      agents: [...agentNames.entries()].map(([id, label]) => ({ id, label })),
    },
    groups,
    activeFilters: {
      query: "",
      statuses: [],
      eventTypes: [],
      toolNames: [],
      agents: [],
    },
  };
}

export function normalizeEventStatus(
  event: SyncedAgentSessionEvent
): AgentStatus {
  const eventType = event.eventType.toLowerCase();
  if (eventType.includes("error") || eventType.includes("fail")) {
    return "error";
  }
  if (
    eventType.includes("complete") ||
    eventType.includes("success") ||
    eventType.includes("finish")
  ) {
    return "completed";
  }
  if (eventType.includes("wait") || eventType.includes("queued")) {
    return "waiting";
  }
  return "working";
}

/**
 * ISS-5073: an event paired with everything the timeline derives from its
 * `createdAt`, so the sort, the grouping, and the group label all read from ONE
 * parse instead of re-tokenizing the same string on every comparison.
 *
 * `createdAtDate` is that single parsed `Date` (or `null` when `createdAt` could
 * not be parsed), carried forward so the per-GROUP label in `buildEventData` is
 * formatted from the same value `groupKey` was derived from — see the comment
 * there for why the label is not precomputed per event.
 */
type DecoratedSessionEvent = {
  event: SessionEvent;
  createdAtDate: Date | null;
  groupKey: string;
  sortKey: number;
};

/**
 * An unparseable timestamp keeps the previous degraded shape: the event's own
 * `createdAt` renders as `"Unknown"`, it lands in the `"unknown"` group (whose
 * `"Unknown"` title is formatted in {@link buildEventData}), and it takes a 0
 * sort key — which places it last among the post-epoch timestamps real sessions
 * carry, under the newest-first ordering.
 */
function decorateSessionEvent(
  event: SyncedAgentSessionEvent,
  sessionId: string,
  agentNames: Map<string, string>
): DecoratedSessionEvent {
  const parsed = ensureDate(event.createdAt);
  const createdAt = parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
  return {
    event: {
      id: event.externalEventId,
      sessionId,
      agentId: event.agentExternalId,
      agentLabel: event.agentExternalId
        ? (agentNames.get(event.agentExternalId) ?? event.agentExternalId)
        : null,
      eventType: event.eventType,
      status: normalizeEventStatus(event),
      toolName: event.toolName,
      title: event.toolName ?? event.eventType,
      summary: event.summary,
      createdAt: createdAt ? createdAt.toISOString() : "Unknown",
      /* ISS-5074: no serialized `event.data` here. The timeline renders
       * `summary`/`metadata`/`detail` only, so pretty-printing every event's
       * payload cost the desktop renderer — which hydrates `data` from local
       * SQLite, unlike the cloud lane where FEA-2718 leaves it undefined — a
       * per-event string nothing reads.
       *
       * The `errors` lane still serializes, uncapped, one payload per error
       * event. Do NOT read that as "the errors payload is load-bearing":
       * `SessionErrorDetailsPanel`, its only consumer, is currently mounted
       * ONLY in `session-detail-panels.stories.tsx` — so that string is
       * unread by any shipped surface too. It is left alone here because
       * removing it is a separate change with its own blast radius, not
       * because anything renders it. */
      metadata: event.toolName
        ? [{ label: "Tool", value: event.toolName }]
        : undefined,
    },
    createdAtDate: createdAt,
    groupKey: getLocalCalendarDateKey(createdAt),
    sortKey: createdAt ? createdAt.getTime() : 0,
  };
}
