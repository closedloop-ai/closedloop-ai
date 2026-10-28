import { describe, expect, it } from "vitest";
import { BranchActivityEvidenceCompleteness } from "./branch-activity.ts";
import { MonitoredSessionActivityEventKind } from "./branch-activity-kind.ts";
import {
  compareMonitoredActivityIdentities,
  normalizeSyncedMonitoredSessionActivity,
  type SyncedMonitoredSessionActivityEvent,
} from "./session-monitored-activity.ts";

const OCCURRED_AT = "2026-08-12T10:00:00.000Z";
const OCCURRED_AT_LATER = "2026-08-12T11:00:00.000Z";
/** The retired per-target cap (ISS-9860); a carrier this wide used to degrade. */
const RETIRED_PER_TARGET_CAP = 50;
/** The retired raw-scan budget (ISS-9860); entries past it were never parsed. */
const RETIRED_RAW_SCAN_BUDGET = 200;
/** A full desktop sync page and then some — wider than every retired cap. */
const WIDE_PAGE_EVENT_COUNT = 1200;

function monitoredEvent(
  overrides: Partial<SyncedMonitoredSessionActivityEvent> = {}
): SyncedMonitoredSessionActivityEvent {
  return {
    kind: MonitoredSessionActivityEventKind.AgentRead,
    sourceEventId: "evt-1",
    occurredAt: OCCURRED_AT,
    completeness: BranchActivityEvidenceCompleteness.Complete,
    ...overrides,
  };
}

function eventsWithIds(
  count: number,
  makeOverrides: (index: number) => Partial<SyncedMonitoredSessionActivityEvent>
): SyncedMonitoredSessionActivityEvent[] {
  return Array.from({ length: count }, (_, index) =>
    monitoredEvent({
      sourceEventId: `evt-${index}`,
      ...makeOverrides(index),
    })
  );
}

