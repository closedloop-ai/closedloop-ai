/**
 * @file shared-agent-components-invocation-race.test.ts
 * @description ISS-5520 (#4716) — the desktop invocation-page reader's PRODUCER
 * boundary under a count that disagrees with the rows delivered beside it.
 *
 * Lives in its own file rather than in `shared-agent-components-api.test.ts`
 * because that suite is on `biome.jsonc`'s shrink-only file-size grandfather
 * list, so new coverage cannot be added to it. The seed helpers it needs moved
 * to `agent-components-test-fixtures.js` in the same change instead of being
 * duplicated here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { getAgentComponentDetailLocal } from "../src/main/dashboard/shared-agent-components-api.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  insertInvocations,
  insertUsage,
} from "./agent-components-test-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

/**
 * SQL unique to the status-count read that runs BESIDE the invocation row read.
 * The row query selects no aggregate, so this alias identifies the count half of
 * the `Promise.all` and nothing else.
 */
const INVOCATION_COUNT_SQL_SIGNATURE = "AS unmatched_count";

/**
 * Return an empty count for the invocation status-count read while every other
 * query still hits the ephemeral store — the observable result of a delete
 * landing between the two halves of that `Promise.all`.
 *
 * It has to be injected rather than seeded: the two reads are not in one
 * transaction, so the disagreement they can produce is precisely the state a
 * single consistent database cannot be put into.
 */
function withZeroedInvocationCount(prisma: DesktopPrisma): DesktopPrisma {
  const real = prisma.client.$queryRawUnsafe.bind(prisma.client);
  return {
    client: {
      $queryRawUnsafe: (query: string, ...params: unknown[]) =>
        query.includes(INVOCATION_COUNT_SQL_SIGNATURE)
          ? Promise.resolve([
              { total: 0, unmatched_count: 0, ambiguous_count: 0 },
            ])
          : real(query, ...params),
    },
  } as unknown as DesktopPrisma;
}

/**
 * ISS-5520 (wongk review, #4716) — the producer boundary the client's
 * incredible-count fallback stands on.
 *
 * This reader returned `undefined` on `total === 0`, and both call sites spread
 * it conditionally, so the key vanished from the payload and the tab rendered
 * "Evidence unavailable" — a claim that this source records no exact evidence
 * AT ALL. When the count races to zero beside rows that really were delivered,
 * that claim is false, and it took the zero endpoint of the client's
 * `total < delivered` fallback permanently out of reach on this surface: the
 * one state where the fallback matters most could never reach it.
 *
 * Rows in hand outrank a count that contradicts them. The page now survives, and
 * the client marks the population a floor from there.
 */
test("getAgentComponentDetailLocal keeps a delivered invocation page when the count races to zero", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertUsage(prisma, {
      sessionId: "s-racy-count",
      kind: AgentComponentInvocationKind.Skill,
      key: "ghost",
      invocations: 1,
    });
    await insertInvocations(prisma, [
      {
        id: "inv-racy",
        sessionId: "s-racy-count",
        componentKind: AgentComponentInvocationKind.Skill,
        componentKey: "ghost",
        anchorKind: AgentComponentInvocationAnchorKind.Session,
        anchorValue: "s-racy-count",
        status: AgentComponentInvocationAttributionStatus.Unresolved,
      },
    ]);

    // Control: with both halves agreeing, this component has a page. So a
    // missing page below could only come from the injected zero.
    const consistent = await getAgentComponentDetailLocal(
      prisma,
      "skill::ghost"
    );
    assert.equal(consistent?.invocationRows?.items.length, 1);

    const detail = await getAgentComponentDetailLocal(
      withZeroedInvocationCount(prisma),
      "skill::ghost"
    );

    assert.ok(
      detail?.invocationRows,
      "delivered rows must outlive a count that contradicts them"
    );
    assert.equal(detail.invocationRows.items.length, 1);
    assert.equal(detail.invocationRows.items[0].id, "inv-racy");
    // The count is reported as it arrived; deciding it is not credible is the
    // client's job, and it needs the page in order to do it.
    assert.equal(detail.invocationRows.total, 0);
  } finally {
    await close();
  }
});
