/**
 * ISS-9395 — the contract's own distinctions, pinned.
 *
 * The states exist because this repo keeps collapsing them, so the assertions
 * that matter are the ones about SEPARATENESS: seven distinct states, and a
 * concern that is a host's is never also the surface's. The expectations are
 * written out by hand rather than derived from the const objects, because
 * `expect(Object.values(X)).toEqual(Object.values(X))` is the shape that cannot
 * fail.
 */

import { describe, expect, it } from "vitest";
import {
  COMPLETE_SURFACE_STATES,
  CompleteSurfaceState,
  DISTINCT_EMPTY_STATES,
  HOST_BOUNDARY_SEAMS,
  HostBoundarySeam,
  isHostBoundarySeam,
  isSurfaceOwnedConcern,
  NON_POPULATION_STATES,
  SURFACE_OWNED_CONCERNS,
  SurfaceOwnedConcern,
} from "../complete-surface-contract";

/** The seven states, written out. A collapse shows up as a missing member. */
const EXPECTED_STATES = [
  "loading",
  "filtered-empty",
  "genuine-empty",
  "partial",
  "unavailable",
  "error",
  "ready",
];

/** The five seams a host may fill. Anything else is the surface's. */
const EXPECTED_SEAMS = [
  "transport",
  "auth",
  "routing",
  "feature-assignment",
  "local-runtime-capability",
];

/** The nine concerns the surface owns. */
const EXPECTED_CONCERNS = [
  "hierarchy",
  "toolbar",
  "metrics",
  "filters",
  "sorting",
  "grouping",
  "pagination",
  "responsive-presentation",
  "state-selection",
];

describe("complete-surface state machine", () => {
  it("keeps all seven truth states distinct", () => {
    expect([...COMPLETE_SURFACE_STATES]).toEqual(EXPECTED_STATES);
    expect(new Set(COMPLETE_SURFACE_STATES).size).toBe(EXPECTED_STATES.length);
  });

  /**
   * The distinction the repo has most often lost: "the filter hid it" and
   * "there is nothing" carry different remedies for the reader.
   */
  it("separates filtered-empty from genuine-empty", () => {
    expect(CompleteSurfaceState.FilteredEmpty).not.toBe(
      CompleteSurfaceState.GenuineEmpty
    );
    expect([...DISTINCT_EMPTY_STATES]).toEqual([
      "filtered-empty",
      "genuine-empty",
    ]);
  });

  /**
   * "We did not compute this" is three states, and none of them is a claim
   * about the population — so none may render as a zero or as either empty.
   */
  it("keeps the three non-population states out of the empty states", () => {
    expect([...NON_POPULATION_STATES]).toEqual([
      "loading",
      "unavailable",
      "error",
    ]);
    for (const state of NON_POPULATION_STATES) {
      expect(DISTINCT_EMPTY_STATES).not.toContain(state);
      expect(state).not.toBe(CompleteSurfaceState.Ready);
    }
  });
});

describe("host boundary seams", () => {
  it("names exactly the five seams a host may own", () => {
    expect([...HOST_BOUNDARY_SEAMS]).toEqual(EXPECTED_SEAMS);
  });

  /**
   * The whole point of declaring both sets: a concern cannot be a host's slot
   * AND the surface's job. An overlap would make "who owns this?" unanswerable,
   * which is the state the program started from.
   */
  it("shares no member with the surface-owned concerns", () => {
    for (const seam of HOST_BOUNDARY_SEAMS) {
      expect(SURFACE_OWNED_CONCERNS, seam).not.toContain(seam);
    }
    for (const concern of SURFACE_OWNED_CONCERNS) {
      expect(HOST_BOUNDARY_SEAMS, concern).not.toContain(concern);
    }
  });

  it("classifies a known seam and a known surface concern", () => {
    expect(isHostBoundarySeam(HostBoundarySeam.Transport)).toBe(true);
    expect(isHostBoundarySeam(SurfaceOwnedConcern.Pagination)).toBe(false);
    expect(isSurfaceOwnedConcern(SurfaceOwnedConcern.Toolbar)).toBe(true);
    expect(isSurfaceOwnedConcern(HostBoundarySeam.Auth)).toBe(false);
  });

  it("rejects a value that is neither", () => {
    expect(isHostBoundarySeam("colour-scheme")).toBe(false);
    expect(isSurfaceOwnedConcern("colour-scheme")).toBe(false);
  });
});

describe("surface-owned concerns", () => {
  it("names exactly the concerns a complete surface owns", () => {
    expect([...SURFACE_OWNED_CONCERNS]).toEqual(EXPECTED_CONCERNS);
  });
});