describe("normalizeSyncedMonitoredSessionActivity", () => {
  it("returns undefined when the carrier is not an object", () => {
    expect(normalizeSyncedMonitoredSessionActivity(null)).toBeUndefined();
    expect(
      normalizeSyncedMonitoredSessionActivity("not-an-object")
    ).toBeUndefined();
    expect(normalizeSyncedMonitoredSessionActivity([])).toBeUndefined();
  });

  it("returns undefined when events is not an array", () => {
    expect(
      normalizeSyncedMonitoredSessionActivity({
        completeness: BranchActivityEvidenceCompleteness.Complete,
        events: "not-an-array",
      })
    ).toBeUndefined();
  });

  it("returns undefined when every event is dropped, leaving zero retained", () => {
    expect(
      normalizeSyncedMonitoredSessionActivity({ events: [] })
    ).toBeUndefined();
    expect(
      normalizeSyncedMonitoredSessionActivity({
        events: [{ kind: UNKNOWN_EVENT_KIND }],
      })
    ).toBeUndefined();
  });

  it("passes through a fully valid, complete carrier unchanged and undegraded", () => {
    const result = normalizeSyncedMonitoredSessionActivity({
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [monitoredEvent()],
    });

    expect(result).toEqual({
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [monitoredEvent()],
    });
  });

  it("drops a malformed event (invalid occurredAt) and marks the result partial", () => {
    const result = normalizeSyncedMonitoredSessionActivity({
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [
        monitoredEvent({ sourceEventId: "good" }),
        monitoredEvent({ sourceEventId: "bad", occurredAt: "not-a-date" }),
      ],
    });

    expect(result?.completeness).toBe(
      BranchActivityEvidenceCompleteness.Partial
    );
    expect(result?.events.map((event) => event.sourceEventId)).toEqual([
      "good",
    ]);
  });

  it("drops an event with an unknown kind and marks the result partial", () => {
    const result = normalizeSyncedMonitoredSessionActivity({
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [
        monitoredEvent({ sourceEventId: "good" }),
        {
          ...monitoredEvent({ sourceEventId: "unknown-kind" }),
          kind: "future_kind",
        },
      ],
    });

    expect(result?.completeness).toBe(
      BranchActivityEvidenceCompleteness.Partial
    );
    expect(result?.events.map((event) => event.sourceEventId)).toEqual([
      "good",
    ]);
  });

  it("drops an event carrying an extra unknown field (strict schema)", () => {
    const result = normalizeSyncedMonitoredSessionActivity({
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [
        { ...monitoredEvent({ sourceEventId: "extra" }), extra: "field" },
      ],
    });

    expect(result).toBeUndefined();
  });

  it("degrades the result when the top-level completeness is not complete", () => {
    const result = normalizeSyncedMonitoredSessionActivity({
      completeness: BranchActivityEvidenceCompleteness.Partial,
      events: [monitoredEvent()],
    });

    expect(result?.completeness).toBe(
      BranchActivityEvidenceCompleteness.Partial
    );
    expect(result?.events).toEqual([
      {
        ...monitoredEvent(),
        completeness: BranchActivityEvidenceCompleteness.Partial,
      },
    ]);
  });

  it("degrades the result when a valid event itself declares partial completeness", () => {
    const result = normalizeSyncedMonitoredSessionActivity({
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [
        monitoredEvent({
          sourceEventId: "partial-evt",
          completeness: BranchActivityEvidenceCompleteness.Partial,
        }),
      ],
    });

    expect(result?.completeness).toBe(
      BranchActivityEvidenceCompleteness.Partial
    );
  });

  it("keeps a single copy of an exact duplicate sourceEventId without degrading", () => {
    const result = normalizeSyncedMonitoredSessionActivity({
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [
        monitoredEvent({ sourceEventId: "dup" }),
        monitoredEvent({ sourceEventId: "dup" }),
      ],
    });

    expect(result?.completeness).toBe(
      BranchActivityEvidenceCompleteness.Complete
    );
    expect(result?.events).toHaveLength(1);
  });

  it("drops both siblings and degrades when duplicate sourceEventIds disagree on kind", () => {
    const result = normalizeSyncedMonitoredSessionActivity({
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [
        monitoredEvent({
          sourceEventId: "conflict",
          kind: MonitoredSessionActivityEventKind.AgentRead,
        }),
        monitoredEvent({
          sourceEventId: "conflict",
          kind: MonitoredSessionActivityEventKind.AgentAction,
        }),
        monitoredEvent({ sourceEventId: "other" }),
      ],
    });

    expect(result?.completeness).toBe(
      BranchActivityEvidenceCompleteness.Partial
    );
    expect(result?.events.map((event) => event.sourceEventId)).toEqual([
      "other",
    ]);
  });

  it("degrades and drops when duplicate sourceEventIds agree on kind/time but disagree on completeness", () => {
    const result = normalizeSyncedMonitoredSessionActivity({
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [
        monitoredEvent({
          sourceEventId: "conflict",
          completeness: BranchActivityEvidenceCompleteness.Complete,
        }),
        monitoredEvent({
          sourceEventId: "conflict",
          completeness: BranchActivityEvidenceCompleteness.Partial,
        }),
        monitoredEvent({ sourceEventId: "other" }),
      ],
    });

    expect(result?.completeness).toBe(
      BranchActivityEvidenceCompleteness.Partial
    );
    expect(result?.events.map((event) => event.sourceEventId)).toEqual([
      "other",
    ]);
  });

  it("skips a third occurrence of an already-conflicted sourceEventId without re-adding it", () => {
    const result = normalizeSyncedMonitoredSessionActivity({
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [
        monitoredEvent({
          sourceEventId: "conflict",
          kind: MonitoredSessionActivityEventKind.AgentRead,
        }),
        monitoredEvent({
          sourceEventId: "conflict",
          kind: MonitoredSessionActivityEventKind.AgentAction,
        }),
        monitoredEvent({
          sourceEventId: "conflict",
          kind: MonitoredSessionActivityEventKind.UserReference,
        }),
        monitoredEvent({ sourceEventId: "other" }),
      ],
    });

    expect(result?.completeness).toBe(
      BranchActivityEvidenceCompleteness.Partial
    );
    expect(result?.events.map((event) => event.sourceEventId)).toEqual([
      "other",
    ]);
  });

  it("retains every event past the retired 50-per-target cap and stays Complete (ISS-9860)", () => {
    const count = RETIRED_PER_TARGET_CAP + 1;
    const events = eventsWithIds(count, (index) => ({
      occurredAt: new Date(
        Date.parse(OCCURRED_AT) + index * 1000
      ).toISOString(),
    }));

    const result = normalizeSyncedMonitoredSessionActivity({
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events,
    });

    expect(result?.completeness).toBe(
      BranchActivityEvidenceCompleteness.Complete
    );
    expect(result?.events).toHaveLength(count);
    expect(result?.events.map((event) => event.sourceEventId)).toEqual(
      Array.from({ length: count }, (_, index) => `evt-${count - index - 1}`)
    );
    expect(
      result?.events.every(
        (event) =>
          event.completeness === BranchActivityEvidenceCompleteness.Complete
      )
    ).toBe(true);
  });

  it("parses every entry past the retired 200-raw budget instead of leaving a tail unprocessed (ISS-9860)", () => {
    const validEvents = eventsWithIds(5, (index) => ({
      occurredAt: new Date(
        Date.parse(OCCURRED_AT) + index * 1000
      ).toISOString(),
    }));
    const malformedFiller = rawMonitoredEvents(
      RETIRED_RAW_SCAN_BUDGET - 5,
      (index) => ({
        sourceEventId: `filler-${index}`,
        kind: UNKNOWN_EVENT_KIND,
      })
    );
    const pastBudget = monitoredEvent({ sourceEventId: "past-budget" });

    const result = normalizeSyncedMonitoredSessionActivity({
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [...validEvents, ...malformedFiller, pastBudget],
    });

    // Partial because of the malformed filler, never because of the width.
    expect(result?.completeness).toBe(
      BranchActivityEvidenceCompleteness.Partial
    );
    expect(result?.events).toHaveLength(6);
    expect(result?.events.map((event) => event.sourceEventId)).toContain(
      "past-budget"
    );
  });

  it("returns a full 1,200-event page whole, newest-first and Complete (ISS-9860)", () => {
    const events = eventsWithIds(WIDE_PAGE_EVENT_COUNT, (index) => ({
      occurredAt: new Date(
        Date.parse(OCCURRED_AT) + index * 1000
      ).toISOString(),
    }));

    const result = normalizeSyncedMonitoredSessionActivity({
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events,
    });

    expect(result?.completeness).toBe(
      BranchActivityEvidenceCompleteness.Complete
    );
    expect(result?.events).toHaveLength(WIDE_PAGE_EVENT_COUNT);
    expect(result?.events[0]?.sourceEventId).toBe(
      `evt-${WIDE_PAGE_EVENT_COUNT - 1}`
    );
    expect(result?.events.at(-1)?.sourceEventId).toBe("evt-0");
    expect(
      result?.events.every(
        (event) =>
          event.completeness === BranchActivityEvidenceCompleteness.Complete
      )
    ).toBe(true);
  });

  it("sorts retained events by occurredAt descending", () => {
    const result = normalizeSyncedMonitoredSessionActivity({
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [
        monitoredEvent({ sourceEventId: "earlier", occurredAt: OCCURRED_AT }),
        monitoredEvent({
          sourceEventId: "later",
          occurredAt: OCCURRED_AT_LATER,
        }),
      ],
    });

    expect(result?.events.map((event) => event.sourceEventId)).toEqual([
      "later",
      "earlier",
    ]);
  });

  it("breaks a tie in occurredAt using the code-point identity comparator", () => {
    const result = normalizeSyncedMonitoredSessionActivity({
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [
        monitoredEvent({ sourceEventId: "b", occurredAt: OCCURRED_AT }),
        monitoredEvent({ sourceEventId: "a", occurredAt: OCCURRED_AT }),
      ],
    });

    expect(result?.events.map((event) => event.sourceEventId)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("compareMonitoredActivityIdentities", () => {
  it("returns a negative number when left sorts before right by code point", () => {
    expect(compareMonitoredActivityIdentities("a", "b")).toBeLessThan(0);
  });

  it("returns a positive number when left sorts after right by code point", () => {
    expect(compareMonitoredActivityIdentities("b", "a")).toBeGreaterThan(0);
  });

  it("returns zero for identical strings", () => {
    expect(compareMonitoredActivityIdentities("same", "same")).toBe(0);
  });

  it("returns a negative number when left is a strict prefix of right", () => {
    expect(compareMonitoredActivityIdentities("ab", "abc")).toBe(-1);
  });

  it("returns a positive number when right is a strict prefix of left", () => {
    expect(compareMonitoredActivityIdentities("abc", "ab")).toBe(1);
  });

  it("compares by Unicode code point rather than UTF-16 code unit for astral characters", () => {
    // pins current behavior; "\u{10000}" is a surrogate pair whose lone high
    // surrogate charCode is lower than "￿", but as a full code point it
    // is far greater, so the two orderings disagree.
    const astral = "\u{10000}";
    const bmpMax = "￿";

    expect(compareMonitoredActivityIdentities(astral, bmpMax)).toBeGreaterThan(
      0
    );
  });
});

/**
 * An event kind no version of this module knows. The normalizer takes `unknown`,
 * so a version-skewed producer can put this on the wire even though the emitted
 * union forbids it — which is exactly the drop path under test.
 */
const UNKNOWN_EVENT_KIND = "not_a_real_kind";

/** Wire-shaped monitored events, unconstrained by the emitted event union. */
function rawMonitoredEvents(
  count: number,
  makeOverrides: (index: number) => Record<string, unknown>
): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: MonitoredSessionActivityEventKind.AgentRead,
    sourceEventId: `evt-${index}`,
    occurredAt: OCCURRED_AT,
    completeness: BranchActivityEvidenceCompleteness.Complete,
    ...makeOverrides(index),
  }));
}
