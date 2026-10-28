/**
 * ISS-11280: `resolvePreserveTargetIds`' no-match arm (a session-declared
 * unresolved PR ref that matches NO existing link's stored refs, so nothing
 * is preserved for it) and `storeUnresolvedPrRefs`' validator over a
 * pre-existing `cause` field (a trust-boundary read of the session's own
 * previously stored `_unresolvedPrRefs`, since `persistSessionPrArtifactLinks`
 * itself never writes a `cause` on a PR-unresolved entry).
 */

import { SessionPrRelationType } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import { persistSessionPrArtifactLinks } from "./pr-links";

const ORG = "org-1";
const SESSION_ARTIFACT_ID = "session-1";
const REPO = "acme/web";

describe("persistSessionPrArtifactLinks — unresolved PR ref reconciliation", () => {
  it("preserves only a matched unresolved ref's link and keeps a valid pre-existing cause while dropping a malformed one", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const sessionUpdate = vi
      .fn()
      .mockResolvedValue({ artifactId: SESSION_ARTIFACT_ID });
    const artifactLinkFindMany = vi.fn().mockImplementation((args) => {
      if (args.where?.metadata?.path) {
        // downgradeRemovedPrEvidence's branchLinked sweep.
        return Promise.resolve([]);
      }
      if (args.select?.metadata !== undefined) {
        // resolvePreserveTargetIds: a stored link for an UNRELATED PR (999),
        // so PR#9 below matches nothing.
        return Promise.resolve([
          {
            targetId: "branch-old",
            metadata: {
              prRefs: [
                {
                  repositoryFullName: REPO,
                  prNumber: 999,
                  relationTypes: [SessionPrRelationType.Created],
                },
              ],
            },
          },
        ]);
      }
      return Promise.resolve([]);
    });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
      artifactLink: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany,
        findMany: artifactLinkFindMany,
        update: vi.fn().mockResolvedValue({ id: "link-1" }),
        upsert: vi.fn().mockResolvedValue({ id: "link-1" }),
      },
      sessionDetail: {
        findUnique: vi.fn().mockResolvedValue({
          metadata: {
            _unresolvedPrRefs: [
              {
                repositoryFullName: "legacy/repo",
                prNumber: 5,
                cause: "provider_lookup_failed",
              },
              // Malformed: `cause` is not a string.
              { repositoryFullName: "legacy/repo2", prNumber: 6, cause: 42 },
            ],
          },
        }),
        update: sessionUpdate,
      },
    } as unknown as Parameters<typeof persistSessionPrArtifactLinks>[0];

    await persistSessionPrArtifactLinks(
      tx,
      ORG,
      SESSION_ARTIFACT_ID,
      [
        {
          repositoryFullName: REPO,
          prNumber: 9,
          relationType: SessionPrRelationType.Created,
        },
      ],
      new Map() // nothing resolves -> PR#9 is unresolved
    );

    // Nothing matched PR#9, so nothing is preserved: the retraction sweep runs
    // with no `targetId` exclusion at all, org-scoped like every other write
    // in this lane.
    expect(deleteMany).toHaveBeenCalledTimes(1);
    const deleteWhere = deleteMany.mock.calls[0][0].where;
    expect(deleteWhere).toMatchObject({
      organizationId: ORG,
      sourceId: SESSION_ARTIFACT_ID,
    });
    expect(deleteWhere).not.toHaveProperty("targetId");

    const metadataUpdate = sessionUpdate.mock.calls.find(
      (call) =>
        (call[0] as { data: { metadata?: unknown } }).data.metadata !==
        undefined
    );
    expect(metadataUpdate).toBeDefined();
    const stored = (
      metadataUpdate![0] as {
        data: { metadata: { _unresolvedPrRefs: unknown } };
      }
    ).data.metadata._unresolvedPrRefs;
    expect(stored).toEqual([
      {
        repositoryFullName: "legacy/repo",
        prNumber: 5,
        cause: "provider_lookup_failed",
      },
      { repositoryFullName: REPO, prNumber: 9 },
    ]);
  });
});
