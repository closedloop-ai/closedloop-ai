import { Priority } from "@repo/api/src/types/common";
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
  mergeBranchRefAggregatesReplacingPullRequestRefs,
  mergePersistedSessionPrRefs,
} from "./branch-ref-aggregate";

function aggregate(
  overrides: Partial<BranchRefAggregate> = {}
): BranchRefAggregate {
  return {
    repositoryFullName: "acme/web",
    branchName: "feat/x",
    method: ArtifactRefMethod.GitCommand,
    relation: ArtifactRefRelation.Created,
    branchLifecycleEvents: [],
    ...overrides,
  };
}

describe("mergeBranchRefAggregates priority carry-forward", () => {
  it("adopts the incoming ref's priority when the existing aggregate carries none", () => {
    const merged = mergeBranchRefAggregates(
      aggregate({}),
      aggregate({ priority: Priority.High })
    );

    expect(merged.priority).toBe(Priority.High);
  });
});

describe("mergeBranchRefAggregatesReplacingPullRequestRefs", () => {
  it("retains no existing PR refs when the existing aggregate carried none", () => {
    const existing = aggregate({});
    const incoming = aggregate({
      pullRequestObserved: true,
      branchRefObserved: false,
      prRefs: [
        {
          repositoryFullName: "acme/web",
          prNumber: 5,
          relationTypes: [SessionPrRelationType.Created],
        },
      ],
    });

    const merged = mergeBranchRefAggregatesReplacingPullRequestRefs(
      existing,
      incoming
    );

    expect(merged.prRefs).toEqual([
      {
        repositoryFullName: "acme/web",
        prNumber: 5,
        relationTypes: [SessionPrRelationType.Created],
      },
    ]);
  });

  it("drops an existing PR ref the incoming snapshot no longer names, and merges relation types on one it retains", () => {
    const existing = aggregate({
      pullRequestObserved: true,
      branchRefObserved: false,
      prRefs: [
        {
          repositoryFullName: "acme/web",
          prNumber: 5,
          relationTypes: [SessionPrRelationType.Created],
        },
        {
          repositoryFullName: "acme/web",
          prNumber: 9,
          relationTypes: [SessionPrRelationType.Referenced],
        },
      ],
    });
    // The incoming PR-head snapshot no longer names #9 at all — only #5.
    const incoming = aggregate({
      pullRequestObserved: true,
      branchRefObserved: false,
      prRefs: [
        {
          repositoryFullName: "acme/web",
          prNumber: 5,
          relationTypes: [SessionPrRelationType.Reviewed],
        },
      ],
    });

    const merged = mergeBranchRefAggregatesReplacingPullRequestRefs(
      existing,
      incoming
    );

    expect(merged.prRefs?.map((ref) => ref.prNumber)).toEqual([5]);
    expect(merged.prRefs?.[0].relationTypes).toEqual([
      SessionPrRelationType.Created,
      SessionPrRelationType.Reviewed,
    ]);
  });
});

describe("mergePersistedSessionPrRefs method precedence", () => {
  function ref(
    method: string,
    relationType: SessionPrRelationType
  ): PersistedSessionPrRef {
    return {
      repositoryFullName: "acme/web",
      prNumber: 5,
      relationTypes: [relationType],
      method,
    };
  }

  // pins current behavior; looks odd because a later ref's method
  // unconditionally overwrites an already-set method, regardless of which
  // source is "stronger" — the neighboring source comment claims command
  // evidence is "never weakened by prose," but a later group carrying a prose
  // method still wins here.
  it("lets a later ref's method overwrite an already-set method from an earlier ref", () => {
    const merged = mergePersistedSessionPrRefs(
      [ref(ArtifactRefMethod.GitCommand, SessionPrRelationType.Created)],
      [ref(ArtifactRefMethod.PrMentionInProse, SessionPrRelationType.Reviewed)]
    );

    expect(merged).toEqual([
      {
        repositoryFullName: "acme/web",
        prNumber: 5,
        relationTypes: [
          SessionPrRelationType.Created,
          SessionPrRelationType.Reviewed,
        ],
        method: ArtifactRefMethod.PrMentionInProse,
      },
    ]);
  });

  // Intended per branch-ref-aggregate.ts: a ref with no method is
  // command-derived, and command evidence is never weakened by prose.
  it("never restores a method once the first-seen ref for an identity carried none", () => {
    const merged = mergePersistedSessionPrRefs([
      {
        repositoryFullName: "acme/web",
        prNumber: 5,
        relationTypes: [SessionPrRelationType.Created],
      },
      ref(ArtifactRefMethod.GitCommand, SessionPrRelationType.Reviewed),
    ]);

    expect(merged).toEqual([
      {
        repositoryFullName: "acme/web",
        prNumber: 5,
        relationTypes: [
          SessionPrRelationType.Created,
          SessionPrRelationType.Reviewed,
        ],
      },
    ]);
  });
});
