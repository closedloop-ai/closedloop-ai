/**
 * @file sqlite-cov-iss11283-boot-faults.test.ts
 * @description ISS-11283: every boot-chain step in `openSqliteAgentDatabase` is
 * `.catch`-isolated so one failing pass costs its own work and never the open.
 * These cases make each step fail against a REAL store — a SQLite trigger that
 * refuses the step's write, or a store missing the table its discovery query
 * reads — and pin what the boot does about it: the log line it writes, whether
 * the sweeps that depend on the floor heal still run, and that the open still
 * resolves with the refused row left untouched.
 */

import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterEach, describe, expect, it } from "vitest";
import {
  linesStartingWith,
  makeStoreDir,
  readSession,
  type SeedStatement,
  type StoreDir,
  sessionRow,
} from "./sqlite-cov-iss11283-harness.js";

const REFUSED = "iss11283 refused this write";
const STALE_UPDATED_AT = "2026-06-22T08:00:00.000Z";
const STALE_ACTIVITY = "2026-06-22T07:30:00.000Z";
const EXPIRED_ACTIVITY = "2026-01-01T00:00:00.000Z";
const RECENT_ACTIVITY = "2026-06-22T11:30:00.000Z";

const SKIP_SWEEPS_LINE =
  "boot: skipping orphan + retention sweeps — the last-activity floor heal did not complete, and sweeping unhealed rows could stamp pre-start ended_at values or purge rows by corrupted timestamps; both retry next boot";
const FLOOR_HEAL_FAILED_PREFIX = "boot: last-activity floor heal failed: ";
const FLOORED_PREFIX = "boot: floored ";
const ORPHAN_SWEEP_FAILED_PREFIX = "boot: orphaned-session sweep failed: ";
const RETENTION_FAILED_PREFIX = "boot: retention sweep failed: ";
const CLAIM_FAILED_PREFIX = "boot: session owner claim failed: ";
const SWEPT_PREFIX = "boot: swept ";
const ERROR_CLASS_PREFIX = /^\w*Error: /;
const NON_EMPTY = /\S/;

function refuseTrigger(name: string, when: string): SeedStatement {
  return [
    `CREATE TRIGGER ${name} ${when} BEGIN SELECT RAISE(ABORT, '${REFUSED}'); END`,
  ];
}

function staleOrphan(id: string): SeedStatement {
  return sessionRow({
    id,
    status: SESSION_STATUS.ACTIVE,
    updatedAt: STALE_UPDATED_AT,
    lastActivityAt: STALE_ACTIVITY,
  });
}

/**
 * The text each `prefix` line carries after the prefix. The boot writes the
 * error's MESSAGE there — never `String(error)`, whose `<Name>Error: ` lead
 * would mean the `instanceof Error` arm was not taken; each case pins that.
 */
function failureMessages(lines: string[], prefix: string): string[] {
  return linesStartingWith(lines, prefix).map((line) =>
    line.slice(prefix.length)
  );
}

let store: StoreDir | undefined;

afterEach(async () => {
  await store?.dispose();
  store = undefined;
});

