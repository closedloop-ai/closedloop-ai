// FEA-4276: the Sessions LIST must filter, sort, count, and paginate on the
// RECONCILED captured cost — the same figure the row displays — not the stored
// `SessionDetail.estimatedCost` rollup that `buildCostBucketWhere` /
// `buildAgentSessionOrderBy` predicate on. When the per-event stream reprices a
// session (its rollup goes stale) a cost-bucket filter or a cost sort keyed off
// the rollup would drop the session from its true bucket or place it in the
// wrong page position. These tests drive `findSessions` through the
// cost-sensitive path and assert the reconciled value governs the result set.

import { SESSION_UNKNOWN_COST_BUCKET_ID } from "@repo/api/src/agent-session-filters";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FROM_50_BUCKET,
  getCapturedQueryRaw,
  installCostSessions,
  resetCapturedQueryRaw,
  UNDER_1_BUCKET,
  UPDATED,
} from "@/__tests__/support/agent-sessions/service/cost-query-reconciliation.test-harness";
import { agentSessionsService } from "../service";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

/** Read the composed SQL text out of a `Prisma.sql` fragment. */
function sqlText(fragment: unknown): string {
  const sql =
    (fragment as { sql?: string; strings?: string[] } | undefined) ?? {};
  if (typeof sql.sql === "string") {
    return sql.sql;
  }
  return (sql.strings ?? []).join(" ");
}

/** Read the bound parameter values out of a `Prisma.sql` fragment. */
function queryRawParams(fragment: unknown): unknown[] {
  return (fragment as { values?: unknown[] } | undefined)?.values ?? [];
}

