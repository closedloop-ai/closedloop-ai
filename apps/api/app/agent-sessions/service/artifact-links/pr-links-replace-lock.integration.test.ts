/**
 * ISS-9859 LOCK: what the session→PR link Replace path does.
 *
 * Written before `persistSessionPrArtifactLinks` gained its Merge mode, so that
 * the diff in expectations after ISS-9859 is the Merge arm plus the one fix
 * named below and nothing else. Every payload not marked `prRefsPaginated:
 * true` takes this path, including page 0 of a paginated sequence (`false`).
 *
 * Two of the behaviors pinned here (a link-level `relationTypes` built from the
 * incoming payload alone, and lifecycle events discarded on a link that never
 * independently established its branch) are what the Merge arm must do
 * DIFFERENTLY, which is why the Replace arm needs them pinned.
 *
 * BEHAVIOR CHANGE (ISS-9859, review: davetho). The first case used to pin a
 * defect: Replace could not delete a PR-only link this lane wrote. The delete
 * carried `NOT (branchLinked = true)`, the writer strips `branchLinked`, and in
 * Postgres a comparison against a missing jsonb path is NULL, which a WHERE
 * drops. The paginated design depends on page 0 retracting, so the predicate is
 * now NULL-safe, and the three retraction cases below pin its three arms: a
 * missing key is deleted, an explicit `false` is deleted, `true` is spared.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  linkedPrNumbers,
  persistSessionPrLinks,
  prRef,
  SESSION_PR_LINK_REPO,
  type SessionPrLinkBranch,
  type SessionPrLinkFixture,
  seedSessionPrLinkFixture,
  sessionPrLinkMetadata,
  sessionPrLinkRow,
} from "@/__tests__/support/agent-sessions/session-pr-links.test-harness";
import { autoRollbackTransaction } from "@/__tests__/utils/db-helpers";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;

describeIfDb("ISS-9859 lock: session PR-link Replace path", () => {
  it("deletes a lane-written PR link the payload stops declaring", () => {
    // Pinned `[1, 2]` before ISS-9859 fixed the delete: the writer's own rows
    // have no `branchLinked` key, and the old predicate never matched them.
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      await persistSessionPrLinks(fixture, [prRef(1), prRef(2)]);
      expect(await linkedPrNumbers(fixture)).toEqual([1, 2]);

      await persistSessionPrLinks(fixture, [prRef(1)]);
      expect(await linkedPrNumbers(fixture)).toEqual([1]);
    });
  });

  it("CONTROL: deletes a link whose metadata carries an explicit branchLinked:false", () => {
    // The `NOT` arm of the predicate. This case passed before the fix too,
    // because the key is present, so the comparison is a real `false` and not
    // NULL.
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();
      await createPrLinkRow(fixture, "branch-2", false);
      expect(await linkedPrNumbers(fixture)).toEqual([2]);

      await persistSessionPrLinks(fixture, [prRef(1)]);
      expect(await linkedPrNumbers(fixture)).toEqual([1]);
    });
  });

  it("spares a branchLinked:true row, stripping only its PR identity", () => {
    // FEA-2729: the branch lane owns this row. Retraction must not delete it;
    // `downgradeRemovedPrEvidence` reduces it to branch-only evidence instead.
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();
      await createPrLinkRow(fixture, "branch-2", true);

      await persistSessionPrLinks(fixture, [prRef(1)]);

      // `findUniqueOrThrow`: this read throws if the row was deleted.
      const row = await sessionPrLinkRow(fixture, "branch-2");
      expect(row.metadata).toMatchObject({
        branchLinked: true,
        linkKind: SessionArtifactLinkKind.SessionBranch,
      });
      expect(await linkedPrNumbers(fixture)).toEqual([1]);
    });
  });

  it("builds link-level relationTypes from the INCOMING payload alone", () => {
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      await persistSessionPrLinks(fixture, [
        prRef(1, SessionPrRelationType.Created),
      ]);
      expect(await sessionPrLinkMetadata(fixture, "branch-1")).toMatchObject({
        relationTypes: [SessionPrRelationType.Created],
      });

      // A second payload declaring only `Reviewed` REPLACES the set rather than
      // unioning with what the first wrote. This is the behavior the Merge arm
      // must not inherit, and the reason it is pinned here.
      await persistSessionPrLinks(fixture, [
        prRef(1, SessionPrRelationType.Reviewed),
      ]);
      expect(await sessionPrLinkMetadata(fixture, "branch-1")).toMatchObject({
        relationTypes: [SessionPrRelationType.Reviewed],
      });
    });
  });

  it("discards stored branchLifecycleEvents on a link that is not branchLinked", () => {
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      await persistSessionPrLinks(fixture, [
        {
          ...prRef(1),
          branchLifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.PrRaised,
              observedAt: "2026-05-20T17:01:00.000Z",
              evidenceId: "desktop-artifact-link:pr-create",
            },
          ],
        },
      ]);
      expect(await sessionPrLinkMetadata(fixture, "branch-1")).toMatchObject({
        branchLifecycleEvents: [
          expect.objectContaining({
            kind: BranchLifecycleBoundaryKind.PrRaised,
          }),
        ],
      });

      // `buildSessionPrLinkMetadata` re-reads stored lifecycle events ONLY when
      // the link independently established its branch (`branchLinked === true`).
      // This link did not, so a later payload carrying no events drops them.
      await persistSessionPrLinks(fixture, [prRef(1)]);
      expect(
        await sessionPrLinkMetadata(fixture, "branch-1")
      ).not.toHaveProperty("branchLifecycleEvents");
    });
  });
});

/** PR 1 resolves to branch-1, PR 2 to branch-2, so deletion is observable. */
function seedFixture(): Promise<SessionPrLinkFixture> {
  return seedSessionPrLinkFixture("iss9859-lock", {
    1: "branch-1",
    2: "branch-2",
  });
}

/** A PR 2 link with the `branchLinked` key written out, a shape only a merged edge carries. */
function createPrLinkRow(
  fixture: SessionPrLinkFixture,
  branch: SessionPrLinkBranch,
  branchLinked: boolean
): Promise<unknown> {
  const linkKinds = branchLinked
    ? [SessionArtifactLinkKind.SessionBranch, SessionArtifactLinkKind.SessionPr]
    : [SessionArtifactLinkKind.SessionPr];
  return withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId: fixture.organizationId,
        sourceId: fixture.sessionArtifactId,
        targetId: fixture.branchArtifactIds[branch],
        linkType: LinkType.RelatesTo,
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          linkKinds,
          branchLinked,
          relationTypes: [SessionPrRelationType.Created],
          prRefs: [
            {
              repositoryFullName: SESSION_PR_LINK_REPO,
              prNumber: 2,
              relationTypes: [SessionPrRelationType.Created],
            },
          ],
        },
      },
      select: { id: true },
    })
  );
}
