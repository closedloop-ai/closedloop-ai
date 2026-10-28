import { describe, expect, it } from "vitest";
import {
  TRACE_BRANCH_EVENTS_TRUNCATED_NOTE,
  TRACE_END_OF_READ_NOTE,
  TRACE_EVENTS_TRUNCATED_CAPTION,
  TRACE_EVENTS_TRUNCATED_NOTE,
  TRACE_LATER_ACTIVITY_UNREAD_LEGEND,
  TRACE_PREFIX_COUNTED_NOTE,
  TRACE_TOO_MANY_EVENTS_TO_PLOT,
  TRACE_UNREAD_TAIL_LEGEND,
} from "../trace-truncation-copy";

describe("trace-truncation-copy constants", () => {
  it("every exported constant is a non-empty string", () => {
    const constants = [
      TRACE_EVENTS_TRUNCATED_NOTE,
      TRACE_BRANCH_EVENTS_TRUNCATED_NOTE,
      TRACE_END_OF_READ_NOTE,
      TRACE_TOO_MANY_EVENTS_TO_PLOT,
      TRACE_UNREAD_TAIL_LEGEND,
      TRACE_EVENTS_TRUNCATED_CAPTION,
      TRACE_PREFIX_COUNTED_NOTE,
      TRACE_LATER_ACTIVITY_UNREAD_LEGEND,
    ];

    for (const value of constants) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("pins the base fragment's exact wording", () => {
    expect(TRACE_EVENTS_TRUNCATED_NOTE).toBe("later events truncated");
  });

  it("composes TRACE_END_OF_READ_NOTE from the shared fragment", () => {
    expect(TRACE_END_OF_READ_NOTE).toContain(TRACE_EVENTS_TRUNCATED_NOTE);
    expect(TRACE_END_OF_READ_NOTE).toBe(
      `End of what we could read · ${TRACE_EVENTS_TRUNCATED_NOTE}`
    );
  });

  it("composes TRACE_UNREAD_TAIL_LEGEND from the shared fragment", () => {
    expect(TRACE_UNREAD_TAIL_LEGEND).toContain(TRACE_EVENTS_TRUNCATED_NOTE);
    expect(TRACE_UNREAD_TAIL_LEGEND).toBe(
      `Shaded: ${TRACE_EVENTS_TRUNCATED_NOTE}`
    );
  });

  it("composes TRACE_PREFIX_COUNTED_NOTE from the shared fragment", () => {
    expect(TRACE_PREFIX_COUNTED_NOTE).toContain(TRACE_EVENTS_TRUNCATED_NOTE);
    expect(TRACE_PREFIX_COUNTED_NOTE).toBe(
      `counted over the events we could read · ${TRACE_EVENTS_TRUNCATED_NOTE}`
    );
  });

  it("deliberately diverges the branch-trace wording from the shared fragment", () => {
    // Per the module docstring: the branch combined-trace cut is interior to
    // the merged rows, not at their end, so it must NOT reuse the "later
    // events truncated" phrasing that implies a trailing cut.
    expect(TRACE_BRANCH_EVENTS_TRUNCATED_NOTE).toBe("some events not read");
    expect(TRACE_BRANCH_EVENTS_TRUNCATED_NOTE).not.toBe(
      TRACE_EVENTS_TRUNCATED_NOTE
    );
    expect(TRACE_BRANCH_EVENTS_TRUNCATED_NOTE).not.toContain(
      TRACE_EVENTS_TRUNCATED_NOTE
    );
  });

  it("pins the timeline empty-state sentence", () => {
    expect(TRACE_TOO_MANY_EVENTS_TO_PLOT).toBe(
      "This session had too many events to plot."
    );
  });

  it("pins the timeline's own truncated caption distinctly from the shared fragment casing", () => {
    expect(TRACE_EVENTS_TRUNCATED_CAPTION).toBe("Later events truncated");
  });

  // ISS-9858: a different fact (the activity tiling, which sizes the axis) from
  // the event-stream caption, so it must not restate that caption's words.
  it("pins the tiling legend as a hedged sentence distinct from the events caption", () => {
    expect(TRACE_LATER_ACTIVITY_UNREAD_LEGEND).toBe(
      "Later activity was not read, so the timeline may end early."
    );
    expect(TRACE_LATER_ACTIVITY_UNREAD_LEGEND).toContain("may end");
    expect(TRACE_LATER_ACTIVITY_UNREAD_LEGEND).not.toContain(
      TRACE_EVENTS_TRUNCATED_NOTE
    );
  });
});
