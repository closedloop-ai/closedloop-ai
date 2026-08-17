import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import {
  ActivityFeedActorKind,
  ActivityFeedItemSource,
  type ArtifactActivityFeedItem,
} from "@repo/api/src/types/artifact-activity-feed";
import { describe, expect, it } from "vitest";
import {
  deriveActivityChange,
  describeActivity,
  formatSnapshotValue,
  readAssignmentIds,
} from "../../sources/activity-formatting";

function makeEvent(
  overrides: Partial<ArtifactActivityFeedItem>
): ArtifactActivityFeedItem {
  return {
    id: "event:1",
    source: ActivityFeedItemSource.Event,
    action: null,
    actor: { kind: ActivityFeedActorKind.Human, id: "u1" },
    before: null,
    after: null,
    payload: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const LOOP_PATTERN = /loop/i;
const RUN_STATE_PATTERN = /failure/i;

describe("formatSnapshotValue", () => {
  it("returns null for null / empty string", () => {
    expect(formatSnapshotValue(null)).toBeNull();
    expect(formatSnapshotValue("")).toBeNull();
  });

  it("stringifies scalars", () => {
    expect(formatSnapshotValue("TODO")).toBe("TODO");
    expect(formatSnapshotValue(3)).toBe("3");
    expect(formatSnapshotValue(true)).toBe("true");
  });

  it("collapses a single-key field object to its scalar value", () => {
    expect(formatSnapshotValue({ status: "IN_REVIEW" })).toBe("IN_REVIEW");
  });

  it("unwraps the { field, value } envelope to its value", () => {
    expect(formatSnapshotValue({ field: "priority", value: "MEDIUM" })).toBe(
      "MEDIUM"
    );
  });

  // ISS-5007: this join is what put `field: priority, value: MEDIUM` and a
  // whole serialized artifact snapshot on screen as user-facing copy.
  it("never joins an unresolvable object into a key: value dump", () => {
    expect(formatSnapshotValue({ a: "x", b: 2 })).toBeNull();
    expect(
      formatSnapshotValue({ title: "Enhance Signals", status: "TODO", id: "x" })
    ).toBeNull();
  });

  it("joins arrays", () => {
    expect(formatSnapshotValue(["a", "b"])).toBe("a, b");
    expect(formatSnapshotValue([])).toBeNull();
  });
});

describe("deriveActivityChange", () => {
  it("collapses before/after field snapshots to canonical labels", () => {
    const change = deriveActivityChange(
      makeEvent({
        action: ArtifactActivityAction.StatusChange,
        before: { status: "TODO" },
        after: { status: "DONE" },
      })
    );
    expect(change).toEqual({ before: "Todo", after: "Done" });
  });

  it("yields null before for a creation event", () => {
    const change = deriveActivityChange(
      makeEvent({ action: ArtifactActivityAction.Creation, before: null })
    );
    expect(change.before).toBeNull();
  });

  // ISS-5007, the reported case: the created-artifact row rendered its whole
  // `{ status, title }` snapshot as a chip, clipped mid-word.
  it("renders no value pair for a creation event's artifact snapshot", () => {
    const change = deriveActivityChange(
      makeEvent({
        action: ArtifactActivityAction.Creation,
        before: null,
        after: {
          status: "TODO",
          title: "Enhance Session Quality Signals with GitHub PR Metrics",
        },
      })
    );
    expect(change).toEqual({ before: null, after: null });
  });

  // ISS-5007, the milder reported case: `field: priority, value: MEDIUM`.
  it("unwraps a field-change envelope to canonical value labels", () => {
    const change = deriveActivityChange(
      makeEvent({
        action: ArtifactActivityAction.FieldChange,
        before: { field: "priority", value: "MEDIUM" },
        after: { field: "priority", value: "LOW" },
      })
    );
    expect(change).toEqual({ before: "Medium", after: "Low" });
  });

  it("labels a status change from the canonical status map", () => {
    const change = deriveActivityChange(
      makeEvent({
        action: ArtifactActivityAction.StatusChange,
        before: "IN_REVIEW",
        after: "DONE",
      })
    );
    expect(change).toEqual({ before: "In Review", after: "Done" });
  });

  it("formats a due-date change as a date, not an ISO string", () => {
    const change = deriveActivityChange(
      makeEvent({
        action: ArtifactActivityAction.FieldChange,
        before: { field: "dueDate", value: null },
        after: { field: "dueDate", value: "2026-02-01T00:00:00.000Z" },
      })
    );
    expect(change.before).toBeNull();
    expect(change.after).not.toContain("T00:00:00");
    expect(change.after).toContain("2026");
  });

  it("shows no value chips for fields whose values are opaque ids", () => {
    expect(
      deriveActivityChange(
        makeEvent({
          action: ArtifactActivityAction.FieldChange,
          before: { field: "projectId", value: "018f-aaaa" },
          after: { field: "projectId", value: "018f-bbbb" },
        })
      )
    ).toEqual({ before: null, after: null });
    expect(
      deriveActivityChange(
        makeEvent({
          action: ArtifactActivityAction.Assignment,
          before: null,
          after: "user_2abc",
        })
      )
    ).toEqual({ before: null, after: null });
  });

  it("carries a title change through verbatim", () => {
    const change = deriveActivityChange(
      makeEvent({
        action: ArtifactActivityAction.FieldChange,
        before: { field: "title", value: "Old name" },
        after: { field: "title", value: "New name" },
      })
    );
    expect(change).toEqual({ before: "Old name", after: "New name" });
  });
});

describe("readAssignmentIds", () => {
  it("returns the raw actor ids for an assignment event", () => {
    expect(
      readAssignmentIds(
        makeEvent({
          action: ArtifactActivityAction.Assignment,
          before: "user_a",
          after: "user_b",
        })
      )
    ).toEqual({ before: "user_a", after: "user_b" });
  });

  it("returns null for every other action", () => {
    expect(
      readAssignmentIds(
        makeEvent({ action: ArtifactActivityAction.StatusChange })
      )
    ).toBeNull();
  });
});

describe("describeActivity - events", () => {
  it("describes a status change", () => {
    expect(
      describeActivity(
        makeEvent({ action: ArtifactActivityAction.StatusChange })
      )
    ).toBe("changed the status");
  });

  it("describes an assignment", () => {
    expect(
      describeActivity(makeEvent({ action: ArtifactActivityAction.Assignment }))
    ).toBe("updated the assignment");
  });

  it("describes a creation", () => {
    expect(
      describeActivity(makeEvent({ action: ArtifactActivityAction.Creation }))
    ).toBe("created this artifact");
  });

  it("names the changed field for a field change", () => {
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.FieldChange,
          after: { dueDate: "2026-02-01" },
        })
      )
    ).toBe("updated the due date");
  });

  it("names the changed field from a { field, value } envelope", () => {
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.FieldChange,
          before: { field: "priority", value: "MEDIUM" },
          after: { field: "priority", value: "LOW" },
        })
      )
    ).toBe("updated the priority");
  });

  it("reads projectId as the project, not as an id", () => {
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.FieldChange,
          after: { field: "projectId", value: "018f-bbbb" },
        })
      )
    ).toBe("updated the project");
  });

  it("falls back when a field change has no single-key snapshot", () => {
    expect(
      describeActivity(
        makeEvent({ action: ArtifactActivityAction.FieldChange, after: null })
      )
    ).toBe("updated a field");
  });
});

