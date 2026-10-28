/**
 * @file invocation-ancestry-resolver.test.ts
 * @description ISS-10714: pins the batched ancestor walk the invocation read
 * uses — the part that has to leave the page, because an invocation's ancestors
 * belong to its SESSION while the read is scoped to a COMPONENT.
 *
 * The fake database records every query it is asked, so the assertions cover
 * the hop batching and the generation scoping, not just the returned depths.
 */
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it } from "vitest";
import {
  type InvocationAncestrySeed,
  loadInvocationAncestries,
} from "../app/agent-components/service/invocation-ancestry";

type StoredRow = {
  generationId: string;
  externalInvocationId: string;
  parentExternalInvocationId: string | null;
};

type RecordedQuery = { generationId: string; externalInvocationId: string }[];

function fakeDb(stored: StoredRow[]) {
  const queries: RecordedQuery[] = [];
  const db = {
    agentComponentInvocation: {
      findMany: ({
        where,
      }: {
        where: {
          OR: { generationId: string; externalInvocationId: string }[];
        };
      }) => {
        queries.push(where.OR);
        return Promise.resolve(
          stored.filter((row) =>
            where.OR.some(
              (clause) =>
                clause.generationId === row.generationId &&
                clause.externalInvocationId === row.externalInvocationId
            )
          )
        );
      },
    },
  };
  return { db, queries };
}

function seed(
  id: string,
  externalInvocationId: string,
  parentExternalInvocationId: string | null,
  generationId = "gen-1",
  componentKind: string = AgentComponentInvocationKind.Subagent
): InvocationAncestrySeed {
  return {
    id,
    generationId,
    externalInvocationId,
    componentKind,
    parentExternalInvocationId,
  };
}

