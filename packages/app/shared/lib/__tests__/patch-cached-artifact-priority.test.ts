import { Priority } from "@repo/api/src/types/common";
import { describe, expect, it } from "vitest";
import { patchCachedArtifactPriority } from "../patch-cached-artifact-priority";

/**
 * ISS-10332: the optimistic rewrite that `useArtifactPriorityMutation` applies
 * to every cached view of a row. What must hold: the target row is rewritten
 * wherever it sits, by `id` or by `artifactId`; a row that never carried the
 * key is left alone (an omitted value is "unknown", not a slot to fill); and
 * an untouched entry keeps its identity so nothing re-renders for nothing.
 */

const ID = "55555555-5555-4555-8555-555555555551";

describe("patchCachedArtifactPriority", () => {
  it("rewrites the target row inside a list and a page-data envelope", () => {
    const cached = {
      list: {
        items: [
          { id: ID, priority: null },
          { id: "other", priority: Priority.Low },
        ],
      },
    };

    const next = patchCachedArtifactPriority(cached, ID, Priority.High);

    expect(next.list.items[0]).toEqual({ id: ID, priority: Priority.High });
    expect(next.list.items[1]).toBe(cached.list.items[1]);
  });

  it("matches a branch row by its artifactId as well as its id", () => {
    const cached = [{ id: "local", artifactId: ID, priority: Priority.Low }];

    expect(patchCachedArtifactPriority(cached, ID, null)).toEqual([
      { id: "local", artifactId: ID, priority: null },
    ]);
  });

  it("leaves a row that never carried the key alone, and keeps an untouched cache by identity", () => {
    const omitted = { items: [{ id: ID }] };
    expect(patchCachedArtifactPriority(omitted, ID, Priority.High)).toBe(
      omitted
    );

    const unrelated = { items: [{ id: "other", priority: null }] };
    expect(patchCachedArtifactPriority(unrelated, ID, Priority.High)).toBe(
      unrelated
    );
  });
});
