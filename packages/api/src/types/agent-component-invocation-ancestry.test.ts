/**
 * @file agent-component-invocation-ancestry.test.ts
 * @description ISS-10714: pins the pure ancestry walk — the ordered chain and
 * the depth an invocation read publishes.
 *
 * The fixtures are deliberately not flat. A one-hop tree cannot tell a walk
 * from a constant, so the depth cases run a three-deep chain with a sibling
 * branch, and the refusal cases cover the three shapes that must NOT produce a
 * confident depth: a dangling pointer, a cycle, and a chain past the hop cap.
 */
import { describe, expect, it } from "vitest";
import {
  INVOCATION_ANCESTRY_MAX_HOPS,
  walkInvocationAncestry,
} from "./agent-component-invocation-ancestry.ts";

function parents(
  entries: [string, string | null][]
): ReadonlyMap<string, string | null> {
  return new Map(entries);
}

describe("walkInvocationAncestry", () => {
  const tree = parents([
    ["root", null],
    ["mid", "root"],
    ["leaf", "mid"],
    ["sibling", "mid"],
  ]);

  it("reports a root invocation as depth 0 with an empty chain", () => {
    expect(walkInvocationAncestry("root", tree)).toEqual({
      chain: [],
      depthFromRootInvocation: 0,
    });
  });

  it("orders the chain nearest ancestor first and counts real hops", () => {
    expect(walkInvocationAncestry("leaf", tree)).toEqual({
      chain: ["mid", "root"],
      depthFromRootInvocation: 2,
    });
    expect(walkInvocationAncestry("mid", tree)).toEqual({
      chain: ["root"],
      depthFromRootInvocation: 1,
    });
    // The sibling shares an ancestor without inheriting the leaf's chain.
    expect(walkInvocationAncestry("sibling", tree)).toEqual({
      chain: ["mid", "root"],
      depthFromRootInvocation: 2,
    });
  });

  it("returns nothing for an invocation the lookup does not hold", () => {
    expect(walkInvocationAncestry("absent", tree)).toBeUndefined();
  });

  it("refuses a dangling parent rather than publishing a short chain", () => {
    const dangling = parents([["orphan", "gone"]]);
    expect(walkInvocationAncestry("orphan", dangling)).toBeUndefined();
  });

  it("refuses a cycle rather than walking forever", () => {
    const cyclic = parents([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(walkInvocationAncestry("a", cyclic)).toBeUndefined();
    expect(walkInvocationAncestry("b", cyclic)).toBeUndefined();
  });

  it("refuses a self-parent", () => {
    expect(walkInvocationAncestry("x", parents([["x", "x"]]))).toBeUndefined();
  });

  /**
   * The boundary is the CAP ITSELF, not one below it. A chain of exactly
   * INVOCATION_ANCESTRY_MAX_HOPS ancestors is reconstructable and must resolve;
   * the previous walk exited without reading that ancestor's terminating edge
   * and reported it absent (whitlockk review). `n0` is the root, so walking from
   * `n{k}` yields a chain of exactly k.
   */
  function linearChain(deepest: number): [string, string | null][] {
    const edges: [string, string | null][] = [];
    for (let i = 0; i <= deepest; i++) {
      edges.push([`n${i}`, i === 0 ? null : `n${i - 1}`]);
    }
    return edges;
  }

  it("resolves a complete chain of exactly the hop cap", () => {
    const resolved = walkInvocationAncestry(
      `n${INVOCATION_ANCESTRY_MAX_HOPS}`,
      parents(linearChain(INVOCATION_ANCESTRY_MAX_HOPS))
    );
    expect(resolved?.depthFromRootInvocation).toBe(
      INVOCATION_ANCESTRY_MAX_HOPS
    );
    expect(resolved?.chain).toHaveLength(INVOCATION_ANCESTRY_MAX_HOPS);
    expect(resolved?.chain.at(-1)).toBe("n0");
  });

  it("resolves a chain one below the hop cap", () => {
    expect(
      walkInvocationAncestry(
        `n${INVOCATION_ANCESTRY_MAX_HOPS - 1}`,
        parents(linearChain(INVOCATION_ANCESTRY_MAX_HOPS - 1))
      )?.depthFromRootInvocation
    ).toBe(INVOCATION_ANCESTRY_MAX_HOPS - 1);
  });

  it("refuses a chain one past the hop cap", () => {
    expect(
      walkInvocationAncestry(
        `n${INVOCATION_ANCESTRY_MAX_HOPS + 1}`,
        parents(linearChain(INVOCATION_ANCESTRY_MAX_HOPS + 1))
      )
    ).toBeUndefined();
  });
});
