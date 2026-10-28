import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { withDb } from "@repo/database";
import { BRANCH_OWNER_UNATTRIBUTED_LABEL } from "@repo/lib/branches/branch-list-page";
import { afterEach, describe, expect, it } from "vitest";
import {
  closedloopKey,
  FIRST_PUSHED_AT,
  GIT_PUSH_METHOD,
  HAS_DATABASE,
  LATER_PUSHED_AT,
  NON_PUSH_METHOD,
  readIdentityProjections,
  renameUser,
  seedBranch,
  seedEvidenceLink,
} from "@/__tests__/utils/branch-identity-sql-fixture";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";

/**
 * ISS-10298 — equivalence oracle for the Branches-list OWNER identity LATERAL.
 *
 * Every case seeds a corpus, then asserts the SQL projection agrees with what
 * the production JavaScript projector (`resolveBranchIdentities`) returns for
 * the same branch, rather than against hand-written expectations: the SQL is a
 * move, so the JS is the specification and a restated expectation could agree
 * with a shared mistake.
 *
 * ISS-11737: that agreement is the whole point of the suite — the JS moved
 * `first_pushed_at` from a precondition to a tiebreak and the SQL twin did not,
 * so the branch row named a person the Owner facet counted as Unattributed. The
 * collaborator half of the oracle lives in
 * `branch-list-identity-collaborators.integration.test.ts`.
 *
 * ISS-12463: both sides now read the Owner from the branch's assignee, which the
 * oracle seeds from the case's evidence first. The cases therefore pin which
 * person the seed names, and an assignee read is always complete.
 */

const describeIfDb = HAS_DATABASE ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

