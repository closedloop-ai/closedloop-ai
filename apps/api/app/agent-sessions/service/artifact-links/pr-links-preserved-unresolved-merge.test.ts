/**
 * ISS-11280: `mergePreservedUnresolvedRef` folds a session-declared unresolved
 * PR ref into `byBranch` once `resolvePreserveTargetIds` matches it against an
 * existing stored link. Two shapes neither sibling suite exercises:
 *  - the branch group ALREADY has an entry (from another, resolved PR ref in
 *    the same payload) — the preserved ref merges INTO it; and
 *  - the branch group has NO entry yet — the preserved ref alone creates it,
 *    which is also the only path that shows the `method` ternary's FALSE
 *    result (no method survives) alongside its TRUE result (method kept).
 */

import { LinkType } from "@repo/api/src/types/artifact";
import {
  ArtifactRefMethod,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import { persistSessionPrArtifactLinks } from "./pr-links";
import { sessionPullRequestDetailKey } from "./pull-request-details";

const ORG = "org-1";
const SESSION_ARTIFACT_ID = "session-1";
const REPO = "acme/web";

type PrLinkFindManyArgs = {
  where?: { metadata?: { path?: readonly unknown[] } };
  select?: { metadata?: boolean; branchParticipation?: boolean };
};

function makeTx(findManyImpl: (args: PrLinkFindManyArgs) => Promise<unknown>) {
  const upsert = vi.fn().mockResolvedValue({ id: "link-1" });
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
    artifactLink: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockImplementation(findManyImpl),
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

describe("mergePreservedUnresolvedRef", () => {
  it("merges a preserved unresolved ref's method into a branch group an already-resolved PR ref populated", async () => {
    const { tx, upsert } = makeTx((args) => {
      if (args.where?.metadata?.path) {
        return Promise.resolve([]);
      }
      if (args.select?.metadata !== undefined) {
        // Stored link for PR#7, prose-derived (carries a method).
        return Promise.resolve([
          {
            targetId: "branch-1",
            metadata: {
              prRefs: [
                {
                  repositoryFullName: REPO,
                  prNumber: 7,
                  relationTypes: [SessionPrRelationType.Referenced],
                  method: ArtifactRefMethod.PrMentionInProse,
                },
              ],
            },
          },
        ]);
      }
      return Promise.resolve([]);
    });
    const detailMap = new Map([
      [
        sessionPullRequestDetailKey(REPO, 8),
        { prDetailId: "prd-8", branchArtifactId: "branch-1" },
      ],
    ]);

    await persistSessionPrArtifactLinks(
      tx,
      ORG,
      SESSION_ARTIFACT_ID,
      [
        {
          repositoryFullName: REPO,
          prNumber: 8,
          relationType: SessionPrRelationType.Created,
        },
        {
          repositoryFullName: REPO,
          prNumber: 7,
          relationType: SessionPrRelationType.Referenced,
          method: ArtifactRefMethod.PrMentionInProse,
        },
      ],
      detailMap
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = upsert.mock.calls[0][0];
    expect(upsertArgs.create).toMatchObject({
      organizationId: ORG,
      sourceId: SESSION_ARTIFACT_ID,
      targetId: "branch-1",
      linkType: LinkType.RelatesTo,
    });
    const prRefs = upsertArgs.create.metadata.prRefs as {
      prNumber: number;
      method?: string;
    }[];
    expect(prRefs).toContainEqual(
      expect.objectContaining({
        prNumber: 7,
        method: ArtifactRefMethod.PrMentionInProse,
      })
    );
    expect(prRefs).toContainEqual(expect.objectContaining({ prNumber: 8 }));
  });

  it("creates a fresh branch group from a preserved unresolved ref alone, keeping a mutually-prose method and dropping a methodless one", async () => {
    const { tx, upsert } = makeTx((args) => {
      if (args.where?.metadata?.path) {
        return Promise.resolve([]);
      }
      if (args.select?.metadata !== undefined) {
        return Promise.resolve([
          {
            targetId: "branch-9",
            metadata: {
              prRefs: [
                {
                  repositoryFullName: REPO,
                  prNumber: 9,
                  relationTypes: [SessionPrRelationType.Referenced],
                  method: "legacy_prose_mention",
                },
              ],
            },
          },
          {
            targetId: "branch-10",
            metadata: {
              prRefs: [
                {
                  repositoryFullName: REPO,
                  prNumber: 10,
                  relationTypes: [SessionPrRelationType.Referenced],
                },
              ],
            },
          },
        ]);
      }
      return Promise.resolve([]);
    });

    // Both PRs are wholly unresolved (empty detail map), and NOTHING else in
    // this payload resolves to branch-9 or branch-10, so the preserved ref is
    // the only thing that ever creates either group.
    await persistSessionPrArtifactLinks(
      tx,
      ORG,
      SESSION_ARTIFACT_ID,
      [
        {
          repositoryFullName: REPO,
          prNumber: 9,
          relationType: SessionPrRelationType.Referenced,
          method: ArtifactRefMethod.PrMentionInProse,
        },
        {
          repositoryFullName: REPO,
          prNumber: 10,
          relationType: SessionPrRelationType.Referenced,
        },
      ],
      new Map()
    );

    expect(upsert).toHaveBeenCalledTimes(2);
    for (const call of upsert.mock.calls) {
      expect(call[0].create).toMatchObject({
        organizationId: ORG,
        sourceId: SESSION_ARTIFACT_ID,
        linkType: LinkType.RelatesTo,
      });
    }
    const byTarget = new Map(
      upsert.mock.calls.map((call) => [
        call[0].create.targetId as string,
        call[0].create.metadata.prRefs as {
          prNumber: number;
          method?: string;
        }[],
      ])
    );
    const branch9Refs = byTarget.get("branch-9");
    expect(branch9Refs).toContainEqual(
      expect.objectContaining({
        prNumber: 9,
        method: ArtifactRefMethod.PrMentionInProse,
      })
    );
    const branch10Ref = byTarget
      .get("branch-10")
      ?.find((ref) => ref.prNumber === 10);
    expect(branch10Ref).toBeDefined();
    expect(branch10Ref).not.toHaveProperty("method");
  });
});
