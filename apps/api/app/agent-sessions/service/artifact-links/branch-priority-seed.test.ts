import { ArtifactType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  type SyncedBranchArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import {
  branchRefPrioritiesByIdentity,
  seedBranchPrioritiesIfUnset,
  withBranchPriorityClaim,
} from "./branch-priority-seed";
import {
  type BranchRefAggregate,
  branchRefAggregateKey,
} from "./branch-ref-aggregate";

const ORGANIZATION_ID = "org-1";

function branchRef(
  overrides: Partial<SyncedBranchArtifactRef> = {}
): SyncedBranchArtifactRef {
  return {
    repositoryFullName: "acme/web",
    branchName: "feat/x",
    method: ArtifactRefMethod.GitCommand,
    relation: ArtifactRefRelation.Created,
    ...overrides,
  } as SyncedBranchArtifactRef;
}

describe("branchRefPrioritiesByIdentity", () => {
  it("skips a ref carrying no priority", () => {
    const priorities = branchRefPrioritiesByIdentity([branchRef({})]);

    expect(priorities.size).toBe(0);
  });

  it("keeps the first-seen priority for a given identity and ignores a later ref's differing priority", () => {
    const priorities = branchRefPrioritiesByIdentity([
      branchRef({ priority: Priority.Urgent }),
      branchRef({ priority: Priority.Low }),
    ]);

    expect(
      priorities.get(
        branchRefAggregateKey({
          repositoryFullName: "acme/web",
          branchName: "feat/x",
        })
      )
    ).toBe(Priority.Urgent);
    expect(priorities.size).toBe(1);
  });
});

describe("seedBranchPrioritiesIfUnset", () => {
  it("issues one org- and type-scoped, unset-only update per distinct priority", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = { artifact: { updateMany } };

    await seedBranchPrioritiesIfUnset(tx as never, ORGANIZATION_ID, [
      { artifactId: "branch-a", priority: Priority.High },
      { artifactId: "branch-b", priority: Priority.High },
      { artifactId: "branch-c", priority: Priority.Low },
    ]);

    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["branch-a", "branch-b"] },
        organizationId: ORGANIZATION_ID,
        type: ArtifactType.Branch,
        priority: null,
      },
      data: { priority: Priority.High },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["branch-c"] },
        organizationId: ORGANIZATION_ID,
        type: ArtifactType.Branch,
        priority: null,
      },
      data: { priority: Priority.Low },
    });
  });
});

describe("withBranchPriorityClaim", () => {
  const aggregate: BranchRefAggregate = {
    repositoryFullName: "acme/web",
    branchName: "feat/x",
    method: ArtifactRefMethod.GitCommand,
    relation: ArtifactRefRelation.Created,
    branchLifecycleEvents: [],
  };

  it("attaches the claimed priority onto a copy of the aggregate", () => {
    const claimed = withBranchPriorityClaim(aggregate, Priority.Urgent);

    expect(claimed).toEqual({ ...aggregate, priority: Priority.Urgent });
    expect(claimed).not.toBe(aggregate);
  });

  it("returns the same aggregate unchanged when there is no priority to claim", () => {
    const claimed = withBranchPriorityClaim(aggregate, undefined);

    expect(claimed).toBe(aggregate);
  });
});
