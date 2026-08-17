/**
 * @file session-owner-identity.test.ts
 * @description ISS-6168 DB-backed regression coverage for session owner
 * attribution.
 *
 * Three writers can CREATE a `sessions` row. The live hook bound
 * `user_id`/`organization_id`; the transcript importer and the Codex OTel batch
 * writer did not — so on a machine whose sessions all come from the importer
 * (the normal case) every row persisted a NULL owner and the Owner column, Owner
 * facet, Branches Owner column and `byUser` rollup were blank for the whole
 * corpus, while web resolved the same sessions fine.
 *
 * These tests drive the REAL `createSqliteImporter.importSession`, the REAL
 * `persistCodexOtelBatch`, and the REAL boot wiring inside
 * `openSqliteAgentDatabase` against a live libSQL store, and assert the
 * PERSISTED row — not a call on a mock. The fix is a column that reaches disk or
 * it is nothing, and the boot claim is only a fix if the boot path actually runs
 * it.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createSqliteTokenUsageStore } from "../src/main/database/read-stores.js";
import { runRebuildSessionTransaction } from "../src/main/database/rebuild-session-tx.js";
import {
  claimUnownedSessionIdentity,
  type SessionIdentity,
  SessionOwnerClaimSkip,
} from "../src/main/database/session-owner-identity.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { createSqliteImporter } from "../src/main/database/write-core.js";
import { persistCodexOtelBatch } from "../src/main/otel/codex-otel-writer.js";
import { makeSession } from "./normalized-session-test-utils.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

const NOW = "2026-08-12T12:00:00.000Z";
const STARTED_AT = "2026-08-12T11:00:00.000Z";
const ENDED_AT = "2026-08-12T11:30:00.000Z";
/** Well before RECENT_ACTIVITY_MS of NOW, so the import resolves as terminal. */
const OLD_FILE_MTIME_MS = Date.parse("2026-08-11T00:00:00.000Z");

const SIGNED_IN: SessionIdentity = {
  userId: "u-mike",
  organizationId: "org-closedloop",
};

type OwnerRow = {
  user_id: string | null;
  organization_id: string | null;
  updated_at: string | null;
};

function importerFor(
  h: OpenTestPrisma,
  getUserIdentity?: () => SessionIdentity | null
) {
  return createSqliteImporter(h.prisma, createSqliteTokenUsageStore(h.prisma), {
    detectBillingMode: () => "metered_api",
    getUserIdentity,
    now: () => NOW,
    log: () => {
      // discarded — no test here asserts on import log output
    },
  });
}

async function readOwner(
  h: OpenTestPrisma,
  sessionId: string
): Promise<OwnerRow | undefined> {
  const rows = await h.prisma.client.$queryRawUnsafe<OwnerRow[]>(
    "SELECT user_id, organization_id, updated_at FROM sessions WHERE id = $1",
    sessionId
  );
  return rows[0];
}

