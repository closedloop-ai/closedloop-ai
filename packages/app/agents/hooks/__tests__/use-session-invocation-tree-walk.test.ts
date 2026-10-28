import type { AgentComponentInvocationSessionTreePage } from "@repo/api/src/types/agent-component-invocation-session-tree";
import { describe, expect, it, vi } from "vitest";
import { walkSessionInvocationTree } from "../use-session-invocation-tree";

const SESSION_ID = "session-1";

function page(
  ids: readonly string[],
  total: number,
  nextCursor?: string
): AgentComponentInvocationSessionTreePage {
  return {
    items: ids.map(
      (id) =>
        ({
          externalInvocationId: id,
        }) as AgentComponentInvocationSessionTreePage["items"][number]
    ),
    total,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

describe("walkSessionInvocationTree", () => {
  it("follows every continuation, so the tree is whole rather than a first page", async () => {
    // The defect this exists to prevent: rendering page 1 orphans every
    // descendant whose parent sits on page 2, so the ancestry chain — the whole
    // point of the surface — comes back WRONG rather than short.
    const read = vi
      .fn<
        (request: {
          sessionId: string;
          cursor?: string;
        }) => Promise<AgentComponentInvocationSessionTreePage>
      >()
      .mockResolvedValueOnce(page(["a", "b"], 4, "cursor-1"))
      .mockResolvedValueOnce(page(["c", "d"], 4));

    const tree = await walkSessionInvocationTree(read, SESSION_ID);

    expect(tree.items.map((item) => item.externalInvocationId)).toStrictEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(read).toHaveBeenNthCalledWith(1, { sessionId: SESSION_ID });
    expect(read).toHaveBeenNthCalledWith(2, {
      sessionId: SESSION_ID,
      cursor: "cursor-1",
    });
    expect(tree.bound.truncated).toBe(false);
    expect(tree.bound.droppedCount).toBe(0);
  });

  it("discloses what it does not hold when it stops at its own page ceiling", async () => {
    // A producer that never exhausts must not become an unbounded client loop —
    // and must not be reported as a complete tree either.
    const read = vi.fn(() => Promise.resolve(page(["a"], 10, "always-more")));

    const tree = await walkSessionInvocationTree(read, SESSION_ID, 3);

    expect(read).toHaveBeenCalledTimes(3);
    expect(tree.items).toHaveLength(3);
    expect(tree.bound.droppedCount).toBe(7);
    expect(tree.bound.truncated).toBe(true);
    expect(tree.bound.maxPages).toBe(3);
  });

  it("never reports a negative shortfall when the count trails the rows", async () => {
    // `total` and the rows are separate reads: a delete landing between them
    // must not be published as rows this walk dropped.
    const read = vi.fn(() => Promise.resolve(page(["a", "b"], 1)));

    const tree = await walkSessionInvocationTree(read, SESSION_ID);

    expect(tree.bound.droppedCount).toBe(0);
    expect(tree.bound.truncated).toBe(false);
  });
});
