import { describe, expect, it } from "vitest";
import { ArtifactStatusEditSurface } from "./artifact-status-contract";
import { Priority } from "./common";
import {
  ARTIFACT_PRIORITY_EDIT_SURFACE_VALUES,
  ArtifactPriorityCommitResult,
  isArtifactPriorityEditSurface,
  isPriority,
} from "./priority-contract";

// Spelled literally, not read from `Priority`: an expectation taken from the
// vocabulary it polices still passes when a member is dropped from it.
const EXPECTED_MEMBERS = ["LOW", "MEDIUM", "HIGH", "URGENT"];

// Every shape that can reach a boundary: a value only a newer peer knows, the
// wrong casing, the search grammar's unset sentinel, a prototype key, and the
// non-string forms JSON can deliver.
const NON_MEMBERS = [
  "CRITICAL",
  "urgent",
  "Urgent",
  "NONE",
  "",
  " HIGH ",
  "toString",
  "constructor",
  null,
  undefined,
  0,
  3,
  {},
  [],
  ["HIGH"],
];

describe("priority contract", () => {
  it("narrows exactly the persisted vocabulary", () => {
    expect(Object.values(Priority).sort()).toEqual(
      [...EXPECTED_MEMBERS].sort()
    );
    for (const member of EXPECTED_MEMBERS) {
      expect(isPriority(member)).toBe(true);
    }
  });

  it("narrows nothing else", () => {
    for (const value of NON_MEMBERS) {
      expect(isPriority(value)).toBe(false);
    }
  });

  it("does not accept the casing of a near-miss", () => {
    // The sharp case, with its positive sibling: were this a case-insensitive
    // compare, a skewed peer's spelling would silently rank as a real member
    // and reorder a work queue.
    expect(isPriority("urgent")).toBe(false);
    expect(isPriority(Priority.Urgent)).toBe(true);
  });

  it("rejects a prototype key, which `in` would accept", () => {
    expect(isPriority("toString")).toBe(false);
    expect(isPriority("constructor")).toBe(false);
    expect(isPriority(Priority.Low)).toBe(true);
  });
});

/**
 * ISS-9443 — which surfaces can have written a priority.
 *
 * The applicability table these are derived from is the only hand-written
 * statement in the module; the type, the predicate and the value list all come
 * out of it. So the cases that matter are the two REFUSALS — a member of the
 * shared edit-surface taxonomy that priority does not have — because an
 * over-wide set is what puts a real number on a bar nobody can click.
 */
describe("artifact priority edit surfaces", () => {
  it("accepts the three surfaces that write a priority", () => {
    expect(
      isArtifactPriorityEditSurface(ArtifactStatusEditSurface.Detail)
    ).toBe(true);
    expect(
      isArtifactPriorityEditSurface(ArtifactStatusEditSurface.InlineCell)
    ).toBe(true);
    expect(isArtifactPriorityEditSurface(ArtifactStatusEditSurface.Bulk)).toBe(
      true
    );
  });

  it("refuses board — a kanban column is a status, so no drag writes a priority", () => {
    expect(isArtifactPriorityEditSurface(ArtifactStatusEditSurface.Board)).toBe(
      false
    );
  });

  it("refuses row_action — the projects-table item writes no artifact priority", () => {
    expect(
      isArtifactPriorityEditSurface(ArtifactStatusEditSurface.RowAction)
    ).toBe(false);
  });

  it("derives its value list from the same table, with nothing extra in it", () => {
    // Set equality, not a count: a list holding three WRONG members passes a
    // length check.
    expect([...ARTIFACT_PRIORITY_EDIT_SURFACE_VALUES].sort()).toEqual(
      [
        ArtifactStatusEditSurface.Bulk,
        ArtifactStatusEditSurface.Detail,
        ArtifactStatusEditSurface.InlineCell,
      ].sort()
    );
  });

  it("has exactly one commit result, and it is `committed`", () => {
    // Whether a REFUSED attempt earns a receipt is an open PRODUCT question,
    // filed as ISS-10176. A second member appearing here before that question
    // is answered is the drift this pins.
    expect(Object.values(ArtifactPriorityCommitResult)).toEqual(["committed"]);
  });
});
