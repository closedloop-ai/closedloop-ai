import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InsightsSection } from "@closedloop-ai/loops-api/insights";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
} from "@repo/api/src/types/session-artifact-link";
import {
  BASELINE_MIGRATIONS,
  LEGACY_SCHEMA_REASSERT_SEQUENCE,
} from "../src/main/database/baseline-schema.js";
import { computeLocalInsights } from "../src/main/database/local-insights.js";
import { openMigrationDatabase } from "../src/main/database/migration-executor.js";
import { runDesktopMigrations } from "../src/main/database/migration-runner.js";
import { MIGRATIONS } from "../src/main/database/migrations-manifest.js";
import {
  createDesktopPrisma,
  type WriteSerializer,
} from "../src/main/database/prisma-client.js";
// FEA-3132: the heatmap/autonomy reads now GROUP BY the materialized
// session_turn_bucket; these tests seed sessions directly, so they must populate
// the buckets the same way production ingest does (rebuildSessionTurnBuckets in
// the rollup tx) before computing.
import { rebuildSessionTurnBuckets } from "../src/main/database/write-core.js";
import { PrState } from "../src/main/enrichment/types.js";

/**
 * Contract test for the Insights backend (`local-insights.ts`) on the single
 * `DesktopPrisma` client. The sqlite-conversion golden suite already pins exact
 * byte-for-byte section output against a seeded DB (run in CI, where the runtime +
 * electron load); this test is the ELECTRON-FREE companion that builds the Prisma
 * client straight from the migration runner (no `sqlite.ts`/electron import) so
 * it is verifiable in the dev sandbox too. It focuses on:
 *
 * - the TYPED `agent.groupBy` / `session.groupBy` reads (agentsByStatus /
 *   agentsByType / sessionsByStatus) produce the same keys / counts / desc order
 *   as the old `GROUP BY … ORDER BY n DESC` SQL, with a nullable `type` mapped to
 *   'unknown';
 * - aggregate INTEGER columns the Prisma raw path can surface as `bigint` come
 *   back as JS numbers through the `num()` / `token()` coercion boundary.
 */

// computeLocalInsights only reads, so the write queue is never exercised — a
// pass-through satisfies the factory without importing sqlite.ts (electron).
const passthroughQueue: WriteSerializer = { run: (fn) => fn() };

// FEA-2430: the insights SQL buckets display days/hours in the process-local
// timezone (strftime 'localtime'), and eachDay() generates local axis keys —
// pin a fixed NON-UTC zone so the conversion is actively exercised (not an
// identity) and deterministic across machines/CI. America/Chicago is a real
// negative offset with DST. Runs at module evaluation, before any test opens
// a DB or reads a Date (same pattern as sqlite-conversion-golden's TZ=UTC).
process.env.TZ = "America/Chicago";

const NOW = new Date("2026-06-22T00:00:00.000Z"); // = June 21 19:00 CDT
const IN_WINDOW = "2026-06-20T10:00:00.000Z"; // = June 20 05:00 CDT (same local day)
// Cross-midnight instant: June 21 03:00 UTC = June 20 22:00 CDT — UTC and
// local calendar days DISAGREE, so any bucket that regresses to UTC misplaces it.
const CROSS_MIDNIGHT = "2026-06-21T03:00:00.000Z";

test("FEA-2430 TZ canary: process is pinned to America/Chicago", () => {
  // getTimezoneOffset is minutes behind UTC: CDT (June) = 300, CST = 360. A
  // loud failure here means the module-eval pin did not take and every
  // localtime assertion in this file would silently test the wrong zone.
  assert.equal(new Date("2026-06-20T10:00:00.000Z").getTimezoneOffset(), 300);
  assert.equal(new Date("2026-01-15T10:00:00.000Z").getTimezoneOffset(), 360);
});

