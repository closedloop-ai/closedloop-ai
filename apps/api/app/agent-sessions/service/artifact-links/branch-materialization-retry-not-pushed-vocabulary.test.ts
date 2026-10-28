import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CloudBranchNonMaterializationKind } from "@/app/branches/branch-write-eligibility";
import {
  isRetryableBranchMaterializationCause,
  terminalReasonFromBranchMaterializationCause,
} from "./branch-materialization-retry";
import { BranchMaterializationRetryTerminalReason } from "./branch-materialization-retry-monitor";

/*
 * ISS-8284. The reviewer concern was that the retry drain persists `not_pushed`
 * and that `settleTerminalBranchMaterializationRetry` therefore fails with a
 * check violation, leaving the retry claimed. Adjudicated against `main` and
 * REFUTED — these cases pin the two facts that refute it, so the refutation
 * cannot quietly stop being true.
 *
 * Scope note, deliberately narrow: these assert the two PREDICATES the drain
 * composes, not a drain run. The drain's own ordering (retryable-first, before
 * terminal mapping) is exercised by the reschedule cases above.
 */
describe("branch materialization NotPushed terminal-vocabulary parity (ISS-8284)", () => {
  it("routes NotPushed to the retryable branch the drain tests first", () => {
    // This is the whole reason the mapper below is never consulted for the
    // cause. Flip it to false and the drain falls through to terminal mapping.
    expect(
      isRetryableBranchMaterializationCause(
        CloudBranchNonMaterializationKind.NotPushed
      )
    ).toBe(true);
  });

  it("still maps NotPushed to a real terminal reason if that ordering ever changes", () => {
    // The latent half ISS-8284 actually fixed: the mapper CAN return this
    // member, and until the migration widened the CHECK the column refused it —
    // so only an early return in a different file stood between the two.
    expect(
      terminalReasonFromBranchMaterializationCause(
        CloudBranchNonMaterializationKind.NotPushed
      )
    ).toBe(BranchMaterializationRetryTerminalReason.NotPushed);
  });
});

/*
 * #7204 review (davetho): the migration's reason list and
 * `BranchMaterializationRetryTerminalReason` are two hand-maintained spellings
 * of one vocabulary, and `packages/database` cannot import this one — so the
 * parity check has to live on THIS side, where the runtime set actually is.
 *
 * Without it, a later terminal reason added to the const object is accepted by
 * the monitor and then REFUSED by the column, and every existing case — here and
 * in `packages/database` — stays green: the sibling text-scan suite asserts the
 * literal count against its own baseline, which knows nothing about this set.
 *
 * Reading `migration.sql` is the sanctioned shape: the
 * `no-raw-text-source-scan` gate exempts declarative data files by name and bans
 * only raw-text scans of TypeScript source.
 */
describe("branch materialization terminal-reason storage parity (ISS-8284)", () => {
  it("accepts every runtime terminal reason in the migrated CHECK vocabulary", async () => {
    const storable = await migratedReasonLiterals();

    // A SUPERSET check, not equality: the column legitimately also accepts the
    // non-terminal `authority_unavailable`, which no terminal mapper returns.
    for (const reason of Object.values(
      BranchMaterializationRetryTerminalReason
    )) {
      expect(storable).toContain(reason);
    }
  });
});

const MIGRATION_NAME =
  "20260917153000_iss8284_branch_materialization_retry_reason_not_pushed";
const REASON_CONSTRAINT = "branch_materialization_retries_reason_check";
const REASON_LITERAL_REGEX = /'([^']*)'/g;

/** The quoted reason values the applied CHECK predicate accepts. */
async function migratedReasonLiterals(): Promise<string[]> {
  const sql = await readFile(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../../../packages/database/prisma/migrations",
      MIGRATION_NAME,
      "migration.sql"
    ),
    "utf8"
  );
  const markerIndex = sql.indexOf(`ADD CONSTRAINT "${REASON_CONSTRAINT}"`);
  if (markerIndex < 0) {
    throw new Error(`Missing ${REASON_CONSTRAINT} constraint`);
  }
  const end = sql.indexOf(";", markerIndex);
  return [...sql.slice(markerIndex, end).matchAll(REASON_LITERAL_REGEX)].map(
    ([, literal]) => literal
  );
}
