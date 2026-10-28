/**
 * @file sqlite-cov-iss11283-boot-maintenance.test.ts
 * @description ISS-11283: the boot-chain REPORT lines `openSqliteAgentDatabase`
 * logs when its sweeps and owner claim find work that is not a plain success —
 * a retention purge, a past-window session kept because the cloud is still owed
 * it, a stale session held back because its timestamps cannot be compared, and
 * an owner claim refused because the store holds another account's sessions.
 *
 * Each case seeds a real migrated store, closes it, and re-opens the same data
 * dir so the chain runs exactly as it does at app start. The negative checks in
 * each case pin that a line is written ONLY when its count is non-zero.
 */
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterEach, describe, expect, it } from "vitest";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  linesStartingWith,
  makeStoreDir,
  readSession,
  type StoreDir,
  sessionRow,
} from "./sqlite-cov-iss11283-harness.js";

// Past the default 90-day window relative to BOOT_NOW (2026-06-22).
const EXPIRED_ACTIVITY = "2026-01-01T00:00:00.000Z";
// Older than the 180-minute stale cutoff relative to BOOT_NOW.
const STALE_UPDATED_AT = "2026-06-22T08:00:00.000Z";
const STALE_ACTIVITY = "2026-06-22T07:30:00.000Z";
const RECENT_ACTIVITY = "2026-06-22T11:30:00.000Z";

const PURGED_LINE = "boot: purged 1 session(s) past the retention window";
const KEPT_LINE =
  "boot: kept 1 session(s) past the retention window that still owe the cloud a delivery (pending sync outbox row)";
const HELD_BACK_LINE =
  "boot: held back 1 stale session(s) with non-canonical timestamps the format heal did not repair; they stay active";
const FOREIGN_OWNER_LINE =
  "boot: left unowned sessions unattributed — this store also holds another account's sessions, and local evidence cannot say which account the unowned ones belong to";

const PURGED_PREFIX = "boot: purged ";
const KEPT_PREFIX = "boot: kept ";
const HELD_BACK_PREFIX = "boot: held back ";
const SWEPT_PREFIX = "boot: swept ";
const FOREIGN_OWNER_PREFIX = "boot: left unowned sessions unattributed";
const ATTRIBUTED_PREFIX = "boot: attributed ";

const OUTBOX_SOURCE_KEY = "compute-target-iss11283";

function outboxRow(sessionId: string) {
  return [
    `INSERT INTO agent_session_sync_outbox
       (source_key, external_session_id, status, sync_class, attempt_count,
        next_attempt_at, last_error, created_at, updated_at)
     VALUES ($1, $2, $3, 'backfill', 0, NULL, NULL, $4, $4)`,
    OUTBOX_SOURCE_KEY,
    sessionId,
    OutboxStatus.Pending,
    EXPIRED_ACTIVITY,
  ] as const;
}

let store: StoreDir | undefined;

afterEach(async () => {
  await store?.dispose();
  store = undefined;
});

describe("openSqliteAgentDatabase boot report lines (ISS-11283)", () => {
  it("reports the retention purge and the past-window sessions it kept for an undelivered outbox row", async () => {
    store = await makeStoreDir("retention");
    await store.seed([
      sessionRow({
        id: "expired-delivered",
        status: SESSION_STATUS.INACTIVE,
        updatedAt: EXPIRED_ACTIVITY,
        lastActivityAt: EXPIRED_ACTIVITY,
      }),
      sessionRow({
        id: "expired-owed",
        status: SESSION_STATUS.INACTIVE,
        updatedAt: EXPIRED_ACTIVITY,
        lastActivityAt: EXPIRED_ACTIVITY,
      }),
      outboxRow("expired-owed"),
    ]);

    const { database, lines } = await store.boot();

    expect(linesStartingWith(lines, PURGED_PREFIX)).toEqual([PURGED_LINE]);
    expect(linesStartingWith(lines, KEPT_PREFIX)).toEqual([KEPT_LINE]);
    expect(await readSession(database, "expired-delivered")).toBeUndefined();
    expect((await readSession(database, "expired-owed"))?.status).toBe(
      SESSION_STATUS.INACTIVE
    );
  });

  it("holds back a stale active session whose started_at the format heal cannot parse, and says so", async () => {
    store = await makeStoreDir("held-back");
    await store.seed([
      sessionRow({
        id: "unparseable-start",
        status: SESSION_STATUS.ACTIVE,
        updatedAt: STALE_UPDATED_AT,
        lastActivityAt: STALE_ACTIVITY,
        // Offset-shaped but not a real instant: the heal leaves it as-is, and
        // the sweep's floor comparison cannot be made soundly against it.
        startedAt: "2026-13-45T99:99:99+05:00",
      }),
    ]);

    const { database, lines } = await store.boot();

    expect(linesStartingWith(lines, HELD_BACK_PREFIX)).toEqual([
      HELD_BACK_LINE,
    ]);
    expect(linesStartingWith(lines, SWEPT_PREFIX)).toEqual([]);
    expect((await readSession(database, "unparseable-start"))?.status).toBe(
      SESSION_STATUS.ACTIVE
    );
    // Nothing crossed the retention window and no identity was offered, so
    // neither of those report lines may appear.
    expect(linesStartingWith(lines, PURGED_PREFIX)).toEqual([]);
    expect(linesStartingWith(lines, KEPT_PREFIX)).toEqual([]);
    expect(linesStartingWith(lines, FOREIGN_OWNER_PREFIX)).toEqual([]);
  });

  it("leaves unowned sessions unattributed when the store already holds another account's session", async () => {
    store = await makeStoreDir("foreign-owner");
    await store.seed([
      sessionRow({
        id: "someone-elses",
        status: SESSION_STATUS.INACTIVE,
        updatedAt: RECENT_ACTIVITY,
        lastActivityAt: RECENT_ACTIVITY,
        userId: "user-other",
        organizationId: "org-other",
      }),
      sessionRow({
        id: "unowned",
        status: SESSION_STATUS.INACTIVE,
        updatedAt: RECENT_ACTIVITY,
        lastActivityAt: RECENT_ACTIVITY,
      }),
    ]);

    const { database, lines } = await store.boot({
      getUserIdentity: () => ({ userId: "user-me", organizationId: "org-me" }),
    });

    expect(linesStartingWith(lines, FOREIGN_OWNER_PREFIX)).toEqual([
      FOREIGN_OWNER_LINE,
    ]);
    expect(linesStartingWith(lines, ATTRIBUTED_PREFIX)).toEqual([]);
    expect((await readSession(database, "unowned"))?.user_id).toBeNull();
    expect(linesStartingWith(lines, HELD_BACK_PREFIX)).toEqual([]);
  });

  it("attributes unowned sessions without the foreign-owner line when no other account is present", async () => {
    store = await makeStoreDir("claim-ok");
    await store.seed([
      sessionRow({
        id: "unowned",
        status: SESSION_STATUS.INACTIVE,
        updatedAt: RECENT_ACTIVITY,
        lastActivityAt: RECENT_ACTIVITY,
      }),
    ]);

    const { database, lines } = await store.boot({
      getUserIdentity: () => ({ userId: "user-me", organizationId: "org-me" }),
    });

    expect(linesStartingWith(lines, ATTRIBUTED_PREFIX)).toEqual([
      "boot: attributed 1 previously unowned session(s)",
    ]);
    expect(linesStartingWith(lines, FOREIGN_OWNER_PREFIX)).toEqual([]);
    expect((await readSession(database, "unowned"))?.user_id).toBe("user-me");
  });
});