describe("describeActivity - projections", () => {
  it("describes a version projection with its number", () => {
    expect(
      describeActivity(
        makeEvent({
          source: ActivityFeedItemSource.VersionCreated,
          action: null,
          payload: { version: 4 },
        })
      )
    ).toBe("saved version 4");
  });

  it("describes derivation direction", () => {
    expect(
      describeActivity(
        makeEvent({
          source: ActivityFeedItemSource.Derivation,
          payload: { direction: "produced_from", relatedArtifactId: "x" },
        })
      )
    ).toBe("was derived from another artifact");
    expect(
      describeActivity(
        makeEvent({
          source: ActivityFeedItemSource.Derivation,
          payload: { direction: "produced", relatedArtifactId: "x" },
        })
      )
    ).toBe("produced a related artifact");
  });

  it("describes an agent run without Loop vocabulary or run state (ISS-5474)", () => {
    // The payload still carries a loopId, a command and a run status — the
    // wire is unchanged. The copy must expose none of them: no "loop" noun,
    // and no run outcome, because the product has no user-facing Loops
    // concept and an artifact surface must not report run state.
    const described = describeActivity(
      makeEvent({
        source: ActivityFeedItemSource.Loop,
        payload: { loopId: "l1", status: "FAILURE", command: "code" },
      })
    );

    expect(described).toBe("started an agent run on this artifact");
    expect(described).not.toMatch(LOOP_PATTERN);
    expect(described).not.toMatch(RUN_STATE_PATTERN);
  });

  it("describes an evaluation with its report type", () => {
    expect(
      describeActivity(
        makeEvent({
          source: ActivityFeedItemSource.Evaluation,
          payload: { reportType: "code_review", loopId: "l1" },
        })
      )
    ).toBe("evaluated (code review)");
  });
});

