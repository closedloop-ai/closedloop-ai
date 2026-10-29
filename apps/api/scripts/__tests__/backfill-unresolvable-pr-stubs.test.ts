/**
 * ISS-8463 — the population predicate's shape and the run config, without a
 * database. The behavioral proof (which rows the predicate selects) is
 * `__tests__/integration/iss8463-unresolvable-pr-stub-backfill.integration.test.ts`.
 */
import { GitHubFetchMechanism } from "@repo/api/src/types/github-read-model";
import { describe, expect, it } from "vitest";
import {
  BackfillMode,
  resolveRunConfig,
  UNRESOLVABLE_STUB_MIN_ATTEMPT_AGE_MS,
} from "../backfill-unresolvable-pr-stubs";
import { unresolvableStubPredicateSql } from "../backfill-unresolvable-pr-stubs-queries";

/**
 * The `pull_request_detail` columns a provider fetch could fill, written out
 * here rather than imported from `DESKTOP_PR_FETCHABLE_FACT_COLUMNS`.
 *
 * Deliberate duplication: importing the map the predicate renders from would
 * make this test agree with that map by construction, so dropping a column from
 * it would stay green. The list is the contract, and it is pinned from outside.
 */
const EXPECTED_FACT_COLUMNS = [
  "title",
  "additions",
  "deletions",
  "changed_files",
  "merged_at",
  "closed_at",
];

const CUTOFF = new Date("2026-08-22T00:00:00.000Z");

const MIN_ATTEMPT_AGE_ERROR = /MIN_ATTEMPT_AGE_HOURS/;
const LIMIT_ERROR = /LIMIT/;

describe("unresolvableStubPredicateSql", () => {
  it("requires every fetchable fact column to be empty", () => {
    const sql = unresolvableStubPredicateSql(CUTOFF).sql;

    for (const column of EXPECTED_FACT_COLUMNS) {
      expect(sql).toContain(`prd.${column} IS NULL`);
    }
  });

  it("names no column outside the fetchable set", () => {
    const sql = unresolvableStubPredicateSql(CUTOFF).sql;

    // `pr_state` and `is_draft` are NOT NULL with defaults, so an emptiness
    // test on them can never distinguish a measurement from the default and
    // would silently narrow the population to nothing.
    expect(sql).not.toContain("prd.pr_state IS NULL");
    expect(sql).not.toContain("prd.is_draft IS NULL");
    expect(sql).not.toContain("prd.base_ref_name IS NULL");
  });

  it("keys origin on the desktop sync mechanism", () => {
    const predicate = unresolvableStubPredicateSql(CUTOFF);

    expect(predicate.sql).toContain("prd.fetch_mechanism =");
    expect(predicate.values).toContain(GitHubFetchMechanism.DesktopSync);
  });

  it("requires an attempt strictly later than the stamp it clears", () => {
    const sql = unresolvableStubPredicateSql(CUTOFF).sql;

    // The legacy producer wrote both clocks from one `observedAt`, so equality
    // means "never attempted by the reconciler" — a row still due to self-heal.
    expect(sql).toContain("prd.last_refresh_attempt_at > prd.last_verified_at");
  });

  it("carries no null guard the comparison already implies", () => {
    const sql = unresolvableStubPredicateSql(CUTOFF).sql;

    // A comparison against NULL is NULL and admits nothing, so these guards
    // cannot change the result set. Asserting their absence keeps a conjunct
    // that reads as an exclusion but can never perform one from creeping back.
    expect(sql).not.toContain("prd.last_verified_at IS NOT NULL");
    expect(sql).not.toContain("prd.last_refresh_attempt_at IS NOT NULL");
    // Nor may the comparison be made null-tolerant, which would admit a
    // post-ISS-8423 row that carries no stamp to clear.
    expect(sql).not.toContain("COALESCE(prd.last_verified_at");
  });

  it("bounds the attempt by the operator's cutoff", () => {
    const predicate = unresolvableStubPredicateSql(CUTOFF);

    expect(predicate.sql).toContain("prd.last_refresh_attempt_at <");
    expect(predicate.values).toContain(CUTOFF);
  });
});

describe("resolveRunConfig", () => {
  it("defaults to a dry run at the seven-day attempt age", () => {
    const config = resolveRunConfig({});

    expect(config.mode).toBe(BackfillMode.DryRun);
    expect(config.minAttemptAgeMs).toBe(UNRESOLVABLE_STUB_MIN_ATTEMPT_AGE_MS);
    expect(config.limit).toBeNull();
  });

  it("treats any DRY_RUN value other than an explicit 0 as a dry run", () => {
    expect(resolveRunConfig({ DRY_RUN: "false" }).mode).toBe(
      BackfillMode.DryRun
    );
    expect(resolveRunConfig({ DRY_RUN: "1" }).mode).toBe(BackfillMode.DryRun);
    expect(resolveRunConfig({ DRY_RUN: "0" }).mode).toBe(BackfillMode.Apply);
  });

  it("takes a revert run id over an apply", () => {
    const runId = "1b1a4f2e-0000-4000-8000-000000000000";

    const config = resolveRunConfig({ DRY_RUN: "0", REVERT_RUN_ID: runId });

    expect(config.mode).toBe(BackfillMode.Revert);
    expect(config.revertRunId).toBe(runId);
  });

  it("accepts a positive attempt-age override", () => {
    expect(
      resolveRunConfig({ MIN_ATTEMPT_AGE_HOURS: "24" }).minAttemptAgeMs
    ).toBe(24 * 60 * 60 * 1000);
  });

  it("rejects a set-but-unusable override instead of substituting a default", () => {
    // Both fall open on a silent fallback: a dropped LIMIT clears the whole
    // population, and a substituted age widens it past what was asked for.
    for (const bad of ["0", "-1", "nonsense", "1.5"]) {
      expect(() => resolveRunConfig({ MIN_ATTEMPT_AGE_HOURS: bad })).toThrow(
        MIN_ATTEMPT_AGE_ERROR
      );
      expect(() => resolveRunConfig({ LIMIT: bad })).toThrow(LIMIT_ERROR);
    }
  });

  it("reads a positive LIMIT as the operator's cap", () => {
    expect(resolveRunConfig({ LIMIT: "10" }).limit).toBe(10);
  });

  it("rejects a partially-parsed value rather than reading its numeric prefix", () => {
    // `Number.parseInt("3oops")` is 3, so a prefix-reading parser would accept a
    // typo as a cap of 3 and clear three rows the operator never authorized —
    // and would read `500px` as 500. The whole string has to parse.
    for (const typo of ["3oops", "5px", "1_000", "Infinity", "12 34"]) {
      expect(() => resolveRunConfig({ LIMIT: typo })).toThrow(LIMIT_ERROR);
      expect(() => resolveRunConfig({ MIN_ATTEMPT_AGE_HOURS: typo })).toThrow(
        MIN_ATTEMPT_AGE_ERROR
      );
    }
  });
});
