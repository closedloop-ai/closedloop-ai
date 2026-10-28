/**
 * ISS-9755 / ISS-9754 — the two rewritten usage statements, EXECUTED.
 *
 * Nothing in this repo ran `sessionFacetCounts.sql` or
 * `sessionLocCoverageCounts.sql`. `usage-sql-reader.test.ts` mocks
 * `@repo/database` wholesale, so it asserts bigint/Decimal coercion over
 * hand-written rows and never reaches Postgres; the composer suite mocks the
 * readers. ISS-8554's SQL correctness fixes were therefore revertible with
 * every test and guard in the repo still green:
 *
 *   - restore the row-per-project lateral and a two-project session
 *     double-counts in the owner, harness, repository and model arms;
 *   - drop the organisation predicate and another tenant's usage and cost sum
 *     into this one's totals.
 *
 * These cases fail under exactly those mutations. They go through the READERS
 * rather than `$queryRawTyped` directly, so the 25-slot `facetArgs` tuple is
 * exercised with the statement it feeds — and `narrows on a SELECTED facet`
 * drives a real selection through that tuple, because a renumbering that points
 * a dimension at the wrong parameter is invisible to a suite that only ever
 * sends the empty facet set (whitlockk on #6897).
 *
 * SCOPED CLAIM, and it NARROWED at ISS-10753 rather than widening. Slots a
 * case here actually populates: `repositories` (that case), `qualityMode`
 * (ISS-10150), `statuses` and the three cost-bucket slots (the two graduation
 * cases below), and `subscriptionBillingModes` (the cost-split case, where a
 * swap reads as the wrong dollar figure). A transposition involving any of
 * those now reads as a wrong count or a wrong sum.
 *
 * What still stays green under a swap is the three slots no case populates —
 * `harnesses`, `models`, `projectIds` — plus the autonomy bounds,
 * which nothing in this file drives at all. Such a swap compiles and passes
 * `check:typed-sql-fragments` (which compares SQL against SQL, not against the
 * TS tuple). Do not read this file as covering the whole tuple.
 *
 * The two person slots, `ownerUserIds` ($4) and `creatorUserIds` ($25), are
 * driven by `usage-typed-sql-owner-creator.integration.test.ts` (ISS-12251).
 *
 * WINDOW AND COVERAGE-NUMERATOR ADMISSION are a separate suite,
 * `usage-typed-sql-coverage-numerator.integration.test.ts` — split out
 * (AGENTS.md's 1,000-line ceiling) rather than left to grow this file further.
 * Both import the same fixtures from `./usage-typed-sql-statements.test-helpers`.
 */

import { randomUUID } from "node:crypto";
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { SUBSCRIPTION_BILLING_MODES } from "@repo/api/src/types/billing-mode";
import { Priority } from "@repo/api/src/types/common";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestSessionDetail,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import {
  computeSessionCostSplit,
  SessionCostLedger,
} from "@/app/agent-sessions/service/usage-cost-split";
import {
  EMPTY_USAGE_SQL_FACETS,
  readCostSplit,
  readFacetCounts,
  readLocCoverageCounts,
  type UsageSqlFacets,
} from "@/app/agent-sessions/service/usage-sql-reader";
import {
  arm,
  createTestBranchArtifact,
  linkSessionToProject,
  stampSession,
  wholeOrg,
} from "./usage-typed-sql-statements.test-helpers";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;