describe("activity-formatting - revived Date snapshots", () => {
  // The web client parses every response through `reviveWithDates`, so a live
  // due-date row reaches the formatter carrying a real Date, not the ISO string
  // the store holds. Treating it as a plain object dropped the chip entirely.
  it("renders a due-date chip when the value arrived as a revived Date", () => {
    const change = deriveActivityChange(
      makeEvent({
        action: ArtifactActivityAction.FieldChange,
        before: { field: "dueDate", value: null },
        after: {
          field: "dueDate",
          value: new Date("2026-02-01T00:00:00.000Z"),
        } as never,
      })
    );
    expect(change.before).toBeNull();
    expect(change.after).toBe("Feb 1, 2026");
  });

  // A due date is a calendar day stored as UTC midnight. Read in the viewer's
  // zone it renders the previous day everywhere west of UTC — a wrong date, not
  // a differently formatted one. The expected string is the same in every zone.
  it("keeps calendar-date semantics for a UTC-midnight due date", () => {
    for (const value of [
      "2026-02-01T00:00:00.000Z",
      new Date("2026-02-01T00:00:00.000Z"),
    ]) {
      const change = deriveActivityChange(
        makeEvent({
          action: ArtifactActivityAction.FieldChange,
          before: null,
          after: { field: "dueDate", value } as never,
        })
      );
      expect(change.after).toBe("Feb 1, 2026");
    }
  });

  // The review asked for the fetched shape in a NON-UTC zone specifically: the
  // ISO path already read correctly under CI's UTC clock, so a UTC-only test
  // would have passed before the fix and proved nothing about the viewer west
  // of UTC who saw the previous day.
  it("renders the same calendar day west of UTC", () => {
    const previous = Reflect.get(process.env, "TZ");
    process.env.TZ = "America/Los_Angeles";
    try {
      for (const value of [
        "2026-02-01T00:00:00.000Z",
        new Date("2026-02-01T00:00:00.000Z"),
      ]) {
        const change = deriveActivityChange(
          makeEvent({
            action: ArtifactActivityAction.FieldChange,
            before: null,
            after: { field: "dueDate", value } as never,
          })
        );
        expect(change.after).toBe("Feb 1, 2026");
      }
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "TZ");
      } else {
        process.env.TZ = previous;
      }
    }
  });

  it("falls back to the raw string for an unparseable due date", () => {
    const change = deriveActivityChange(
      makeEvent({
        action: ArtifactActivityAction.FieldChange,
        before: null,
        after: { field: "dueDate", value: "not-a-date" },
      })
    );
    expect(change.after).toBe("not-a-date");
  });
});

describe("activity-formatting - inherited-key safety", () => {
  // Field keys and values are persisted data, so a prototype key is reachable
  // input. A bare map lookup returns Object.prototype (or a function), which
  // reaches React as a non-element child and takes the whole feed down.
  it.each([
    ["__proto__", "updated the proto"],
    ["constructor", "updated the constructor"],
    ["toString", "updated the to string"],
  ])("labels the inherited field key %s as text", (field, expected) => {
    const headline = describeActivity(
      makeEvent({
        action: ArtifactActivityAction.FieldChange,
        after: { field, value: "x" },
      })
    );
    expect(typeof headline).toBe("string");
    expect(headline).toBe(expected);
  });

  // The single-key snapshot shape is the one that genuinely reaches us with an
  // own `__proto__`: a JS object literal would set the prototype instead, but
  // the stored snapshot is parsed from JSON, which creates a real own key.
  it("labels an inherited key on a JSON-parsed single-key snapshot", () => {
    const headline = describeActivity(
      makeEvent({
        action: ArtifactActivityAction.FieldChange,
        after: JSON.parse('{"__proto__":"x"}'),
      })
    );
    expect(typeof headline).toBe("string");
    expect(headline).toBe("updated the proto");
  });

  it.each([
    "__proto__",
    "constructor",
    "toString",
  ])("returns a string chip for the inherited value %s", (value) => {
    const change = deriveActivityChange(
      makeEvent({
        action: ArtifactActivityAction.FieldChange,
        after: { field: "status", value },
      })
    );
    expect(typeof change.after).toBe("string");
    expect(change.after).toBe(value);
  });
});

describe("activity-formatting - assignment roles", () => {
  it("names which role moved when the row carries the envelope", () => {
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.Assignment,
          before: { field: "assigneeId", value: null },
          after: { field: "assigneeId", value: "user_b" },
        })
      )
    ).toBe("updated the assignee");
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.Assignment,
          before: { field: "approverId", value: "user_a" },
          after: { field: "approverId", value: "user_c" },
        })
      )
    ).toBe("updated the approver");
  });

  it("keeps the generic headline for a legacy bare-id assignment row", () => {
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.Assignment,
          before: "user_a",
          after: "user_b",
        })
      )
    ).toBe("updated the assignment");
  });

  it("reads the actor ids out of the envelope as well as the bare id", () => {
    expect(
      readAssignmentIds(
        makeEvent({
          action: ArtifactActivityAction.Assignment,
          before: { field: "approverId", value: "user_a" },
          after: { field: "approverId", value: "user_c" },
        })
      )
    ).toEqual({ before: "user_a", after: "user_c" });
  });

  it("still shows no raw-id chips for either role field", () => {
    expect(
      deriveActivityChange(
        makeEvent({
          action: ArtifactActivityAction.Assignment,
          before: { field: "assigneeId", value: "018f-aaaa" },
          after: { field: "assigneeId", value: "018f-bbbb" },
        })
      )
    ).toEqual({ before: null, after: null });
  });
});
