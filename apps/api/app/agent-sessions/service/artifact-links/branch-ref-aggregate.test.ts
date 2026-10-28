import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  type PersistedSessionPrRef,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import {
  type BranchRefAggregate,
  mergeBranchRefAggregates,
} from "./branch-ref-aggregate";

describe("mergeBranchRefAggregates PR identities", () => {
  it("unions PR identities by repository and number, merging relation types", () => {
    const merged = mergeBranchRefAggregates(
      aggregateWith([
        prRef(3, SessionPrRelationType.Created),
        prRef(1, SessionPrRelationType.Referenced),
      ]),
      aggregateWith([
        prRef(1, SessionPrRelationType.Created),
        prRef(2, SessionPrRelationType.Reviewed),
      ])
    );

    expect(merged.prRefs).toEqual([
      prRefWith(1, [
        SessionPrRelationType.Created,
        SessionPrRelationType.Referenced,
      ]),
      prRefWith(2, [SessionPrRelationType.Reviewed]),
      prRefWith(3, [SessionPrRelationType.Created]),
    ]);
  });

  // ISS-9859: the merge used to slice the set to the desktop producer's 100.
  // The set is cumulative across payloads and sorted by ascending prNumber, so
  // that slice dropped the NEWEST PRs at the write.
  it("keeps every identity when the merged set passes the retired 100 cap", () => {
    const merged = mergeBranchRefAggregates(
      aggregateWith(createdRefs(1, 75)),
      aggregateWith(createdRefs(76, 150))
    );

    expect(merged.prRefs?.map((ref) => ref.prNumber)).toEqual(
      createdRefs(1, 150).map((ref) => ref.prNumber)
    );
  });
});

function createdRefs(first: number, last: number): PersistedSessionPrRef[] {
  return Array.from({ length: last - first + 1 }, (_, index) =>
    prRef(first + index, SessionPrRelationType.Created)
  );
}

function aggregateWith(prRefs: PersistedSessionPrRef[]): BranchRefAggregate {
  return {
    repositoryFullName: "acme/web",
    branchName: "feat/x",
    method: ArtifactRefMethod.PrCreateOutput,
    relation: ArtifactRefRelation.Created,
    branchLifecycleEvents: [],
    pullRequestObserved: true,
    branchRefObserved: false,
    prRefs,
  };
}

function prRef(
  prNumber: number,
  relationType: SessionPrRelationType
): PersistedSessionPrRef {
  return prRefWith(prNumber, [relationType]);
}

function prRefWith(
  prNumber: number,
  relationTypes: SessionPrRelationType[]
): PersistedSessionPrRef {
  return { repositoryFullName: "acme/web", prNumber, relationTypes };
}