describeIfDb("usage TypedSQL statements, against a real database", () => {
  it("counts a two-project session ONCE in EVERY non-project arm, and in BOTH project buckets", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const { id: userId } = await createTestUser(organizationId);
      const projectA = await createTestProject(organizationId, userId, {
        name: "Project A",
      });
      const projectB = await createTestProject(organizationId, userId, {
        name: "Project B",
      });

      // ONE session, linked into TWO projects. This is the shape that used to
      // fan out into two `base` rows.
      const twoProject = await createTestSessionDetail({
        organizationId,
        userId,
        label: "two-project",
      });
      await stampSession(twoProject, {
        harness: "claude",
        repositoryFullName: "acme/two-project",
        model: "opus",
      });
      for (const [projectId, label] of [
        [projectA, "a"],
        [projectB, "b"],
      ] as const) {
        await linkSessionToProject({
          organizationId,
          sessionArtifactId: twoProject,
          projectId,
          label,
        });
      }

      // A second session with NO linked project, for the null bucket.
      const unlinked = await createTestSessionDetail({
        organizationId,
        userId,
        label: "unlinked",
      });
      await stampSession(unlinked, {
        harness: "claude",
        repositoryFullName: "acme/two-project",
        model: "opus",
      });

      const rows = await readFacetCounts(
        wholeOrg(organizationId),
        EMPTY_USAGE_SQL_FACETS
      );

      // THE FAN-OUT ASSERTION, on ALL FOUR non-project arms. Asserting `owner`
      // alone left a regression in any of the other three green (davetho on
      // #6897): the lateral fans out `base` itself, so every arm reading it
      // doubles together.
      for (const dimension of [
        "owner",
        "harness",
        "repository",
        "model",
      ] as const) {
        const rowsForArm = arm(rows, dimension);
        expect(
          rowsForArm,
          `${dimension} arm collapsed to one value`
        ).toHaveLength(1);
        expect(rowsForArm[0]?.sessionCount, `${dimension} arm counts 2`).toBe(
          2
        );
      }
      expect(arm(rows, "owner")[0]?.value).toBe(userId);
      expect(arm(rows, "harness")[0]?.value).toBe("claude");
      expect(arm(rows, "repository")[0]?.value).toBe("acme/two-project");
      expect(arm(rows, "model")[0]?.value).toBe("opus");

      // The project arm is the one place fanning out is correct.
      const byProject = new Map(
        arm(rows, "project").map((row) => [row.value, row])
      );
      expect(byProject.get(projectA)?.sessionCount).toBe(1);
      expect(byProject.get(projectB)?.sessionCount).toBe(1);
      // And the unlinked session keeps its real NULL bucket, which
      // `UsageSqlFacetCount.value` documents as a genuine value.
      expect(byProject.get(null)?.sessionCount).toBe(1);
    });
  });

  it("does not double ANY of the six sums for a two-project session", async () => {
    // The fan-out hit `count(*)` and all six `sum()`s. Asserting cost alone
    // left the five token/error sums able to double with this green (whitlockk on
    // #6897).
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const { id: userId } = await createTestUser(organizationId);
      const projectA = await createTestProject(organizationId, userId, {
        name: "Sum A",
      });
      const projectB = await createTestProject(organizationId, userId, {
        name: "Sum B",
      });

      const sessionArtifactId = await createTestSessionDetail({
        organizationId,
        userId,
        label: "sums",
        cost: { estimatedCost: 12.5 },
      });
      // Distinct values per column, so a sum that read the wrong column is a
      // failure rather than a coincidence.
      await stampSession(sessionArtifactId, {
        inputTokens: 11,
        outputTokens: 22,
        cacheReadTokens: 33,
        cacheWriteTokens: 44,
        errorCount: 5,
      });
      for (const [projectId, label] of [
        [projectA, "a"],
        [projectB, "b"],
      ] as const) {
        await linkSessionToProject({
          organizationId,
          sessionArtifactId,
          projectId,
          label,
        });
      }

      const rows = await readFacetCounts(
        wholeOrg(organizationId),
        EMPTY_USAGE_SQL_FACETS
      );
      const owner = arm(rows, "owner")[0];

      expect(owner?.sessionCount).toBe(1);
      expect(owner?.estimatedCost).toBeCloseTo(12.5, 6);
      expect(owner?.inputTokens).toBe(11);
      expect(owner?.outputTokens).toBe(22);
      expect(owner?.cacheReadTokens).toBe(33);
      expect(owner?.cacheWriteTokens).toBe(44);
      expect(owner?.errorCount).toBe(5);
    });
  });

  it("excludes another organisation's sessions from BOTH statements", async () => {
    // Every other case seeds one organisation, so deleting the `organization_id`
    // predicate from either statement leaves them all green in a clean
    // integration database. These statements aggregate usage and cost, so that
    // is tenant isolation going unguarded (davetho on #6897).
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const { id: userId } = await createTestUser(organizationId);
      const foreignOrgId = await createTestOrganization();
      const { id: foreignUserId } = await createTestUser(foreignOrgId);

      const mineBranch = await createTestBranchArtifact(organizationId, "mine");
      const mine = await linkValidSessionToBranch({
        organizationId,
        userId,
        branchArtifactId: mineBranch,
        label: "mine",
        linkKind: SessionArtifactLinkKind.SessionPr,
        cost: { estimatedCost: 7 },
      });
      await stampSession(mine, { inputTokens: 100 });

      // A session that QUALIFIES on every dimension except the organisation:
      // same shape, same window, and delivery-linked so it would land in the
      // coverage numerator too.
      const foreignBranch = await createTestBranchArtifact(
        foreignOrgId,
        "foreign"
      );
      const foreignSession = await linkValidSessionToBranch({
        organizationId: foreignOrgId,
        userId: foreignUserId,
        branchArtifactId: foreignBranch,
        label: "foreign",
        linkKind: SessionArtifactLinkKind.SessionPr,
        // Through the helper's own cost parameter rather than a second raw
        // update -- that helper exists to keep cost seeding in one place.
        cost: { estimatedCost: 1000 },
      });
      await stampSession(foreignSession, { inputTokens: 999 });

      const rows = await readFacetCounts(
        wholeOrg(organizationId),
        EMPTY_USAGE_SQL_FACETS
      );
      // THE GUARD IS THE ROW COUNT, not the sums. The owner arm groups by the
      // assignee (ISS-12251), and the foreign session is assigned to a different
      // user, so
      // dropping the organisation predicate adds a SECOND ROW rather than
      // inflating this one. (An earlier revision of this comment said the
      // opposite. It was wrong, and it mattered: a maintainer trusting it could
      // delete the length assertion as redundant and leave the case unable to
      // fail.)
      const owner = arm(rows, "owner");
      expect(owner).toHaveLength(1);
      // Selected by user rather than by position: the arm is a GROUP BY with no
      // ORDER BY, so under the mutation `owner[0]` could be either row and the
      // value assertions below would be plan-dependent.
      const mineRow = owner.find((row) => row.value === userId);
      expect(mineRow).toBeDefined();
      expect(mineRow?.sessionCount).toBe(1);
      expect(mineRow?.estimatedCost).toBeCloseTo(7, 6);
      expect(mineRow?.inputTokens).toBe(100);

      // And the coverage statement, which has its own organisation predicate.
      // `mine` carries a delivery link too, so this asserts "the right one
      // present, the wrong one absent" rather than a bare zero over an empty
      // population -- dropping the predicate reads 2, not 1.
      const counts = await readLocCoverageCounts(
        wholeOrg(organizationId),
        EMPTY_USAGE_SQL_FACETS
      );
      expect(counts.numeratorSessionCount).toBe(1);
    });
  });

  it("narrows on a SELECTED facet, and relaxes that facet's own arm", async () => {
    // Every other case sends the empty facet set, so the 18-slot tuple is never
    // exercised with a real selection and a renumbering that pointed a dimension
    // at the wrong parameter would stay green (whitlockk on #6897). The selected
    // value is a repository name, which matches no harness and no model, so a
    // slot swap reads as zero rather than as the expected narrowing.
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const { id: userId } = await createTestUser(organizationId);

      const kept = await createTestSessionDetail({
        organizationId,
        userId,
        label: "kept",
      });
      await stampSession(kept, {
        harness: "claude",
        repositoryFullName: "acme/kept",
        model: "opus",
      });
      const dropped = await createTestSessionDetail({
        organizationId,
        userId,
        label: "dropped",
      });
      await stampSession(dropped, {
        harness: "codex",
        repositoryFullName: "acme/dropped",
        model: "sonnet",
      });

      const facets: UsageSqlFacets = {
        ...EMPTY_USAGE_SQL_FACETS,
        repositories: ["acme/kept"],
      };
      const rows = await readFacetCounts(wholeOrg(organizationId), facets);

      // Arms OTHER than the selected one see only the selection.
      expect(arm(rows, "owner")[0]?.sessionCount).toBe(1);
      expect(arm(rows, "harness")).toHaveLength(1);
      expect(arm(rows, "harness")[0]?.value).toBe("claude");
      expect(arm(rows, "model")).toHaveLength(1);
      expect(arm(rows, "model")[0]?.value).toBe("opus");

      // CROSS-FILTERING: the repository arm relaxes its OWN selection, so both
      // repositories still carry a count. Filtering it by its own selection
      // would zero every unselected value and make the facet useless for
      // widening a search, which is what the statement's header forbids.
      const repositories = new Map(
        arm(rows, "repository").map((row) => [row.value, row.sessionCount])
      );
      expect(repositories.get("acme/kept")).toBe(1);
      expect(repositories.get("acme/dropped")).toBe(1);
    });
  });

  it("narrows on `qualityMode` in both directions (ISS-10150)", async () => {
    // `quality` graduated off the D13 cohort onto this statement's own $18
    // predicate. Exercised both ways, like every other facet in this file: a
    // substantive session (real token usage) and an idle one (the fixture
    // default — no turns, no tokens, no tool use, no component invocation),
    // so a `substantive`/`idle` swap or a dropped `NOT` reads as the wrong
    // count rather than staying green.
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const { id: userId } = await createTestUser(organizationId);

      const worked = await createTestSessionDetail({
        organizationId,
        userId,
        label: "worked",
      });
      await stampSession(worked, { inputTokens: 5 });
      await createTestSessionDetail({
        organizationId,
        userId,
        label: "idle",
      });

      const substantive = await readFacetCounts(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        qualityMode: "substantive",
      });
      expect(arm(substantive, "owner")[0]?.sessionCount).toBe(1);

      const idle = await readFacetCounts(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        qualityMode: "idle",
      });
      expect(arm(idle, "owner")[0]?.sessionCount).toBe(1);

      const all = await readFacetCounts(
        wholeOrg(organizationId),
        EMPTY_USAGE_SQL_FACETS
      );
      expect(arm(all, "owner")[0]?.sessionCount).toBe(2);
    });
  });

  it("narrows on `statuses` in both directions (ISS-10629 / ISS-10753)", async () => {
    // `statuses` graduated off the D13 cohort onto a plain equality on
    // `artifacts.status` — the same collapse #7603 shipped on the live path.
    // Exercised both ways: a selection that must keep a row, and one that must
    // exclude it, so a dropped `= ANY(...)` or an inverted comparison reads as
    // the wrong count rather than staying green.
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const { id: userId } = await createTestUser(organizationId);

      await createTestSessionDetail({
        organizationId,
        userId,
        label: "active",
        status: SESSION_STATUS.ACTIVE,
      });
      await createTestSessionDetail({
        organizationId,
        userId,
        label: "inactive",
        status: SESSION_STATUS.INACTIVE,
      });

      const activeOnly = await readFacetCounts(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        statuses: [SESSION_STATUS.ACTIVE],
      });
      expect(arm(activeOnly, "owner")[0]?.sessionCount).toBe(1);

      const inactiveOnly = await readFacetCounts(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        statuses: [SESSION_STATUS.INACTIVE],
      });
      expect(arm(inactiveOnly, "owner")[0]?.sessionCount).toBe(1);

      const both = await readFacetCounts(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        statuses: [SESSION_STATUS.ACTIVE, SESSION_STATUS.INACTIVE],
      });
      expect(arm(both, "owner")[0]?.sessionCount).toBe(2);

      // A selection of ONLY display-only statuses resolves to `[]`, and `[]`
      // must match nothing. It is the one array facet here where empty is not
      // "no filter": `artifacts.status` is freeform, so a stale bookmarked
      // `?status=waiting` reaching this statement as "no narrowing" would answer
      // with the whole org while the served endpoint answers with nothing.
      const allRetired = await readFacetCounts(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        statuses: [],
      });
      expect(arm(allRetired, "owner")).toEqual([]);

      const all = await readFacetCounts(
        wholeOrg(organizationId),
        EMPTY_USAGE_SQL_FACETS
      );
      expect(arm(all, "owner")[0]?.sessionCount).toBe(2);
    });
  });

  it("narrows on `priorities`, including the unset arm (ISS-10332 / ISS-10753)", async () => {
    // ISS-10332 landed this facet on the D13 artifact-id cohort while ISS-10753
    // was deleting that cohort, so it is a predicate here now. The unset arm is
    // the half one `= ANY(...)` cannot carry: a NULL priority matches no value
    // list, so folding the unset token into the members selects nothing for it.
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const { id: userId } = await createTestUser(organizationId);

      const highArtifactId = await createTestSessionDetail({
        organizationId,
        userId,
        label: "high-priority",
      });
      await createTestSessionDetail({
        organizationId,
        userId,
        label: "no-priority",
      });
      await withDb((db) =>
        db.artifact.update({
          where: { id: highArtifactId },
          data: { priority: Priority.High },
        })
      );

      const members = await readFacetCounts(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        priorityMembers: [Priority.High],
      });
      expect(arm(members, "owner")[0]?.sessionCount).toBe(1);

      const unsetOnly = await readFacetCounts(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        priorityIncludesUnset: true,
      });
      expect(arm(unsetOnly, "owner")[0]?.sessionCount).toBe(1);

      // The two arms partition the population, so selecting both recovers it —
      // an unset arm that also matched the HIGH row would read as 1 here, and a
      // members arm that swallowed the unset token would too.
      const both = await readFacetCounts(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        priorityMembers: [Priority.High],
        priorityIncludesUnset: true,
      });
      expect(arm(both, "owner")[0]?.sessionCount).toBe(2);

      const noSelection = await readFacetCounts(
        wholeOrg(organizationId),
        EMPTY_USAGE_SQL_FACETS
      );
      expect(arm(noSelection, "owner")[0]?.sessionCount).toBe(2);
    });
  });

  it("narrows on the OPEN-ENDED cost bucket, whose ceiling reaches SQL as NULL", async () => {
    // `costBucketRawBounds(from_50).lt` is null and `resolveCostBucketBounds`
    // spells that `Number.POSITIVE_INFINITY`, which does not survive
    // serialisation into a `float8[]` — it arrives as SQL NULL. Without
    // facet-common's `bucket.hi IS NULL` arm, `estimated_cost < NULL` is NULL
    // rather than TRUE and selecting "$50+" returns zero sessions on every
    // statement (tamsinb on #7684). The sibling case below drives only buckets
    // with a finite ceiling, so nothing there sees this.
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const { id: userId } = await createTestUser(organizationId);

      await createTestSessionDetail({
        organizationId,
        userId,
        label: "over-50",
        cost: { billingMode: "api", estimatedCost: 5000 },
      });
      await createTestSessionDetail({
        organizationId,
        userId,
        label: "under-1",
        cost: { billingMode: "api", estimatedCost: 0.5 },
      });

      const openEnded = await readFacetCounts(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        costBucketLowerBounds: [50.005],
        costBucketUpperBounds: [Number.POSITIVE_INFINITY],
      });
      // The floor still has to bite, or "unbounded above" would be
      // indistinguishable from "no predicate at all".
      expect(arm(openEnded, "owner")[0]?.sessionCount).toBe(1);
      expect(arm(openEnded, "owner")[0]?.estimatedCost).toBe(5000);
    });
  });

  it("narrows on `costBuckets` — a numeric bucket, and the Unknown pseudo-bucket (ISS-7176 / ISS-10753)", async () => {
    // `costBuckets` graduated off the D13 cohort onto a real predicate: the
    // numeric buckets arrive as parallel bound arrays (mirroring the
    // autonomy-tier facet), and "Unknown" is a separate boolean rather than a
    // range. Exercised in both directions plus the disjoint Unknown case, so a
    // dropped bound, a swapped `gte`/`lt`, or a KNOWN/UNKNOWN partition that
    // stops summing to the whole population reads as the wrong count.
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const { id: userId } = await createTestUser(organizationId);

      // Priced, non-subscription: KNOWN, and inside "under_1" ([0, 1] displayed).
      await createTestSessionDetail({
        organizationId,
        userId,
        label: "under-1",
        cost: { billingMode: "api", estimatedCost: 0.5 },
      });
      // Priced, non-subscription: KNOWN, and inside "from_1_to_10".
      await createTestSessionDetail({
        organizationId,
        userId,
        label: "1-to-10",
        cost: { billingMode: "api", estimatedCost: 5 },
      });
      // No billing mode, zero cost: UNKNOWN (never a genuine $0.00 bucket).
      await createTestSessionDetail({
        organizationId,
        userId,
        label: "unknown",
        cost: { estimatedCost: 0 },
      });

      const under1 = await readFacetCounts(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        costBucketLowerBounds: [-0.005],
        costBucketUpperBounds: [1.005],
      });
      expect(arm(under1, "owner")[0]?.sessionCount).toBe(1);

      const oneToTen = await readFacetCounts(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        costBucketLowerBounds: [1.005],
        costBucketUpperBounds: [10.005],
      });
      expect(arm(oneToTen, "owner")[0]?.sessionCount).toBe(1);

      const unknownOnly = await readFacetCounts(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        costBucketIncludesUnknown: true,
      });
      expect(arm(unknownOnly, "owner")[0]?.sessionCount).toBe(1);

      // Both numeric buckets PLUS Unknown must sum to the whole population —
      // the KNOWN/UNKNOWN partition test every other facet in this file gets.
      const everything = await readFacetCounts(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        costBucketLowerBounds: [-0.005, 1.005],
        costBucketUpperBounds: [1.005, 10.005],
        costBucketIncludesUnknown: true,
      });
      expect(arm(everything, "owner")[0]?.sessionCount).toBe(3);

      const noSelection = await readFacetCounts(
        wholeOrg(organizationId),
        EMPTY_USAGE_SQL_FACETS
      );
      expect(arm(noSelection, "owner")[0]?.sessionCount).toBe(3);
    });
  });

  it("classifies subscription and metered spend into the RIGHT bucket ($21/$22)", async () => {
    // readCostSplit had no real-database coverage at all before this case: every
    // existing assertion on it is a unit test against a mocked `queryRawTyped`,
    // which pins the CALLER's tuple, not the STATEMENT's own use of it. A
    // transposition of sessionCostSplit.sql's $21 (subscriptionBillingModes) and
    // $22 (meteredBillingModes) — both `text[]`, so nothing type-level catches
    // it — would report subscription spend as metered and vice versa with every
    // other check green (marisolashgrove on #7246). Two distinct, asymmetric costs
    // make a swap read as the WRONG number rather than merely the wrong bucket
    // being non-empty.
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const { id: userId } = await createTestUser(organizationId);

      // "pro" is in SUBSCRIPTION_BILLING_MODES; "api" is in
      // METERED_BILLING_MODES (packages/api/src/types/billing-mode.ts).
      await createTestSessionDetail({
        organizationId,
        userId,
        label: "subscription",
        cost: { billingMode: "pro", estimatedCost: 3 },
      });
      await createTestSessionDetail({
        organizationId,
        userId,
        label: "metered",
        cost: { billingMode: "api", estimatedCost: 5 },
      });

      // ISS-10753: `subscriptionBillingModes` moved out of `readCostSplit`'s own
      // resolution and onto the shared facet tuple — the composer's `toFacets`
      // resolves it once, shared with the cost-bucket known/unknown predicate.
      // A caller driving the reader directly now supplies it, same as any other
      // facet.
      const split = await readCostSplit(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        subscriptionBillingModes: [...SUBSCRIPTION_BILLING_MODES],
      });
      expect(split.subscriptionCost).toBeCloseTo(3, 6);
      expect(split.meteredCost).toBeCloseTo(5, 6);
    });
  });

  it("keeps a former loop session in its stored ledger, ahead of billing_mode (ISS-12435)", async () => {
    // The Prisma path (`usage-cost-split.ts`) classifies by the stored
    // `legacy_loop_cost_ledger` first; this statement must agree, or the shadow
    // comparison and the cutover would split the same rows differently.
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const { id: userId } = await createTestUser(organizationId);

      const subscriptionLoop = await createTestSessionDetail({
        organizationId,
        userId,
        label: "former-loop-subscription",
        cost: { billingMode: "api", estimatedCost: 3 },
      });
      const unknownLoop = await createTestSessionDetail({
        organizationId,
        userId,
        label: "former-loop-unknown",
        cost: { billingMode: "pro", estimatedCost: 7 },
      });
      await createTestSessionDetail({
        organizationId,
        userId,
        label: "metered",
        cost: { billingMode: "api", estimatedCost: 5 },
      });
      await withDb(async (db) => {
        await db.sessionDetail.update({
          where: { artifactId: subscriptionLoop },
          data: { legacyLoopCostLedger: SessionCostLedger.Subscription },
          select: { artifactId: true },
        });
        await db.sessionDetail.update({
          where: { artifactId: unknownLoop },
          data: { legacyLoopCostLedger: SessionCostLedger.Unknown },
          select: { artifactId: true },
        });
      });

      const split = await readCostSplit(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        subscriptionBillingModes: [...SUBSCRIPTION_BILLING_MODES],
      });
      expect(split.subscriptionCost).toBeCloseTo(3, 6);
      expect(split.meteredCost).toBeCloseTo(5, 6);
      expect(split.unclassifiedCost).toBeCloseTo(7, 6);
    });
  });

  // N-6 (ISS-12435): the two shapes where `toSessionCostLedger` and the SQL
  // ledger arms could diverge. Each case reads the same rows through both
  // classifiers and asserts they agree.
  it("files a stored metered ledger on a subscription billing_mode as metered, in both classifiers", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const { id: userId } = await createTestUser(organizationId);
      // "pro" is in SUBSCRIPTION_BILLING_MODES.
      const formerLoop = await createTestSessionDetail({
        organizationId,
        userId,
        label: "former-loop-metered",
        cost: { billingMode: "pro", estimatedCost: 4 },
      });
      await withDb((db) =>
        db.sessionDetail.update({
          where: { artifactId: formerLoop },
          data: { legacyLoopCostLedger: SessionCostLedger.Metered },
          select: { artifactId: true },
        })
      );

      const sql = await readCostSplit(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        subscriptionBillingModes: [...SUBSCRIPTION_BILLING_MODES],
      });
      const prisma = await computeSessionCostSplit({
        artifact: { is: { organizationId } },
      });
      expect(sql.meteredCost).toBeCloseTo(4, 6);
      expect(sql.subscriptionCost).toBeNull();
      expect(sql.unclassifiedCost).toBeNull();
      expect(prisma.meteredEstimatedCost).toBeCloseTo(4, 6);
      expect(prisma.subscriptionEstimatedCost).toBeCloseTo(0, 6);
      expect(prisma.unknownEstimatedCost).toBeCloseTo(0, 6);
    });
  });

  it("files an out-of-vocabulary stored ledger as unknown, in both classifiers", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const { id: userId } = await createTestUser(organizationId);
      // "pro" is in SUBSCRIPTION_BILLING_MODES, so a fall-through to
      // billing_mode would read as subscription, not unknown.
      const formerLoop = await createTestSessionDetail({
        organizationId,
        userId,
        label: "former-loop-out-of-vocabulary",
        cost: { billingMode: "pro", estimatedCost: 6 },
      });
      // A stored row value this repo does not control, so a literal.
      await withDb((db) =>
        db.sessionDetail.update({
          where: { artifactId: formerLoop },
          data: { legacyLoopCostLedger: "SUBSCRIPTION" },
          select: { artifactId: true },
        })
      );

      const sql = await readCostSplit(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        subscriptionBillingModes: [...SUBSCRIPTION_BILLING_MODES],
      });
      const prisma = await computeSessionCostSplit({
        artifact: { is: { organizationId } },
      });
      expect(sql.unclassifiedCost).toBeCloseTo(6, 6);
      expect(sql.subscriptionCost).toBeNull();
      expect(sql.meteredCost).toBeNull();
      expect(prisma.unknownEstimatedCost).toBeCloseTo(6, 6);
      expect(prisma.subscriptionEstimatedCost).toBeCloseTo(0, 6);
      expect(prisma.meteredEstimatedCost).toBeCloseTo(0, 6);
    });
  });

  it("ignores a CROSS-ORG document link in the project facet (ISS-9903)", async () => {
    // The isolation case above guards the DRIVING-row predicate: it seeds a
    // foreign SESSION and asserts neither statement counts it. It does not
    // construct a cross-org LINK, so it says nothing about the second artifact
    // these statements reach THROUGH one.
    //
    // The project dimension walks session -> artifact_links -> artifacts(DOCUMENT)
    // to read `project_id`. Before ISS-9903 neither the link nor that document
    // carried an organisation predicate, so a RELATES_TO link pointing at
    // ANOTHER TENANT'S document pulled that tenant's project id into this org's
    // facet -- and, with `projectIds` selected, into its session counts.
    //
    // Reachable only if a cross-org link exists. `artifactLinksService.createLink`
    // refuses to write one, which is why this is defence in depth rather than a
    // live leak; the fixture writes it directly for exactly that reason.
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const { id: userId } = await createTestUser(organizationId);
      const foreignOrgId = await createTestOrganization();
      const { id: foreignUserId } = await createTestUser(foreignOrgId);

      const mineProject = await createTestProject(organizationId, userId, {
        name: "Mine",
      });
      const foreignProject = await createTestProject(
        foreignOrgId,
        foreignUserId,
        { name: "Theirs" }
      );
      // A project of OUR OWN that this session must not reach, because the only
      // thing linking it is a link ROW owned by the other organisation.
      const foreignLinkedProject = await createTestProject(
        organizationId,
        userId,
        { name: "Mine, linked by them" }
      );

      // Delivery-linked, so the coverage numerator can be NON-zero. Without it
      // every `readLocCoverageCounts` assertion below is a bare zero over an
      // empty population and proves nothing about the project predicate.
      const branchArtifactId = await createTestBranchArtifact(
        organizationId,
        "cross-org"
      );
      const session = await linkValidSessionToBranch({
        organizationId,
        userId,
        branchArtifactId,
        label: "cross-org",
        linkKind: SessionArtifactLinkKind.SessionPr,
      });
      await linkSessionToProject({
        organizationId,
        sessionArtifactId: session,
        projectId: mineProject,
        label: "mine",
      });

      // TWO cross-org links, because the fix has TWO predicates and each needs a
      // fixture that isolates it. Seeding only the first left the second
      // droppable with this case still green — the link predicate alone was
      // excluding the row, so the artifact predicate was never exercised.
      //
      //   1. link stamped org B  -> exercises `al/pl.organization_id`
      //   2. link stamped org A, target document in org B
      //                          -> exercises `doc/pd.organization_id`
      //
      // (2) is also the more realistic shape: a write path that stamps the link
      // from its SOURCE and never validates the target produces exactly it.
      await withDb(async (db) => {
        for (const linkOrganizationId of [foreignOrgId, organizationId]) {
          const foreignDoc = await db.artifact.create({
            data: {
              organizationId: foreignOrgId,
              type: ArtifactType.Document,
              name: `doc-foreign-${randomUUID().slice(0, 8)}`,
              status: "ACTIVE",
              projectId: foreignProject,
            },
            select: { id: true },
          });
          await db.artifactLink.create({
            data: {
              organizationId: linkOrganizationId,
              sourceId: session,
              targetId: foreignDoc.id,
              linkType: LinkType.RelatesTo,
            },
            select: { id: true },
          });
        }

        // THE LINK-SIDE SHAPE (whitlockk on #6967). A document that is OURS, so
        // `doc.organization_id` passes, reached by a link row owned by the
        // OTHER organisation. Only `al`/`pl`.organization_id rejects it, which
        // is what makes that predicate separately mutation-visible — I had
        // recorded it as having no isolating fixture, and that was wrong.
        //
        // Not a confidentiality leak (the project is this org's own) but an
        // integrity one: another tenant could otherwise put a project into this
        // org's facet by writing a link this org never created.
        const localDoc = await db.artifact.create({
          data: {
            organizationId,
            type: ArtifactType.Document,
            name: `doc-local-${randomUUID().slice(0, 8)}`,
            status: "ACTIVE",
            projectId: foreignLinkedProject,
          },
          select: { id: true },
        });
        await db.artifactLink.create({
          data: {
            organizationId: foreignOrgId,
            sourceId: session,
            targetId: localDoc.id,
            linkType: LinkType.RelatesTo,
          },
          select: { id: true },
        });
      });

      // The FLAG dialect: sessionFacetCounts' lateral aggregates project ids.
      const rows = await readFacetCounts(
        wholeOrg(organizationId),
        EMPTY_USAGE_SQL_FACETS
      );
      const projectValues = arm(rows, "project").map((row) => row.value);
      expect(projectValues).toContain(mineProject);
      expect(projectValues).not.toContain(foreignProject);
      // Ours, but reached only through another org's link row.
      expect(projectValues).not.toContain(foreignLinkedProject);

      // The CONJUNCT dialect: the spliced fragment's EXISTS. Selecting the
      // foreign project must match nothing -- before the fix this session
      // qualified through the other tenant's document.
      const viaForeignProject = await readFacetCounts(
        wholeOrg(organizationId),
        { ...EMPTY_USAGE_SQL_FACETS, projectIds: [foreignProject] }
      );
      expect(arm(viaForeignProject, "owner")).toHaveLength(0);

      // THE FRAGMENT'S OWN DIALECT. `readFacetCounts` above exercises the FLAG
      // form (`matches_project`); the EXISTS conjunct lives in
      // `facet-dimensions.sql`, which is spliced into the coverage statement and
      // three others but deliberately NOT into sessionFacetCounts. So this pair
      // is what actually guards the spliced copy.
      //
      // Asserted as a PAIR — the session's own project selects it, the foreign
      // one does not — so neither line can pass by the cohort being empty.
      const viaMine = await readLocCoverageCounts(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        projectIds: [mineProject],
      });
      expect(viaMine.numeratorSessionCount).toBe(1);

      const viaForeign = await readLocCoverageCounts(wholeOrg(organizationId), {
        ...EMPTY_USAGE_SQL_FACETS,
        projectIds: [foreignProject],
      });
      expect(viaForeign.numeratorSessionCount).toBe(0);

      // And the link-side shape through the spliced fragment: selecting a
      // project this session reaches ONLY via another org's link must not
      // select it.
      const viaForeignLink = await readLocCoverageCounts(
        wholeOrg(organizationId),
        { ...EMPTY_USAGE_SQL_FACETS, projectIds: [foreignLinkedProject] }
      );
      expect(viaForeignLink.numeratorSessionCount).toBe(0);
    });
  });
});