test("FEA-1791: local insights run on the single Prisma client against real libSQL", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-insights-contract-"));
  const { db, config } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = await createDesktopPrisma(config, passthroughQueue);
  try {
    // Three in-window sessions: status completed×2, running×1.
    for (const [id, status] of [
      ["s1", "completed"],
      ["s2", "completed"],
      ["s3", "running"],
    ]) {
      await db.query(
        "INSERT INTO sessions (id, status, started_at, ended_at) VALUES ($1, $2, $3, $4)",
        [id, status, IN_WINDOW, "2026-06-20T11:00:00.000Z"]
      );
      await db.query(
        `INSERT INTO session_analytics (session_id, started_at, is_human, est_cost)
         VALUES ($1, $2, $3, $4)`,
        [id, IN_WINDOW, id === "s1" ? 1 : 0, 2.5]
      );
    }
    // Agents: status completed×2, running×1; type general×2, NULL×1.
    for (const [id, sessionId, status, type] of [
      ["a1", "s1", "completed", "general"],
      ["a2", "s1", "running", "general"],
      ["a3", "s2", "completed", null],
    ]) {
      await db.query(
        "INSERT INTO agents (id, session_id, status, type) VALUES ($1, $2, $3, $4)",
        [id, sessionId, status, type]
      );
    }
    // One tool event (Agents tool-runs KPI + Utilization eventsByType).
    await db.query(
      `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      ["e1", "s1", "PreToolUse", "Bash", IN_WINDOW]
    );
    // Token usage (Agents tokens KPI / model breakdown) — BigInt columns plus
    // a REAL cost_usd_estimated that the FEA-2331 spend breakdown reads.
    await db.query(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cost_usd_estimated)
       VALUES ($1, $2, 300, 100, 4.2)`,
      ["s1", "claude-sonnet-4-5"]
    );

    // --- Agents section: typed agent.groupBy reads ------------------------
    const agents = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      "90",
      NOW
    );
    const agentsByStatus = agents.charts.agentsByStatus;
    assert.deepEqual(
      agentsByStatus.map((b) => [b.key, b.value]),
      // completed (2) before running (1) — the SQL's ORDER BY n DESC.
      [
        ["completed", 2],
        ["running", 1],
      ]
    );
    assert.equal(typeof agentsByStatus[0]?.value, "number");
    assert.deepEqual(
      agents.charts.agentsByType.map((b) => [b.key, b.value]),
      // type general (2) before the NULL group mapped to 'unknown' (1).
      [
        ["general", 2],
        ["unknown", 1],
      ]
    );
    // Token KPIs come back as numbers (bigint-coerced), models distinct = 1.
    const tokensKpi = agents.kpis.find((k) => k.key === "tokens");
    assert.equal(tokensKpi?.value, 400);
    assert.equal(typeof tokensKpi?.value, "number");
    assert.equal(agents.kpis.find((k) => k.key === "models")?.value, 1);
    assert.equal(agents.kpis.find((k) => k.key === "tool-runs")?.value, 1);
    // FEA-2331: the model breakdown ranks models by estimated SPEND (USD) from
    // cost_usd_estimated — NOT input+output tokens — as a float, not a token int.
    assert.deepEqual(
      agents.charts.modelBreakdown.map((b) => [b.key, b.value]),
      [["claude-sonnet-4-5", 4.2]]
    );
    // The over-time series carries the same spend metric (one in-window day).
    const spendDay = agents.charts.modelUsageOverTime.points.find(
      (point) => point.values["claude-sonnet-4-5"] !== undefined
    );
    assert.equal(spendDay?.values["claude-sonnet-4-5"], 4.2);

    // --- Utilization section: typed session.groupBy read ------------------
    const utilization = await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      "90",
      NOW
    );
    assert.deepEqual(
      utilization.charts.sessionsByStatus.map((b) => [b.key, b.value]),
      [
        ["completed", 2],
        ["running", 1],
      ]
    );
    const sessionsKpi = utilization.kpis.find((k) => k.key === "sessions");
    assert.equal(sessionsKpi?.value, 3);
    assert.equal(typeof sessionsKpi?.value, "number");
    assert.equal(utilization.kpis.find((k) => k.key === "events")?.value, 1);

    // --- Delivery section: raw reads still run + coerce -------------------
    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    // No PR artifacts seeded → captured 0, but the section must compute, and
    // the cost KPI sums token_usage.cost_usd_estimated ⋈ sessions (FEA-2346).
    // Only session s1 has a token_usage row (4.2), so total cost = 4.2.
    assert.equal(delivery.kpis.find((k) => k.key === "merged")?.value, 0);
    const costKpi = delivery.kpis.find((k) => k.key === "cost");
    assert.equal(costKpi?.value, 4.2);
    assert.equal(typeof costKpi?.value, "number");
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2868: Delivery Median PR size excludes un-enriched PRs (KLOC still sums them as 0)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-insights-prsize-"));
  const { db, config } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = await createDesktopPrisma(config, passthroughQueue);
  try {
    // Two ENRICHED PRs (300 and 100 LOC) and one UN-ENRICHED PR (NULL line
    // counts — size not yet fetched). FEA-2868: the un-enriched PR has UNKNOWN
    // size and is excluded from the median, so it is over [100, 300] = 200.
    // (FEA-2159 previously folded it in as 0, giving median([0, 100, 300]) = 100,
    // which dragged the dashboard KPI toward 0 versus the Branches page.) KLOC —
    // a sum — is unchanged either way because the un-enriched PR adds 0
    // (400 LOC → 0.4).
    for (const [id, key, prNumber, added, removed] of [
      ["pr-enriched-a", "pr:org/repo:1", 1, 300, 0],
      ["pr-enriched-b", "pr:org/repo:2", 2, 100, 0],
      ["pr-unenriched", "pr:org/repo:3", 3, null, null],
    ] as const) {
      await db.query(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, pr_number,
            lines_added, lines_removed, files_changed, created_at, last_seen_at)
         VALUES ($1, $2, 'pull_request', 'org/repo', $3, $4, $5, $6, $7, $7)`,
        [
          id,
          key,
          prNumber,
          added,
          removed,
          added === null ? null : 5,
          IN_WINDOW,
        ]
      );
    }

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    const prSize = delivery.kpis.find((k) => k.key === "pr-size");
    // median([100, 300]) = 200 — the un-enriched PR (unknown size) is excluded.
    assert.equal(prSize?.value, 200);
    assert.equal(typeof prSize?.value, "number");
    // KLOC (a sum) is unaffected by the 0-LOC un-enriched PR: 400 LOC → 0.4 KLOC.
    assert.equal(delivery.kpis.find((k) => k.key === "kloc")?.value, 0.4);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2923: Delivery Median PR size is `—` (non-finite), not 0, when no window PR is enriched", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "local-insights-prsize-empty-")
  );
  const { db, config } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = await createDesktopPrisma(config, passthroughQueue);
  try {
    // A single UN-enriched PR (NULL line counts) in-window: nothing to median.
    // Previously this medianed to `?? 0`, surfacing a misleading 0; now the KPI
    // carries a non-finite sentinel so the dashboard renders `—`.
    await db.query(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number,
          lines_added, lines_removed, files_changed, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', 'org/repo', $3, NULL, NULL, NULL, $4, $4)`,
      ["pr-unenriched-only", "pr:org/repo:9", 9, IN_WINDOW]
    );

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    const prSize = delivery.kpis.find((k) => k.key === "pr-size");
    // No enriched PR ⇒ null value ⇒ the dashboard renders `—`, not 0.
    assert.equal(prSize?.value, null);
    // ...and no delta (no baseline to compare an unknown current value against).
    assert.equal(prSize?.deltaPct, null);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2868 (thread 3): `enriched` uses AND — a PR with only ONE line count set is un-enriched", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "local-insights-prsize-and-")
  );
  const { db, config } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = await createDesktopPrisma(config, passthroughQueue);
  try {
    // Enrichment is AND semantics (matching isLocEnrichedRow): a row is enriched
    // ONLY when BOTH lines_added AND lines_removed are non-NULL. A "half-enriched"
    // row (one count present, one NULL) is UNKNOWN size and must be EXCLUDED from
    // the median. Under the old OR predicate the half-enriched PR would have been
    // treated as a real 0-LOC PR (COALESCE → 200 + 0 = 200 here) and folded into
    // the median, wrongly dragging it.
    //
    //   pr-both:  added=400 removed=0   → enriched, loc=400
    //   pr-half:  added=200 removed=NULL → un-enriched (AND), EXCLUDED
    //   pr-none:  added=NULL removed=NULL → un-enriched, EXCLUDED
    for (const [id, key, prNumber, added, removed] of [
      ["pr-both", "pr:and/repo:1", 1, 400, 0],
      ["pr-half", "pr:and/repo:2", 2, 200, null],
      ["pr-none", "pr:and/repo:3", 3, null, null],
    ] as const) {
      await db.query(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, pr_number,
            lines_added, lines_removed, files_changed, created_at, last_seen_at)
         VALUES ($1, $2, 'pull_request', 'and/repo', $3, $4, $5, $6, $7, $7)`,
        [
          id,
          key,
          prNumber,
          added,
          removed,
          added === null && removed === null ? null : 5,
          IN_WINDOW,
        ]
      );
    }

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    const prSize = delivery.kpis.find((k) => k.key === "pr-size");
    // Only pr-both is enriched → median([400]) = 400. If OR were still in effect,
    // pr-half would count as a real 0-LOC... 200-LOC PR and change the median.
    assert.equal(prSize?.value, 400);
    // KLOC sums the COALESCE'd LOC over ALL PRs regardless of enrichment:
    // 400 (both) + 200 (half) + 0 (none) = 600 LOC → 0.6 KLOC.
    assert.equal(delivery.kpis.find((k) => k.key === "kloc")?.value, 0.6);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2868 (thread 1): empty prior enriched population → PR-size delta suppressed (no bogus +100%)", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "local-insights-prsize-delta-")
  );
  const { db, config } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = await createDesktopPrisma(config, passthroughQueue);
  try {
    // Sentinel record older than priorStartIso so hasFullPriorPeriod is TRUE —
    // the delta gate that thread 1 warns about. Without the null-prior guard the
    // PR-size delta would then be computed off a fabricated 0 prior median.
    const SENTINEL_DATE = "2025-12-01T00:00:00.000Z";
    await db.query(
      `INSERT INTO session_analytics (session_id, started_at, is_human, est_cost)
       VALUES ($1, $2, 0, 0)`,
      ["sentinel", SENTINEL_DATE]
    );

    // Current window: one ENRICHED PR (200 LOC) → current median = 200.
    await db.query(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number,
          lines_added, lines_removed, files_changed, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', 'org/repo', 1, 200, 0, 5, $3, $3)`,
      ["cur-enriched", "pr:delta/repo:1", IN_WINDOW]
    );

    // Prior window (2026-01-15 lands in prior): ONLY an UN-ENRICHED PR, so the
    // prior enriched population is EMPTY → prior median is null → delta suppressed.
    const PRIOR_WINDOW = "2026-01-15T10:00:00.000Z";
    await db.query(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number,
          lines_added, lines_removed, files_changed, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', 'org/repo', 2, NULL, NULL, NULL, $3, $3)`,
      ["prior-unenriched", "pr:delta/repo:2", PRIOR_WINDOW]
    );

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    const prSize = delivery.kpis.find((k) => k.key === "pr-size");
    // Current median is a real value...
    assert.equal(prSize?.value, 200);
    // ...but the delta MUST be null: the prior window has no enriched PRs, so
    // there is no baseline. A 0 prior median would have produced +100% here.
    assert.equal(prSize?.deltaPct, null);

    // The KLOC delta has a full prior period but a 0 prior sum basis. Under the
    // FEA-2895 reconciled pctDelta contract, a 0 prior yields null (no baseline
    // to form a percentage against) rather than a bogus +100% — matching the
    // cloud dashboard so web and desktop report the same delta.
    // priorKloc = 0, currentKloc = 0.2 → pctDelta(0.2, 0) = null.
    const kloc = delivery.kpis.find((k) => k.key === "kloc");
    assert.equal(kloc?.deltaPct, null);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2868 (thread 1): non-empty prior enriched population → PR-size delta computed", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "local-insights-prsize-delta2-")
  );
  const { db, config } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = await createDesktopPrisma(config, passthroughQueue);
  try {
    const SENTINEL_DATE = "2025-12-01T00:00:00.000Z";
    await db.query(
      `INSERT INTO session_analytics (session_id, started_at, is_human, est_cost)
       VALUES ($1, $2, 0, 0)`,
      ["sentinel", SENTINEL_DATE]
    );
    // Current: enriched median = 200.
    await db.query(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number,
          lines_added, lines_removed, files_changed, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', 'org/repo', 1, 200, 0, 5, $3, $3)`,
      ["cur", "pr:delta2/repo:1", IN_WINDOW]
    );
    // Prior: one ENRICHED PR (100 LOC) → prior median = 100, delta reported.
    const PRIOR_WINDOW = "2026-01-15T10:00:00.000Z";
    await db.query(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number,
          lines_added, lines_removed, files_changed, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', 'org/repo', 2, 100, 0, 5, $3, $3)`,
      ["prior", "pr:delta2/repo:2", PRIOR_WINDOW]
    );

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    const prSize = delivery.kpis.find((k) => k.key === "pr-size");
    assert.equal(prSize?.value, 200);
    // pctDelta(200, 100) = ((200 - 100) / 100) * 100 = 100.
    assert.equal(prSize?.deltaPct, 100);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("activity heatmap buckets parsed turns by their own role — session flag and events corpus are ignored", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-insights-turns-"));
  const { db, config } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = await createDesktopPrisma(config, passthroughQueue);
  try {
    // FEA-2641 Fix 4 (PM ruling): a HUMAN-steered session (is_human = 1) whose
    // transcript records 1 genuine human prompt and 2 assistant turns. The
    // split must come from the per-turn roles in metadata $.messages — NOT
    // from the session flag or the events corpus. Seed 5 contradictory
    // main-agent events at the same instant: the old event-density query
    // would have painted all 5 Human (is_human = 1, main agent) and scored
    // autonomy 0; per-turn attribution must report 1 Human / 2 Agent and
    // autonomy 200/3 regardless.
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, metadata) VALUES ($1, $2, $3, $4, $5)",
      [
        "h1",
        "completed",
        IN_WINDOW,
        "2026-06-20T11:00:00.000Z",
        JSON.stringify({
          messages: [
            { role: "human", timestamp: IN_WINDOW, text: "Build it." },
            { role: "assistant", timestamp: IN_WINDOW, text: "On it." },
            { role: "assistant", timestamp: IN_WINDOW, text: "Done." },
          ],
        }),
      ]
    );
    await db.query(
      `INSERT INTO session_analytics (session_id, started_at, is_human)
       VALUES ($1, $2, 1)`,
      ["h1", IN_WINDOW]
    );
    await db.query(
      "INSERT INTO agents (id, session_id, type, parent_agent_id) VALUES ($1, $2, $3, $4)",
      ["h1-main", "h1", "general", null]
    );
    for (let i = 0; i < 5; i++) {
      await db.query(
        `INSERT INTO events (id, session_id, agent_id, event_type, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [`ev-${i}`, "h1", "h1-main", "PostToolUse", IN_WINDOW]
      );
    }
    // A headless-SDK session (entrypoint "sdk-cli" — cron-scheduled review,
    // fleet agent, scripted `claude -p`) on a DIFFERENT local day. Its
    // role:"human" kickoff was injected programmatically, so BOTH of its
    // turns must attribute to Agent and its day must score 100% agentic.
    const CRON_DAY = "2026-06-19T12:00:00.000Z"; // June 19 07:00 CDT
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, metadata) VALUES ($1, $2, $3, $4, $5)",
      [
        "cron1",
        "completed",
        CRON_DAY,
        "2026-06-19T12:10:00.000Z",
        JSON.stringify({
          entrypoint: "sdk-cli",
          messages: [
            { role: "human", timestamp: CRON_DAY, text: "Review PR #42." },
            {
              role: "assistant",
              timestamp: "2026-06-19T12:05:00.000Z",
              text: "Reviewed.",
            },
          ],
        }),
      ]
    );

    // A scripted Codex session — since DATA_REVISION 13 the parser stores
    // session_meta.originator as the entrypoint, so exec-style launches
    // ("codex_exec", "claude-codex-exec") must classify headless exactly like
    // Claude's "sdk-cli" (the LIKE '%exec%' arm of the predicate).
    const CODEX_DAY = "2026-06-18T12:00:00.000Z"; // June 18 07:00 CDT
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, metadata) VALUES ($1, $2, $3, $4, $5)",
      [
        "codex1",
        "completed",
        CODEX_DAY,
        "2026-06-18T12:10:00.000Z",
        JSON.stringify({
          entrypoint: "claude-codex-exec",
          messages: [
            { role: "human", timestamp: CODEX_DAY, text: "Review PR #7." },
            {
              role: "assistant",
              timestamp: "2026-06-18T12:04:00.000Z",
              text: "Reviewed.",
            },
          ],
        }),
      ]
    );
    // FEA-3132: materialize the turn buckets the heatmap/autonomy now read.
    await prisma.write((client) =>
      client.$transaction((tx) =>
        rebuildSessionTurnBuckets(tx, ["h1", "cron1", "codex1"])
      )
    );

    const utilization = await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      "90",
      NOW
    );
    const cells = utilization.charts.activityHeatmap.cells;
    const humanTotal = cells.reduce((sum, cell) => sum + cell.human, 0);
    const agentTotal = cells.reduce((sum, cell) => sum + cell.agent, 0);
    // Interactive session: 1 human + 2 assistant turns — not the 5 Human the
    // old event-density split would have produced from the seeded events.
    // Headless sessions (sdk-cli + claude-codex-exec): 0 human + 2 agent each.
    assert.equal(humanTotal, 1);
    assert.equal(agentTotal, 6);
    for (const [day, label] of [
      ["2026-06-19", "sdk-cli"],
      ["2026-06-18", "codex exec"],
    ] as const) {
      const headlessCells = cells.filter((cell) => cell.day === day);
      assert.equal(
        headlessCells.reduce((sum, cell) => sum + cell.human, 0),
        0,
        `${label} kickoff must not paint a Human cell`
      );
      assert.equal(
        headlessCells.reduce((sum, cell) => sum + cell.agent, 0),
        2
      );
    }

    // The autonomy trend (Agents section) shares the SAME turn source, so the
    // same fixture must report the same attribution: 2 of 3 turns are the
    // agent's → 200/3 ≈ 66.7% (the old event split would score 0). Asserting
    // it here keeps the heatmap and autonomy SQL provably in lockstep.
    const agentsSection = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      "90",
      NOW
    );
    const autonomyPoint = agentsSection.charts.autonomyTrend.points.find(
      (point) => point.date === "2026-06-20"
    );
    assert.ok(autonomyPoint, "expected an autonomy point for the seeded day");
    assert.ok(
      Math.abs(autonomyPoint.values.autonomy - 200 / 3) < 1e-6,
      `expected ~66.7% agent-driven autonomy, got ${autonomyPoint.values.autonomy}`
    );
    // Headless sessions' days are fully agentic: their human-role kickoffs
    // count toward the agent share, not the human share.
    for (const day of ["2026-06-19", "2026-06-18"]) {
      assert.equal(
        agentsSection.charts.autonomyTrend.points.find(
          (point) => point.date === day
        )?.values.autonomy,
        100,
        `expected 100% agentic autonomy on ${day}`
      );
    }
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2346: Delivery Cost KPI reads token_usage, not session_analytics.est_cost (stale rollup + missing row)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-insights-cost-src-"));
  const { db, config } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = await createDesktopPrisma(config, passthroughQueue);
  try {
    // Session A: stale rollup — est_cost deliberately disagrees with
    // SUM(token_usage.cost_usd_estimated). If the KPI reads est_cost it will
    // report 100; the correct (token_usage-derived) answer is 18.03.
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at) VALUES ($1, $2, $3, $4)",
      ["stale", "completed", IN_WINDOW, "2026-06-20T11:00:00.000Z"]
    );
    await db.query(
      `INSERT INTO session_analytics (session_id, started_at, is_human, est_cost)
       VALUES ($1, $2, 0, 100)`,
      ["stale", IN_WINDOW]
    );
    await db.query(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cost_usd_estimated)
       VALUES ($1, $2, 500, 200, 18.03)`,
      ["stale", "claude-opus-4-5"]
    );

    // Session B: token_usage exists but NO session_analytics row at all.
    // If the KPI reads session_analytics this session's cost is invisible.
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at) VALUES ($1, $2, $3, $4)",
      ["no-analytics", "completed", IN_WINDOW, "2026-06-20T12:00:00.000Z"]
    );
    await db.query(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cost_usd_estimated)
       VALUES ($1, $2, 100, 50, 3.50)`,
      ["no-analytics", "claude-sonnet-4-5"]
    );

    // Session C: in the PRIOR window (before the 90-day current window) —
    // verifies the prior-window query also reads token_usage, not est_cost.
    // NOW is 2026-06-22, 90-day window starts ~2026-03-24, prior window is
    // [~2025-12-24, ~2026-03-24). Use 2026-01-15 to land firmly in prior.
    const PRIOR_WINDOW = "2026-01-15T10:00:00.000Z";
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at) VALUES ($1, $2, $3, $4)",
      ["prior", "completed", PRIOR_WINDOW, "2026-01-15T11:00:00.000Z"]
    );
    await db.query(
      `INSERT INTO session_analytics (session_id, started_at, is_human, est_cost)
       VALUES ($1, $2, 0, 999)`,
      ["prior", PRIOR_WINDOW]
    );
    await db.query(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cost_usd_estimated)
       VALUES ($1, $2, 200, 100, 7.00)`,
      ["prior", "claude-opus-4-5"]
    );

    // Sentinel session: older than priorStartIso (~2025-12-24) so the
    // hasFullPriorPeriod gate is true and reportDelta produces a real deltaPct.
    // No token_usage → contributes $0 to both windows.
    const SENTINEL_DATE = "2025-12-01T00:00:00.000Z";
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at) VALUES ($1, $2, $3, $4)",
      ["sentinel", "completed", SENTINEL_DATE, SENTINEL_DATE]
    );
    await db.query(
      `INSERT INTO session_analytics (session_id, started_at, is_human, est_cost)
       VALUES ($1, $2, 0, 0)`,
      ["sentinel", SENTINEL_DATE]
    );

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );

    // Current-window cost: 18.03 (stale) + 3.50 (no-analytics) = 21.53.
    // If it read session_analytics.est_cost it would be 100 (only the stale
    // session has an analytics row; no-analytics session would be invisible).
    const costKpi = delivery.kpis.find((k) => k.key === "cost");
    assert.equal(costKpi?.value, 21.53);
    assert.equal(typeof costKpi?.value, "number");

    // Prior-window cost from token_usage: 7.00 (session "prior").
    // If the prior-window query read session_analytics.est_cost it would be
    // 999 and deltaPct would be ~ -98 instead of +208.
    // FEA-2895: pctDelta rounds to a whole percent —
    // Math.round(((21.53 - 7.00) / 7.00) * 100) = 208.
    assert.equal(costKpi?.deltaPct, 208);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2430: cross-midnight activity buckets to the LOCAL day/hour across all storage owners", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-insights-tz-"));
  const { db, config } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = await createDesktopPrisma(config, passthroughQueue);
  try {
    // One seed per STORAGE OWNER at the same cross-midnight instant (June 21
    // 03:00 UTC = June 20 22:00 CDT), so every day-bucketed chart family is
    // proven local, not just the event-backed ones:
    //   1. sessions.started_at        → perDay, toolsOverTime, modelUsageOverTime
    //   2. events.created_at          → eventsPerDay
    //   2b. metadata $.messages ts    → heatmap (day+hour), autonomy (FEA-2641
    //       Fix 4: turn-based; one assistant turn at the same instant)
    //   3. artifacts COALESCE         → prTrend, klocTrend
    // (4. token_events.created_at is covered in dashboard-queries-contract.)
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at, metadata) VALUES ($1, $2, $3, $4, $5)",
      [
        "night",
        "completed",
        CROSS_MIDNIGHT,
        "2026-06-21T04:00:00.000Z",
        JSON.stringify({
          messages: [{ role: "assistant", timestamp: CROSS_MIDNIGHT }],
        }),
      ]
    );
    await db.query(
      `INSERT INTO session_analytics (session_id, started_at, is_human)
       VALUES ($1, $2, 0)`,
      ["night", CROSS_MIDNIGHT]
    );
    await db.query(
      `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      ["night-ev", "night", "PostToolUse", "Bash", CROSS_MIDNIGHT]
    );
    await db.query(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cost_usd_estimated)
       VALUES ($1, $2, 100, 50, 1.5)`,
      ["night", "claude-sonnet-4-5"]
    );
    await db.query(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number,
          lines_added, lines_removed, files_changed, observed_at, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', 'org/repo', 9, 400, 100, 5, $3, $3, $3)`,
      ["night-pr", "pr:org/repo:9", CROSS_MIDNIGHT]
    );
    // FEA-3132: materialize the turn buckets the heatmap/autonomy now read.
    await prisma.write((client) =>
      client.$transaction((tx) => rebuildSessionTurnBuckets(tx, ["night"]))
    );

    const utilization = await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      "90",
      NOW
    );
    // Owner 2b (metadata $.messages timestamp): heatmap cell lands on the
    // LOCAL day at the LOCAL hour (22:00 CDT), not UTC day June 21 hour 03.
    const cell = utilization.charts.activityHeatmap.cells.find(
      (c) => c.day === "2026-06-20" && c.hour === 22
    );
    assert.ok(cell, "expected heatmap cell at 2026-06-20 hour 22 (local)");
    assert.equal(cell.agent, 1);
    assert.equal(
      utilization.charts.activityHeatmap.cells.some(
        (c) => c.day === "2026-06-21" && c.hour === 3
      ),
      false,
      "no cell may appear at the UTC day/hour"
    );
    // Axis lockstep: the SQL's local day key must exist in eachDay()'s axis,
    // and the axis must end on the LOCAL day of NOW (June 21 CDT, not June 22).
    const days = utilization.charts.activityHeatmap.days;
    assert.ok(days.includes("2026-06-20"), "axis must contain the local day");
    assert.equal(days.at(-1), "2026-06-21");
    // Owner 1 (sessions.started_at): sessions-per-day trend.
    const sessionPoint = utilization.charts.eventActivity.points.find(
      (p) => p.date === "2026-06-20"
    );
    assert.equal(sessionPoint?.values.sessions, 1);
    assert.equal(
      utilization.charts.eventActivity.points.find(
        (p) => p.date === "2026-06-21"
      )?.values.sessions,
      0
    );
    // Owner 2 again via the events-per-day trend.
    const eventPoint = utilization.charts.eventVolume.points.find(
      (p) => p.date === "2026-06-20"
    );
    assert.equal(eventPoint?.values.events, 1);

    const agents = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      "90",
      NOW
    );
    // Owner 1: tool runs + model spend bucket by s.started_at → local June 20.
    assert.equal(
      agents.charts.toolRunsOverTime.points.find((p) => p.date === "2026-06-20")
        ?.values["tool-runs"],
      1
    );
    assert.equal(
      agents.charts.modelUsageOverTime.points.find(
        (p) => p.date === "2026-06-20"
      )?.values["claude-sonnet-4-5"],
      1.5
    );
    // Owner 2b: lone assistant turn → 100% agent-driven on the local day.
    assert.equal(
      agents.charts.autonomyTrend.points.find((p) => p.date === "2026-06-20")
        ?.values.autonomy,
      100
    );

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    // Owner 3 (artifacts COALESCE(observed_at, created_at)): PR + KLOC trends.
    assert.equal(
      delivery.charts.prTrend.points.find((p) => p.date === "2026-06-20")
        ?.values.merged,
      1
    );
    assert.equal(
      delivery.charts.klocTrend.points.find((p) => p.date === "2026-06-20")
        ?.values.kloc,
      0.5
    );
    assert.equal(
      delivery.charts.prTrend.points.find((p) => p.date === "2026-06-21")
        ?.values.merged,
      0
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3091: events-per-day counts events by their own time, even when the parent session started before the trend window", async () => {
  // A session that began BEFORE the trend-window start but keeps emitting events
  // inside it must count on the event's local day — matching web's
  // fetchEventVolume (filters `e.event_created_at BETWEEN trendStart AND end`)
  // and the bucket field localDay(e.created_at). The old query scoped by
  // s.started_at, so this session was fully excluded, depressing the left edge.
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-insights-evwin-"));
  const { db, config } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = await createDesktopPrisma(config, passthroughQueue);
  try {
    // period "90" → trendStart = NOW - 90d = 2026-03-24. Session started well
    // before that (Jan 1), event lands IN_WINDOW (June 20).
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at) VALUES ($1, $2, $3, $4)",
      ["long-runner", "completed", "2026-01-01T00:00:00.000Z", IN_WINDOW]
    );
    await db.query(
      `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      ["late-ev", "long-runner", "PostToolUse", "Bash", IN_WINDOW]
    );

    const utilization = await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      "90",
      NOW
    );
    // Bucketed on the event's local day (June 20 CDT), and counted despite the
    // session's Jan 1 start being outside the trend window.
    assert.equal(
      utilization.charts.eventVolume.points.find((p) => p.date === "2026-06-20")
        ?.values.events,
      1
    );
    // The session itself (started Jan 1) contributes no sessions-per-day point
    // inside the window — confirming the two series legitimately scope on
    // different columns now.
    assert.equal(
      utilization.charts.eventActivity.points.find(
        (p) => p.date === "2026-06-20"
      )?.values.sessions,
      0
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2430: DST transitions bucket by true local wall-clock (fall-back collapse, spring-forward gap)", async () => {
  // Raw-SQL characterization (attribution-day-bucketing style): the production
  // bucket expression against the two America/Chicago DST boundaries in 2026.
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-insights-dst-"));
  const { db } = await openMigrationDatabase(path.join(dir, "dst.sqlite"));
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS dst_events (
        id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    await db.query(
      `INSERT INTO dst_events (id, created_at) VALUES
         ('fallback-cdt', '2026-11-01T06:30:00.000Z'),
         ('fallback-cst', '2026-11-01T07:30:00.000Z'),
         ('springfwd',    '2026-03-08T08:30:00.000Z')`
    );
    const rows = await db.query<{ id: string; day: string; hour: number }>(
      `SELECT id,
              strftime('%Y-%m-%d', created_at, 'localtime') AS day,
              CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS hour
       FROM dst_events ORDER BY id`
    );
    const byId = new Map(
      rows.rows.map((r) => [r.id, { day: r.day, hour: Number(r.hour) }])
    );
    // Fall-back: 06:30Z is 01:30 CDT (UTC-5) and 07:30Z is 01:30 CST (UTC-6) —
    // two distinct UTC hours collapse into the same local day+hour bucket.
    assert.deepEqual(byId.get("fallback-cdt"), { day: "2026-11-01", hour: 1 });
    assert.deepEqual(byId.get("fallback-cst"), { day: "2026-11-01", hour: 1 });
    // Spring-forward: 02:xx local does not exist on 2026-03-08; 08:30Z resolves
    // to 03:30 CDT (UTC-5 after the jump), never to a phantom hour 2.
    assert.deepEqual(byId.get("springfwd"), { day: "2026-03-08", hour: 3 });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2486: KPI merge-rate counts lowercase pr_state='merged' rows (pre-fix 'MERGED' matched zero)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-insights-kpi-case-"));
  const { db, config } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = await createDesktopPrisma(config, passthroughQueue);
  try {
    // Session required by the session_artifact_link FK constraint (below).
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at) VALUES ($1, $2, $3, $4)",
      ["kpi-case-session", "completed", IN_WINDOW, IN_WINDOW]
    );
    // 4 captured PRs: 2 lowercase-'merged', 1 'closed', 1 NULL.
    // Pre-FEA-2486 the KPI compared pr_state = 'MERGED' (uppercase) and matched
    // zero rows — merge-rate was always 0 on real stores regardless of actual
    // state. The fix uses LOWER(pr_state) = PrState.Merged so 'merged' matches.
    for (const [id, prNum, prState] of [
      ["kpi-m1", 1, PrState.Merged],
      ["kpi-m2", 2, PrState.Merged],
      ["kpi-c1", 3, PrState.Closed],
      ["kpi-n1", 4, null],
    ] as [string, number, string | null][]) {
      await db.query(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, pr_number,
            pr_state, created_at, last_seen_at)
         VALUES ($1, $2, 'pull_request', 'org/repo', $3, $4, $5, $5)`,
        [id, `pr:kpi-case:${prNum}`, prNum, prState, IN_WINDOW]
      );
    }
    // FEA-2995: both merged PRs were authored in-session (relation='created'),
    // so the authored-gated "mergedCount" denominator counts both. The closed
    // and open PRs need no links here — they are not merged.
    for (const [linkId, artifactId] of [
      ["sal-kpi-m1", "kpi-m1"],
      ["sal-kpi-m2", "kpi-m2"],
    ] as [string, string][]) {
      await db.query(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence,
            extractor_version, observed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          linkId,
          "kpi-case-session",
          artifactId,
          ArtifactRefRelation.Created,
          ArtifactRefMethod.PrCreateOutput,
          "{}",
          1,
          IN_WINDOW,
          IN_WINDOW,
        ]
      );
    }

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    // "merged" KPI (label "Captured PRs") = total in-window PR count.
    assert.equal(delivery.kpis.find((k) => k.key === "merged")?.value, 4);
    // FEA-2946: the dedicated "mergedCount" KPI (AI-Impact card's cost-per-merged-PR
    // denominator) = the MERGED count only (2), NOT the captured count (4). This is
    // the same merged-PR semantic the cloud surface's mergedCount carries.
    // FEA-2995: it is additionally gated on the created-artifact links, so the
    // 2 authored merged PRs above count while reference-only merged PRs would
    // not (see the dedicated FEA-2995 test below).
    assert.equal(delivery.kpis.find((k) => k.key === "mergedCount")?.value, 2);
    // merge-rate = Math.round((mergedCount / decidedCount) * 100). FEA-2942:
    // the denominator is DECIDED PRs (merged + closed), so the still-open NULL
    // row is excluded: 2 merged / 3 decided (2 merged + 1 closed) = 67%.
    // FEA-2486 (LOWER() casing) still validated — the 2 lowercase 'merged' rows
    // match the numerator. Pre-FEA-2942 this was 2 / 4 captured = 50%.
    assert.equal(delivery.kpis.find((k) => k.key === "merge-rate")?.value, 67);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2995: mergedCount denominator excludes reference-only merged PRs (created-link gated, matches cloud)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-insights-fea2995-"));
  const { db, config } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = await createDesktopPrisma(config, passthroughQueue);
  try {
    // Session required by the session_artifact_link FK constraint.
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at) VALUES ($1, $2, $3, $4)",
      ["fea2995-session", "completed", IN_WINDOW, IN_WINDOW]
    );
    // Two MERGED PRs captured in-window:
    //  - pr-authored: the user opened it in-session (relation='created').
    //  - pr-refonly: a reference-only merged PR (e.g. a competitor repo scanned
    //    via `gh api`, a CI `uses:` ref, or a test fixture) — captured but never
    //    authored, so it has NO created link (prByRepo/FEA-2862 excludes it too).
    for (const [id, prNum] of [
      ["pr-authored", 1],
      ["pr-refonly", 2],
    ] as [string, number][]) {
      await db.query(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, pr_number,
            pr_state, created_at, last_seen_at)
         VALUES ($1, $2, 'pull_request', 'org/repo', $3, $4, $5, $5)`,
        [id, `pr:fea2995:${prNum}`, prNum, PrState.Merged, IN_WINDOW]
      );
    }
    await db.query(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          extractor_version, observed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        "sal-fea2995-authored",
        "fea2995-session",
        "pr-authored",
        ArtifactRefRelation.Created,
        ArtifactRefMethod.PrCreateOutput,
        "{}",
        1,
        IN_WINDOW,
        IN_WINDOW,
      ]
    );

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    // "merged" KPI (label "Captured PRs") still counts EVERY captured PR — both
    // the authored and the reference-only merged PR — matching the capture-count
    // charts and the (ungated) merge-rate population.
    assert.equal(delivery.kpis.find((k) => k.key === "merged")?.value, 2);
    // FEA-2995: the AI-Impact card's cost-per-merged-PR denominator counts ONLY
    // the authored merged PR (1), NOT the reference-only one — matching cloud's
    // countMergedPrsInRange (authored pullRequestDetail rows). Pre-fix this
    // returned 2 and understated cost-per-merged-PR versus cloud.
    assert.equal(delivery.kpis.find((k) => k.key === "mergedCount")?.value, 1);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2486: prTrend agent/manual split — PR with created link counts as agent, without as manual", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-insights-pr-split-"));
  const { db, config } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = await createDesktopPrisma(config, passthroughQueue);
  try {
    // Session required by the session_artifact_link FK constraint.
    await db.query(
      "INSERT INTO sessions (id, status, started_at, ended_at) VALUES ($1, $2, $3, $4)",
      ["split-session", "completed", IN_WINDOW, "2026-06-20T11:00:00.000Z"]
    );

    // PR1: has a session_artifact_link with relation='created' → agent bucket.
    await db.query(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', 'org/repo', $3, $4, $4)`,
      ["pr-agent", "pr:split-test:1", 1, IN_WINDOW]
    );
    await db.query(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          extractor_version, observed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        "sal-split-agent",
        "split-session",
        "pr-agent",
        ArtifactRefRelation.Created,
        ArtifactRefMethod.PrCreateOutput,
        "{}",
        1,
        IN_WINDOW,
        IN_WINDOW,
      ]
    );

    // PR2: no session_artifact_link at all → manual bucket.
    await db.query(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', 'org/repo', $3, $4, $4)`,
      ["pr-manual", "pr:split-test:2", 2, IN_WINDOW]
    );

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    const { prTrend } = delivery.charts;

    // Series must declare exactly agent and manual — "merged" is an undeclared
    // total key in values but must NOT appear in series (would double-count in
    // bar/heatmap renderers that sum only declared series).
    assert.deepEqual(prTrend.series, [
      { key: "agent", label: "Agent-raised" },
      { key: "manual", label: "Manual/untracked" },
    ]);

    // The local day 2026-06-20 (IN_WINDOW = 05:00 CDT) gets both PRs.
    const dayPoint = prTrend.points.find((p) => p.date === "2026-06-20");
    assert.ok(dayPoint, "expected a prTrend point for 2026-06-20");
    assert.deepEqual(dayPoint.values, { agent: 1, manual: 1, merged: 2 });

    // Structural invariant: agent + manual === merged across every day.
    // Violations indicate a gap in the split logic (e.g. a PR counted twice).
    let sumAgent = 0;
    let sumManual = 0;
    let sumMerged = 0;
    for (const p of prTrend.points) {
      sumAgent += p.values.agent;
      sumManual += p.values.manual;
      sumMerged += p.values.merged;
    }
    assert.equal(sumAgent + sumManual, sumMerged);
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2486: prTrend DISTINCT collapses two created links from different sessions into agent=1", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "local-insights-pr-fanout-")
  );
  const { db, config } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = await createDesktopPrisma(config, passthroughQueue);
  try {
    // Two distinct sessions — the unique constraint (session_id, artifact_id,
    // relation) permits one 'created' link row per session, so two sessions can
    // each link to the same PR with relation='created'.
    for (const sessionId of ["fanout-s1", "fanout-s2"]) {
      await db.query(
        "INSERT INTO sessions (id, status, started_at, ended_at) VALUES ($1, $2, $3, $4)",
        [sessionId, "completed", IN_WINDOW, "2026-06-20T11:00:00.000Z"]
      );
    }

    // One PR artifact — 1 captured PR, 1 total for the day.
    await db.query(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', 'org/repo', $3, $4, $4)`,
      ["pr-fanout", "pr:fanout-test:99", 99, IN_WINDOW]
    );

    // Two 'created' links from two different sessions pointing at the same PR.
    // The subquery SELECT DISTINCT artifact_id collapses these to one artifact_id
    // so the LEFT JOIN yields cl.artifact_id IS NOT NULL exactly once → agent=1.
    for (const [linkId, sessionId] of [
      ["sal-fanout-1", "fanout-s1"],
      ["sal-fanout-2", "fanout-s2"],
    ] as [string, string][]) {
      await db.query(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence,
            extractor_version, observed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          linkId,
          sessionId,
          "pr-fanout",
          ArtifactRefRelation.Created,
          ArtifactRefMethod.PrCreateOutput,
          "{}",
          1,
          IN_WINDOW,
          IN_WINDOW,
        ]
      );
    }

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    const dayPoint = delivery.charts.prTrend.points.find(
      (p) => p.date === "2026-06-20"
    );
    assert.ok(dayPoint, "expected a prTrend point for 2026-06-20");
    // DISTINCT collapses two created-link rows into one artifact → agent=1, not 2.
    assert.deepEqual(dayPoint.values, { agent: 1, manual: 0, merged: 1 });
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2951: Utilization Review backlog KPI counts only open PRs; reviewQueue keeps all captured", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-insights-backlog-"));
  const { db, config } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = await createDesktopPrisma(config, passthroughQueue);
  try {
    // 6 captured PRs: 1 open, 1 NULL (un-enriched → treated as open),
    // 2 merged, 1 closed, and 1 with an UNKNOWN/future lifecycle value
    // ('draft', not in PrState). The shared kpi:backlog label means "Open PRs
    // awaiting review", approximating the web `countReviewBacklog`. Pre-FEA-2951
    // the desktop KPI counted every captured PR artifact regardless of state.
    // The fix counts only positively-open PRs (LOWER(pr_state)=PrState.Open) and
    // un-enriched (NULL) rows. Critically it does NOT use NOT IN('merged',
    // 'closed'): an unknown non-null state like 'draft' must stay OUT of the
    // backlog rather than being fabricated as open, so backlog = 2 (open+NULL),
    // NOT 3. The reviewQueue "Captured locally" bar still reflects all 6.
    for (const [id, prNum, prState] of [
      ["bk-open", 1, PrState.Open],
      ["bk-null", 2, null],
      ["bk-merged1", 3, PrState.Merged],
      ["bk-merged2", 4, PrState.Merged],
      ["bk-closed", 5, PrState.Closed],
      // Unknown/future lifecycle value from a hypothetical newer enricher.
      ["bk-unknown", 6, "draft"],
    ] as [string, number, string | null][]) {
      await db.query(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, pr_number,
            pr_state, created_at, last_seen_at)
         VALUES ($1, $2, 'pull_request', 'org/repo', $3, $4, $5, $5)`,
        [id, `pr:backlog:${prNum}`, prNum, prState, IN_WINDOW]
      );
    }

    const utilization = await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      "90",
      NOW
    );
    // Review backlog KPI: only open + un-enriched (NULL) PRs → 2. The unknown
    // 'draft' state is excluded (not treated as open).
    assert.equal(utilization.kpis.find((k) => k.key === "backlog")?.value, 2);
    // reviewQueue "Captured locally" still counts every captured PR → 6.
    assert.equal(
      utilization.charts.reviewQueue.find((b) => b.key === "captured")?.value,
      6
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