describe("session cost query reconciliation (FEA-4276)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCapturedQueryRaw();
  });

  it("keeps a session in the bucket its RECONCILED cost belongs to, not its stale rollup", async () => {
    // The dossier case: rollup inflated to $1,378.39, per-event authority $33.24.
    // The rollup-keyed filter would EXCLUDE it from < $1 AND from $50+ wrongly;
    // the reconciled $33.24 belongs to neither bucket → excluded from < $1,
    // and a repriced-cheap session belongs to neither $50+ nor < $1 here, so we
    // assert the concrete inclusion: it is NOT in $50+ (rollup would include it).
    installCostSessions([
      {
        artifactId: "repriced",
        storedRollup: 1378.39,
        eventCostSum: 33.24,
        eventCount: 4,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const inFiftyPlus = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [FROM_50_BUCKET] },
    });

    // Rollup ($1,378.39) is in $50+; reconciled ($33.24) is NOT. The reconciled
    // value governs, so the session is excluded and the count reflects that.
    expect(inFiftyPlus.total).toBe(0);
    expect(inFiftyPlus.items).toHaveLength(0);
  });

  it("includes a repriced-cheap session in the < $1 bucket when its reconciled cost is < $1", async () => {
    installCostSessions([
      {
        artifactId: "now-cheap",
        storedRollup: 1378.39, // stale/inflated rollup — would be excluded from < $1
        eventCostSum: 0.42, // reconciled authority — belongs in < $1
        eventCount: 3,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const underOne = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [UNDER_1_BUCKET] },
    });

    expect(underOne.total).toBe(1);
    expect(underOne.items).toHaveLength(1);
    expect(underOne.items[0]?.cost).toBe("$0.42");
  });

  it("INCLUDES a session whose RECONCILED cost DISPLAYS $1.00 in the ≤ $1 bucket (FEA-4293, inclusive boundary)", async () => {
    // Mike's FEA-4293 decision: the first bucket is INCLUSIVE of $1 ("≤ $1"), so
    // a reconciled cost of 0.996 — which renders as "$1.00" in the cell — belongs
    // to the ≤ $1 bucket, and the displayed boundary equals the bucket boundary.
    installCostSessions([
      {
        artifactId: "rounds-to-one",
        storedRollup: 0.996,
        eventCostSum: 0.996,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const underOne = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [UNDER_1_BUCKET] },
    });

    expect(underOne.total).toBe(1);
    expect(underOne.items).toHaveLength(1);
    expect(underOne.items[0]?.cost).toBe("$1.00");

    // The same session is NOT in "$1 to $10": that bucket's lower bound is now
    // EXCLUSIVE of $1.00 (the $1.00 boundary belongs to ≤ $1), so no overlap.
    const oneToTen = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: ["from_1_to_10"] },
    });
    expect(oneToTen.total).toBe(0);
    expect(oneToTen.items).toHaveLength(0);
  });

  it("excludes an UNKNOWN-cost session (renders — ) from the < $1 bucket (FEA-4294)", async () => {
    // A session that burned tokens but has no pricing data: rollup 0, no priced
    // events, no subscription → cost is UNKNOWN and the cell shows "—". Its
    // placeholder 0 must NOT satisfy the numeric "< $1" bucket.
    installCostSessions([
      {
        artifactId: "unknown-cost",
        storedRollup: 0,
        eventCostSum: 0,
        eventCount: 0,
        billingMode: null,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const underOne = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [UNDER_1_BUCKET] },
    });

    expect(underOne.total).toBe(0);
    expect(underOne.items).toHaveLength(0);
  });

  it("keeps a $0 SUBSCRIPTION session (shows a $ figure) in the < $1 bucket (FEA-4294)", async () => {
    // A subscription session displays "$0.00", a KNOWN numeric cost, so it stays
    // in "< $1" — the null-exclusion targets only the "—" unknown case.
    installCostSessions([
      {
        artifactId: "sub-zero",
        storedRollup: 0,
        eventCostSum: 0,
        eventCount: 0,
        billingMode: "max_20x",
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const underOne = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [UNDER_1_BUCKET] },
    });

    expect(underOne.total).toBe(1);
    expect(underOne.items).toHaveLength(1);
    expect(underOne.items[0]?.id).toBe("sub-zero");
  });

  it("ISS-4481: the Unknown option returns EXACTLY the — (unknown-cost) rows, and only those", async () => {
    // Four cost states on one screen: an unknown-cost row (renders "—"), a priced
    // row, a $0 subscription row (renders "$0.00"), and a repriced row whose stored
    // rollup is 0 but whose per-event cost is > 0 (renders a "$" figure, so it is
    // KNOWN despite the 0 rollup). The Unknown filter must return the "—" row and
    // ONLY it — never the genuine $0.00 subscription, never the priced rows.
    installCostSessions([
      {
        artifactId: "unknown-cost",
        storedRollup: 0,
        eventCostSum: 0,
        eventCount: 0,
        billingMode: null,
        sessionUpdatedAt: UPDATED(4),
      },
      {
        artifactId: "priced",
        storedRollup: 12.34,
        eventCostSum: 12.34,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(3),
      },
      {
        artifactId: "sub-zero",
        storedRollup: 0,
        eventCostSum: 0,
        eventCount: 0,
        billingMode: "max_20x",
        sessionUpdatedAt: UPDATED(2),
      },
      {
        // Stored rollup 0 but reconciled per-event cost $0.42 → displays "$0.42",
        // a KNOWN cost. The Unknown filter must NOT capture it (that is the whole
        // reason Unknown routes through the reconciled value, not the raw rollup).
        artifactId: "reconciled-known",
        storedRollup: 0,
        eventCostSum: 0.42,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [SESSION_UNKNOWN_COST_BUCKET_ID] },
    });

    expect(result.total).toBe(1);
    expect(result.items.map((item) => item.id)).toEqual(["unknown-cost"]);
    // The one matched row is the unknown-cost row, whose Cost cell renders "—"
    // (the projection carries no numeric cost figure for it).
    expect(result.items[0]?.cost).toBeNull();
  });

  it("ISS-4481: Unknown does NOT overlap the numeric buckets — every session lands in exactly one", async () => {
    installCostSessions([
      {
        artifactId: "unknown-cost",
        storedRollup: 0,
        eventCostSum: 0,
        eventCount: 0,
        billingMode: null,
        sessionUpdatedAt: UPDATED(3),
      },
      {
        artifactId: "cheap",
        storedRollup: 0.5,
        eventCostSum: 0.5,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(2),
      },
      {
        artifactId: "pricey",
        storedRollup: 80,
        eventCostSum: 80,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const unknownOnly = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [SESSION_UNKNOWN_COST_BUCKET_ID] },
    });
    const underOneOnly = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [UNDER_1_BUCKET] },
    });

    // The unknown row is in Unknown and NOT in "≤ $1"; the cheap known row is in
    // "≤ $1" and NOT in Unknown — the two cohorts are disjoint.
    expect(unknownOnly.items.map((item) => item.id)).toEqual(["unknown-cost"]);
    expect(underOneOnly.items.map((item) => item.id)).toEqual(["cheap"]);
  });

  it("ISS-4481: Unknown composes OR-within the dimension with a numeric bucket", async () => {
    // Selecting Unknown + "$50+" returns BOTH the unknown-cost row and the $50+
    // row (union), not their intersection (which would be empty).
    installCostSessions([
      {
        artifactId: "unknown-cost",
        storedRollup: 0,
        eventCostSum: 0,
        eventCount: 0,
        billingMode: null,
        sessionUpdatedAt: UPDATED(2),
      },
      {
        artifactId: "pricey",
        storedRollup: 80,
        eventCostSum: 80,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {
        costBuckets: [SESSION_UNKNOWN_COST_BUCKET_ID, FROM_50_BUCKET],
      },
    });

    expect(result.total).toBe(2);
    expect(result.items.map((item) => item.id).sort()).toEqual([
      "pricey",
      "unknown-cost",
    ]);
  });

  it("ISS-4481: a NO-WORK $0 subscription session is Unknown (—), not in ≤ $1", async () => {
    // ISS-4418/ISS-4481 (codex P2 / stage threads): a subscription session that
    // never ran (no turns/tokens/tool-uses, $0) renders "—", not "$0.00" — so it
    // must NOT fall in the "≤ $1" numeric bucket, and it MUST be captured by the
    // Unknown facet. The old predicate wrongly called it numeric (hidden from
    // Unknown, filed under ≤ $1).
    installCostSessions([
      {
        artifactId: "sub-no-work",
        storedRollup: 0,
        eventCostSum: 0,
        eventCount: 0,
        billingMode: "max_20x",
        turns: 0, // never ran → renders "—"
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const underOne = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [UNDER_1_BUCKET] },
    });
    expect(underOne.total).toBe(0);
    expect(underOne.items).toHaveLength(0);

    const unknown = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [SESSION_UNKNOWN_COST_BUCKET_ID] },
    });
    expect(unknown.total).toBe(1);
    expect(unknown.items.map((item) => item.id)).toEqual(["sub-no-work"]);
  });

  it("ISS-4481 (shafty): an EXHAUSTIVE cost selection is a no-op — returns EVERY session, not the bounded/truncating path", async () => {
    // Selecting all five options (every numeric bucket AND Unknown) excludes no
    // row, so it must normalize to no cost filter and NOT route through the
    // bounded reconciled candidate scan (which would truncate older sessions).
    // A row of every cost state is returned in full: a priced row, a $50+ row, a
    // no-work-subscription Unknown row, and a non-subscription unknown row.
    installCostSessions([
      {
        artifactId: "priced",
        storedRollup: 3,
        eventCostSum: 3,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(4),
      },
      {
        artifactId: "pricey",
        storedRollup: 80,
        eventCostSum: 80,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(3),
      },
      {
        artifactId: "sub-no-work",
        storedRollup: 0,
        eventCostSum: 0,
        eventCount: 0,
        billingMode: "max_20x",
        turns: 0,
        sessionUpdatedAt: UPDATED(2),
      },
      {
        artifactId: "unknown-cost",
        storedRollup: 0,
        eventCostSum: 0,
        eventCount: 0,
        billingMode: null,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const exhaustive = [
      "under_1",
      "from_1_to_10",
      "from_10_to_50",
      FROM_50_BUCKET,
      SESSION_UNKNOWN_COST_BUCKET_ID,
    ];
    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: exhaustive },
    });

    expect(result.total).toBe(4);
    expect(result.items.map((item) => item.id).sort()).toEqual([
      "priced",
      "pricey",
      "sub-no-work",
      "unknown-cost",
    ]);
  });

  it("sorts by RECONCILED cost, not the stale rollup", async () => {
    // By rollup: A($100) > B($50) > C($1). By reconciled: C($90) > A($60) > B($5).
    installCostSessions([
      {
        artifactId: "A",
        storedRollup: 100,
        eventCostSum: 60,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(3),
      },
      {
        artifactId: "B",
        storedRollup: 50,
        eventCostSum: 5,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(2),
      },
      {
        artifactId: "C",
        storedRollup: 1,
        eventCostSum: 90,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const sorted = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "cost", sortDir: "desc" },
    });

    // Reconciled descending: C ($90), A ($60), B ($5) — NOT the rollup order.
    expect(sorted.items.map((item) => item.id)).toEqual(["C", "A", "B"]);
    expect(sorted.items.map((item) => item.cost)).toEqual([
      "$90.00",
      "$60.00",
      "$5.00",
    ]);
  });

  it("sorts blank (—) cost rows LAST, keeping a real subscription $0.00 ahead of them (shafty cost-blanks-last)", async () => {
    // `paid` shows $5.00; `sub0` is a subscription session that renders a real
    // $0.00; `blank` is a non-subscription 0-cost session with tokens that renders
    // `—`. ASC by cost: $0.00 (sub0) < $5.00 (paid) < — (blank, last). The blank
    // must NOT collide at numeric 0 with the subscription $0.00.
    installCostSessions([
      {
        artifactId: "paid",
        storedRollup: 5,
        eventCostSum: 5,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(3),
      },
      {
        artifactId: "sub0",
        storedRollup: 0,
        eventCostSum: 0,
        eventCount: 0, // no per-event stream → reconciled falls back to rollup (0)
        billingMode: "pro", // subscription → renders a real $0.00
        sessionUpdatedAt: UPDATED(2),
      },
      {
        artifactId: "blank",
        storedRollup: 0,
        eventCostSum: 0,
        eventCount: 0,
        // non-subscription, 0 cost, but has tokens → Unavailable → renders `—`.
        inputTokens: 100,
        outputTokens: 50,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const asc = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "cost", sortDir: "asc" },
    });
    // Order proves blanks-last: the non-subscription 0-cost `blank` row sorts
    // AFTER the subscription `sub0` even though both are numeric 0 — the sort key
    // nulls the blank while keeping sub0 a real 0.
    expect(asc.items.map((item) => item.id)).toEqual(["sub0", "paid", "blank"]);
    // The API emits `cost: null` for BOTH zero-cost rows (the "$0.00" vs "—"
    // distinction is the client cell's job via billingMode); `paid` carries a
    // formatted value.
    expect(asc.items.map((item) => item.cost)).toEqual([null, "$5.00", null]);
    // The subscription row keeps its billingMode so the cell can render $0.00.
    expect(asc.items[0]?.billingMode).toBe("pro");

    // DESC keeps the blank LAST too (nulls-last in both directions).
    const desc = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "cost", sortDir: "desc" },
    });
    expect(desc.items.map((item) => item.id)).toEqual([
      "paid",
      "sub0",
      "blank",
    ]);
  });

  it("paginates the RECONCILED cost sort so the page cut is on the value the UI shows", async () => {
    // Reconciled desc order: C(90) > A(60) > B(5). Page size 1, offset 1 → A.
    installCostSessions([
      {
        artifactId: "A",
        storedRollup: 100,
        eventCostSum: 60,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(3),
      },
      {
        artifactId: "B",
        storedRollup: 50,
        eventCostSum: 5,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(2),
      },
      {
        artifactId: "C",
        storedRollup: 1,
        eventCostSum: 90,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const page = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "cost", sortDir: "desc", limit: 1, offset: 1 },
    });

    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
    // Second row of the reconciled ordering is A ($60) — the rollup order would
    // have put B ($50 rollup) here.
    expect(page.items[0]?.id).toBe("A");
    expect(page.items[0]?.cost).toBe("$60.00");
  });

  it("keeps the rollup (not a partial sum) for a MIXED priced/unpriced stream", async () => {
    // FEA-4276 completeness (Thread 1): an omitted `estimatedCostUsd` persists as
    // 0, so a per-event SUM over an unpriced/mixed stream under-reports. Here 4
    // rows exist but only 1 is priced ($5) — the naive sum ($5) would drop the
    // session out of the $50+ bucket its rollup ($75) belongs to. The reconciled
    // value must fall back to the whole rollup, NOT the partial $5.
    installCostSessions([
      {
        artifactId: "mixed",
        storedRollup: 75,
        eventCostSum: 5, // partial sum over the 1 priced row
        eventCount: 4,
        pricedCount: 1, // 3 rows unpriced (persisted-as-0)
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const fiftyPlus = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [FROM_50_BUCKET] },
    });

    // Rollup ($75) governs because the stream was not fully priced — the session
    // stays in $50+ and shows $75, never the partial $5.
    expect(fiftyPlus.total).toBe(1);
    expect(fiftyPlus.items).toHaveLength(1);
    expect(fiftyPlus.items[0]?.cost).toBe("$75.00");
  });

  it("uses the per-event sum only when EVERY row is priced", async () => {
    // Same shape as above but fully priced (4/4): now the per-event authority
    // ($5.00) governs, moving the session OUT of the $50+ bucket its rollup would
    // have kept it in — proving the completeness gate is the only difference.
    installCostSessions([
      {
        artifactId: "fully-priced",
        storedRollup: 75,
        eventCostSum: 5,
        eventCount: 4,
        pricedCount: 4,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const fiftyPlus = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [FROM_50_BUCKET] },
    });

    expect(fiftyPlus.total).toBe(0);
    expect(fiftyPlus.items).toHaveLength(0);
  });

  it("scopes the reconciled-cost aggregate to the caller's organization", async () => {
    // FEA-4276 tenant isolation (Thread 2): `agent_session_token_events` has no
    // organization_id — isolation is JOIN-REACHED through SessionDetail → Artifact.
    // The reader must keep that org predicate IN its own query so a cross-org id
    // can never be reconciled even if passed in. Assert the raw SQL the reader
    // issues carries the org id and joins through session_detail + artifacts.
    installCostSessions([
      {
        artifactId: "scoped",
        storedRollup: 10,
        eventCostSum: 3,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    await agentSessionsService.findSessions({
      organizationId: "org-42",
      filters: { sortBy: "cost", sortDir: "desc" },
    });

    const rawCall = getCapturedQueryRaw()?.mock.calls.find((call) =>
      sqlText(call[0]).includes("agent_session_token_events")
    );
    expect(rawCall).toBeDefined();
    const sql = sqlText(rawCall?.[0]);
    expect(sql).toContain("session_detail");
    expect(sql).toContain("artifacts");
    expect(sql).toContain("organization_id");
    expect(sql).toContain("estimated_cost > 0");
    expect(sql).toContain("cost_completeness");
    // The org id is a bound parameter (Prisma.sql), not inlined text — assert it
    // rides the parameter list so isolation is actually applied at execution.
    expect(queryRawParams(rawCall?.[0])).toContain("org-42");
  });

  it("falls back to the rollup for a session with no per-event stream when bucketing", async () => {
    // No token events → reconciled cost IS the rollup, so a rollup-in-bucket
    // session stays in the bucket (parity with the pre-reconciliation behavior
    // for un-repriced sessions).
    installCostSessions([
      {
        artifactId: "no-events",
        storedRollup: 75,
        eventCostSum: 0,
        eventCount: 0,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const fiftyPlus = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [FROM_50_BUCKET] },
    });

    expect(fiftyPlus.total).toBe(1);
    expect(fiftyPlus.items[0]?.cost).toBe("$75.00");
  });

  it("keeps the rollup for an OVERFLOW-TRUNCATED stream whose per-event tokens are short of the rollup", async () => {
    // FEA-4276 completeness (shafty review): the per-event stream is chunked into
    // separate append-only sync requests, so a dropped/overflowed chunk leaves
    // fewer rows than the session actually has WITHOUT hitting the read cap. Row
    // count + full pricing alone can't detect that — a partial stream looks
    // complete. Here every held row is priced, but the per-event token counts
    // (400) fall short of the desktop rollup's authoritative total (1000), proving
    // the stream is incomplete. The reconciled cost must fall back to the whole
    // rollup ($75), NOT the partial per-event sum ($5).
    installCostSessions([
      {
        artifactId: "overflow-truncated",
        storedRollup: 75,
        eventCostSum: 5, // partial sum over the rows that survived ingest
        eventCount: 4,
        pricedCount: 4, // every HELD row is priced — the priced gate passes
        eventTokenSum: 400, // but the tokens are short of the rollup total…
        rollupTokenTotal: 1000, // …so a chunk was dropped → fall back to rollup
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const fiftyPlus = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [FROM_50_BUCKET] },
    });

    // The token cross-check catches the drop, so the rollup ($75) governs and the
    // session stays in $50+ instead of collapsing to the partial $5.
    expect(fiftyPlus.total).toBe(1);
    expect(fiftyPlus.items).toHaveLength(1);
    expect(fiftyPlus.items[0]?.cost).toBe("$75.00");
  });

  it("trusts the per-event sum when the token counts MATCH the rollup (a reprice, not a drop)", async () => {
    // The complement of the overflow case: token counts reconcile with the rollup
    // (a complete stream) and only the per-token PRICE was corrected — the exact
    // FEA-4276 reprice scenario. The token cross-check must NOT reject this; the
    // per-event authority ($5) governs and moves the session out of $50+.
    installCostSessions([
      {
        artifactId: "repriced-complete",
        storedRollup: 75,
        eventCostSum: 5,
        eventCount: 4,
        pricedCount: 4,
        eventTokenSum: 1000, // tokens match the rollup → stream is complete
        rollupTokenTotal: 1000,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const fiftyPlus = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [FROM_50_BUCKET] },
    });

    expect(fiftyPlus.total).toBe(0);
    expect(fiftyPlus.items).toHaveLength(0);
  });

  it("treats an UNKNOWN-only cost bucket as no filter (not an empty result)", async () => {
    // FEA-4276 (shafty review): the reconciled path must match the DB
    // `buildCostBucketWhere` skip-unknown contract. A stale/legacy bucket id
    // normalizes to zero canonical buckets, which is "no cost filter" — every
    // session is returned, NOT an empty page.
    installCostSessions([
      {
        artifactId: "s1",
        storedRollup: 3,
        eventCostSum: 3,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(2),
      },
      {
        artifactId: "s2",
        storedRollup: 80,
        eventCostSum: 80,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: ["legacy_value"] },
    });

    // Unknown-only → no cost filter → both sessions returned. It did NOT route
    // through the reconciled path as a match-nothing filter.
    expect(result.total).toBe(2);
    expect(result.items.map((item) => item.id).sort()).toEqual(["s1", "s2"]);
  });

  it("drops unknown ids from a MIXED cost-bucket array, keeping the canonical one", async () => {
    // A canonical id mixed with unknown/duplicate junk: only the canonical bucket
    // filters; the junk is dropped (not matched, not multiplied).
    installCostSessions([
      {
        artifactId: "cheap",
        storedRollup: 0.5,
        eventCostSum: 0.5,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(2),
      },
      {
        artifactId: "pricey",
        storedRollup: 80,
        eventCostSum: 80,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      // under_1 (canonical) + unknown + a duplicate under_1 → effectively under_1.
      filters: {
        costBuckets: [UNDER_1_BUCKET, "legacy_value", UNDER_1_BUCKET],
      },
    });

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("cheap");
  });

  it("counts idle rows on the RECONCILED value when a cost bucket hides idle sessions (idleCount)", async () => {
    // FEA-4276 (shafty review, thread G): the reconciled path must count the
    // idle-hidden rows on the SAME reconciled cost + bucket filter it applies to
    // the visible page, so the "reveal N idle" label matches the figure the rows
    // display. `quality: substantive` makes the service build an idleWhere and
    // count the hidden set through `findCostReconciledPage`'s idle branch.
    // The harness serves the same candidate population to both the main and idle
    // reads, so both are filtered by the reconciled cost bucket: two sessions
    // land in the < $1 bucket by their reconciled cost (their stale rollups would
    // not), so total AND idleCount are both 2 — proving the idle count is taken
    // on the reconciled value, not the rollup.
    installCostSessions([
      {
        artifactId: "reconciled-cheap-1",
        // Stale rollup would exclude it from < $1; reconciled $0.40 includes it.
        storedRollup: 42,
        eventCostSum: 0.4,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(2),
      },
      {
        artifactId: "reconciled-cheap-2",
        storedRollup: 88,
        eventCostSum: 0.6,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [UNDER_1_BUCKET], quality: "substantive" },
    });

    // Both sessions are in the < $1 bucket by reconciled cost, and the idle count
    // is taken on that same reconciled bucket — not the > $1 rollups.
    expect(result.total).toBe(2);
    expect(result.idleCount).toBe(2);
    expect(result.items.map((item) => item.cost).sort()).toEqual([
      "$0.40",
      "$0.60",
    ]);
  });

  it("resolves the reconciled cost ONCE on the cost-sensitive path (no redundant re-read)", async () => {
    // FEA-4276 (shafty review, thread E): the cost-sensitive page already
    // resolved the per-event authority to filter/order/paginate; the displayed
    // cost must project from THAT snapshot, not a second read. A second read
    // could observe a sync/reprice landing between them and show a cost outside
    // the selected bucket/order. Assert the reconciled reader (`$queryRaw`) runs
    // exactly once for the whole request.
    installCostSessions([
      {
        artifactId: "s1",
        storedRollup: 100,
        eventCostSum: 5,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(2),
      },
      {
        artifactId: "s2",
        storedRollup: 1,
        eventCostSum: 90,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { sortBy: "cost", sortDir: "desc" },
    });

    expect(getCapturedQueryRaw()?.mock.calls).toHaveLength(1);
  });

  it("reconciles cost on the by-ids list path (listByArtifactIds), not the stale rollup", async () => {
    // FEA-4276 (shafty review, thread G): the agent-component "Sessions" tab
    // reads sessions by artifact id through `listByArtifactIds`, which must
    // reconcile cost the same way the main list and the detail card do — a stale
    // rollup must not leak a divergent figure onto that surface.
    const sessionId = "0196f2df-5b7d-7e72-9e4c-8d8af9fba010";
    installCostSessions([
      {
        artifactId: sessionId,
        // The 41× dossier case: rollup inflated, per-event stream repriced cheap.
        storedRollup: 1378.39,
        eventCostSum: 33.24,
        eventCount: 4,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const items = await agentSessionsService.listByArtifactIds("org-1", [
      sessionId,
    ]);

    expect(items).toHaveLength(1);
    // The by-ids surface shows the reconciled per-event authority, not the
    // stale rollup — parity with the main list and the detail card.
    expect(items[0]?.cost).toBe("$33.24");
  });
});
