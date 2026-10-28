/**
 * Long-running routes must declare their serverless ceiling (PR #4321 review).
 *
 * For every route a client calls with `LONG_RUNNING_API_TIMEOUT_MS`, the
 * client-side deadline's whole justification is that 5 minutes is the
 * `maxDuration` the route runs under, so a request outliving it cannot still be
 * doing useful work. Before this test the routes declared nothing and ran on
 * the platform default, so the function was terminated first and the user saw a
 * 504 long before the client deadline could state the honest "we stopped
 * waiting". This pins the two numbers together.
 *
 * Two routes here have no in-repo client. Preview-schema ensure is invoked by
 * automation (ISS-5983). The Linear export route has been API-only since
 * ISS-12856 removed the product's Export to Linear; its cases pin the
 * server-side budget instead, the extraction deadline inside the declared
 * ceiling (PLN-2218 AC-009).
 */

import { LONG_RUNNING_API_TIMEOUT_MS } from "@repo/api/src/types/long-running-api-timeout";
import { DD_LOG_INTAKE_TIMEOUT_MS } from "@repo/database/scripts/migrate-telemetry";
import { TASK_EXTRACTION_TIMEOUT_MS } from "@repo/linear";
import { describe, expect, it } from "vitest";
import { maxDuration as selectedPullRequestDiffMaxDuration } from "./branches/[id]/selected-pull-request/diff/route";
import { maxDuration as selectedPullRequestFilesMaxDuration } from "./branches/[id]/selected-pull-request/files/route";
import { maxDuration as packRepoImportMaxDuration } from "./catalog/[id]/import-repo/route";
import { maxDuration as packZipImportMaxDuration } from "./catalog/[id]/import-zip/route";
import { maxDuration as documentMergeMaxDuration } from "./documents/merge/route";
import { MERGE_REQUEST_TIMEOUT_MS } from "./documents/merge-service";
import { maxDuration as githubBackfillMaxDuration } from "./integrations/github/backfill/route";
import { maxDuration as googleImportMaxDuration } from "./integrations/google/import/route";
import { maxDuration as linearExportMaxDuration } from "./integrations/linear/export/route";
import {
  ENSURE_DEADLINE_RESERVE_MS,
  ENSURE_ROUTE_CEILING_MS,
} from "./preview-schemas/ensure/constants";
import { maxDuration as previewSchemaEnsureMaxDuration } from "./preview-schemas/ensure/route";

const LONG_RUNNING_MAX_DURATION_SECONDS = LONG_RUNNING_API_TIMEOUT_MS / 1000;

