import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  type BranchSyncSource,
  getSharedBranchesPageData,
} from "../src/main/branch/shared-branches-api.js";
import {
  emptySharedBranchesPageDataResponse,
  SHARED_BRANCHES_SOURCE_ERROR_CODE,
} from "../src/shared/shared-branches-contract.js";
import {
  link,
  makeSource,
  rawQueryClientOf,
  SQL_SECRET,
  throwingSource,
} from "./shared-branches-test-helpers.js";

describe("getSharedBranchesPageData (FEA-3056 follow-up: combined list + analytics)", () => {
  test("returns the empty canonical pair for a missing source", async () => {
    assert.deepEqual(
      await getSharedBranchesPageData(null),
      emptySharedBranchesPageDataResponse()
    );
  });

  test("contributor cloud filter returns the empty canonical pair without touching the source", async () => {
    let queried = false;
    const source = makeSource({}, () => {
      queried = true;
    });

    assert.deepEqual(
      await getSharedBranchesPageData(source, { contributorUserId: "u1" }),
      emptySharedBranchesPageDataResponse()
    );
    assert.equal(queried, false);
  });

  test("a read failure rethrows a sanitized, code-only error (no SQL leak)", async () => {
    await assert.rejects(
      getSharedBranchesPageData(throwingSource),
      (err: Error) => {
        assert.equal(err.message, SHARED_BRANCHES_SOURCE_ERROR_CODE);
        assert.doesNotMatch(err.message, SQL_SECRET);
        return true;
      }
    );
  });

  // FEA-4177 whitlockk review: the analytics-only per-session usage read
  // (`readBranchAnalyticsTokenRows`, the no-billing-JOIN token read) must live in
  // the BEST-EFFORT analytics half. It previously ran in the outer fatal
  // `Promise.all`, so a failure there rejected the whole read and blanked the
  // list. Fail ONLY that read and prove the list still resolves with
  // `analyticsError: true` (and no `sessionCostUsd`, since the cost map derives
  // from the same failed read), while the shared list reads stay fatal.
  test("an analytics-token read failure degrades to analyticsError without blanking the list", async () => {
    const base = makeSource({
      links: [link({ branch_name: "a", session_id: "s1" })],
      usageTokens: [
        {
          session_id: "s1",
          model: "claude-sonnet-4-5",
          input_tokens: 10,
          output_tokens: 20,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cost_usd_estimated: 1.23,
        },
      ],
    });
    const baseClient = rawQueryClientOf(base);
    const baseQueryRaw = baseClient.$queryRawUnsafe.bind(baseClient);
    // Reject ONLY the analytics-path token read (no billing-mode JOIN); the
    // list's own token aggregate + link/PR/commit reads still succeed.
    const source = {
      ...base,
      prisma: {
        client: new Proxy(baseClient, {
          get: (target, prop) => {
            if (prop === "$queryRawUnsafe") {
              return (sql: string, ...args: unknown[]) => {
                // Both token reads now JOIN sessions (FEA-4270 added
                // `s.started_at` to the analytics path too), so the sessions JOIN
                // no longer distinguishes them. The analytics path is the one that
                // does NOT select `s.billing_mode` (the usage path's billing
                // split), so reject on that.
                if (
                  sql.includes("FROM token_usage tu") &&
                  !sql.includes("s.billing_mode")
                ) {
                  return Promise.reject(
                    new Error("analytics token read failed")
                  );
                }
                return baseQueryRaw(sql, ...args);
              };
            }
            return Reflect.get(target, prop);
          },
        }),
      },
    } as unknown as BranchSyncSource;

    const result = await getSharedBranchesPageData(source);

    assert.ok(result.list, "list should still resolve");
    assert.equal(result.list.total, 1);
    assert.equal(result.analytics, undefined);
    assert.equal(result.analyticsError, true);
    assert.equal(result.list.sessionCostUsd, undefined);
  });
});
