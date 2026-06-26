import type { DragEndEvent } from "@dnd-kit/core";
import { MovePosition } from "@repo/api/src/types/project-artifact-move";
import { describe, expect, it } from "vitest";
import { resolveDragMove } from "../rank-drag-helpers";

const A = { data: { id: "a" } };
const B = { data: { id: "b" } };
const C = { data: { id: "c" } };
const ITEMS = [A, B, C];

function fakeEvent(activeId: string, overId: string | null): DragEndEvent {
  return {
    active: { id: activeId },
    over: overId ? { id: overId } : null,
  } as unknown as DragEndEvent;
}

describe("resolveDragMove (PLN-755 Phase E)", () => {
  it("returns null when over is null (drop outside any row)", () => {
    expect(resolveDragMove(fakeEvent("a", null), ITEMS)).toBeNull();
  });

  it("returns null when dropping onto the same row", () => {
    expect(resolveDragMove(fakeEvent("a", "a"), ITEMS)).toBeNull();
  });

  it("returns null when active or over id is not in the list", () => {
    expect(resolveDragMove(fakeEvent("ghost", "a"), ITEMS)).toBeNull();
    expect(resolveDragMove(fakeEvent("a", "ghost"), ITEMS)).toBeNull();
  });

  it("dragging upward picks `before` the reference", () => {
    // C (index 2) onto A (index 0) → place C before A.
    expect(resolveDragMove(fakeEvent("c", "a"), ITEMS)).toEqual({
      artifactId: "c",
      position: MovePosition.Before,
      referenceArtifactId: "a",
    });
  });

  it("dragging downward picks `after` the reference", () => {
    // A (index 0) onto C (index 2) → place A after C.
    expect(resolveDragMove(fakeEvent("a", "c"), ITEMS)).toEqual({
      artifactId: "a",
      position: MovePosition.After,
      referenceArtifactId: "c",
    });
  });

  it("dragging onto an adjacent neighbour still resolves to a valid move", () => {
    expect(resolveDragMove(fakeEvent("a", "b"), ITEMS)).toEqual({
      artifactId: "a",
      position: MovePosition.After,
      referenceArtifactId: "b",
    });
    expect(resolveDragMove(fakeEvent("b", "a"), ITEMS)).toEqual({
      artifactId: "b",
      position: MovePosition.Before,
      referenceArtifactId: "a",
    });
  });
});
