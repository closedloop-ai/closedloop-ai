/**
 * ISS-5283 — facet counts apply every OTHER active filter but exclude their own
 * dimension.
 *
 * Both directions are covered on purpose. The reported defect is the ZEROING
 * direction (a facet option still showing the unfiltered total next to an empty
 * table), but the obvious over-correction — applying every filter to every facet
 * — breaks the WIDENING direction, collapsing a facet to the single value
 * already selected. A test that only proved the first would happily pass on the
 * worse bug.
 */
import { SESSION_COST_BUCKETS } from "@repo/api/src/agent-session-filters";
import type { Prisma } from "@repo/database";
import { describe, expect, test } from "vitest";
import { buildSessionFacetCountWheres } from "./facet-count-where";
import type { SessionUsageInput } from "./records";
import { buildUsageSummaryWhere } from "./usage-summary-where";

/**
 * The FULLY filtered predicate `getUsageSummary` computes and hands to
 * `buildSessionFacetCountWheres` — the same value production passes, so an
 * unfiltered dimension's "reuse the caller's where" path is exercised against
 * the real predicate rather than a stub that would hide a missing filter.
 */
async function fullWhere(input: SessionUsageInput) {
  return await buildUsageSummaryWhere(input);
}

const ORG_ID = "org_1";
const OWNER_ID = "user_owner";
const OTHER_USER_ID = "user_other";
const HARNESS = "codex";
/** ISS-5355: a project id for the Project facet cases. */
const PROJECT_A = "019f8008-1969-74f9-b056-99c13cca9a07";
/** A canonical numeric bucket — what makes a query cost-reconciliation-sensitive. */
const COST_BUCKET = SESSION_COST_BUCKETS[0].id;

function usageInput(
  filters: Partial<SessionUsageInput["filters"]> = {}
): SessionUsageInput {
  return {
    organizationId: ORG_ID,
    userId: undefined,
    filters: filters as SessionUsageInput["filters"],
  } as SessionUsageInput;
}

/** The harness predicate `applySessionFacetFilters` writes, if any. */
function harnessPredicate(where: Record<string, unknown>) {
  return where.harness;
}
function modelPredicate(where: Record<string, unknown>) {
  return where.model;
}
/** ISS-12251: the Owner facet (assignee) and the scoped `userId` (Created by). */
function artifactPredicates(where: Record<string, unknown>) {
  const artifact = where.artifact as
    | { is?: { assigneeId?: unknown; createdById?: unknown } }
    | undefined;
  return artifact?.is ?? {};
}
function ownerPredicate(where: Record<string, unknown>) {
  return artifactPredicates(where).assigneeId;
}
function creatorPredicate(where: Record<string, unknown>) {
  return artifactPredicates(where).createdById;
}
function repositoryPredicate(where: Record<string, unknown>) {
  return where.repositoryFullName;
}

describe("ISS-5283 — zeroing direction (the reported defect)", () => {
  test("an Owner filter constrains the HARNESS facet's counts", async () => {
    // The report: filter by an Owner with no Claude sessions and Harness→Claude
    // still reads the unfiltered total. The harness facet must carry the owner
    // predicate so that count collapses to the real intersection (0).
    const input = usageInput({ userIds: [OWNER_ID] });
    const base = await fullWhere(input);
    const wheres = await buildSessionFacetCountWheres(input, base);

    expect(ownerPredicate(wheres.harness as Record<string, unknown>)).toEqual({
      in: [OWNER_ID],
    });
    // …and the harness facet does NOT constrain itself.
    expect(
      harnessPredicate(wheres.harness as Record<string, unknown>)
    ).toBeUndefined();
  });

  test("a Harness filter constrains the MODEL and OWNER facets' counts", async () => {
    const input = usageInput({ harnesses: ["claude"] });
    const base = await fullWhere(input);
    const wheres = await buildSessionFacetCountWheres(input, base);

    expect(
      modelPredicate(wheres.model as Record<string, unknown>)
    ).toBeUndefined();
    // Every OTHER facet still respects the active harness selection.
    expect(harnessPredicate(wheres.model as Record<string, unknown>)).toEqual({
      in: ["claude"],
    });
    expect(harnessPredicate(wheres.owner as Record<string, unknown>)).toEqual({
      in: ["claude"],
    });
    expect(
      harnessPredicate(wheres.repository as Record<string, unknown>)
    ).toEqual({ in: ["claude"] });
  });
});

