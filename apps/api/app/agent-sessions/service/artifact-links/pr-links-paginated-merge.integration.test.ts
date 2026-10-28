/**
 * ISS-9859: the Merge arm of the session→PR link lane, against real Postgres.
 *
 * A continuation part of a paginated `prRefs` sequence declares ONE SLICE, not
 * the session's whole set. Every assertion here is about the difference that
 * makes: it may add identities, it may not retract them, and it may not re-derive
 * link-level state from its own partial contents.
 *
 * The sibling `pr-links-replace-lock.integration.test.ts` pins the Replace arm
 * this one sits beside. Read together they are the contract: page 0 replaces,
 * the parts after it merge.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import {
  ArtifactRefMethod,
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
  type SessionPrLinkFixture,
  seedSessionPrLinkFixture,
  sessionPrLinkMetadata,
  sessionPrLinkRow,
} from "@/__tests__/support/agent-sessions/session-pr-links.test-harness";
import { autoRollbackTransaction } from "@/__tests__/utils/db-helpers";
import { SessionPrLinkWriteMode } from "./session-pr-link-merge";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;

describeIfDb("ISS-9859: paginated PR-link Merge arm (real Postgres)", () => {
  it("adds a later page's identity without dropping the page-0 identities", () => {
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      await persistSessionPrLinks(
        fixture,
        [prRef(1), prRef(2)],
        SessionPrLinkWriteMode.Replace
      );
      await persistSessionPrLinks(
        fixture,
        [prRef(3)],
        SessionPrLinkWriteMode.Merge
      );

      // The core of pagination: page 1 declared only PR 3, and PRs 1-2 survive.
      // Under Replace this same payload would have deleted them.
      expect(await linkedPrNumbers(fixture)).toEqual([1, 2, 3]);
    });
  });

  it("derives link-level relationTypes from the FOLDED refs, not the incoming slice", () => {
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      await persistSessionPrLinks(
        fixture,
        [prRef(1, SessionPrRelationType.Created)],
        SessionPrLinkWriteMode.Replace
      );
      await persistSessionPrLinks(
        fixture,
        [prRef(2, SessionPrRelationType.Reviewed)],
        SessionPrLinkWriteMode.Merge
      );

      // Both PRs resolve to the SAME branch, so one link carries both. Its
      // relationTypes must be the union over the folded refs — a slice-only
      // derivation would write ["REVIEWED"] and lose page 0's CREATED.
      const metadata = await sessionPrLinkMetadata(fixture, "branch-1");
      expect(metadata.relationTypes).toEqual([
        SessionPrRelationType.Created,
        SessionPrRelationType.Reviewed,
      ]);
    });
  });

  it("withholds a prose relation for an identity a stored strong ref already claims", () => {
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      await persistSessionPrLinks(
        fixture,
        [prRef(1, SessionPrRelationType.Created)],
        SessionPrLinkWriteMode.Replace
      );
      // `withProseDerivedPrRefs` mints exactly this on a later part: artifactRefs
      // ride every part whole, so page 1 re-offers PR 1 as a prose mention. Whole
      // delivery never produces that REFERENCED, so the merge must not either.
      await persistSessionPrLinks(
        fixture,
        [
          {
            ...prRef(1, SessionPrRelationType.Referenced),
            method: ArtifactRefMethod.PrMentionInProse,
          },
        ],
        SessionPrLinkWriteMode.Merge
      );

      const metadata = await sessionPrLinkMetadata(fixture, "branch-1");
      expect(metadata.relationTypes).toEqual([SessionPrRelationType.Created]);
      const prRefs = metadata.prRefs as { method?: string }[];
      expect(prRefs[0]).not.toHaveProperty("method");
    });
  });

  it("keeps branchLifecycleEvents a page-0 part wrote on a non-branchLinked link", () => {
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      await persistSessionPrLinks(
        fixture,
        [
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
        ],
        SessionPrLinkWriteMode.Replace
      );
      await persistSessionPrLinks(
        fixture,
        [prRef(2)],
        SessionPrLinkWriteMode.Merge
      );

      // `buildSessionPrLinkMetadata` re-reads stored events only when the link is
      // branchLinked, which a PR-only link is not — so the Merge arm seeds them
      // unconditionally or page 0's evidence is silently dropped.
      const metadata = await sessionPrLinkMetadata(fixture, "branch-1");
      expect(metadata.branchLifecycleEvents).toEqual([
        expect.objectContaining({ kind: BranchLifecycleBoundaryKind.PrRaised }),
      ]);
    });
  });

  it("preserves a stored branch projection when the later page's ref has no association", () => {
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();
      // Stand in for what an earlier part established: a projection on the link,
      // written with the participation columns set.
      await withDb((db) =>
        db.artifactLink.create({
          data: {
            organizationId: fixture.organizationId,
            sourceId: fixture.sessionArtifactId,
            targetId: fixture.branchArtifactIds["branch-1"],
            linkType: LinkType.RelatesTo,
            branchParticipation: BranchParticipationKind.Wrote,
            branchParticipationMethod: ArtifactRefMethod.PrCreateOutput,
            branchParticipationObservedAt: new Date("2026-05-20T17:01:00.000Z"),
            metadata: {
              linkKind: SessionArtifactLinkKind.SessionPr,
              linkKinds: [SessionArtifactLinkKind.SessionPr],
              branchName: "feat/x",
              branchParticipation: BranchParticipationKind.Wrote,
              relationTypes: [SessionPrRelationType.Created],
              prRefs: [
                {
                  repositoryFullName: SESSION_PR_LINK_REPO,
                  prNumber: 1,
                  relationTypes: [SessionPrRelationType.Created],
                },
              ],
            },
          },
          select: { id: true },
        })
      );

      // PR 2 resolves through an already-verified detail row, so it carries NO
      // branchAssociation — the path EVERY later-page ref takes. Under Replace
      // this nulls the three columns and strips the projection.
      await persistSessionPrLinks(
        fixture,
        [prRef(2)],
        SessionPrLinkWriteMode.Merge
      );

      const link = await sessionPrLinkRow(fixture, "branch-1");
      expect(link.branchParticipation).toBe(BranchParticipationKind.Wrote);
      expect(link.branchParticipationMethod).toBe(
        ArtifactRefMethod.PrCreateOutput
      );
      expect(link.branchParticipationObservedAt).not.toBeNull();
      expect(link.metadata).toMatchObject({ branchName: "feat/x" });
    });
  });

  it("keeps the session_branch kind, not just the projection, on a PR-head link", () => {
    // REGRESSION, found by review. The Merge arm preserved the branch
    // projection and the three participation columns but still deleted
    // `session_branch` from `linkKinds`, because that delete was gated on
    // `branchLinked !== true` and a PR-HEAD-derived link never carries that key
    // (`branchLinkedMetadata` writes it only for INDEPENDENT branch evidence).
    // The row then asserted `branchParticipation: wrote` while every reader that
    // gates on `session_branch` skipped it — branch contribution, branch
    // analytics, LOC attribution and the PR reconcile lane all silently lost the
    // edge. A row that contradicts itself is worse than one that is merely
    // incomplete, which is why this is pinned rather than left to the
    // projection assertions above.
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();
      await withDb((db) =>
        db.artifactLink.create({
          data: {
            organizationId: fixture.organizationId,
            sourceId: fixture.sessionArtifactId,
            targetId: fixture.branchArtifactIds["branch-1"],
            linkType: LinkType.RelatesTo,
            branchParticipation: BranchParticipationKind.Wrote,
            branchParticipationMethod: ArtifactRefMethod.PrCreateOutput,
            branchParticipationObservedAt: new Date("2026-05-20T17:01:00.000Z"),
            metadata: {
              // Exactly the shape the PR-head lane writes: the kind and the
              // projection, and NO `branchLinked`.
              linkKind: SessionArtifactLinkKind.SessionBranch,
              linkKinds: [
                SessionArtifactLinkKind.SessionBranch,
                SessionArtifactLinkKind.SessionPr,
              ],
              branchName: "feat/x",
              branchParticipation: BranchParticipationKind.Wrote,
              relationTypes: [SessionPrRelationType.Created],
              prRefs: [
                {
                  repositoryFullName: SESSION_PR_LINK_REPO,
                  prNumber: 1,
                  relationTypes: [SessionPrRelationType.Created],
                },
              ],
            },
          },
          select: { id: true },
        })
      );

      // The ordinary path: a later page carries a prose twin for the page-0 PR
      // (artifactRefs ride every part whole), resolving to the same branch.
      await persistSessionPrLinks(
        fixture,
        [
          {
            ...prRef(1, SessionPrRelationType.Referenced),
            method: ArtifactRefMethod.PrMentionInProse,
          },
        ],
        SessionPrLinkWriteMode.Merge
      );

      const metadata = await sessionPrLinkMetadata(fixture, "branch-1");
      expect(metadata.linkKinds).toContain(
        SessionArtifactLinkKind.SessionBranch
      );
      // The projection it agrees with must still be there too — the point is
      // that the two stay consistent, not that either survives alone.
      expect(metadata).toMatchObject({ branchName: "feat/x" });
    });
  });

  it("COUNTERFACTUAL: the same later page under Replace writes SLICE-ONLY relationTypes", () => {
    // Without a counterfactual, every case above would pass just as well if the
    // mode flag were ignored and both calls took one path.
    //
    // Both PRs here resolve to branch-1, so they share one link row and Replace
    // upserts that row rather than deleting it. `relationTypes` is what
    // discriminates the two arms: Replace derives them from the incoming slice
    // alone, Merge from the folded union. Same two payloads as the relationTypes
    // case above, one flag changed. The deletion counterfactual, across two
    // branches, is in `pr-links-paginated-association.integration.test.ts`.
    return autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      await persistSessionPrLinks(
        fixture,
        [prRef(1, SessionPrRelationType.Created)],
        SessionPrLinkWriteMode.Replace
      );
      await persistSessionPrLinks(
        fixture,
        [prRef(2, SessionPrRelationType.Reviewed)],
        SessionPrLinkWriteMode.Replace
      );

      const metadata = await sessionPrLinkMetadata(fixture, "branch-1");
      expect(metadata.relationTypes).toEqual([SessionPrRelationType.Reviewed]);
      // And the identity set is the slice alone, where Merge held both.
      expect(
        (metadata.prRefs as { prNumber: number }[]).map((ref) => ref.prNumber)
      ).toEqual([2]);
    });
  });
});

/** PRs 1-2 share branch-1; PR 3 is on branch-2, so cross-link effects show. */
function seedFixture(): Promise<SessionPrLinkFixture> {
  return seedSessionPrLinkFixture("iss9859-merge", {
    1: "branch-1",
    2: "branch-1",
    3: "branch-2",
  });
}
