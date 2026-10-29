import { describe, expect, it, vi } from "vitest";
import { AGENT_SESSION_UPSERT_TX_TIMEOUT_MS } from "@/app/agent-sessions/service/ingest-work-budget";
import {
  acquirePullRequestProviderIdentityLocksInTransaction,
  pullRequestProviderLockHolderTxOptions,
  pullRequestProviderLockKey,
  pullRequestProviderLockTxOptions,
} from "./pull-request-provider-lock";

/** Prisma's interactive-transaction default, restated as the value being escaped. */
const PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS = 5000;

describe("pull request provider lock transaction bounds", () => {
  /**
   * ISS-7130: `pg_advisory_xact_lock` blocks inside the WAITER's transaction, so
   * a waiter allowed less time than a holder may run aborts with P2028 under
   * exactly the contention the lock exists for. The session-sync lane is the
   * longest-lived holder of this lock, so its ceiling is the floor here.
   */
  it("lets a waiter outlast the longest-lived holder of the same lock", () => {
    expect(
      pullRequestProviderLockHolderTxOptions.timeout
    ).toBeGreaterThanOrEqual(AGENT_SESSION_UPSERT_TX_TIMEOUT_MS);
    expect(pullRequestProviderLockTxOptions.timeout).toBeGreaterThan(
      PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS
    );
  });

  /**
   * The holder ceiling alone is not enough (davetho, #6454): a waiter's clock
   * starts at BEGIN, not when the lock is granted, so a bound equal to the
   * holder's leaves the waiter's own pre-/post-lock work nothing and still loses
   * the write to P2028 whenever a holder runs near its ceiling.
   *
   * This is also what keeps the derivation from closing on itself. Put a
   * long-batch HOLDER on the waiter bound and the maximum holder lifetime
   * becomes the waiter bound, so the margin silently evaporates — which is why
   * the holder ceiling is asserted above as an independent value rather than as
   * whatever the waiter happens to carry.
   */
  it("reserves the waiter's own work budget beyond that holder ceiling", () => {
    expect(
      pullRequestProviderLockTxOptions.timeout -
        pullRequestProviderLockHolderTxOptions.timeout
    ).toBeGreaterThanOrEqual(PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS);
  });

  it("bounds connection acquisition without spending the lock wait on it", () => {
    expect(pullRequestProviderLockTxOptions.maxWait).toBeLessThan(
      pullRequestProviderLockTxOptions.timeout
    );
    expect(pullRequestProviderLockHolderTxOptions.maxWait).toBeLessThan(
      pullRequestProviderLockHolderTxOptions.timeout
    );
  });
});

const ORGANIZATION_ID = "019ff900-3000-7000-8000-000000000001";

/**
 * `en_US.utf8` ignores the hyphen at the first comparison level, so it puts
 * `symphonya` BEFORE `closedloop-ai`; JavaScript's code-unit sort puts it
 * after. Passed in the collation's order, the fixture only comes out in JS
 * order if JS did the sorting.
 */
const COLLATION_ORDERED_IDENTITIES = [
  {
    organizationId: ORGANIZATION_ID,
    repositoryFullName: "closedloop-ai/symphonya",
    number: 1,
  },
  {
    organizationId: ORGANIZATION_ID,
    repositoryFullName: "closedloop-ai/closedloop-ai",
    number: 1,
  },
] as const;

function lockTx() {
  return { $executeRaw: vi.fn().mockResolvedValue(1) };
}

describe("acquirePullRequestProviderIdentityLocksInTransaction (ISS-11608)", () => {
  it("issues no statement for no identities", async () => {
    const tx = lockTx();

    await acquirePullRequestProviderIdentityLocksInTransaction(tx, []);

    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("keeps the single-key statement for one identity", async () => {
    const tx = lockTx();
    const [identity] = COLLATION_ORDERED_IDENTITIES;

    await acquirePullRequestProviderIdentityLocksInTransaction(tx, [
      identity,
      identity,
    ]);

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const [template, key] = tx.$executeRaw.mock.calls[0];
    expect(template.join("")).toContain(
      "pg_advisory_xact_lock(hashtextextended("
    );
    expect(key).toBe(pullRequestProviderLockKey(identity));
  });

  it("takes two or more keys in one ordered call, deduplicated and JS-sorted", async () => {
    const tx = lockTx();
    const [symphonya, closedloopAi] = COLLATION_ORDERED_IDENTITIES;

    await acquirePullRequestProviderIdentityLocksInTransaction(tx, [
      symphonya,
      closedloopAi,
      symphonya,
    ]);

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const [template, keys] = tx.$executeRaw.mock.calls[0];
    const sql = template.join("");
    expect(sql).toContain("advisory_xact_lock_text_keys_in_order(");
    expect(sql).not.toContain("ORDER BY");
    expect(keys).toEqual([
      pullRequestProviderLockKey(closedloopAi),
      pullRequestProviderLockKey(symphonya),
    ]);
  });
});
