/**
 * @file subagent-ancestry.test.ts
 * @description ISS-10714: pins the reconstruction of the real spawn tree from
 * the delegation evidence the parsers already record.
 *
 * Every case drives `buildSubagentAncestryIndex` over a session shaped like the
 * ones the Claude parser emits, and asserts the DEPTHS and CHAINS it produces —
 * not that a walk ran. A fixture where every subagent hangs off the main agent
 * cannot tell a real walk from the constant it replaced, so the fixtures here
 * are a three-deep chain with a sibling branch, plus the corrupt shapes
 * transcript-derived ancestry can actually take.
 */

import { describe, expect, it } from "vitest";
import type {
  NormalizedSession,
  NormalizedSubagent,
  NormalizedToolUse,
} from "../src/main/collectors/types.js";
import {
  buildSubagentAncestryIndex,
  SubagentParentSource,
} from "../src/main/database/subagent-ancestry.js";

const SESSION_ID = "session-ancestry";

function agentToolUse(
  id: string,
  owner: string | null
): NormalizedToolUse & { subagentId: string | null } {
  return {
    name: "Agent",
    id,
    timestamp: "2026-09-01T00:00:00.000Z",
    subagentId: owner,
  };
}

function subagent(
  id: string,
  options: {
    spawnedByToolUseId?: string;
    parentId?: string | null;
    toolUses?: NormalizedToolUse[];
  } = {}
): NormalizedSubagent {
  return {
    id,
    name: id,
    ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
    toolUses: options.toolUses ?? [],
    ...(options.spawnedByToolUseId === undefined
      ? {}
      : { metadata: { spawnedByToolUseId: options.spawnedByToolUseId } }),
  };
}

function session(
  subagents: NormalizedSubagent[],
  mainToolUses: NormalizedToolUse[]
): NormalizedSession {
  return {
    sessionId: SESSION_ID,
    name: "ancestry",
    cwd: null,
    model: null,
    version: null,
    slug: null,
    gitBranch: null,
    startedAt: null,
    endedAt: null,
    teams: [],
    userMessages: 0,
    assistantMessages: 0,
    tokensByModel: {},
    messageTimestamps: [],
    toolUses: mainToolUses,
    compactions: [],
    apiErrors: [],
    subagents,
  } as unknown as NormalizedSession;
}

function mintedIds(subagents: NormalizedSubagent[]): Map<string, string> {
  return new Map(
    subagents.map((s) => [s.id, `${SESSION_ID}-parser-sub-${s.id}`])
  );
}

function indexFor(
  subagents: NormalizedSubagent[],
  mainToolUses: NormalizedToolUse[]
) {
  return buildSubagentAncestryIndex(
    session(subagents, mainToolUses),
    mintedIds(subagents)
  );
}