function seedUnownedSession(
  h: OpenTestPrisma,
  sessionId: string,
  userId: string | null = null,
  organizationId: string | null = null
): Promise<unknown> {
  return h.prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO sessions (id, name, status, cwd, started_at, updated_at, harness, user_id, organization_id)
       VALUES ($1, $1, 'inactive', '/sandbox/project', $2, $3, 'claude', $4, $5)`,
      sessionId,
      STARTED_AT,
      NOW,
      userId,
      organizationId
    )
  );
}

test("ISS-6168: the transcript importer stamps the signed-in owner on the session row", async () => {
  const h = await openTestPrisma();
  try {
    const importer = importerFor(h, () => SIGNED_IN);
    const result = await importer.importSession(
      makeSession({
        sessionId: "imported-owned",
        cwd: "/sandbox/project",
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        fileModifiedAt: OLD_FILE_MTIME_MS,
      }),
      "claude"
    );
    assert.equal(result.skipped, false);

    const row = await readOwner(h, "imported-owned");
    assert.equal(
      row?.user_id,
      SIGNED_IN.userId,
      "the imported session persists the signed-in user_id"
    );
    assert.equal(
      row?.organization_id,
      SIGNED_IN.organizationId,
      "the imported session persists the signed-in organization_id"
    );
  } finally {
    await h.close();
  }
});

test("ISS-6168: an import with no signed-in identity persists a NULL owner rather than inventing one", async () => {
  const h = await openTestPrisma();
  try {
    const importer = importerFor(h, () => null);
    await importer.importSession(
      makeSession({
        sessionId: "imported-signed-out",
        cwd: "/sandbox/project",
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        fileModifiedAt: OLD_FILE_MTIME_MS,
      }),
      "claude"
    );

    const row = await readOwner(h, "imported-signed-out");
    assert.equal(row?.user_id, null);
    assert.equal(row?.organization_id, null);
  } finally {
    await h.close();
  }
});

test("ISS-6168: a throwing identity provider degrades to a NULL owner instead of failing the import", async () => {
  const h = await openTestPrisma();
  try {
    const importer = importerFor(h, () => {
      throw new Error("identity store unavailable");
    });
    const result = await importer.importSession(
      makeSession({
        sessionId: "imported-provider-throws",
        cwd: "/sandbox/project",
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        fileModifiedAt: OLD_FILE_MTIME_MS,
      }),
      "claude"
    );
    assert.equal(result.skipped, false, "the session still imports");
    const row = await readOwner(h, "imported-provider-throws");
    assert.equal(row?.user_id, null);
  } finally {
    await h.close();
  }
});

test("ISS-6168: the boot claim attributes previously unowned sessions to the signed-in user", async () => {
  const h = await openTestPrisma();
  try {
    await seedUnownedSession(h, "legacy-a");
    await seedUnownedSession(h, "legacy-b");

    const result = await claimUnownedSessionIdentity(h.prisma, SIGNED_IN);
    assert.equal(result.claimed, 2);
    assert.equal(result.skipped, null);

    for (const id of ["legacy-a", "legacy-b"]) {
      const row = await readOwner(h, id);
      assert.equal(row?.user_id, SIGNED_IN.userId, id);
      assert.equal(row?.organization_id, SIGNED_IN.organizationId, id);
      assert.equal(
        row?.updated_at,
        NOW,
        "the claim must not bump the local→cloud sync watermark"
      );
    }
  } finally {
    await h.close();
  }
});

test("ISS-6168: the boot claim refuses to reattribute when the store also holds another account's sessions", async () => {
  const h = await openTestPrisma();
  try {
    await seedUnownedSession(h, "other-account", "u-someone-else");
    await seedUnownedSession(h, "legacy-unowned");

    const result = await claimUnownedSessionIdentity(h.prisma, SIGNED_IN);
    assert.equal(result.claimed, 0);
    assert.equal(result.skipped, SessionOwnerClaimSkip.ForeignOwnerPresent);

    const unowned = await readOwner(h, "legacy-unowned");
    assert.equal(
      unowned?.user_id,
      null,
      "an unowned row stays unattributed rather than being claimed by the wrong account"
    );
    const other = await readOwner(h, "other-account");
    assert.equal(
      other?.user_id,
      "u-someone-else",
      "the other account is intact"
    );
  } finally {
    await h.close();
  }
});

test("ISS-6168: the boot claim invents no owner when nobody is signed in", async () => {
  const h = await openTestPrisma();
  try {
    await seedUnownedSession(h, "legacy-unowned");

    const result = await claimUnownedSessionIdentity(h.prisma, {
      userId: null,
      organizationId: null,
    });
    assert.equal(result.claimed, 0);
    assert.equal(result.skipped, SessionOwnerClaimSkip.NoIdentity);
    assert.equal((await readOwner(h, "legacy-unowned"))?.user_id, null);
  } finally {
    await h.close();
  }
});

test("ISS-6168: the boot claim re-runs safely against a store this user already owns", async () => {
  const h = await openTestPrisma();
  try {
    await seedUnownedSession(h, "already-mine", SIGNED_IN.userId);
    await seedUnownedSession(h, "legacy-unowned");

    const first = await claimUnownedSessionIdentity(h.prisma, SIGNED_IN);
    assert.equal(first.claimed, 1, "only the unowned row is claimed");

    const second = await claimUnownedSessionIdentity(h.prisma, SIGNED_IN);
    assert.equal(second.claimed, 0, "the second boot is a no-op");
    assert.equal(second.skipped, null);
  } finally {
    await h.close();
  }
});

/**
 * Opens a REAL store through the production entry point, so the assertions below
 * cover the boot WIRING (`openSqliteAgentDatabase` invoking the claim), not just
 * the claim helper in isolation. `seed` runs against the same file BEFORE the
 * store opens, which is the only way to present the boot pass with rows that
 * already exist — exactly the pre-fix corpus this ticket repairs.
 */
async function withBootedStore(
  getUserIdentity: (() => SessionIdentity | null) | undefined,
  seed: (dataDir: string) => Promise<void>,
  assertions: (
    db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>
  ) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6168-boot-"));
  const dataDir = path.join(dir, "agent-dashboard.sqlite");
  await seed(dataDir);
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    getUserIdentity,
    now: () => NOW,
  });
  try {
    await assertions(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Insert an unowned session into a store that is not currently open. */
async function seedUnownedSessionAt(
  dataDir: string,
  sessionId: string,
  userId: string | null = null
): Promise<void> {
  const seeded = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    await seeded.run(
      `INSERT INTO sessions (id, name, status, cwd, started_at, updated_at, harness, user_id)
       VALUES ($1, $1, 'inactive', '/sandbox/project', $2, $3, 'claude', $4)`,
      sessionId,
      STARTED_AT,
      NOW,
      userId
    );
  } finally {
    await seeded.close();
  }
}

test("ISS-6168: opening the store runs the owner claim — the boot wiring, not just the helper", async () => {
  await withBootedStore(
    () => SIGNED_IN,
    (dataDir) => seedUnownedSessionAt(dataDir, "booted-unowned"),
    async (db) => {
      const row = await db.sessions.getById("booted-unowned");
      assert.equal(
        row?.userId,
        SIGNED_IN.userId,
        "openSqliteAgentDatabase must claim the pre-existing unowned row"
      );
      assert.equal(row?.organizationId, SIGNED_IN.organizationId);
    }
  );
});

test("ISS-6168: opening the store with nobody signed in leaves the row unattributed", async () => {
  await withBootedStore(
    () => null,
    (dataDir) => seedUnownedSessionAt(dataDir, "booted-signed-out"),
    async (db) => {
      const row = await db.sessions.getById("booted-signed-out");
      assert.equal(row?.userId, null);
    }
  );
});

test("ISS-6168: a throwing identity provider does not fail the database open", async () => {
  await withBootedStore(
    () => {
      throw new Error("identity store unavailable");
    },
    (dataDir) => seedUnownedSessionAt(dataDir, "booted-provider-throws"),
    async (db) => {
      const row = await db.sessions.getById("booted-provider-throws");
      assert.equal(
        row?.userId,
        null,
        "attribution is skipped, but the store still opened"
      );
    }
  );
});

test("ISS-6168: an identity arriving after open repairs the corpus via claimSessionOwnerIdentity", async () => {
  await withBootedStore(
    () => null,
    (dataDir) => seedUnownedSessionAt(dataDir, "late-identity"),
    async (db) => {
      assert.equal(
        (await db.sessions.getById("late-identity"))?.userId,
        null,
        "nothing is claimed while signed out"
      );
      const result = await db.claimSessionOwnerIdentity(SIGNED_IN);
      assert.equal(result.claimed, 1);
      assert.equal(
        (await db.sessions.getById("late-identity"))?.userId,
        SIGNED_IN.userId
      );
    }
  );
});

test("ISS-6168: the Codex OTel writer stamps the owner on the session row it creates", async () => {
  const h = await openTestPrisma();
  try {
    await persistCodexOtelBatch({
      prisma: h.prisma,
      now: NOW,
      getUserIdentity: () => SIGNED_IN,
      batch: {
        spans: [],
        tokenUsage: [
          {
            sessionId: "codex-otel-session",
            observedAt: STARTED_AT,
            model: "gpt-5-codex",
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        ],
      },
    });

    const row = await readOwner(h, "codex-otel-session");
    assert.equal(
      row?.user_id,
      SIGNED_IN.userId,
      "an OTel-created session row carries the signed-in owner"
    );
    assert.equal(row?.organization_id, SIGNED_IN.organizationId);
  } finally {
    await h.close();
  }
});

/**
 * `session_activity_metrics.closedloop_user` is materialized from the identity
 * columns, at the CURRENT classifier version — so `backfillActivityMetrics`,
 * which only re-selects missing or version-stale rows, will never revisit it.
 * Seeded here at that current version, which is the only case that matters.
 */
function seedActivityMetricsRow(
  h: OpenTestPrisma,
  sessionId: string,
  closedloopUser: number
): Promise<unknown> {
  return h.prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO session_activity_metrics
         (session_id, autonomy_band, closedloop_user, length_band, version, updated_at)
       VALUES ($1, 'human_steered', $2, 'short', 1, $3)`,
      sessionId,
      closedloopUser,
      NOW
    )
  );
}

