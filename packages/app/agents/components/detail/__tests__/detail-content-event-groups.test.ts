/**
 * ISS-5073 (#4366 review): the timeline's group key, group title, and ordering
 * had no coverage at all, so nothing pinned the invariants the decorate-sort-
 * undecorate refactor rewired. Kept in its own file because
 * `detail-content.test.ts` is at the 1,000-line ceiling.
 *
 * Five invariants, all observable from `buildSessionDetailContent(...).eventData`:
 *   1. no event is lost or duplicated — the summed group populations equal
 *      `session.events.length`, and the facets reconcile with what the groups
 *      actually contain;
 *   2. groups come out newest-day-first;
 *   3. each day group's label is formatted from the same `Date` that produced
 *      its `groupKey`, and distinct days never collapse onto one label — the
 *      guarantee moving the `format` call per-GROUP had to preserve;
 *   4. an event whose `createdAt` cannot be parsed lands in the `"unknown"`
 *      bucket;
 *   5. that bucket is titled `"Unknown"` and sorts last, and events that tie on
 *      the sort key hold their input order.
 *
 * Timestamp choice is deliberate: day buckets are a whole 24h apart at the same
 * wall clock, and same-day siblings sit at 12:00Z/12:05Z. A local midnight falls
 * between those two instants only for a UTC offset in [+11:55, +12:00), and no
 * real zone uses one — so the expected bucketing holds whatever `TZ` the runner
 * uses. The margin on that side is zero, though: respacing the siblings across
 * a :00 boundary (23:55Z/00:00Z) WOULD split them at ±12:00. Keep them within
 * the same UTC hour.
 */

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { formatDate } from "@repo/app/shared/lib/date-utils";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { buildSessionDetailContent } from "../detail-content";

// `formatDate` is the date-fns `format` call behind every group label, and
// `detail-content.ts` calls it from exactly one site
// (`formatLocalCalendarGroupTitle`). Counting it is therefore an exact,
// non-timing proxy for "how many times did the timeline format a day label" —
// the quantity the ISS-5073 review thread was about. The real implementation is
// kept so every other assertion here still exercises production formatting.
vi.mock("@repo/app/shared/lib/date-utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@repo/app/shared/lib/date-utils")>();
  return { ...actual, formatDate: vi.fn(actual.formatDate) };
});

const NEWEST_DAY_LATER = "2026-06-12T12:05:00.000Z";
const NEWEST_DAY_EARLIER = "2026-06-12T12:00:00.000Z";
const MIDDLE_DAY = "2026-06-11T12:00:00.000Z";
const OLDEST_DAY_LATER = "2026-06-10T12:05:00.000Z";
const OLDEST_DAY_EARLIER = "2026-06-10T12:00:00.000Z";
const UNPARSEABLE = "not-a-timestamp";

const UNKNOWN_GROUP_ID = "unknown";
const UNKNOWN_GROUP_TITLE = "Unknown";

/**
 * Three calendar days plus one unparseable timestamp, deliberately supplied
 * OUT of chronological order so the assertions below cannot pass by accident on
 * an implementation that merely preserves input order. Each event carries a
 * distinct `eventType`/`toolName` so a dropped event is visible as a facet that
 * no group can account for.
 */
const events: AgentSessionDetail["events"] = [
  {
    externalEventId: "middle-1",
    agentExternalId: "agent-main",
    eventType: "tool_use_middle",
    toolName: "middle-tool",
    createdAt: MIDDLE_DAY,
  },
  {
    externalEventId: "unparseable-1",
    agentExternalId: "agent-main",
    eventType: "tool_use_unparseable",
    toolName: "unparseable-tool",
    createdAt: UNPARSEABLE,
  },
  {
    externalEventId: "oldest-earlier",
    agentExternalId: "agent-main",
    eventType: "session_started",
    createdAt: OLDEST_DAY_EARLIER,
  },
  {
    externalEventId: "newest-later",
    agentExternalId: "agent-main",
    eventType: "tool_use_newest_later",
    toolName: "newest-later-tool",
    createdAt: NEWEST_DAY_LATER,
  },
  {
    externalEventId: "oldest-later",
    agentExternalId: "agent-main",
    eventType: "error_oldest",
    toolName: "oldest-later-tool",
    createdAt: OLDEST_DAY_LATER,
  },
  {
    externalEventId: "newest-earlier",
    agentExternalId: "agent-main",
    eventType: "session_finished",
    createdAt: NEWEST_DAY_EARLIER,
  },
];

const session = createAgentSessionDetailFixture({ events });

function eventData() {
  return buildSessionDetailContent(session).eventData;
}

function flattenedGroupEvents() {
  return eventData().groups.flatMap((group) => group.events);
}