describe("buildSubagentAncestryIndex", () => {
  it("walks a three-deep chain and a sibling branch to real depths", () => {
    // main -> a -> b -> c, and main -> a -> sibling. `a` spawns two children, so
    // a resolver that picked the wrong owner would show up as a wrong parent on
    // exactly one of them.
    const c = subagent("c", { spawnedByToolUseId: "tu-c" });
    const sibling = subagent("sibling", { spawnedByToolUseId: "tu-sibling" });
    const b = subagent("b", {
      spawnedByToolUseId: "tu-b",
      toolUses: [agentToolUse("tu-c", null)],
    });
    const a = subagent("a", {
      spawnedByToolUseId: "tu-a",
      toolUses: [agentToolUse("tu-b", null), agentToolUse("tu-sibling", null)],
    });
    const index = indexFor([a, b, c, sibling], [agentToolUse("tu-a", null)]);

    expect(index.bySubagentId.get("a")).toEqual({
      parentSubagentId: null,
      parentSource: SubagentParentSource.SpawnToolUse,
      depth: 1,
      chain: [null],
    });
    expect(index.bySubagentId.get("b")).toEqual({
      parentSubagentId: "a",
      parentSource: SubagentParentSource.SpawnToolUse,
      depth: 2,
      chain: ["a", null],
    });
    expect(index.bySubagentId.get("c")).toEqual({
      parentSubagentId: "b",
      parentSource: SubagentParentSource.SpawnToolUse,
      depth: 3,
      chain: ["b", "a", null],
    });
    expect(index.bySubagentId.get("sibling")?.parentSubagentId).toBe("a");
    expect(index.bySubagentId.get("sibling")?.depth).toBe(2);
    expect(index.maxDepth).toBe(3);
    expect(index.counts.resolvedToMain).toBe(1);
    expect(index.counts.resolvedToSubagent).toBe(3);
  });

  it("attributes a main-transcript delegation carrying subagentId to that agent", () => {
    // The nested delegation lives on `session.toolUses` but names its owner, the
    // other shape the parser emits.
    const child = subagent("child", { spawnedByToolUseId: "tu-child" });
    const parent = subagent("parent", { spawnedByToolUseId: "tu-parent" });
    const index = indexFor(
      [parent, child],
      [agentToolUse("tu-parent", null), agentToolUse("tu-child", "parent")]
    );

    expect(index.bySubagentId.get("child")?.parentSubagentId).toBe("parent");
    expect(index.bySubagentId.get("child")?.depth).toBe(2);
  });

  it("reads a subagent with no spawn evidence as unknown, never depth 1", () => {
    const index = indexFor([subagent("orphan")], []);
    const ancestry = index.bySubagentId.get("orphan");

    expect(ancestry?.parentSubagentId).toBeUndefined();
    expect(ancestry?.depth).toBeUndefined();
    expect(ancestry?.parentSource).toBe(SubagentParentSource.NoEvidence);
    expect(ancestry?.chain).toEqual([]);
    expect(index.counts.noEvidence).toBe(1);
    expect(index.counts.resolvedToMain).toBe(0);
  });

  it("counts a claim nothing in the session answers separately from no claim", () => {
    const index = indexFor(
      [subagent("dangling", { spawnedByToolUseId: "tu-absent" })],
      []
    );

    expect(index.bySubagentId.get("dangling")?.parentSource).toBe(
      SubagentParentSource.UnresolvableSpawnClaim
    );
    expect(index.bySubagentId.get("dangling")?.depth).toBeUndefined();
    expect(index.counts.unresolvableSpawnClaim).toBe(1);
    expect(index.counts.noEvidence).toBe(0);
  });

  it("falls back to the parser parentId when no spawn tool use resolves", () => {
    const parent = subagent("parent", { spawnedByToolUseId: "tu-parent" });
    const child = subagent("child", { parentId: "parent" });
    const index = indexFor([parent, child], [agentToolUse("tu-parent", null)]);

    expect(index.bySubagentId.get("child")).toEqual({
      parentSubagentId: "parent",
      parentSource: SubagentParentSource.ParentUuid,
      depth: 2,
      chain: ["parent", null],
    });
  });

  it("refuses a self-parent rather than persisting a one-node loop", () => {
    const selfSpawned = subagent("loner", {
      spawnedByToolUseId: "tu-self",
      toolUses: [agentToolUse("tu-self", null)],
    });
    const index = indexFor([selfSpawned], []);

    expect(index.bySubagentId.get("loner")?.parentSource).toBe(
      SubagentParentSource.SelfParent
    );
    expect(index.bySubagentId.get("loner")?.depth).toBeUndefined();
    expect(index.counts.selfParent).toBe(1);
  });

  it("refuses a two-node cycle rather than walking forever", () => {
    // `left` is spawned by a call inside `right`, and `right` by a call inside
    // `left`. Nothing terminates, so neither gets a depth.
    const left = subagent("left", {
      spawnedByToolUseId: "tu-left",
      toolUses: [agentToolUse("tu-right", null)],
    });
    const right = subagent("right", {
      spawnedByToolUseId: "tu-right",
      toolUses: [agentToolUse("tu-left", null)],
    });
    const index = indexFor([left, right], []);

    for (const id of ["left", "right"]) {
      expect(index.bySubagentId.get(id)?.parentSource).toBe(
        SubagentParentSource.CyclicAncestry
      );
      expect(index.bySubagentId.get(id)?.depth).toBeUndefined();
      expect(index.bySubagentId.get(id)?.parentSubagentId).toBeUndefined();
    }
    expect(index.counts.cyclicAncestry).toBe(2);
    expect(index.maxDepth).toBe(0);
  });

  it("refuses both claimants when two children claim one delegation", () => {
    const first = subagent("first", { spawnedByToolUseId: "tu-shared" });
    const second = subagent("second", { spawnedByToolUseId: "tu-shared" });
    const index = indexFor([first, second], [agentToolUse("tu-shared", null)]);

    for (const id of ["first", "second"]) {
      expect(index.bySubagentId.get(id)?.parentSource).toBe(
        SubagentParentSource.AmbiguousSpawnClaim
      );
      expect(index.bySubagentId.get(id)?.depth).toBeUndefined();
    }
    expect(index.counts.ambiguousSpawnClaim).toBe(2);
  });

  it("keeps a known parent whose own ancestor is unreconstructable, but no depth", () => {
    // `orphanParent` records no spawn evidence, so the chain above `child`
    // never reaches the main agent. The parent edge is still evidence and is
    // published; the DISTANCE from the root is not, and is withheld rather
    // than reported as the 1 a truncated chain would give.
    const orphanParent = subagent("orphan-parent");
    const child = subagent("child", { parentId: "orphan-parent" });
    const index = indexFor([orphanParent, child], []);

    const ancestry = index.bySubagentId.get("child");
    expect(ancestry?.parentSubagentId).toBe("orphan-parent");
    expect(ancestry?.parentSource).toBe(SubagentParentSource.ParentUuid);
    expect(ancestry?.depth).toBeUndefined();
    expect(ancestry?.chain).toEqual([]);
    expect(index.counts.resolvedToSubagent).toBe(1);
    expect(index.counts.resolvedParentUnknownDepth).toBe(1);
    expect(index.counts.noEvidence).toBe(1);
    expect(index.maxDepth).toBe(0);
  });

  it("reports an empty session without inventing a depth", () => {
    const index = indexFor([], []);
    expect(index.counts.subagents).toBe(0);
    expect(index.maxDepth).toBe(0);
    expect(index.bySubagentId.size).toBe(0);
  });
});