async function readClosedloopUser(
  h: OpenTestPrisma,
  sessionId: string
): Promise<number | undefined> {
  const rows = await h.prisma.client.$queryRawUnsafe<
    Array<{ closedloop_user: number }>
  >(
    "SELECT closedloop_user FROM session_activity_metrics WHERE session_id = $1",
    sessionId
  );
  return rows[0]?.closedloop_user;
}

test("ISS-6168: a session that already knows its organization is never claimed or blanked", async () => {
  const h = await openTestPrisma();
  try {
    // The reviewed defect (PR #4947, wongk): `organization_id <> $2` is NULL —
    // never true — when the signed-in identity carries no organization, so this
    // row passed the foreign-owner guard and the UPDATE then erased its org.
    await seedUnownedSession(h, "org-only", null, "org-other");
    await seedUnownedSession(h, "fully-unowned");

    const result = await claimUnownedSessionIdentity(h.prisma, {
      userId: "u-mike",
      organizationId: null,
    });
    assert.equal(result.claimed, 0);
    assert.equal(result.skipped, SessionOwnerClaimSkip.ForeignOwnerPresent);

    const orgOnly = await readOwner(h, "org-only");
    assert.equal(orgOnly?.user_id, null);
    assert.equal(
      orgOnly?.organization_id,
      "org-other",
      "the one identity value the row did know must survive the claim"
    );
    assert.equal(
      (await readOwner(h, "fully-unowned"))?.user_id,
      null,
      "and the whole claim is refused while a foreign organization is present"
    );
  } finally {
    await h.close();
  }
});

