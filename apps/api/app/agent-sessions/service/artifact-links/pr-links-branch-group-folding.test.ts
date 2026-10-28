/**
 * ISS-11280: two private folds inside `aggregatePrRefsByBranch` that no
 * sibling `pr-links*.test.ts` suite drives through more than one ref per
 * branch/identity:
 *  - `mergeBranchAssociationInto` merges a THIRD ref's PR-head branch
 *    association into a branch group that a SECOND ref already gave one.
 *  - `mergeIdentityInto` only ever DELETES a `method` marker on a repeat ref
 *    for the same PR identity — it never assigns one — so a PR's `method` is
 *    fixed by whichever ref for that identity the payload lists FIRST.
 */

import { LinkType } from "@repo/api/src/types/artifact";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import type { BranchRefAggregate } from "./branch-ref-aggregate";
import { persistSessionPrArtifactLinks } from "./pr-links";
import { sessionPullRequestDetailKey } from "./pull-request-details";

const ORG = "org-1";
const SESSION_ARTIFACT_ID = "session-1";
const REPO = "acme/web";

function makeTx() {
  const upsert = vi.fn().mockResolvedValue({ id: "link-1" });
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
    artifactLink: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({ id: "link-1" }),
      upsert,
    },
    sessionDetail: {
      findUnique: vi.fn().mockResolvedValue({ metadata: null }),
      update: vi.fn().mockResolvedValue({ artifactId: SESSION_ARTIFACT_ID }),
    },
  } as unknown as Parameters<typeof persistSessionPrArtifactLinks>[0];
  return { tx, upsert };
}

function prHeadAggregate(prNumber: number): BranchRefAggregate {
  return {
    repositoryFullName: REPO,
    branchName: "feat/head",
    method: "pr_head_ref",
    relation: ArtifactRefRelation.Created,
    branchLifecycleEvents: [],
    pullRequestObserved: true,
    branchRefObserved: false,
    prRefs: [
      {
        repositoryFullName: REPO,
        prNumber,
        relationTypes: [SessionPrRelationType.Created],
      },
    ],
  };
}

