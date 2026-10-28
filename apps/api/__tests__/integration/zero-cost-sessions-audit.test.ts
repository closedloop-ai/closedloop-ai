import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  checkZeroCostMeteredSessions,
  type InvariantCheckResult,
} from "@/app/cron/audit-data-invariants/service";
import {
  autoRollbackTransaction,
  createTestSessionDetail,
} from "../utils/db-helpers";
import {
  type CountDelta,
  METERED_BILLING_MODE,
  type Owner,
  RECORDED_INPUT_TOKENS,
  recordSessionWork,
  type SessionShape,
  STILL_COUNTED_ERROR_FLAG_CASES,
  seedOwner,
} from "./zero-cost-audit.test-helpers";

/**
 * ISS-10833 — the zero-cost audit leaves out a metered session that recorded no
 * token usage and ended on a recorded provider error, and keeps paging on every
 * other zero-cost metered session.
 *
 * The audit counts the whole table, so each case reads the count before and
 * after seeding inside one rolled-back transaction and asserts the delta.
 */

const hasDatabase = !!keys().DATABASE_URL;

const PRICED_COST_USD = 0.68;

const COUNT_DELTAS: CountDelta[] = [
  ...STILL_COUNTED_ERROR_FLAG_CASES,
  {
    label: "is priced",
    shape: {
      endsWithError: false,
      inputTokens: RECORDED_INPUT_TOKENS,
      estimatedCost: PRICED_COST_USD,
    },
    delta: 0,
  },
];

describe.skipIf(!hasDatabase)("zero-cost sessions audit", () => {
  it("leaves out an error-ended session with no usage and counts its twin with no recorded error", async () => {
    await autoRollbackTransaction(async () => {
      const owner = await seedOwner();
      const baseline = await zeroCostSessions();

      const errorEnded = await seedMeteredSession(owner, {
        endsWithError: true,
      });
      const afterErrorEnded = await zeroCostSessions();
      expect(afterErrorEnded.count).toBe(baseline.count);
      expect(afterErrorEnded.sampleIds).not.toContain(errorEnded);

      await seedMeteredSession(owner, { endsWithError: false });
      expect((await zeroCostSessions()).count).toBe(baseline.count + 1);
    });
  });

  it.each(COUNT_DELTAS)(
    "a metered session that $label changes the count by $delta",
    async ({ shape, delta }) => {
      await autoRollbackTransaction(async () => {
        const owner = await seedOwner();
        const baseline = await zeroCostSessions();

        await seedMeteredSession(owner, shape);

        expect((await zeroCostSessions()).count).toBe(baseline.count + delta);
      });
    }
  );
});

function zeroCostSessions(): Promise<InvariantCheckResult> {
  return checkZeroCostMeteredSessions();
}

async function seedMeteredSession(
  owner: Owner,
  shape: SessionShape
): Promise<string> {
  const artifactId = await createTestSessionDetail({
    ...owner,
    label: "zero-cost-audit",
    endsWithError: shape.endsWithError,
    cost: {
      billingMode: METERED_BILLING_MODE,
      estimatedCost: shape.estimatedCost ?? null,
    },
  });
  await recordSessionWork(artifactId, shape);
  return artifactId;
}
