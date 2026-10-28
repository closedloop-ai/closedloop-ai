/**
 * Unit tests for projectsService.calculateStatus, the project completion
 * percentage.
 */
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

import { projectsService } from "../service";

describe("projectsService.calculateStatus", () => {
  it("returns null for an empty population (no documents/issues to complete)", () => {
    // ISS-4679: an empty population has no percentage; `null` distinguishes it
    // from a real 0-of-N so the ring can render an empty-state track.
    expect(projectsService.calculateStatus([])).toBeNull();
  });

  it("returns 0 (not null) when all document artifacts have non-terminal statuses", () => {
    const artifacts = [
      { status: DocumentStatus.Draft, subtype: DocumentType.Prd },
      { status: DocumentStatus.InReview, subtype: DocumentType.Prd },
      { status: DocumentStatus.ChangesRequested, subtype: DocumentType.Prd },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(0);
  });

  it("returns 100 when all documents are in a terminal status (Approved/Executed/Obsolete)", () => {
    const artifacts = [
      { status: DocumentStatus.Approved, subtype: DocumentType.Prd },
      {
        status: DocumentStatus.Executed,
        subtype: DocumentType.ImplementationPlan,
      },
      { status: DocumentStatus.Obsolete, subtype: DocumentType.Prd },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(100);
  });

  it("returns 100 when all features are terminal (Done/Canceled)", () => {
    const artifacts = [
      { status: IssueStatus.Done, subtype: DocumentType.Feature },
      { status: IssueStatus.Canceled, subtype: DocumentType.Feature },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(100);
  });

  it("returns 50 for a mix of 2-of-4 terminal across documents and features", () => {
    const artifacts = [
      { status: DocumentStatus.Approved, subtype: DocumentType.Prd },
      { status: IssueStatus.Done, subtype: DocumentType.Feature },
      { status: DocumentStatus.Draft, subtype: DocumentType.Prd },
      { status: IssueStatus.Backlog, subtype: DocumentType.Feature },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(50);
  });

  it("treats per-subtype terminal sets independently: a feature Approved-string is not terminal", () => {
    // APPROVED is terminal for documents but not part of the feature vocabulary,
    // so a feature carrying it counts as non-terminal.
    const artifacts = [
      { status: DocumentStatus.Approved, subtype: DocumentType.Feature },
      { status: IssueStatus.Done, subtype: DocumentType.Feature },
      { status: IssueStatus.Triage, subtype: DocumentType.Feature },
      { status: IssueStatus.InProgress, subtype: DocumentType.Feature },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(25);
  });

  it("regression: document EXECUTED and APPROVED are both terminal post-PRD-495", () => {
    const artifacts = [
      {
        status: DocumentStatus.Executed,
        subtype: DocumentType.ImplementationPlan,
      },
      { status: DocumentStatus.Approved, subtype: DocumentType.Prd },
      { status: DocumentStatus.Draft, subtype: DocumentType.Prd },
      { status: DocumentStatus.InReview, subtype: DocumentType.Prd },
    ];
    expect(projectsService.calculateStatus(artifacts)).toBe(50);
  });
});

/**
 * ISS-9922. `Math.round` promoted every ratio at or above 99.5% to exactly
 * `100`, and the project row renders `100` as a filled complete check with the
 * accessible name and tooltip agreeing — so a project with a document still
 * outstanding was reported done, self-consistently, with nothing left to
 * contradict it.
 *
 * The rule is `Math.min(99, Math.round(…))` behind two count-based guards, per
 * the 2026-09-18 operator ruling: the guards make both terminal claims from the
 * counts themselves, and the cap is the only thing the arithmetic is not
 * allowed to reach. The mid-range is untouched.
 *
 * Each expected number below is a hand-written literal. Deriving it from the
 * ratio, or from `Math.round`/`Math.floor`, would make the fixture agree with
 * whatever arithmetic the service runs, which is precisely how a plausible
 * wrong number survives its own test.
 */
describe("projectsService.calculateStatus completeness reserve", () => {
  function population(completed: number, total: number) {
    return Array.from({ length: total }, (_unused, index) => ({
      status:
        index < completed ? DocumentStatus.Approved : DocumentStatus.Draft,
      subtype: DocumentType.Prd,
    }));
  }

  it("sends 99, not 100, for 199 of 200 documents", () => {
    expect(projectsService.calculateStatus(population(199, 200))).toBe(99);
  });

  it("sends 99, not 100, for 249 of 250 documents", () => {
    expect(projectsService.calculateStatus(population(249, 250))).toBe(99);
  });

  it("sends 99, not 100, for 999 of 1000 documents", () => {
    expect(projectsService.calculateStatus(population(999, 1000))).toBe(99);
  });

  it("still sends 100 when the population is genuinely exhausted", () => {
    // The positive sibling of the three above, on the same population size:
    // reserving 100 must not make it unreachable.
    expect(projectsService.calculateStatus(population(200, 200))).toBe(100);
  });

  it("leaves the ratios round and floor already agreed on alone", () => {
    // 249/251 is 99.203% and 99/100 is exactly 99: neither moves. They are a
    // non-regression guard only — they cannot tell the old rule from the new.
    expect(projectsService.calculateStatus(population(249, 251))).toBe(99);
    expect(projectsService.calculateStatus(population(99, 100))).toBe(99);
  });

  it("leaves the mid-range exactly where it already was", () => {
    // Operator ruling 2026-09-18: the reserve is the WHOLE change. An earlier
    // cut floored the mid-range as well, which moved the rendered number on
    // roughly half of every partial project — 2/3 from 67 to 66, 7/9 from 78 to
    // 77 — a change the ticket never asked for and no human had ruled on.
    // Stated as literals so the contract is written down rather than inferred.
    expect(projectsService.calculateStatus(population(2, 3))).toBe(67);
    expect(projectsService.calculateStatus(population(7, 9))).toBe(78);
  });

  it("sends 0, not an invented 1, for 1 of 250 documents", () => {
    // Same ruling, low end: 0.4% rounds to 0 and stays there. A floor-to-1 is
    // the ticket's own overstatement pointed the other way — nobody measured 1%
    // of this project. The `0` for a started population and the `0` for an
    // unstarted one are told apart by the ring's arc, not by this number; see
    // `packages/design-system/__tests__/status-percentage-icon-completion-reserve.test.tsx`.
    expect(projectsService.calculateStatus(population(1, 250))).toBe(0);
    expect(projectsService.calculateStatus(population(1, 1000))).toBe(0);
  });

  it("still sends 0 when nothing has reached a terminal status", () => {
    expect(projectsService.calculateStatus(population(0, 250))).toBe(0);
  });

  it("does not drop a whole percent to binary floating point", () => {
    // `(29 / 100) * 100` evaluates to 28.999999999999996, which a naive floor
    // reports as 28. Rounding absorbs this one, but the multiply-before-divide
    // ordering stays: it is the guard that does not depend on which arithmetic
    // is in force.
    expect(projectsService.calculateStatus(population(29, 100))).toBe(29);
    // A second, distinct double: `(29 / 50) * 100` is 57.99999999999999.
    expect(projectsService.calculateStatus(population(29, 50))).toBe(58);
  });
});
