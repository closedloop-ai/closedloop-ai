import { describe, expect, it } from "vitest";
import {
  describeSessionListSortDivergence,
  diffSessionListSortPage,
} from "./session-list-sort-differ";

describe("diffSessionListSortPage", () => {
  it("is clean when both sequences agree exactly", () => {
    expect(diffSessionListSortPage(["a", "b", "c"], ["a", "b", "c"])).toEqual({
      clean: true,
    });
  });

  it("is clean on two empty pages", () => {
    expect(diffSessionListSortPage([], [])).toEqual({ clean: true });
  });

  it("reports the first index where the order disagrees", () => {
    expect(diffSessionListSortPage(["a", "b", "c"], ["a", "x", "c"])).toEqual({
      clean: false,
      firstMismatchIndex: 1,
      liveLength: 3,
      candidateLength: 3,
    });
  });

  it("reports a length mismatch with no index when the shared prefix agrees", () => {
    expect(diffSessionListSortPage(["a", "b"], ["a", "b", "c"])).toEqual({
      clean: false,
      firstMismatchIndex: null,
      liveLength: 2,
      candidateLength: 3,
    });
  });
});

describe("describeSessionListSortDivergence", () => {
  const row = (id: string, recordUpdatedAtMs: number | null) => ({
    id,
    recordUpdatedAtMs,
  });

  it("is empty when the two orderings agree", () => {
    expect(
      describeSessionListSortDivergence(
        [row("a", 2), row("b", 1)],
        [row("a", 2), row("b", 1)]
      )
    ).toEqual([]);
  });

  it("carries BOTH sides' keys at each diverging position, so a moved key is visible", () => {
    expect(
      describeSessionListSortDivergence(
        [row("a", 10), row("b", 5)],
        [row("b", 5), row("a", 1)]
      )
    ).toEqual([
      {
        index: 0,
        liveId: "a",
        liveUpdatedAtMs: 10,
        candidateId: "b",
        candidateUpdatedAtMs: 5,
      },
      {
        index: 1,
        liveId: "b",
        liveUpdatedAtMs: 5,
        candidateId: "a",
        candidateUpdatedAtMs: 1,
      },
    ]);
  });

  it("reports the shorter side as a null id rather than dropping the position", () => {
    expect(
      describeSessionListSortDivergence(
        [row("a", 3)],
        [row("a", 3), row("c", 2)]
      )
    ).toEqual([
      {
        index: 1,
        liveId: null,
        liveUpdatedAtMs: null,
        candidateId: "c",
        candidateUpdatedAtMs: 2,
      },
    ]);
  });

  it("walks every diverging position, not just the first", () => {
    expect(
      describeSessionListSortDivergence(
        [row("a", 3), row("b", 2), row("c", 1)],
        [row("x", 3), row("b", 2), row("y", 1)]
      ).map((divergence) => divergence.index)
    ).toEqual([0, 2]);
  });
});
