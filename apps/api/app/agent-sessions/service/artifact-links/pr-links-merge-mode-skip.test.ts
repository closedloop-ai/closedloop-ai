/**
 * ISS-11280: `SessionPrLinkWriteMode.Merge` — a continuation part of a
 * paginated `prRefs` sequence. Every other unit-style sibling suite
 * (`pr-links.test.ts`, `pr-links-convergence.test.ts`,
 * `pr-links-pr-only-retraction.test.ts`) runs the default Replace mode; the
 * real-DB `pr-links-paginated-merge.integration.test.ts` covers Merge but
 * skips without `DATABASE_URL`. This drives Merge mode against a plain
 * transaction double, the same way the Replace-mode unit suites do.
 *
 * Merge mode must not prune retries or retract prior evidence (that already
 * ran on page 0 of the sequence), and it DOES fold the stored link's prior
 * identities into this page's slice.
 */

import { LinkType } from "@repo/api/src/types/artifact";
import { SessionPrRelationType } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import { persistSessionPrArtifactLinks } from "./pr-links";
import { sessionPullRequestDetailKey } from "./pull-request-details";
import { SessionPrLinkWriteMode } from "./session-pr-link-merge";

const ORG = "org-1";
const SESSION_ARTIFACT_ID = "session-1";
const REPO = "acme/web";

type SqlLike = { sql: string; values: unknown[] };

describe("persistSessionPrArtifactLinks — Merge mode skips prune/retraction", () => {
  it("skips prune and retraction in Merge mode, and folds the stored page-0 identity into this page's slice", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const upsert = vi.fn().mockResolvedValue({ id: "link-1" });
    const artifactLinkFindMany = vi.fn().mockImplementation((args) => {
      if (args.select?.branchParticipation !== undefined) {
        // loadExistingLinkStateByTargetId: the link page 0 already wrote,
        // carrying PR#41 from that earlier slice.
        return Promise.resolve([
          {
            targetId: "branch-1",
            metadata: {
              prRefs: [
                {
                  repositoryFullName: REPO,
                  prNumber: 41,
                  relationTypes: [SessionPrRelationType.Created],
                },
              ],
            },
            branchParticipation: null,
            branchParticipationMethod: null,
            branchParticipationObservedAt: null,
          },
        ]);
      }
      return Promise.resolve([]);
    });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: queryRaw,
      artifactLink: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany,
        findMany: artifactLinkFindMany,
        update: vi.fn().mockResolvedValue({ id: "link-1" }),
        upsert,
      },
    } as unknown as Parameters<typeof persistSessionPrArtifactLinks>[0];
    const detailMap = new Map([
      [
        sessionPullRequestDetailKey(REPO, 42),
        { prDetailId: "prd-42", branchArtifactId: "branch-1" },
      ],
    ]);

    await persistSessionPrArtifactLinks(
      tx,
      ORG,
      SESSION_ARTIFACT_ID,
      [
        {
          repositoryFullName: REPO,
          prNumber: 42,
          relationType: SessionPrRelationType.Created,
        },
      ],
      detailMap,
      SessionPrLinkWriteMode.Merge
    );

    // Prune and retraction are page-0-only; a continuation part running
    // either would delete/downgrade evidence for PRs later pages haven't
    // delivered yet. Prune runs through `tx.$queryRaw` (never
    // `branchMaterializationRetry.findMany`, which nothing in this path
    // calls), so the only way to pin it skipped is to check no query
    // against the retries table was ever issued.
    const pruneQueries = queryRaw.mock.calls.filter((call) =>
      (call[0] as SqlLike).sql.includes("FROM branch_materialization_retries")
    );
    expect(pruneQueries).toHaveLength(0);
    expect(deleteMany).not.toHaveBeenCalled();

    expect(upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = upsert.mock.calls[0][0];
    expect(upsertArgs.where).toEqual({
      sourceId_targetId_linkType: {
        sourceId: SESSION_ARTIFACT_ID,
        targetId: "branch-1",
        linkType: LinkType.RelatesTo,
      },
    });
    expect(upsertArgs.create).toMatchObject({
      organizationId: ORG,
      sourceId: SESSION_ARTIFACT_ID,
      targetId: "branch-1",
      linkType: LinkType.RelatesTo,
    });
    const prNumbers = (
      upsertArgs.update.metadata.prRefs as { prNumber: number }[]
    ).map((ref) => ref.prNumber);
    expect(prNumbers).toEqual([41, 42]);
  });
});
