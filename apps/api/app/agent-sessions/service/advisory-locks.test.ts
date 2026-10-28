import { describe, expect, it, vi } from "vitest";
import { IndexKeyOrigin } from "@/lib/index-key-lookup";
import {
  INDEX_KEY_MAX_BYTES,
  projectIndexKey,
} from "@/lib/index-key-projection";
import {
  acquireSessionAdvisoryLocks,
  acquireSessionArtifactLinksAdvisoryLock,
} from "./advisory-locks";

const ORGANIZATION_ID = "019ff900-1000-7000-8000-000000000001";
const SESSION_ARTIFACT_ID = "019ff900-1000-7000-8000-000000000002";
const OTHER_SESSION_ARTIFACT_ID = "019ff900-1000-7000-8000-000000000004";

function lockTx() {
  return { $executeRaw: vi.fn().mockResolvedValue(1) };
}

/**
 * The interpolated identity of each `$executeRaw` call, in call order: a tagged
 * template, so `calls[i][1]` is the first interpolated value.
 */
function lockedIdentities(tx: ReturnType<typeof lockTx>): string[] {
  return tx.$executeRaw.mock.calls.map((call) => call[1] as string);
}

/**
 * ISS-11608: one Session key per transaction. The ingest reaches this lock from
 * the branch lane, the PR-link lane and the per-PR-branch writer in ONE
 * transaction, so a repeat must cost no statement.
 */
describe("acquireSessionArtifactLinksAdvisoryLock", () => {
  it("issues one statement for the first call in a transaction", async () => {
    const tx = lockTx();

    await acquireSessionArtifactLinksAdvisoryLock(tx, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
    });

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const [identity] = lockedIdentities(tx);
    expect(identity).toContain(ORGANIZATION_ID);
    expect(identity).toContain(SESSION_ARTIFACT_ID);
  });

  it("issues no statement for a repeat call on the same transaction", async () => {
    const tx = lockTx();
    const input = {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
    };

    await acquireSessionArtifactLinksAdvisoryLock(tx, input);
    await acquireSessionArtifactLinksAdvisoryLock(tx, input);
    await acquireSessionArtifactLinksAdvisoryLock(tx, { ...input });

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("issues the statement again on a different transaction", async () => {
    const first = lockTx();
    const second = lockTx();
    const input = {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
    };

    await acquireSessionArtifactLinksAdvisoryLock(first, input);
    await acquireSessionArtifactLinksAdvisoryLock(second, input);

    expect(first.$executeRaw).toHaveBeenCalledTimes(1);
    expect(second.$executeRaw).toHaveBeenCalledTimes(1);
    expect(lockedIdentities(second)).toEqual(lockedIdentities(first));
  });

  it("takes each Session's own key when two share one transaction", async () => {
    const tx = lockTx();

    await acquireSessionArtifactLinksAdvisoryLock(tx, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
    });
    await acquireSessionArtifactLinksAdvisoryLock(tx, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: OTHER_SESSION_ARTIFACT_ID,
    });

    const identities = lockedIdentities(tx);
    expect(identities).toHaveLength(2);
    expect(identities[0]).toContain(SESSION_ARTIFACT_ID);
    expect(identities[1]).toContain(OTHER_SESSION_ARTIFACT_ID);
  });

  it("scopes the Session identity to the organization", async () => {
    // Two sessions with the same artifact id in different orgs must not share a
    // lock identity, or one org's writer would serialize against another's.
    const tx = lockTx();

    await acquireSessionArtifactLinksAdvisoryLock(tx, {
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
    });
    await acquireSessionArtifactLinksAdvisoryLock(tx, {
      organizationId: "019ff900-1000-7000-8000-0000000000ff",
      sessionArtifactId: SESSION_ARTIFACT_ID,
    });

    const [first, second] = lockedIdentities(tx);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });
});

/**
 * ISS-8200: the per-SESSION locks, which must serialize the ingest against the
 * stale reaper for the sessions ISS-8069 re-keyed.
 *
 * The two callers hold DIFFERENT strings for one identity — the ingest has the
 * RAW wire id (`session-slice-identity.ts`), the reaper has the DB-read one
 * (`stale-session-reaper-service.ts`) — and `hashtext` of two different strings
 * is two different lock slots, so they stopped excluding each other entirely.
 */
const OVER_BUDGET_SESSION_ID = "s".repeat(INDEX_KEY_MAX_BYTES + 1);
const PROJECTED_SESSION_ID = projectIndexKey(OVER_BUDGET_SESSION_ID).value;
const IN_BUDGET_SESSION_ID = "019ff900-1000-7000-8000-000000000003";

describe("acquireSessionAdvisoryLocks", () => {
  it("locks both candidate keys for an over-budget id, sorted, old-then-new within each", async () => {
    const tx = lockTx();

    await acquireSessionAdvisoryLocks(
      tx as never,
      OVER_BUDGET_SESSION_ID,
      IndexKeyOrigin.Wire
    );

    // Two keys x two lock flavours. Dropping the candidate set makes this 2.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(4);
    const identities = lockedIdentities(tx);
    const expectedOrder = [PROJECTED_SESSION_ID, OVER_BUDGET_SESSION_ID].sort();
    // Sorted, not candidate order: a GLOBAL total order over the keys is what
    // keeps two transactions holding overlapping sets from deadlocking.
    expect(identities).toEqual([
      expectedOrder[0],
      expectedOrder[0],
      expectedOrder[1],
      expectedOrder[1],
    ]);
    const [legacyFirst, currentFirst] = tx.$executeRaw.mock.calls;
    expect(legacyFirst[0].join("")).toContain("hashtext(");
    expect(currentFirst[0].join("")).toContain("hashtextextended(");
  });

  it("gives the ingest and the reaper OVERLAPPING lock sets for one identity", async () => {
    // THE DEFECT. The ingest locks on the raw wire id; the reaper locks on what
    // the column stores, which for this session is the projected key. Before
    // this change those were disjoint slots and both writers held the row at
    // once. Locking the candidate set makes the two sets intersect whichever
    // value each side happens to hold.
    const ingest = lockTx();
    const reaper = lockTx();

    await acquireSessionAdvisoryLocks(
      ingest as never,
      OVER_BUDGET_SESSION_ID,
      IndexKeyOrigin.Wire
    );
    await acquireSessionAdvisoryLocks(
      reaper as never,
      PROJECTED_SESSION_ID,
      IndexKeyOrigin.Stored
    );

    const ingestKeys = new Set(lockedIdentities(ingest));
    const reaperKeys = lockedIdentities(reaper);
    expect(reaperKeys.length).toBeGreaterThan(0);
    expect(reaperKeys.some((key) => ingestKeys.has(key))).toBe(true);
  });

  it("still takes exactly the two locks for an id inside the byte budget", async () => {
    // Every real session id, so the common path must not have gained a lock.
    const tx = lockTx();

    await acquireSessionAdvisoryLocks(
      tx as never,
      IN_BUDGET_SESSION_ID,
      IndexKeyOrigin.Wire
    );

    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(lockedIdentities(tx)).toEqual([
      IN_BUDGET_SESSION_ID,
      IN_BUDGET_SESSION_ID,
    ]);
  });
});