describe("long-running routes declare the client deadline's ceiling", () => {
  it("selected-PR reads run under the ceiling their shared hooks wait for", () => {
    expect(selectedPullRequestFilesMaxDuration).toBe(
      LONG_RUNNING_MAX_DURATION_SECONDS
    );
    expect(selectedPullRequestDiffMaxDuration).toBe(
      LONG_RUNNING_MAX_DURATION_SECONDS
    );
  });

  it("GitHub backfill runs under the 5-minute ceiling the client waits for", () => {
    expect(githubBackfillMaxDuration).toBe(LONG_RUNNING_MAX_DURATION_SECONDS);
  });

  it("Google Drive folder import runs under the 5-minute ceiling the client waits for", () => {
    expect(googleImportMaxDuration).toBe(LONG_RUNNING_MAX_DURATION_SECONDS);
  });

  it("pack zip import runs under the 5-minute ceiling the client waits for", () => {
    expect(packZipImportMaxDuration).toBe(LONG_RUNNING_MAX_DURATION_SECONDS);
  });

  it("pack repo import runs under the 5-minute ceiling the client waits for", () => {
    expect(packRepoImportMaxDuration).toBe(LONG_RUNNING_MAX_DURATION_SECONDS);
  });

  /**
   * ISS-5983: no browser client calls this one — it is invoked by automation —
   * so its ceiling is not derived from a client deadline. It is pinned here
   * because it is the longest-running route in the app (migrate + a full data
   * clone on a first bootstrap) and must declare a ceiling rather than inherit the
   * platform default, which is well under a cold preview bootstrap.
   */
  it("preview-schema ensure declares the 5-minute ceiling its bootstrap needs", () => {
    expect(previewSchemaEnsureMaxDuration).toBe(
      LONG_RUNNING_MAX_DURATION_SECONDS
    );
  });

  /**
   * ISS-6403 Finding 1: the ensure route derives the migration pipeline's
   * budget from its own copy of that ceiling, because Next resolves
   * `maxDuration` as statically-analyzable segment config and will not follow
   * an imported value. Drift would hand the pipeline a budget the platform does
   * not actually grant — the exact mismatch the deadline exists to close.
   */
  it("the ensure ceiling constant tracks the declared maxDuration", () => {
    expect(ENSURE_ROUTE_CEILING_MS).toBe(previewSchemaEnsureMaxDuration * 1000);
  });

  /**
   * The reserve is taken out of the migrate's budget, so it must stay small.
   * Runs that finish between the deadline and the ceiling return 200 today; a
   * reserve that crept upward would start reporting them as failures, which is
   * a behavior trade ISS-6403 did not ask for.
   */
  it("keeps the ensure reserve between the flush it must outlast and the budget it costs", () => {
    // LOWER bound: the reserve has to cover `flushMigrateTelemetry()`, which
    // `ensureSchemaAtHead` awaits in its `finally` and which is itself bounded
    // by this deadline. A reserve under it lets the flush push the 504 past the
    // platform kill — the exact opaque timeout the deadline replaces. Asserted
    // against the canonical constant, not a copy, so raising the flush deadline
    // fails here instead of in production.
    expect(ENSURE_DEADLINE_RESERVE_MS).toBeGreaterThan(
      DD_LOG_INTAKE_TIMEOUT_MS
    );
    // UPPER bound: every millisecond of reserve is taken from the migrate.
    expect(ENSURE_DEADLINE_RESERVE_MS).toBeLessThanOrEqual(
      ENSURE_ROUTE_CEILING_MS / 20
    );
  });
});

/**
 * ISS-6774: the two LLM-backed write routes awaited an Anthropic generation
 * with neither an `abortSignal` nor a declared `maxDuration`, so a hung
 * generation (which the AI SDK retries up to 3 attempts, serially) ran until
 * the platform hard-killed the function and the caller got an opaque 504
 * instead of the JSON error envelope the route contract declares. Both halves
 * are pinned here: the ceiling must be declared, and the SDK deadline must fall
 * strictly inside it so the abort fires first.
 */
describe("LLM write routes bound their generation inside a declared ceiling", () => {
  it("document merge declares a ceiling its generation deadline fits inside", () => {
    expect(documentMergeMaxDuration).toBe(LONG_RUNNING_MAX_DURATION_SECONDS);
    expect(MERGE_REQUEST_TIMEOUT_MS).toBeLessThan(
      documentMergeMaxDuration * 1000
    );
  });

  it("Linear export declares a ceiling its extraction deadline fits inside", () => {
    expect(linearExportMaxDuration).toBe(LONG_RUNNING_MAX_DURATION_SECONDS);
    expect(TASK_EXTRACTION_TIMEOUT_MS).toBeLessThan(
      linearExportMaxDuration * 1000
    );
  });

  /**
   * Extraction runs immediately ahead of `exportImplementationPlan`'s
   * non-idempotent Linear issue fan-out, so it gets a deliberately tighter
   * share than merge's: time spent hanging on the model is time taken from the
   * part of the request that has external side effects. This pins the budget
   * SPLIT — it is not a claim that the fan-out fits in what is left, which
   * nothing bounds today (see the route's comment).
   */
  it("leaves at least half the ceiling to the Linear fan-out", () => {
    expect(TASK_EXTRACTION_TIMEOUT_MS).toBeLessThanOrEqual(
      (linearExportMaxDuration * 1000) / 2
    );
  });
});
