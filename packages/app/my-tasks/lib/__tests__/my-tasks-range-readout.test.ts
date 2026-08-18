import { describe, expect, it } from "vitest";
import {
  MyTasksPagedUnit,
  resolveMyTasksCardReadout,
  resolveMyTasksRangeReadout,
  resolveMyTasksTruncation,
} from "../my-tasks-range-readout";

// ISS-4576: the footer is the surface that most easily lies about the queue.
// Each case below pins one distinction the wording has to keep.
describe("resolveMyTasksRangeReadout", () => {
  it("states a complete total plainly", () => {
    expect(
      resolveMyTasksRangeReadout({
        from: 1,
        to: 50,
        total: 137,
        unit: MyTasksPagedUnit.TopLevelTasks,
        isTotalPartial: false,
      })
    ).toBe("Showing 1-50 of 137 top-level tasks");
  });

  it("marks a floor total so a bounded count is not read as the whole population", () => {
    expect(
      resolveMyTasksRangeReadout({
        from: 1,
        to: 50,
        total: 500,
        unit: MyTasksPagedUnit.TopLevelTasks,
        isTotalPartial: true,
      })
    ).toBe("Showing 1-50 of 500+ top-level tasks");
  });

  it("names the paged unit so a root count is not mistaken for a task count", () => {
    expect(
      resolveMyTasksRangeReadout({
        from: 1,
        to: 12,
        total: 12,
        unit: MyTasksPagedUnit.Tasks,
        isTotalPartial: false,
      })
    ).toBe("Showing 1-12 of 12 tasks");
  });

  it("thousand-separates every number so a four-digit count is readable", () => {
    expect(
      resolveMyTasksRangeReadout({
        from: 1001,
        to: 1050,
        total: 1204,
        unit: MyTasksPagedUnit.Tasks,
        isTotalPartial: false,
      })
    ).toBe("Showing 1,001-1,050 of 1,204 tasks");
  });
});

describe("resolveMyTasksCardReadout", () => {
  it("states the queue-wide range when the page reached the screen intact", () => {
    expect(
      resolveMyTasksCardReadout({
        isNarrowed: false,
        shownCount: 50,
        offset: 50,
        pageCount: 50,
        total: 137,
      })
    ).toEqual({ note: null, readout: "Showing 51-100 of 137 tasks" });
  });

  it("reports a short final page as its real span", () => {
    expect(
      resolveMyTasksCardReadout({
        isNarrowed: false,
        shownCount: 37,
        offset: 100,
        pageCount: 37,
        total: 137,
      })
    ).toEqual({ note: null, readout: "Showing 101-137 of 137 tasks" });
  });
});

describe("resolveMyTasksTruncation", () => {
  it("marks the total a floor AND names exactly what was left out", () => {
    expect(resolveMyTasksTruncation(500, 1204)).toEqual({
      isTotalPartial: true,
      note: "Counted from the first 500 assigned tasks.",
    });
  });

  it("returns no marker and no note when the whole assigned set was loaded", () => {
    expect(resolveMyTasksTruncation(137, 137)).toEqual({
      isTotalPartial: false,
      note: null,
    });
  });

  it("returns no marker and no note when the page somehow exceeds the reported total", () => {
    // A stale total racing a larger page must not produce a nonsense note.
    expect(resolveMyTasksTruncation(140, 137)).toEqual({
      isTotalPartial: false,
      note: null,
    });
  });

  it("never yields a floor marker without its explanation", () => {
    // The two halves come from one resolver precisely so an orphaned "500+"
    // with nothing explaining it is unrepresentable.
    for (const [loaded, total] of [
      [500, 1204],
      [137, 137],
      [140, 137],
      [0, 0],
    ]) {
      const truncation = resolveMyTasksTruncation(loaded, total);
      expect(truncation.isTotalPartial).toBe(truncation.note !== null);
    }
  });
});

describe("resolveMyTasksCardReadout caveat line (ISS-4682 item 3)", () => {
  it("keeps the range as the anchor and moves the caveat to its own line", () => {
    // The reported defect: one non-navigable row flipped the footer from a range
    // to a page count, so the reader lost the queue total AND their place in it
    // while the page buttons still sat beside it.
    expect(
      resolveMyTasksCardReadout({
        isNarrowed: false,
        offset: 0,
        pageCount: 50,
        shownCount: 49,
        total: 137,
      })
    ).toEqual({
      note: "Only 49 of this page's 50 tasks are shown.",
      readout: "Showing 1-50 of 137 tasks",
    });
  });

  it("keeps the range anchored for a filter-narrowed page too", () => {
    expect(
      resolveMyTasksCardReadout({
        isNarrowed: true,
        offset: 50,
        pageCount: 50,
        shownCount: 3,
        total: 137,
      })
    ).toEqual({
      note: "Only 3 of this page's 50 tasks are shown.",
      readout: "Showing 51-100 of 137 tasks",
    });
  });

  it("emits no caveat for a page that reached the screen intact", () => {
    expect(
      resolveMyTasksCardReadout({
        isNarrowed: false,
        offset: 0,
        pageCount: 50,
        shownCount: 50,
        total: 137,
      })
    ).toEqual({ note: null, readout: "Showing 1-50 of 137 tasks" });
  });
});

describe("resolveMyTasksTruncation wording (ISS-4682 item 5)", () => {
  it("states ONE number, and names the population it counted from", () => {
    // The reported defect stacked 550+, 500 and 620 in one glance with nothing
    // saying which was the queue, and ended in "are loaded" — a fetch word with
    // no noun. ISS-5280 retired the flag that staged the fix, so this is the
    // only wording; neither superseded string may come back.
    const truncation = resolveMyTasksTruncation(500, 620);

    expect(truncation).toEqual({
      isTotalPartial: true,
      note: "Counted from the first 500 assigned tasks.",
    });
    expect(truncation.note).not.toContain("are loaded");
    // ISS-5280 (review): "shown" is a claim about the screen, and the screen is
    // showing one 50-row page — this line is about the population the total was
    // counted out of, so it must not borrow the card note's word.
    expect(truncation.note).not.toContain("are shown");
  });

  it("does not reuse the anchor line's noun for a different population", () => {
    // The note sits directly under "Showing 1-50 of 550+ top-level tasks". A
    // note ending in the SAME noun reads as directly comparable, and it is not:
    // `loaded` counts raw assigned artifacts, the total counts the roots they
    // fold into.
    const note = resolveMyTasksTruncation(500, 620).note;

    expect(note).not.toContain(MyTasksPagedUnit.TopLevelTasks);
    expect(note).toContain("assigned tasks");
  });
});
