/**
 * ISS-9755 / ISS-9754 / ISS-9904 — `sessionLocCoverageCounts.sql`'s numerator,
 * EXECUTED: its window bound and its merged-PR admission predicate.
 *
 * Split out of `usage-typed-sql-statements.integration.test.ts` (AGENTS.md's
 * 1,000-line file ceiling) rather than left to grow that file further; both
 * import the same fixtures from `./usage-typed-sql-statements.test-helpers`.
 * That file's header records why nothing here ran against Postgres before
 * ISS-8554/ISS-9904 — the same reasoning applies to every case below.
 */

import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import {
  EMPTY_USAGE_SQL_FACETS,
  readFacetCounts,
  readLocCoverageCounts,
} from "@/app/agent-sessions/service/usage-sql-reader";
import {
  arm,
  createTestBranchArtifact,
  wholeOrg,
} from "./usage-typed-sql-statements.test-helpers";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;

describeIfDb(
  "sessionLocCoverageCounts numerator, against a real database",
  () => {
    it("treats a NULL bound as UNBOUNDED, not as a bound that matches nothing", async () => {
      // `($2::timestamp IS NULL OR ...)` is the only thing making an unbounded read
      // return the whole org. Delete the two `IS NULL OR` guards and every other
      // case here stays green -- the cross-org case expects 0 and the D3 case sends
      // non-null bounds -- so nothing exercised the guard. This is the regression
      // `sessionMergedPrLoc.sql` records having shipped once already: an unbounded
      // request returned NO rows while every sibling card returned the whole org.
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const { id: userId } = await createTestUser(organizationId);
        const branchArtifactId = await createTestBranchArtifact(
          organizationId,
          "unbounded"
        );
        await linkValidSessionToBranch({
          organizationId,
          userId,
          branchArtifactId,
          label: "unbounded",
          linkKind: SessionArtifactLinkKind.SessionPr,
        });

        // Both bounds null. A POSITIVE assertion: the session must be present.
        const counts = await readLocCoverageCounts(
          wholeOrg(organizationId),
          EMPTY_USAGE_SQL_FACETS
        );
        expect(counts.numeratorSessionCount).toBe(1);

        const rows = await readFacetCounts(
          wholeOrg(organizationId),
          EMPTY_USAGE_SQL_FACETS
        );
        expect(arm(rows, "owner")[0]?.sessionCount).toBe(1);
      });
    });

    it("is HALF-OPEN: a session exactly on `start` counts, one exactly on `end` does not", async () => {
      // Every other fixture sits comfortably inside or outside the range, so
      // `>= $2` -> `> $2` and `< $3` -> `<= $3` both survive. The PR's whole thesis
      // is "exactly the sibling predicate, half-open", which is untestable without
      // a row on each bound.
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const { id: userId } = await createTestUser(organizationId);
        const branchArtifactId = await createTestBranchArtifact(
          organizationId,
          "bounds"
        );
        const start = new Date("2026-05-01T00:00:00Z");
        const end = new Date("2026-07-01T00:00:00Z");

        await linkValidSessionToBranch({
          organizationId,
          userId,
          branchArtifactId,
          label: "on-start",
          sessionTimestamp: start,
          linkKind: SessionArtifactLinkKind.SessionPr,
        });
        await linkValidSessionToBranch({
          organizationId,
          userId,
          branchArtifactId,
          label: "on-end",
          sessionTimestamp: end,
          linkKind: SessionArtifactLinkKind.SessionPr,
        });

        const counts = await readLocCoverageCounts(
          { organizationId, start, end },
          EMPTY_USAGE_SQL_FACETS
        );
        // Inclusive start, exclusive end: exactly one of the two.
        expect(counts.numeratorSessionCount).toBe(1);
      });
    });

    it("windows the numerator on the SESSION, excluding an out-of-range link (D3)", async () => {
      // D3 (ISS-9754): this is the sessions page, so the date range selects
      // SESSIONS. The numerator must be drawn from the SAME windowed population
      // the cost divisor sums -- sessionMergedPrLoc, sessionUsageTotals and
      // sessionCostSplit all apply this exact predicate. An out-of-window session
      // is therefore absent from the numerator entirely, NOT present-but-excluded.
      //
      // This fails if `base` loses its window: the January session rejoins the
      // cohort and the numerator reads 2.
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const { id: userId } = await createTestUser(organizationId);
        const branchArtifactId = await createTestBranchArtifact(
          organizationId,
          "delivery"
        );

        // Both carry the same session->PR delivery link; only the window differs.
        // `linkValidSessionToBranch` seeds the session AND the link, including the
        // `branchParticipation` the product writes, which a hand-rolled fixture
        // dropped (marisolashgrove on #6897).
        for (const [label, sessionTimestamp] of [
          ["in-window", new Date("2026-06-15T00:00:00Z")],
          ["out-of-window", new Date("2026-01-05T00:00:00Z")],
        ] as const) {
          await linkValidSessionToBranch({
            organizationId,
            userId,
            branchArtifactId,
            label,
            sessionTimestamp,
            linkKind: SessionArtifactLinkKind.SessionPr,
          });
        }

        // A THIRD in-window session that is revision-stamped and chunk-staged, so
        // the two revision FILTERs have something to EXCLUDE. Without it the whole
        // cohort was one never-stamped row, and `count(*) FILTER (WHERE
        // data_revision IS NULL)` returned the same number as a bare `count(*)` --
        // deleting either FILTER left the case green.
        await linkValidSessionToBranch({
          organizationId,
          userId,
          branchArtifactId,
          label: "staged",
          sessionTimestamp: new Date("2026-06-20T00:00:00Z"),
          linkKind: SessionArtifactLinkKind.SessionPr,
          cost: { dataRevision: 77, pendingChunkRevision: 3 },
        });

        // A FOURTH carrying the ISS-7905 BRANCH arm rather than the PR arm: the
        // helper's default metadata is `{ linkKind: 'session_branch' }` with NO
        // `method` key, which is exactly the shape the statement's prose guard must
        // ADMIT (`COALESCE(al.metadata ? 'method', FALSE) AND ...`). Nothing in the
        // repo executed that arm before -- both other fixtures override to
        // SessionPr -- so the whole block the SQL header calls "THE SUBTLE PART"
        // could be deleted with every test green.
        await linkValidSessionToBranch({
          organizationId,
          userId,
          branchArtifactId,
          label: "branch-arm",
          sessionTimestamp: new Date("2026-06-21T00:00:00Z"),
        });

        // And one PROSE-derived link per rejected method. BOTH literals in the
        // guard's IN list need a fixture: with only `branch_mention_in_prose`
        // seeded, corrupting `pr_mention_in_prose` was undetectable.
        for (const [label, method] of [
          ["prose-branch", "branch_mention_in_prose"],
          ["prose-pr", "pr_mention_in_prose"],
        ] as const) {
          const proseBranch = await createTestBranchArtifact(
            organizationId,
            label
          );
          await linkValidSessionToBranch({
            organizationId,
            userId,
            branchArtifactId: proseBranch,
            label,
            sessionTimestamp: new Date("2026-06-22T00:00:00Z"),
            metadata: { linkKind: "session_branch", method },
          });
        }

        const counts = await readLocCoverageCounts(
          {
            organizationId,
            start: new Date("2026-05-01T00:00:00Z"),
            end: new Date("2026-07-01T00:00:00Z"),
          },
          EMPTY_USAGE_SQL_FACETS
        );

        // THREE in the cohort: in-window (PR arm), staged (PR arm) and branch-arm
        // (ISS-7905 branch arm). The two `prose-*` rows are in-window and
        // delivery-linked but the prose guard REJECTS both, which is what proves
        // each literal in its IN list is live.
        // `out-of-window` is excluded by the window. Strip the window off `base`
        // and this reads 4; delete the branch arm and it reads 2; drop the prose
        // guard and it reads 4.
        expect(counts.numeratorSessionCount).toBe(3);
        // Covered equals numerator by construction, pinned to the LITERAL rather
        // than read back off the same result -- comparing one field of a result to
        // another field of the same result survives an edit to the line above.
        // `foldLocPerDollarCoverage` derives `excludedSessionCount` as the
        // difference, so this is what makes `Missing` unreachable.
        expect(counts.coveredNumeratorSessionCount).toBe(3);
        // DISCRIMINATING now: `staged` is stamped at revision 77, the other two are
        // not, so a bare `count(*)` in either slot reads 3 and reds this.
        expect(counts.unrevisionedSessionCount).toBe(2);
        expect(counts.migrationPendingSessionCount).toBe(1);
      });
    });

    it("counts only sessions whose branch carries a MERGED PR (ISS-9904)", async () => {
      // The numerator is meant to be the sessions whose pull requests produced the
      // lines this card divides. Before ISS-9904 it was every session holding a
      // delivery link, which is strictly wider — and `resolveCoverageState` reports
      // MigrationPending when ANY numerator session has a staged chunk revision,
      // outranking everything else. So a session that contributed no lines could
      // fault a ratio that was in fact fully covered, which is the failure
      // `loc-per-dollar-coverage.ts:26-32` names.
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const { id: userId } = await createTestUser(organizationId);

        // SIX delivery-linked sessions, identical but for their branch's PR.
        // One qualifies; the other five each fail exactly one conjunct.
        for (const [label, pullRequest] of [
          ["merged", "merged"],
          ["open-pr", "open"],
          ["no-pr", "none"],
          ["closed-with-merged-at", "closed-with-merged-at"],
          ["merged-no-timestamp", "merged-no-timestamp"],
          ["merged-unverified", "merged-unverified"],
        ] as const) {
          const branchArtifactId = await createTestBranchArtifact(
            organizationId,
            label,
            pullRequest
          );
          await linkValidSessionToBranch({
            organizationId,
            userId,
            branchArtifactId,
            label,
            linkKind: SessionArtifactLinkKind.SessionPr,
            // THE EXCLUDED SESSIONS CARRY A STAGED CHUNK REVISION (whitlockk on
            // #6969). MigrationPending is the state this ticket is really about —
            // it outranks everything, so folding it over the old delivery-linked
            // cohort is the regression that would publish a fault on a fully
            // covered ratio. Without a staged revision on a session that must be
            // EXCLUDED, that regression stays green: the assertion below would
            // read 0 either way.
            cost:
              pullRequest === "merged"
                ? undefined
                : { pendingChunkRevision: 3 },
          });
        }

        const counts = await readLocCoverageCounts(
          wholeOrg(organizationId),
          EMPTY_USAGE_SQL_FACETS
        );

        // ONE. The other five hold delivery links that satisfy every arm of the
        // link predicate and still contribute no merged lines. Every conjunct has
        // its own fixture, so each is separately mutation-visible:
        //   remove the EXISTS            -> 6
        //   drop pr_state = 'MERGED'     -> 2 (closed-with-merged-at joins)
        //   drop merged_at IS NOT NULL   -> 2 (merged-no-timestamp joins)
        //   drop last_verified_at ...    -> 2 (merged-unverified joins)
        expect(counts.numeratorSessionCount).toBe(1);
        expect(counts.coveredNumeratorSessionCount).toBe(1);
        // The two revision counts are folded over the SAME narrowed cohort, which
        // is the point: they are what MigrationPending and Stale read.
        expect(counts.unrevisionedSessionCount).toBe(1);
        // ZERO, and it is the five EXCLUDED sessions that carry the staged
        // revisions. Fold this count over the old cohort and it reads 5, which
        // publishes MigrationPending on a ratio that is fully covered.
        expect(counts.migrationPendingSessionCount).toBe(0);
      });
    });

    it("keeps a session whose PR merged OUTSIDE the window (D3, ISS-9904)", async () => {
      // The merged-PR check is an EXISTENCE check. ISS-8554 rule 3 says a pull
      // request's own `merged_at` bounds nothing — the window selects SESSIONS.
      //
      // Every other case here reads with an unbounded window, or with a window
      // that happens to contain the fixture's fixed merge time, so adding a
      // `$2`/`$3` predicate on `p.merged_at` would pass them all (davetho on
      // #6969). This one separates the two: the session is inside the window and
      // its qualifying PR merged well outside it.
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const { id: userId } = await createTestUser(organizationId);

        const branchArtifactId = await createTestBranchArtifact(
          organizationId,
          "old-merge"
        );
        // The fixture's PR merges 2026-06-10; move it far outside the window the
        // read below asks for, leaving the SESSION inside it.
        await withDb((db) =>
          db.pullRequestDetail.updateMany({
            where: { branchArtifactId },
            data: { mergedAt: new Date("2025-02-03T00:00:00Z") },
          })
        );
        await linkValidSessionToBranch({
          organizationId,
          userId,
          branchArtifactId,
          label: "old-merge",
          sessionTimestamp: new Date("2026-06-15T00:00:00Z"),
          linkKind: SessionArtifactLinkKind.SessionPr,
        });

        const counts = await readLocCoverageCounts(
          {
            organizationId,
            start: new Date("2026-05-01T00:00:00Z"),
            end: new Date("2026-07-01T00:00:00Z"),
          },
          EMPTY_USAGE_SQL_FACETS
        );

        // STILL COUNTED. Window `p.merged_at` and this reads 0.
        expect(counts.numeratorSessionCount).toBe(1);
      });
    });
  }
);