test("ISS-6168: a row carrying only THIS account's organization is left alone but does not block the claim", async () => {
  const h = await openTestPrisma();
  try {
    await seedUnownedSession(h, "same-org-no-user", null, "org-closedloop");
    await seedUnownedSession(h, "fully-unowned");

    const result = await claimUnownedSessionIdentity(h.prisma, SIGNED_IN);
    assert.equal(result.claimed, 1, "only the fully unowned row is claimable");
    assert.equal(result.skipped, null);
    assert.equal(
      (await readOwner(h, "same-org-no-user"))?.organization_id,
      "org-closedloop",
      "a partially-stamped row keeps what it had"
    );
    assert.equal(
      (await readOwner(h, "fully-unowned"))?.user_id,
      SIGNED_IN.userId
    );
  } finally {
    await h.close();
  }
});

test("ISS-6168: the claim re-stamps the ClosedLoop-user cohort on already-materialized metrics rows", async () => {
  const h = await openTestPrisma();
  try {
    await seedUnownedSession(h, "metrics-claimed");
    await seedActivityMetricsRow(h, "metrics-claimed", 0);
    assert.equal(
      await readClosedloopUser(h, "metrics-claimed"),
      0,
      "the row starts classified as an external user, as the NULL owner implied"
    );

    const result = await claimUnownedSessionIdentity(h.prisma, SIGNED_IN);
    assert.equal(result.claimed, 1);

    assert.equal(
      await readClosedloopUser(h, "metrics-claimed"),
      1,
      "repairing the owner must reclassify the cohort the owner derives"
    );
  } finally {
    await h.close();
  }
});

test("ISS-6168: a refused claim leaves the metrics cohort untouched", async () => {
  const h = await openTestPrisma();
  try {
    await seedUnownedSession(h, "other-account", "u-someone-else");
    await seedUnownedSession(h, "metrics-not-claimed");
    await seedActivityMetricsRow(h, "metrics-not-claimed", 0);

    const result = await claimUnownedSessionIdentity(h.prisma, SIGNED_IN);
    assert.equal(result.skipped, SessionOwnerClaimSkip.ForeignOwnerPresent);
    assert.equal(
      await readClosedloopUser(h, "metrics-not-claimed"),
      0,
      "a cohort must never be re-stamped for an owner that was not written"
    );
  } finally {
    await h.close();
  }
});

test("ISS-6168: the DATA_REVISION rebuild's re-INSERT path stamps the signed-in owner", async () => {
  const h = await openTestPrisma();
  try {
    // PR #4947 review (thadeusb): the rebuild reaches `importSessionWithTx`
    // through its own deps bag, and today the session row always survives the
    // teardown so the UPDATE arm — which deliberately leaves the identity
    // columns alone — always wins. That is a runtime fact, not a type-enforced
    // one. Driving the transaction against an ABSENT row exercises the
    // re-INSERT branch a future teardown change would expose, and proves the
    // rebuild carries an owner into it rather than depending on the existing
    // row to supply one.
    const session = makeSession({
      sessionId: "rebuilt-session",
      cwd: "/sandbox/project",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      fileModifiedAt: OLD_FILE_MTIME_MS,
    });
    await h.prisma.write((client) =>
      client.$transaction((tx) =>
        runRebuildSessionTransaction(tx, {
          session,
          harness: "claude",
          hasRowDigest: false,
          tokenUsage: createSqliteTokenUsageStore(h.prisma),
          detectBillingMode: () => "metered_api",
          getUserIdentity: () => SIGNED_IN,
          log: () => {
            // discarded — no test here asserts on rebuild log output
          },
          now: () => NOW,
        })
      )
    );

    const row = await readOwner(h, "rebuilt-session");
    assert.equal(row?.user_id, SIGNED_IN.userId);
    assert.equal(row?.organization_id, SIGNED_IN.organizationId);
  } finally {
    await h.close();
  }
});