describe("buildEventData timeline grouping (ISS-5073)", () => {
  it("keeps every event exactly once across the groups", () => {
    const flattened = flattenedGroupEvents();

    expect(flattened).toHaveLength(session.events.length);
    expect([...flattened.map((event) => event.id)].sort()).toEqual(
      [...session.events.map((event) => event.externalEventId)].sort()
    );
  });

  it("reconciles the facets with the population the groups actually contain", () => {
    const { facets } = eventData();
    const flattened = flattenedGroupEvents();

    expect([...facets.statuses].sort()).toEqual(
      [...new Set(flattened.map((event) => event.status))].sort()
    );
    expect([...facets.eventTypes].sort()).toEqual(
      [...new Set(flattened.map((event) => event.eventType))].sort()
    );
    expect([...facets.toolNames].sort()).toEqual(
      [
        ...new Set(
          flattened
            .map((event) => event.toolName)
            .filter((toolName): toolName is string => Boolean(toolName))
        ),
      ].sort()
    );
  });

  it("emits one group per calendar day, newest day first", () => {
    const { groups } = eventData();
    const datedGroupIds = groups
      .map((group) => group.id)
      .filter((id) => id !== UNKNOWN_GROUP_ID);

    expect(datedGroupIds).toHaveLength(3);
    // `YYYY-MM-DD` keys sort lexicographically, so descending IS newest-first.
    expect(datedGroupIds).toEqual([...datedGroupIds].sort().reverse());
    expect(groups[0]?.events.map((event) => event.id)).toEqual([
      "newest-later",
      "newest-earlier",
    ]);
    expect(groups[1]?.events.map((event) => event.id)).toEqual(["middle-1"]);
    expect(groups[2]?.events.map((event) => event.id)).toEqual([
      "oldest-later",
      "oldest-earlier",
    ]);
  });

  it("labels each day group from the same date its group key was derived from", () => {
    const { groups } = eventData();

    expect(groups[0]?.title).toBe(formatDate(new Date(NEWEST_DAY_LATER)));
    expect(groups[1]?.title).toBe(formatDate(new Date(MIDDLE_DAY)));
    expect(groups[2]?.title).toBe(formatDate(new Date(OLDEST_DAY_LATER)));
    // Bind the label to the group's OWN key rather than only to a literal, so
    // the key and the label cannot drift apart while both stay individually
    // plausible. Parsing `<key>T12:00:00` without a `Z` is a LOCAL midday parse,
    // so it round-trips the local calendar key in any zone.
    for (const group of groups) {
      if (group.id === UNKNOWN_GROUP_ID) {
        continue;
      }
      expect(group.title).toBe(formatDate(new Date(`${group.id}T12:00:00`)));
    }
    // Distinct days must not collapse onto one label.
    expect(new Set(groups.map((group) => group.title)).size).toBe(
      groups.length
    );
  });

  // ISS-5073 (#4366 review) thread 1: the parent commit derived the label on
  // EVERY event and read only the first per bucket, turning an O(G) date-fns
  // `format` into an O(N) one. This pins the call count so that regression
  // cannot return silently: 3 dated groups vs. 5 parseable events, so a
  // per-event derivation fails this assertion rather than merely costing more.
  it("formats a day label once per group, not once per event", () => {
    const formatDateMock = vi.mocked(formatDate);
    formatDateMock.mockClear();

    const { groups } = buildSessionDetailContent(session).eventData;
    const datedGroups = groups.filter((group) => group.id !== UNKNOWN_GROUP_ID);

    expect(datedGroups).toHaveLength(3);
    expect(
      session.events.filter((event) => event.createdAt !== UNPARSEABLE)
    ).toHaveLength(5);
    expect(formatDateMock).toHaveBeenCalledTimes(datedGroups.length);
  });

  it("buckets an unparseable createdAt under 'unknown', titled 'Unknown', sorted last", () => {
    const { groups } = eventData();
    const lastGroup = groups.at(-1);

    expect(lastGroup?.id).toBe(UNKNOWN_GROUP_ID);
    expect(lastGroup?.title).toBe(UNKNOWN_GROUP_TITLE);
    expect(lastGroup?.events.map((event) => event.id)).toEqual([
      "unparseable-1",
    ]);
  });

  // Events sharing a millisecond are routine (a tool-call pair emitted in the
  // same tick), and EVERY unparseable event collapses onto the same 0 sort key.
  // Decorate-sort-undecorate leans on `Array#sort` stability to keep those in
  // input order; nothing above would fail if a future comparator broke ties.
  it("holds input order for events that tie on the sort key", () => {
    const tied = createAgentSessionDetailFixture({
      events: [
        {
          externalEventId: "same-instant-a",
          agentExternalId: "agent-main",
          eventType: "tool_use",
          createdAt: MIDDLE_DAY,
        },
        {
          externalEventId: "same-instant-b",
          agentExternalId: "agent-main",
          eventType: "tool_use",
          createdAt: MIDDLE_DAY,
        },
        {
          externalEventId: "unparseable-a",
          agentExternalId: "agent-main",
          eventType: "tool_use",
          createdAt: UNPARSEABLE,
        },
        {
          externalEventId: "unparseable-b",
          agentExternalId: "agent-main",
          eventType: "tool_use",
          createdAt: UNPARSEABLE,
        },
      ],
    });
    const { groups } = buildSessionDetailContent(tied).eventData;

    expect(groups).toHaveLength(2);
    expect(groups[0]?.events.map((event) => event.id)).toEqual([
      "same-instant-a",
      "same-instant-b",
    ]);
    expect(groups[1]?.id).toBe(UNKNOWN_GROUP_ID);
    expect(groups[1]?.events.map((event) => event.id)).toEqual([
      "unparseable-a",
      "unparseable-b",
    ]);
  });
});