describe("aggregatePrRefsByBranch — mergeBranchAssociationInto", () => {
  it("merges a third ref's branch association into one a second ref already set, rather than overwriting it", async () => {
    const { tx, upsert } = makeTx();
    const detailMap = new Map([
      [
        sessionPullRequestDetailKey(REPO, 201),
        { prDetailId: "prd-201", branchArtifactId: "branch-1" },
      ],
      [
        sessionPullRequestDetailKey(REPO, 202),
        {
          prDetailId: "prd-202",
          branchArtifactId: "branch-1",
          branchAssociation: prHeadAggregate(501),
        },
      ],
      [
        sessionPullRequestDetailKey(REPO, 203),
        {
          prDetailId: "prd-203",
          branchArtifactId: "branch-1",
          branchAssociation: prHeadAggregate(502),
        },
      ],
    ]);

    await persistSessionPrArtifactLinks(
      tx,
      ORG,
      SESSION_ARTIFACT_ID,
      [
        {
          repositoryFullName: REPO,
          prNumber: 201,
          relationType: SessionPrRelationType.Created,
        },
        {
          repositoryFullName: REPO,
          prNumber: 202,
          relationType: SessionPrRelationType.Created,
        },
        {
          repositoryFullName: REPO,
          prNumber: 203,
          relationType: SessionPrRelationType.Created,
        },
      ],
      detailMap
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = upsert.mock.calls[0][0];
    expect(upsertArgs.where).toEqual({
      sourceId_targetId_linkType: {
        sourceId: SESSION_ARTIFACT_ID,
        targetId: "branch-1",
        linkType: LinkType.RelatesTo,
      },
    });
    const written = upsertArgs.create;
    expect(written).toMatchObject({
      organizationId: ORG,
      sourceId: SESSION_ARTIFACT_ID,
      targetId: "branch-1",
      linkType: LinkType.RelatesTo,
    });
    const prNumbers = (written.metadata.prRefs as { prNumber: number }[]).map(
      (ref) => ref.prNumber
    );
    // Both PR-head refs (501, 502) survive only if the THIRD ref's association
    // was MERGED with the second ref's, rather than replacing it outright.
    expect(prNumbers).toEqual(expect.arrayContaining([501, 502]));
  });

  it("leaves an existing branch group's association untouched when a later same-branch ref carries none", async () => {
    const { tx, upsert } = makeTx();
    const detailMap = new Map([
      [
        sessionPullRequestDetailKey(REPO, 601),
        {
          prDetailId: "prd-601",
          branchArtifactId: "branch-1",
          branchAssociation: prHeadAggregate(701),
        },
      ],
      [
        sessionPullRequestDetailKey(REPO, 602),
        { prDetailId: "prd-602", branchArtifactId: "branch-1" },
      ],
    ]);

    await persistSessionPrArtifactLinks(
      tx,
      ORG,
      SESSION_ARTIFACT_ID,
      [
        {
          repositoryFullName: REPO,
          prNumber: 601,
          relationType: SessionPrRelationType.Created,
        },
        {
          repositoryFullName: REPO,
          prNumber: 602,
          relationType: SessionPrRelationType.Created,
        },
      ],
      detailMap
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    const written = upsert.mock.calls[0][0].create;
    const prNumbers = (written.metadata.prRefs as { prNumber: number }[]).map(
      (ref) => ref.prNumber
    );
    // The first ref's PR-head association (701) must still be there — a
    // second ref with NO association of its own must not clear or crash on
    // top of it.
    expect(prNumbers).toEqual(expect.arrayContaining([701]));
  });
});

describe("aggregatePrRefsByBranch — first ref for a branch carrying its own association", () => {
  it("seeds the branch group's association from the very first (and only) resolved ref", async () => {
    const { tx, upsert } = makeTx();
    const detailMap = new Map([
      [
        sessionPullRequestDetailKey(REPO, 301),
        {
          prDetailId: "prd-301",
          branchArtifactId: "branch-3",
          branchAssociation: prHeadAggregate(701),
        },
      ],
    ]);

    await persistSessionPrArtifactLinks(
      tx,
      ORG,
      SESSION_ARTIFACT_ID,
      [
        {
          repositoryFullName: REPO,
          prNumber: 301,
          relationType: SessionPrRelationType.Created,
        },
      ],
      detailMap
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = upsert.mock.calls[0][0];
    expect(upsertArgs.create).toMatchObject({
      organizationId: ORG,
      sourceId: SESSION_ARTIFACT_ID,
      targetId: "branch-3",
      linkType: LinkType.RelatesTo,
    });
    const prNumbers = (
      upsertArgs.create.metadata.prRefs as { prNumber: number }[]
    ).map((ref) => ref.prNumber);
    // 701 only reaches the written metadata if the FIRST ref's own
    // association was captured when the branch group was created, not just
    // when a later ref merges into an already-present one.
    expect(prNumbers).toEqual(expect.arrayContaining([701]));
    // PR-head evidence never claims independent `branchLinked`.
    expect(upsertArgs.create.metadata.branchLinked).toBeUndefined();
  });
});

describe("mergeIdentityInto — method precedence across repeat refs for one PR", () => {
  it("pins current behavior; looks odd because a repeat ref for the same PR identity can only ever DELETE the stored method, never assign one — so a PR's method is fixed by whichever ref for it comes first in the payload", async () => {
    const { tx, upsert } = makeTx();
    const detailMap = new Map([
      [
        sessionPullRequestDetailKey(REPO, 601),
        { prDetailId: "prd-601", branchArtifactId: "branch-2" },
      ],
    ]);

    await persistSessionPrArtifactLinks(
      tx,
      ORG,
      SESSION_ARTIFACT_ID,
      [
        {
          repositoryFullName: REPO,
          prNumber: 601,
          relationType: SessionPrRelationType.Created,
          method: ArtifactRefMethod.GitCommand,
        },
        {
          repositoryFullName: REPO,
          prNumber: 601,
          relationType: SessionPrRelationType.Reviewed,
          method: ArtifactRefMethod.PrReviewFeedbackCommand,
        },
      ],
      detailMap
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = upsert.mock.calls[0][0];
    expect(upsertArgs.create).toMatchObject({
      organizationId: ORG,
      sourceId: SESSION_ARTIFACT_ID,
      targetId: "branch-2",
      linkType: LinkType.RelatesTo,
    });
    const prRefs = upsertArgs.create.metadata.prRefs as {
      prNumber: number;
      method?: string;
      relationTypes: string[];
    }[];
    const ref601 = prRefs.find((ref) => ref.prNumber === 601);
    expect(ref601?.relationTypes.sort()).toEqual(
      [SessionPrRelationType.Created, SessionPrRelationType.Reviewed].sort()
    );
    // The SECOND ref's method is dropped entirely — never assigned.
    expect(ref601?.method).toBe(ArtifactRefMethod.GitCommand);
  });

  it("deletes a repeat ref's stored method when the repeat carries none of its own", async () => {
    const { tx, upsert } = makeTx();
    const detailMap = new Map([
      [
        sessionPullRequestDetailKey(REPO, 602),
        { prDetailId: "prd-602", branchArtifactId: "branch-2" },
      ],
    ]);

    await persistSessionPrArtifactLinks(
      tx,
      ORG,
      SESSION_ARTIFACT_ID,
      [
        {
          repositoryFullName: REPO,
          prNumber: 602,
          relationType: SessionPrRelationType.Created,
          method: ArtifactRefMethod.GitCommand,
        },
        {
          repositoryFullName: REPO,
          prNumber: 602,
          relationType: SessionPrRelationType.Reviewed,
          // No method on the repeat ref.
        },
      ],
      detailMap
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    const prRefs = upsert.mock.calls[0][0].create.metadata.prRefs as {
      prNumber: number;
      method?: string;
    }[];
    const ref602 = prRefs.find((ref) => ref.prNumber === 602);
    expect(ref602?.method).toBeUndefined();
  });
});
