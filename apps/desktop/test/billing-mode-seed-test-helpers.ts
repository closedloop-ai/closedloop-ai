/**
 * @file billing-mode-seed-test-helpers.ts
 * @description Shared seed wiring for the billing-mode read-path tests
 * (ISS-4869 / ISS-4878).
 *
 * Both `branch-reads-billing-parity.test.ts` and
 * `billing-mode-read-path-parity.test.ts` need the SAME fixture: one historical
 * session persisted BEFORE the detector could classify it (`billing_mode`
 * stamped `'unknown'`, but a knowable `harness`), linked to a branch artifact,
 * carrying both a `token_usage` aggregate row and a `token_events` row — one for
 * each of the two Branches usage producers.
 *
 * Extracted here rather than copied a third time, following the
 * `branch-reads-ac-test-helpers.ts` precedent: when the same nontrivial test
 * fixture appears in multiple files it belongs in the nearest shared module
 * owned by that surface. Keeping ONE definition also means the two suites can
 * never drift into seeding subtly different rows and then disagreeing about
 * what the read paths should return. Pure fixtures; no test state.
 */
import type { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

export const BILLING_SEED_T0 = "2026-06-01T00:00:00.000Z";
export const BILLING_SEED_T1 = "2026-06-01T01:00:00.000Z";

/**
 * The harness under test across both suites. `detectCopilotBillingMode` is a
 * pure constant, so every expectation derived from it holds with no env,
 * filesystem, or Keychain state.
 */
export const BILLING_SEED_HARNESS = "copilot";

/** The mode `BILLING_SEED_HARNESS` resolves to — a SUBSCRIPTION-ledger mode. */
export const BILLING_SEED_RESOLVED_MODE = "copilot_seat";

export type BillingSeedDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

export type LegacyUnknownBillingSeed = {
  sessionId: string;
  artifactId: string;
  identityKey: string;
  linkId: string;
  branchName: string;
  /** Omit to leave the token rows unpriced (`cost_usd_estimated` NULL). */
  costUsd?: number;
  model?: string;
  repoFullName?: string;
};

/**
 * Seed one historical `unknown`-billing session exactly as it sits on disk
 * today, plus the branch artifact/link and the two token row shapes the
 * Branches usage producers read.
 *
 * The row is written directly, never through the importer, so nothing derived
 * from it depends on `write-core.ts`'s sticky `CASE` re-stamp or on a
 * `DATA_REVISION` rebuild having run.
 */
export async function seedLegacyUnknownBillingSession(
  db: BillingSeedDb,
  seed: LegacyUnknownBillingSeed
): Promise<void> {
  const model = seed.model ?? "gpt-4o";
  const costUsd = seed.costUsd ?? null;
  await db.run(
    `INSERT INTO sessions (id, status, started_at, ended_at, updated_at, billing_mode, harness)
     VALUES ($1, 'completed', $2, $3, $3, 'unknown', $4)`,
    seed.sessionId,
    BILLING_SEED_T0,
    BILLING_SEED_T1,
    BILLING_SEED_HARNESS
  );
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
     VALUES ($1, $2, 'branch', $3, $4, $5, $5)`,
    seed.artifactId,
    seed.identityKey,
    seed.repoFullName ?? "acme/web",
    seed.branchName,
    BILLING_SEED_T0
  );
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence,
        is_primary, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, 'created', 'git_push', 'e', 1, 7, $4, $4)`,
    seed.linkId,
    seed.sessionId,
    seed.artifactId,
    BILLING_SEED_T0
  );
  await db.run(
    `INSERT INTO token_usage
       (session_id, model, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, cost_usd_estimated)
     VALUES ($1, $2, 300, 100, 10, 5, $3)`,
    seed.sessionId,
    model,
    costUsd
  );
  await db.run(
    `INSERT INTO token_events
       (session_id, model, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, created_at, cost_usd_estimated)
     VALUES ($1, $2, 300, 100, 10, 5, $3, $4)`,
    seed.sessionId,
    model,
    BILLING_SEED_T0,
    costUsd
  );
}
