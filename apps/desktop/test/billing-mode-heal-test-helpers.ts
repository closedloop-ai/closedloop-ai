/**
 * @file billing-mode-heal-test-helpers.ts
 * @description Shared fixture wiring for the billing-mode heal suites
 * (ISS-4869 / ISS-5259 / ISS-7581).
 *
 * `billing-mode-heal.test.ts` owns the drain's SUCCESS properties and
 * `billing-mode-heal-bailout.test.ts` owns the branches where the pass gives up.
 * Both seed the same row shape and both match the same heal log lines, so the
 * fixture and those patterns live here rather than being copied into the second
 * file — the `billing-mode-seed-test-helpers.ts` precedent, for the same reason:
 * two copies can drift into seeding subtly different rows and then disagreeing
 * about what one production pass should report.
 *
 * Pure fixtures and patterns; no test state.
 */
import type { openTestDb } from "./agent-db-test-utils.js";

export const HEAL_T0 = "2026-06-01T00:00:00.000Z";
export const HEAL_T1 = "2026-06-01T01:00:00.000Z";

export type HealTestDb = Awaited<ReturnType<typeof openTestDb>>;

export async function insertSession(
  db: HealTestDb,
  input: { id: string; harness: string | null; billingMode: string | null }
): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, started_at, ended_at, updated_at, billing_mode, harness)
     VALUES ($1, 'completed', $2, $3, $3, $4, $5)`,
    input.id,
    HEAL_T0,
    HEAL_T1,
    input.billingMode,
    input.harness
  );
}

export async function readBillingMode(
  db: HealTestDb,
  id: string
): Promise<string | null> {
  const [row] = await db.prisma.client.$queryRawUnsafe<
    { billing_mode: string | null }[]
  >("SELECT billing_mode FROM sessions WHERE id = $1", id);
  return row.billing_mode;
}

export const RESTAMPED_ONE_RE = /re-stamped 1 session\(s\)/;
export const HEAL_FAILED_COPILOT_RE = /billing-mode heal failed for copilot/;
export const LOCKED_REASON_RE = /database is locked/;
export const HEAL_COMPLETE_RE = /heal complete/;