describe("ISS-5283 — widening direction (the worse bug, must not be introduced)", () => {
  test("a facet never constrains itself, so its other options stay reachable", async () => {
    // With Harness=claude selected, the harness facet's own `where` must carry
    // NO harness predicate — otherwise every other harness counts 0 and the
    // single-select facet becomes a one-way door the user cannot leave.
    const input = usageInput({ harnesses: ["claude"] });
    const base = await fullWhere(input);
    const wheres = await buildSessionFacetCountWheres(input, base);
    expect(
      harnessPredicate(wheres.harness as Record<string, unknown>)
    ).toBeUndefined();
  });

  test("the legacy single-value `harness` field is excluded too", async () => {
    // A version-skewed client serializes `harness` rather than `harnesses`;
    // clearing only the plural form would leave the collapse bug in place for
    // those clients while the test suite looked green.
    const input = usageInput({ harness: "codex" });
    const base = await fullWhere(input);
    const wheres = await buildSessionFacetCountWheres(input, base);
    expect(
      harnessPredicate(wheres.harness as Record<string, unknown>)
    ).toBeUndefined();
    expect(harnessPredicate(wheres.model as Record<string, unknown>)).toBe(
      "codex"
    );
  });

  test("each of the four dimensions excludes only itself", async () => {
    const input = usageInput({
      userIds: [OWNER_ID],
      harnesses: ["claude"],
      models: ["sonnet"],
      repositories: ["acme/app"],
    });
    const base = await fullWhere(input);
    const wheres = await buildSessionFacetCountWheres(input, base);

    const own = {
      owner: ownerPredicate(wheres.owner as Record<string, unknown>),
      harness: harnessPredicate(wheres.harness as Record<string, unknown>),
      model: modelPredicate(wheres.model as Record<string, unknown>),
      repository: repositoryPredicate(
        wheres.repository as Record<string, unknown>
      ),
    };
    expect(own).toEqual({
      owner: undefined,
      harness: undefined,
      model: undefined,
      repository: undefined,
    });

    // …while every facet keeps the three filters that are not its own.
    expect(harnessPredicate(wheres.owner as Record<string, unknown>)).toEqual({
      in: ["claude"],
    });
    expect(modelPredicate(wheres.owner as Record<string, unknown>)).toEqual({
      in: ["sonnet"],
    });
    expect(
      repositoryPredicate(wheres.owner as Record<string, unknown>)
    ).toEqual({ in: ["acme/app"] });
  });
});

describe("ISS-5283 — the security scope is NOT relaxed", () => {
  test("the Owner facet's own where keeps a scoped userId (FEA-4304)", async () => {
    // `userIds` is the facet the user operates; `userId` is the pinned scope.
    // Dropping the latter here would reintroduce the cross-user leak FEA-4304
    // closed — the Owner facet must never be able to widen out of its scope.
    // The pinned scope lives on `filters.userId` (what `applyArtifactPersonFilters` reads),
    // NOT on the scope object — that distinction is the whole point of the
    // guard, so the fixture has to reproduce it exactly.
    const input = usageInput({
      userId: OTHER_USER_ID,
      userIds: [OWNER_ID],
    });
    // ISS-12251 (operator ruling 2026-10-13): both match the assignee, so the
    // Owner facet's relaxed where drops `in` and keeps the pinned `equals`.
    const base = await fullWhere(input);
    const wheres = await buildSessionFacetCountWheres(input, base);
    expect(ownerPredicate(wheres.harness as Record<string, unknown>)).toEqual({
      in: [OWNER_ID],
      equals: OTHER_USER_ID,
    });
    const ownerWhere = wheres.owner as Record<string, unknown>;
    expect(ownerPredicate(ownerWhere)).toEqual({ equals: OTHER_USER_ID });
    expect(creatorPredicate(ownerWhere)).toBeUndefined();
  });
});

describe("ISS-5283 — an unfiltered read is unchanged and costs nothing extra", () => {
  test("every dimension reuses the caller's where by reference", async () => {
    const input = usageInput({});
    const base = await fullWhere(input);
    const wheres = await buildSessionFacetCountWheres(input, base);
    // Reference equality is the assertion that matters: it proves no second
    // `buildUsageSummaryWhere` ran, so the common path issues no extra query
    // (and, under a cost-bucket filter, no extra candidate scan).
    expect(wheres.owner).toBe(base);
    expect(wheres.harness).toBe(base);
    expect(wheres.model).toBe(base);
    expect(wheres.repository).toBe(base);
  });
});

