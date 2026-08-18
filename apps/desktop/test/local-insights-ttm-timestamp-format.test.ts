import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { InsightsSection } from "@closedloop-ai/loops-api/insights";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
} from "@repo/api/src/types/session-artifact-link";
import { computeLocalInsights } from "../src/main/database/local-insights.js";
import { openInsightsDb } from "./local-insights-test-helpers.js";

/**
 * ISS-5427 — the Delivery "Median time to PR" (`ttm`) gate must compare
 * `artifacts.observed_at` against `sessions.started_at` as INSTANTS, not bytes.
 *
 * Both columns are TEXT, so SQLite's `>=` is a byte comparison, and that is only
 * chronologically correct while both sides share one spelling. This PR made
 * `artifacts.observed_at` canonical UTC 'Z' at the point of derivation
 * (`write-core-pull-requests.ts`), while `sessions.started_at` is still written
 * VERBATIM from the harness by `write-core.ts` — the boot heal re-spells it, and
 * the next import writes it straight back. So the two columns now legitimately
 * disagree in format on a live store.
 *
 * That divergence is only harmful in one direction, and it is the direction an
 * EAST-of-UTC operator lives in: an offset form east of UTC carries LARGER
 * wall-clock digits than the same instant in UTC (`2026-06-20T15:00:00+05:00` is
 * `10:00:00Z`), so a canonical `observed_at` that is genuinely LATER than the
 * session start sorts BYTE-WISE BEFORE it. A whole PR silently left the
 * percentile, and only for operators east of Greenwich.
 *
 * These live in a focused sibling suite because `local-insights-contract.test.ts`
 * is in the shrink-only grandfather list.
 */

// Same timezone pin as the sibling contract suites: the insights SQL buckets by
// process-local day, so a fixed non-UTC zone keeps the conversion exercised and
// deterministic. Runs at module evaluation, before any DB opens.
process.env.TZ = "America/Chicago";

const NOW = new Date("2026-06-22T00:00:00.000Z");

/**
 * The session start, spelled the way a harness east of UTC hands it over and
 * `write-core.ts` stores it: an offset form, NOT canonical 'Z'.
 */
const SESSION_START_OFFSET_FORM = "2026-06-20T15:00:00+05:00";
/** The same instant, for the arithmetic the assertions are pinned to. */
const SESSION_START_INSTANT = "2026-06-20T10:00:00.000Z";
/**
 * The PR observation, spelled the way this PR's write path now produces it. One
 * hour AFTER the session start — but its digits (`11`) sort BEFORE the offset
 * form's (`15`), which is the whole defect.
 */
const PR_OBSERVED_CANONICAL = "2026-06-20T11:00:00.000Z";
const ONE_HOUR_MS = 3_600_000;

const INSERT_SESSION =
  "INSERT INTO sessions (id, status, started_at) VALUES ($1, 'completed', $2)";

const INSERT_PR_ARTIFACT = `INSERT INTO artifacts
     (id, identity_key, kind, repo_full_name, pr_number, pr_state,
      observed_at, created_at, last_seen_at)
   VALUES ($1, $2, 'pull_request', 'east/repo', $3, 'merged', $4, $4, $4)`;

const INSERT_LINK = `INSERT INTO session_artifact_links
     (id, session_id, artifact_id, relation, method, evidence,
      extractor_version, observed_at, created_at)
   VALUES ($1, $2, $3, $4, $5, '{}', 1, $6, $6)`;

test("ISS-5427: a canonical PR observation still counts against an offset-form session start east of UTC", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-ttm-east-");
  try {
    // Pin the fixture's own premise: the fix is only observable because the
    // canonical spelling sorts BEFORE the offset spelling while being LATER.
    assert.ok(
      Date.parse(PR_OBSERVED_CANONICAL) > Date.parse(SESSION_START_OFFSET_FORM),
      "fixture must make the PR observation the LATER instant"
    );
    assert.ok(
      PR_OBSERVED_CANONICAL < SESSION_START_OFFSET_FORM,
      "fixture must make the PR observation sort EARLIER byte-wise"
    );

    await db.query(INSERT_SESSION, ["s-east", SESSION_START_OFFSET_FORM]);
    await db.query(INSERT_PR_ARTIFACT, [
      "pr-east",
      "pr:east/repo:1",
      1,
      PR_OBSERVED_CANONICAL,
    ]);
    await db.query(INSERT_LINK, [
      "link-east",
      "s-east",
      "pr-east",
      ArtifactRefRelation.Created,
      ArtifactRefMethod.PrCreateOutput,
      PR_OBSERVED_CANONICAL,
    ]);

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );

    // The real elapsed time, from the INSTANTS — one hour.
    assert.equal(
      Date.parse(PR_OBSERVED_CANONICAL) - Date.parse(SESSION_START_INSTANT),
      ONE_HOUR_MS
    );
    assert.equal(
      delivery.kpis.find((k) => k.key === "ttm")?.value,
      ONE_HOUR_MS,
      "the byte-wise gate dropped this PR, leaving the median at the 0 fallback"
    );
    // ...and the tile is Available rather than "no terminal outcomes yet": the
    // dropped row took the whole cohort's only piece of TTM evidence with it.
    assert.ok(
      delivery.charts.meanTimeToMerge,
      "hasTtmEvidence must be true — the cohort is not empty"
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5427: the creating session still wins the one-row-per-PR tiebreak when its start is offset-form", async () => {
  const { dir, db, prisma } = await openInsightsDb("local-insights-ttm-tie-");
  try {
    // FEA-1899 collapses a multi-session PR to ONE latency row, preferring the
    // session that CREATED the PR. The format gate ran BEFORE that ROW_NUMBER
    // window, so a byte-wise drop did not merely lose a row — it handed rn = 1
    // to a merely-referencing session, and the percentile silently reported that
    // session's (longer, wrong) latency as the PR's time to merge.
    const referencingStart = "2026-06-20T09:00:00.000Z"; // canonical, 2h before
    await db.query(INSERT_SESSION, ["s-creator", SESSION_START_OFFSET_FORM]);
    await db.query(INSERT_SESSION, ["s-referencer", referencingStart]);
    await db.query(INSERT_PR_ARTIFACT, [
      "pr-multi",
      "pr:east/repo:2",
      2,
      PR_OBSERVED_CANONICAL,
    ]);
    await db.query(INSERT_LINK, [
      "link-creator",
      "s-creator",
      "pr-multi",
      ArtifactRefRelation.Created,
      ArtifactRefMethod.PrCreateOutput,
      PR_OBSERVED_CANONICAL,
    ]);
    await db.query(INSERT_LINK, [
      "link-referencer",
      "s-referencer",
      "pr-multi",
      ArtifactRefRelation.Referenced,
      ArtifactRefMethod.PrCreateOutput,
      PR_OBSERVED_CANONICAL,
    ]);

    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );

    // The creating session started one hour before the PR; the referencing one
    // started two. Only the creator's latency may be reported.
    assert.equal(
      delivery.kpis.find((k) => k.key === "ttm")?.value,
      ONE_HOUR_MS,
      "the referencing session's 2h latency won rn = 1 after the creator was byte-filtered out"
    );
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