describe("loadInvocationAncestries", () => {
  it("walks off-page ancestors one batched hop at a time", async () => {
    // Only the leaf is on the page; `mid` and `root` are two hops away and must
    // be fetched, one query per hop.
    const { db, queries } = fakeDb([
      {
        generationId: "gen-1",
        externalInvocationId: "mid",
        parentExternalInvocationId: "root",
      },
      {
        generationId: "gen-1",
        externalInvocationId: "root",
        parentExternalInvocationId: null,
      },
    ]);
    const resolved = await loadInvocationAncestries(db as never, [
      seed("row-leaf", "leaf", "mid"),
    ]);

    expect(resolved.get("row-leaf")).toEqual({
      chain: ["mid", "root"],
      depthFromRootInvocation: 2,
    });
    expect(queries).toHaveLength(2);
    expect(queries[0]).toEqual([
      { generationId: "gen-1", externalInvocationId: "mid" },
    ]);
    expect(queries[1]).toEqual([
      { generationId: "gen-1", externalInvocationId: "root" },
    ]);
  });

  it("asks once for an ancestor two page rows share", async () => {
    const { db, queries } = fakeDb([
      {
        generationId: "gen-1",
        externalInvocationId: "mid",
        parentExternalInvocationId: null,
      },
    ]);
    const resolved = await loadInvocationAncestries(db as never, [
      seed("row-a", "a", "mid"),
      seed("row-b", "b", "mid"),
    ]);

    expect(resolved.get("row-a")?.depthFromRootInvocation).toBe(1);
    expect(resolved.get("row-b")?.depthFromRootInvocation).toBe(1);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toHaveLength(1);
  });

  it("keeps two generations apart when they reuse one invocation id", async () => {
    // Both generations hold `shared`, with different parents. A
    // generation-agnostic index would resolve one session's chain through the
    // other's row.
    const { db } = fakeDb([
      {
        generationId: "gen-1",
        externalInvocationId: "shared",
        parentExternalInvocationId: "one-root",
      },
      {
        generationId: "gen-2",
        externalInvocationId: "shared",
        parentExternalInvocationId: null,
      },
      {
        generationId: "gen-1",
        externalInvocationId: "one-root",
        parentExternalInvocationId: null,
      },
    ]);
    const resolved = await loadInvocationAncestries(db as never, [
      seed("row-one", "leaf", "shared", "gen-1"),
      seed("row-two", "leaf", "shared", "gen-2"),
    ]);

    expect(resolved.get("row-one")).toEqual({
      chain: ["shared", "one-root"],
      depthFromRootInvocation: 2,
    });
    expect(resolved.get("row-two")).toEqual({
      chain: ["shared"],
      depthFromRootInvocation: 1,
    });
  });

  it("publishes depth 0 for a row that records no parent", async () => {
    const { db, queries } = fakeDb([]);
    const resolved = await loadInvocationAncestries(db as never, [
      seed("row-root", "root", null),
    ]);

    expect(resolved.get("row-root")).toEqual({
      chain: [],
      depthFromRootInvocation: 0,
    });
    expect(queries).toHaveLength(0);
  });

  it("omits a row whose parent no invocation answers for", async () => {
    const { db, queries } = fakeDb([]);
    const resolved = await loadInvocationAncestries(db as never, [
      seed("row-dangling", "leaf", "gone"),
    ]);

    expect(resolved.has("row-dangling")).toBe(false);
    // Asked once and not retried: an absent parent stays absent.
    expect(queries).toHaveLength(1);
  });

  it("omits every row on a cycle rather than reporting a depth", async () => {
    const { db } = fakeDb([
      {
        generationId: "gen-1",
        externalInvocationId: "a",
        parentExternalInvocationId: "b",
      },
      {
        generationId: "gen-1",
        externalInvocationId: "b",
        parentExternalInvocationId: "a",
      },
    ]);
    const resolved = await loadInvocationAncestries(db as never, [
      seed("row-a", "a", "b"),
      seed("row-b", "b", "a"),
    ]);

    expect(resolved.size).toBe(0);
  });

  it("degrades to no ancestry when the ancestor read rejects, rather than failing the page", async () => {
    // The read row declares `ancestry` optional and absent means "we could not
    // tell", so an ancestry read that rejects must cost the page its ancestry
    // and nothing else. A resolver that let the rejection unwind would discard
    // the rows, counts and occurrences that already succeeded.
    const db = {
      agentComponentInvocation: {
        findMany: () => Promise.reject(new Error("ancestor read exploded")),
      },
    };

    const resolved = await loadInvocationAncestries(db as never, [
      seed("row-leaf", "leaf", "mid"),
      seed("row-root", "root", null),
    ]);

    expect(resolved.size).toBe(0);
  });

  it("issues no query for an empty page", async () => {
    const { db, queries } = fakeDb([]);
    const resolved = await loadInvocationAncestries(db as never, []);
    expect(resolved.size).toBe(0);
    expect(queries).toHaveLength(0);
  });

  it.each([
    AgentComponentInvocationKind.Skill,
    AgentComponentInvocationKind.Command,
    AgentComponentInvocationKind.Tool,
    AgentComponentInvocationKind.Mcp,
    AgentComponentInvocationKind.Orchestration,
  ])(
    "states no ancestry for a %s row, whose kind no parent linker ever runs for",
    async (kind) => {
      // The stored parent EXISTS, so a walk would have resolved and published
      // a chain. The refusal has to come from the kind, not from a missing row.
      const { db, queries } = fakeDb([
        {
          generationId: "gen-1",
          externalInvocationId: "mid",
          parentExternalInvocationId: null,
        },
      ]);
      const resolved = await loadInvocationAncestries(db as never, [
        seed("row-other", "leaf", "mid", "gen-1", kind),
      ]);

      expect(resolved.has("row-other")).toBe(false);
      expect(queries).toHaveLength(0);
    }
  );

  it("refuses a depth of 0 for an unlinked kind whose parent column is null", async () => {
    // The exact page a component-scoped skill read serves: every row's parent
    // column is null because nothing links that kind. `{ chain: [], depth: 0 }`
    // would call all of them roots.
    const { db } = fakeDb([]);
    const resolved = await loadInvocationAncestries(db as never, [
      seed(
        "row-skill",
        "skill-a",
        null,
        "gen-1",
        AgentComponentInvocationKind.Skill
      ),
      seed("row-sub", "sub-a", null),
    ]);

    expect(resolved.has("row-skill")).toBe(false);
    expect(resolved.get("row-sub")).toEqual({
      chain: [],
      depthFromRootInvocation: 0,
    });
  });
});