describe("ISS-5283 / ISS-7176 — a cost filter cannot desync a facet from its parent", () => {
  test("every facet carries the SAME estimated_cost predicate, and no id set", async () => {
    // WHAT THIS REPLACED. Three cases used to live here proving the relaxed
    // facet scan's id set was UNIONED with the totals' set, because both scans
    // stopped at a 10,000-candidate cap ordered by recency and truncated
    // DIFFERENT tails — so a facet could advertise fewer sessions for the current
    // selection than the cards already showed for it.
    //
    // There is no scan and no id set now: a cost bucket is a predicate on
    // `estimated_cost`, so the relaxed `where` and the totals' `where` narrow
    // cost identically by construction and there is no tail to truncate. The
    // absence is what this asserts — an `artifactId IN (…)` reappearing here
    // means a bounded candidate scan came back.
    const input = usageInput({
      harnesses: [HARNESS],
      costBuckets: [COST_BUCKET],
    });

    const wheres = await buildSessionFacetCountWheres(
      input,
      await buildUsageSummaryWhere(input)
    );

    const serialized = JSON.stringify(wheres.harness);
    expect(serialized).toContain("estimatedCost");
    expect(serialized).not.toContain('"artifactId"');
  });
});

/**
 * ISS-5355 — the Project facet joins the ISS-5283 contract. Its predicate is the
 * session artifact's link to a DOCUMENT in the project
 * (`artifact.is.sourceLinks.some.target.is.projectId`), not a SessionDetail
 * column, so it needs its own reader rather than the flat ones above.
 */
function projectPredicate(where: Prisma.SessionDetailWhereInput) {
  const artifact = where.artifact as
    | {
        is?: {
          sourceLinks?: {
            some?: { target?: { is?: { projectId?: unknown } } };
          };
        };
      }
    | undefined;
  return artifact?.is?.sourceLinks?.some?.target?.is?.projectId;
}

/** The singular `projectId` scope, which is a different dimension. */
function projectScopePredicate(where: Prisma.SessionDetailWhereInput) {
  const artifact = where.artifact as
    | { is?: { projectId?: unknown } }
    | undefined;
  return artifact?.is?.projectId;
}

describe("ISS-5355 — the Project facet obeys the ISS-5283 rule", () => {
  test("a Project selection does not constrain the PROJECT facet's own counts", async () => {
    // Otherwise selecting one project collapses the facet to that project and
    // there is no row left to widen to — single-select becomes a one-way door.
    const input = usageInput({ projectIds: [PROJECT_A] });
    const base = await fullWhere(input);

    const wheres = await buildSessionFacetCountWheres(input, base);

    expect(projectPredicate(wheres.project)).toBeUndefined();
  });

  test("a Project selection still constrains every OTHER facet's counts", async () => {
    const input = usageInput({ projectIds: [PROJECT_A] });
    const base = await fullWhere(input);

    const wheres = await buildSessionFacetCountWheres(input, base);

    for (const where of [wheres.owner, wheres.harness, wheres.repository]) {
      expect(projectPredicate(where)).toEqual({ in: [PROJECT_A] });
    }
  });

  test("an Owner selection constrains the PROJECT facet's counts", async () => {
    const input = usageInput({ userIds: [OWNER_ID], projectIds: [PROJECT_A] });
    const base = await fullWhere(input);

    const wheres = await buildSessionFacetCountWheres(input, base);

    expect(ownerPredicate(wheres.project as Record<string, unknown>)).toEqual({
      in: [OWNER_ID],
    });
  });

  test("the singular projectId scope survives the Project facet's exclusion", async () => {
    // `projectId` is a caller-supplied scope on a DIFFERENT dimension (the
    // session artifact's own parent project), not the facet's own selection.
    // Relaxing it would let the facet count sessions from outside the scope the
    // caller asked for — the same reason Owner's `userId` survives.
    const input = usageInput({
      projectId: PROJECT_A,
      projectIds: [PROJECT_A],
    });
    const base = await fullWhere(input);

    const wheres = await buildSessionFacetCountWheres(input, base);

    expect(projectScopePredicate(wheres.project)).toBe(PROJECT_A);
    expect(projectPredicate(wheres.project)).toBeUndefined();
  });

  test("an unfiltered Project dimension issues no extra query", async () => {
    const input = usageInput({ harnesses: [HARNESS] });
    const base = await fullWhere(input);

    const wheres = await buildSessionFacetCountWheres(input, base);

    expect(wheres.project).toBe(base);
  });
});