describe("openSqliteAgentDatabase boot-chain fault isolation (ISS-11283)", () => {
  it("skips both sweeps when a floor-heal chunk is refused, leaving a stale session active", async () => {
    store = await makeStoreDir("floor-chunk");
    await store.seed([
      // last_activity_at before started_at: the floor heal selects this row.
      sessionRow({
        id: "pre-start-activity",
        status: SESSION_STATUS.INACTIVE,
        updatedAt: RECENT_ACTIVITY,
        lastActivityAt: "2026-06-22T09:00:00.000Z",
        startedAt: "2026-06-22T10:00:00.000Z",
      }),
      staleOrphan("stale-orphan"),
      refuseTrigger(
        "iss11283_refuse_floor",
        "BEFORE UPDATE OF last_activity_at ON sessions"
      ),
    ]);

    const { database, lines } = await store.boot();

    expect(linesStartingWith(lines, SKIP_SWEEPS_LINE)).toEqual([
      SKIP_SWEEPS_LINE,
    ]);
    // The chunk failed inside the heal, which RESOLVED — so neither the
    // "floored" success line nor the whole-heal failure line is written.
    expect(linesStartingWith(lines, FLOORED_PREFIX)).toEqual([]);
    expect(linesStartingWith(lines, FLOOR_HEAL_FAILED_PREFIX)).toEqual([]);
    expect(linesStartingWith(lines, SWEPT_PREFIX)).toEqual([]);
    expect((await readSession(database, "stale-orphan"))?.status).toBe(
      SESSION_STATUS.ACTIVE
    );
  });

  it("logs a floor heal whose discovery query throws, and skips both sweeps", async () => {
    store = await makeStoreDir("floor-throw");
    await store.seed([
      staleOrphan("stale-orphan"),
      // The discovery query reads `events`; a store without it makes the whole
      // heal reject rather than fail a chunk.
      ["ALTER TABLE events RENAME TO events_hidden_iss11283"],
    ]);

    const { database, lines } = await store.boot();

    const messages = failureMessages(lines, FLOOR_HEAL_FAILED_PREFIX);
    expect(messages).toEqual([
      expect.stringContaining("no such table: events"),
    ]);
    expect(messages[0]).not.toMatch(ERROR_CLASS_PREFIX);
    expect(linesStartingWith(lines, SKIP_SWEEPS_LINE)).toEqual([
      SKIP_SWEEPS_LINE,
    ]);
    expect((await readSession(database, "stale-orphan"))?.status).toBe(
      SESSION_STATUS.ACTIVE
    );
  });

  it("logs a refused orphan sweep and still opens with the stale session active", async () => {
    store = await makeStoreDir("orphan-refused");
    await store.seed([
      staleOrphan("stale-orphan"),
      refuseTrigger(
        "iss11283_refuse_status",
        "BEFORE UPDATE OF status ON sessions WHEN NEW.status <> OLD.status"
      ),
    ]);

    const { database, lines } = await store.boot();

    const messages = failureMessages(lines, ORPHAN_SWEEP_FAILED_PREFIX);
    expect(messages).toEqual([expect.stringContaining(REFUSED)]);
    expect(messages[0]).not.toMatch(ERROR_CLASS_PREFIX);
    expect(linesStartingWith(lines, SKIP_SWEEPS_LINE)).toEqual([]);
    expect((await readSession(database, "stale-orphan"))?.status).toBe(
      SESSION_STATUS.ACTIVE
    );
  });

  it("logs a refused retention purge and keeps the expired session", async () => {
    store = await makeStoreDir("retention-refused");
    await store.seed([
      sessionRow({
        id: "expired",
        status: SESSION_STATUS.INACTIVE,
        updatedAt: EXPIRED_ACTIVITY,
        lastActivityAt: EXPIRED_ACTIVITY,
      }),
      refuseTrigger("iss11283_refuse_delete", "BEFORE DELETE ON sessions"),
    ]);

    const { database, lines } = await store.boot();

    // A typed-delegate failure: Prisma rewords the trigger's RAISE text, so the
    // refusal is proven by the surviving row rather than by the message.
    const messages = failureMessages(lines, RETENTION_FAILED_PREFIX);
    expect(messages).toEqual([expect.stringMatching(NON_EMPTY)]);
    expect(messages[0]).not.toMatch(ERROR_CLASS_PREFIX);
    expect((await readSession(database, "expired"))?.status).toBe(
      SESSION_STATUS.INACTIVE
    );
  });

  it("logs a refused owner claim and leaves the unowned session unowned", async () => {
    store = await makeStoreDir("claim-refused");
    await store.seed([
      sessionRow({
        id: "unowned",
        status: SESSION_STATUS.INACTIVE,
        updatedAt: RECENT_ACTIVITY,
        lastActivityAt: RECENT_ACTIVITY,
      }),
      refuseTrigger(
        "iss11283_refuse_owner",
        "BEFORE UPDATE OF user_id ON sessions"
      ),
    ]);

    const { database, lines } = await store.boot({
      getUserIdentity: () => ({ userId: "user-me", organizationId: "org-me" }),
    });

    const messages = failureMessages(lines, CLAIM_FAILED_PREFIX);
    expect(messages).toEqual([expect.stringContaining(REFUSED)]);
    expect(messages[0]).not.toMatch(ERROR_CLASS_PREFIX);
    expect((await readSession(database, "unowned"))?.user_id).toBeNull();
  });
});
