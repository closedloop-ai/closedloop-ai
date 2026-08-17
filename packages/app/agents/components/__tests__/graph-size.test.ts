import { resolveGraphSize } from "@repo/design-system/components/ui/primitives/graph";
import { describe, expect, it } from "vitest";

/**
 * FEA-3622: the collaboration-network Graph must size to its enclosing card box
 * (from a ResizeObserver) rather than a width-derived height that overflowed the
 * card and overlapped the "Autonomy Over Time" widget. `resolveGraphSize` is the
 * pure sizing rule behind that behaviour.
 */
describe("resolveGraphSize", () => {
  const current = { width: 640, height: 340 };

  it("adopts the observed container box, bounding the graph to its card", () => {
    // A 300px-tall card slot yields a 300px graph — never the old 440–680px.
    expect(resolveGraphSize({ width: 800, height: 300 }, current)).toEqual({
      width: 800,
      height: 300,
    });
  });

  it("floors a very short card at the minimum height", () => {
    expect(resolveGraphSize({ width: 500, height: 40 }, current)).toEqual({
      width: 500,
      height: 180,
    });
  });

  it("keeps the current dimension when the observed one is non-positive", () => {
    // ResizeObserver can fire before layout with a zero box; don't collapse.
    expect(resolveGraphSize({ width: 0, height: 0 }, current)).toBe(current);
    expect(resolveGraphSize({ width: 900, height: 0 }, current)).toEqual({
      width: 900,
      height: 340,
    });
  });

  it("returns the same reference when nothing changed (stable state updates)", () => {
    expect(resolveGraphSize({ width: 640, height: 340 }, current)).toBe(
      current
    );
  });
});