describeIfDb("branch list owner identity SQL (ISS-10298)", () => {
  it("resolves no owner for a branch whose only link is not a push", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "no-push", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await seedEvidenceLink({
        organizationId,
        branchId,
        userId: user.id,
        label: "no-push",
        method: NON_PUSH_METHOD,
        observedAt: FIRST_PUSHED_AT,
      });

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      expect(sql).toEqual(expected);

      expect(sql.ownerKey).toBe(BRANCH_OWNER_UNATTRIBUTED_LABEL);
      expect(sql.ownerAvailability).toBe(BranchIdentityAvailability.Complete);
    });
  });

  it("names no owner for an assignee from another organization (ISS-12463)", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const otherOrganizationId = await committedOrganizations.create();
      const outsider = await createTestUser(otherOrganizationId);
      const branchId = await seedBranch(organizationId, "outside-assignee", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await withDb((db) =>
        db.artifact.update({
          where: { id: branchId },
          data: { assigneeId: outsider.id },
        })
      );

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      expect(sql).toEqual(expected);

      expect(sql.ownerKey).toBe(BRANCH_OWNER_UNATTRIBUTED_LABEL);
    });
  });

  it("keeps a sole push link whose observed_at differs from first_pushed_at", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "sole-push", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await seedEvidenceLink({
        organizationId,
        branchId,
        userId: user.id,
        label: "sole-push",
        method: GIT_PUSH_METHOD,
        observedAt: LATER_PUSHED_AT,
      });

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      expect(sql).toEqual(expected);

      expect(sql.ownerKey).toBe(closedloopKey(user.id));
      expect(sql.ownerAvailability).toBe(BranchIdentityAvailability.Complete);
    });
  });

  it("keeps only the push link matching first_pushed_at when two exist", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const matching = await createTestUser(organizationId);
      const other = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "two-push", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await seedEvidenceLink({
        organizationId,
        branchId,
        userId: matching.id,
        label: "two-push-match",
        method: GIT_PUSH_METHOD,
        observedAt: FIRST_PUSHED_AT,
      });
      await seedEvidenceLink({
        organizationId,
        branchId,
        userId: other.id,
        label: "two-push-later",
        method: GIT_PUSH_METHOD,
        observedAt: LATER_PUSHED_AT,
      });

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      expect(sql).toEqual(expected);

      expect(sql.ownerKey).toBe(closedloopKey(matching.id));
      expect(sql.ownerAvailability).toBe(BranchIdentityAvailability.Complete);
    });
  });

  it("takes the label of the smallest key among two matching push links", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const users = [
        await createTestUser(organizationId),
        await createTestUser(organizationId),
      ].sort((left, right) =>
        closedloopKey(left.id).localeCompare(closedloopKey(right.id))
      );
      const [winner, loser] = users;
      if (!(winner && loser)) {
        throw new Error("expected two seeded users");
      }
      // The smallest KEY deliberately carries the largest LABEL, so a
      // `MIN(label)` in place of the argmin returns the wrong person's name.
      await renameUser(winner.id, "Zoe", "Zulu");
      await renameUser(loser.id, "Ada", "Adams");
      const branchId = await seedBranch(organizationId, "tied-push", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      for (const user of users) {
        await seedEvidenceLink({
          organizationId,
          branchId,
          userId: user.id,
          label: `tied-${user.id.slice(0, 8)}`,
          method: GIT_PUSH_METHOD,
          observedAt: FIRST_PUSHED_AT,
        });
      }

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      expect(sql).toEqual(expected);

      expect(sql.ownerKey).toBe(closedloopKey(winner.id));
      expect(sql.ownerLabel).toBe("Zoe Zulu");
      expect(sql.ownerAvailability).toBe(BranchIdentityAvailability.Complete);
    });
  });

  it("still resolves an owner when a matching push link resolves to nobody", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "partial-push", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      await seedEvidenceLink({
        organizationId,
        branchId,
        userId: user.id,
        label: "partial-known",
        method: GIT_PUSH_METHOD,
        observedAt: FIRST_PUSHED_AT,
      });
      const anonymous = await seedEvidenceLink({
        organizationId,
        branchId,
        userId: user.id,
        label: "partial-unknown",
        method: GIT_PUSH_METHOD,
        observedAt: FIRST_PUSHED_AT,
      });
      // The person behind a push is the pushing session's creator (ISS-12251),
      // so a session with no creator is the push link that resolves to nobody.
      await withDb((db) =>
        db.artifact.update({
          where: { id: anonymous },
          data: { createdById: null },
          select: { id: true },
        })
      );

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      expect(sql).toEqual(expected);

      expect(sql.ownerKey).toBe(closedloopKey(user.id));
      expect(sql.ownerAvailability).toBe(BranchIdentityAvailability.Complete);
    });
  });

  it("keeps the pusher as Owner after the pushing session is reassigned", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const pusher = await createTestUser(organizationId);
      const assignee = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "reassigned-push", {
        firstPushedAt: FIRST_PUSHED_AT,
      });
      const sessionId = await seedEvidenceLink({
        organizationId,
        branchId,
        userId: pusher.id,
        label: "reassigned-push",
        method: GIT_PUSH_METHOD,
        observedAt: FIRST_PUSHED_AT,
      });
      // ISS-12251: reassignment moves the session's Owner, not who pushed.
      await withDb((db) =>
        db.artifact.update({
          where: { id: sessionId },
          data: { createdById: pusher.id, assigneeId: assignee.id },
          select: { id: true },
        })
      );

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      expect(sql).toEqual(expected);

      expect(sql.ownerKey).toBe(closedloopKey(pusher.id));
      expect(sql.ownerAvailability).toBe(BranchIdentityAvailability.Complete);
    });
  });

  it("reports an unpushed branch with a push-method link incomplete", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "unpushed-evidence", {
        firstPushedAt: null,
      });
      await seedEvidenceLink({
        organizationId,
        branchId,
        userId: user.id,
        label: "unpushed-evidence",
        method: GIT_PUSH_METHOD,
        // No `observed_at`: this arm is a wider set than the owner push links.
        observedAt: null,
      });

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      expect(sql).toEqual(expected);

      expect(sql.ownerKey).toBe(BRANCH_OWNER_UNATTRIBUTED_LABEL);
      expect(sql.ownerAvailability).toBe(BranchIdentityAvailability.Complete);
    });
  });

  it("reports an unpushed branch with no push-method link complete", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "unpushed-quiet", {
        firstPushedAt: null,
      });
      await seedEvidenceLink({
        organizationId,
        branchId,
        userId: user.id,
        label: "unpushed-quiet",
        method: NON_PUSH_METHOD,
        observedAt: FIRST_PUSHED_AT,
      });

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      expect(sql).toEqual(expected);

      expect(sql.ownerKey).toBe(BRANCH_OWNER_UNATTRIBUTED_LABEL);
      expect(sql.ownerAvailability).toBe(BranchIdentityAvailability.Complete);
    });
  });

  it("names the earliest push's owner on a branch with no first_pushed_at", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "unstamped-dated", {
        firstPushedAt: null,
      });
      await seedEvidenceLink({
        organizationId,
        branchId,
        userId: user.id,
        label: "unstamped-dated",
        method: GIT_PUSH_METHOD,
        observedAt: FIRST_PUSHED_AT,
      });

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      // ISS-11737 (tamsinb review): the JS moved the column from a
      // precondition to a tiebreak and the SQL twin did not, so this fixture is
      // where the row and the Owner facet disagreed — the SQL nulled the owner
      // and reported Incomplete while the JS named the person.
      expect(sql).toEqual(expected);

      expect(sql.ownerKey).toBe(closedloopKey(user.id));
      expect(sql.ownerAvailability).toBe(BranchIdentityAvailability.Complete);
    });
  });

  it("pins both derivations to the earliest of two undated-branch pushes", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const earliest = await createTestUser(organizationId);
      const later = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "unstamped-two", {
        firstPushedAt: null,
      });
      await seedEvidenceLink({
        organizationId,
        branchId,
        userId: later.id,
        label: "unstamped-two-later",
        method: GIT_PUSH_METHOD,
        observedAt: LATER_PUSHED_AT,
      });
      await seedEvidenceLink({
        organizationId,
        branchId,
        userId: earliest.id,
        label: "unstamped-two-earliest",
        method: GIT_PUSH_METHOD,
        observedAt: FIRST_PUSHED_AT,
      });

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      // With no column to pin against, both halves must read the links' own
      // earliest instant, or they disagree on which push spoke for the branch.
      expect(sql).toEqual(expected);

      expect(sql.ownerKey).toBe(closedloopKey(earliest.id));
      expect(sql.ownerAvailability).toBe(BranchIdentityAvailability.Complete);
    });
  });

  it("reports a mixed dated and undated push set incomplete, owner kept", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const dated = await createTestUser(organizationId);
      const undated = await createTestUser(organizationId);
      const branchId = await seedBranch(organizationId, "unstamped-mixed", {
        firstPushedAt: null,
      });
      await seedEvidenceLink({
        organizationId,
        branchId,
        userId: dated.id,
        label: "unstamped-mixed-dated",
        method: GIT_PUSH_METHOD,
        observedAt: FIRST_PUSHED_AT,
      });
      await seedEvidenceLink({
        organizationId,
        branchId,
        userId: undated.id,
        label: "unstamped-mixed-undated",
        method: GIT_PUSH_METHOD,
        observedAt: null,
      });

      const { sql, expected } = await readIdentityProjections(
        organizationId,
        branchId
      );

      // ISS-11737 (whitlockk review): the undated push may be the earlier one and
      // its owner is unseen, so the dated push's owner is the fallback
      // candidate and the corpus is partial — not a confident Complete.
      expect(sql).toEqual(expected);

      expect(sql.ownerKey).toBe(closedloopKey(dated.id));
      expect(sql.ownerAvailability).toBe(BranchIdentityAvailability.Complete);
    });
  });
});
