/**
 * @file packs-timestamp-instant-order.test.ts
 * @description ISS-11317: the packs/ batch of the `no-lexical-timestamp-aggregate`
 * burn-down. Each read below took a single-operand `MIN`/`MAX` — or a row-picking
 * `ORDER BY … LIMIT` — over a TEXT timestamp column, so the comparison was BYTE-WISE
 * and byte order is time order only at a FIXED WIDTH.
 *
 * Every fixture here is a pair whose LEXICAL and TEMPORAL order DISAGREE, which is the
 * only kind of fixture that can fail on the unfixed code: a whole-second
 * `…T10:00:00Z` sorts ABOVE `…T10:00:00.500Z` (`Z` 0x5A after `.` 0x2E) while being
 * the EARLIER instant. So `MAX` returned the earlier row, `MIN` the later one, and a
 * `DESC` page led with the wrong event.
 *
 * None of these columns is in the FEA-3743 heal's `HEALED_COLUMNS`
 * (timestamp-format-maintenance.ts), so an installed store keeps whatever spelling any
 * release wrote — which is why a `lexical-timestamp-ok:` marker on writer-width
 * grounds was NOT available for them even though every live writer in the tree is a
 * bare `new Date().toISOString()`.
 *
 * `catalog-store.ts` resolved differently: its `MAX(ap.uninstalled_at)` had NO
 * reader (`toCatalogEntry` never mapped `CatalogRow.uninstalled_at`, and
 * `CatalogEntry` has no such field), as did `listPacks`'s
 * `MIN(detected_at) AS first_detected_at`. Both were deleted rather than ranked —
 * ranking a value nobody consumes buys nothing — so what is pinned for those is that
 * the reads still answer over the population the removed subquery selected.
 *
 * The dissent case is pinned too: a value `canonicalizeHealableTimestampSql` declines
 * (hour 24) and a blank `''` both drop the whole window back to the RAW column through
 * `allOrNothingCanonicalSortSql`, which is exactly the byte answer that shipped. That
 * fallback is the reason this change cannot regress anything.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { getCatalog, listCatalog } from "../src/main/packs/catalog-store.js";
import {
  getPack,
  listPackSessions,
  listPacks,
  listPackUsage,
  listSkillInvocations,
  listSkills,
} from "../src/main/packs/pack-store.js";
import { openTestPrisma, type RawDb } from "./prisma-test-utils.js";

/**
 * The disagreeing pair. `WHOLE_SECOND` is the EARLIER instant and the BYTE-GREATER
 * text; `SUB_SECOND` is the LATER instant and the byte-lesser text. Both are shapes
 * `canonicalizeHealableTimestampSql` accepts, so a window holding only these two is in
 * canonical mode.
 */
const WHOLE_SECOND = "2026-06-22T10:00:00Z";
const SUB_SECOND = "2026-06-22T10:00:00.500Z";

/** Canonical spellings, pinned as literals rather than re-derived in the test. */
const WHOLE_SECOND_CANONICAL = "2026-06-22T10:00:00.000Z";
const SUB_SECOND_CANONICAL = "2026-06-22T10:00:00.500Z";

/** A shape the canonicalizer DECLINES: SQLite admits hour 24, `Date.parse` does not. */
const RANGE_INVALID = "2026-06-22T24:30:00Z";

/** Wide enough that the `listPackSessions` lookback never clips the fixture. */
const WIDE_LOOKBACK_DAYS = 36_500;

const PACK_ID = "iss11317/pack";
const INSTALL_PATH = "/iss11317/install-path";
const SKILL_NAME = "iss11317-skill";
const SESSION_A = "iss11317-session-a";
const SESSION_B = "iss11317-session-b";

/** Byte order really does invert time order for this pair — the premise, asserted. */
test("ISS-11317: the fixture pair's lexical and temporal order disagree", () => {
  assert.ok(
    WHOLE_SECOND > SUB_SECOND,
    "whole-second text must sort ABOVE the sub-second text"
  );
  assert.ok(
    Date.parse(WHOLE_SECOND) < Date.parse(SUB_SECOND),
    "whole-second instant must be EARLIER than the sub-second instant"
  );
});

async function seedSession(db: RawDb, id: string): Promise<void> {
  await db.query(
    `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
     VALUES ($1, $1, 'inactive', $2, $2, 'claude')`,
    [id, WHOLE_SECOND_CANONICAL]
  );
}

async function seedPromptEvent(
  db: RawDb,
  id: string,
  sessionId: string,
  createdAt: string
): Promise<void> {
  await db.query(
    `INSERT INTO events (id, session_id, event_type, data, created_at)
     VALUES ($1, $2, 'UserPromptSubmit', $3, $4)`,
    [
      id,
      sessionId,
      JSON.stringify({ prompt: `/${SKILL_NAME} ${INSTALL_PATH}` }),
      createdAt,
    ]
  );
}

async function seedInstall(
  db: RawDb,
  detectedAt: string,
  lastSeenAt: string
): Promise<void> {
  await db.query(
    `INSERT INTO agent_packs
       (pack_id, harness, install_path, install_kind, detected_at, last_seen_at)
     VALUES ($1, 'claude', $2, 'plugin', $3, $4)`,
    [PACK_ID, INSTALL_PATH, detectedAt, lastSeenAt]
  );
  await db.query(
    `INSERT INTO skills (skill_id, pack_id, harness, install_path, name,
       detected_at, last_seen_at)
     VALUES ($1, $2, 'claude', $3, $4, $5, $6)`,
    [`sk-${PACK_ID}`, PACK_ID, INSTALL_PATH, SKILL_NAME, detectedAt, lastSeenAt]
  );
}

test("ISS-11317: listPacks takes the LATEST install instant as last seen", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    // Two install rows of ONE pack. The BYTE-greatest `last_seen_at` is the
    // EARLIER instant, so the byte-wise `MAX` named the wrong install.
    await db.query(
      `INSERT INTO agent_packs
         (pack_id, harness, install_path, install_kind, detected_at, last_seen_at)
       VALUES ($1, 'claude', $2, 'plugin', $3, $3)`,
      [PACK_ID, `${INSTALL_PATH}/one`, WHOLE_SECOND]
    );
    await db.query(
      `INSERT INTO agent_packs
         (pack_id, harness, install_path, install_kind, detected_at, last_seen_at)
       VALUES ($1, 'codex', $2, 'plugin', $3, $3)`,
      [PACK_ID, `${INSTALL_PATH}/two`, SUB_SECOND]
    );

    const packs = await listPacks(prisma);
    const pack = packs.find((p) => p.packId === PACK_ID);
    assert.ok(pack, "the seeded pack must be listed");
    assert.equal(pack.lastSeenAt, SUB_SECOND_CANONICAL);
  } finally {
    await close();
  }
});

test("ISS-11317: getPack's detail roll-up agrees with listPacks on last seen", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    // The same disagreeing pair as the listPacks case. `getPack` rolls up in JS, so
    // this is the one site the SQL fold cannot reach — and a divergence here is worse
    // than the original bug, because the list and the detail would answer differently
    // for the SAME pack.
    await db.query(
      `INSERT INTO agent_packs
         (pack_id, harness, install_path, install_kind, detected_at, last_seen_at)
       VALUES ($1, 'claude', $2, 'plugin', $3, $3)`,
      [PACK_ID, `${INSTALL_PATH}/one`, WHOLE_SECOND]
    );
    await db.query(
      `INSERT INTO agent_packs
         (pack_id, harness, install_path, install_kind, detected_at, last_seen_at)
       VALUES ($1, 'codex', $2, 'plugin', $3, $3)`,
      [PACK_ID, `${INSTALL_PATH}/two`, SUB_SECOND]
    );

    const detail = await getPack(prisma, PACK_ID);
    assert.ok(detail, "the seeded pack must resolve");
    assert.equal(detail.lastSeenAt, SUB_SECOND_CANONICAL);

    const listed = (await listPacks(prisma)).find((p) => p.packId === PACK_ID);
    assert.ok(listed, "the seeded pack must be listed");
    assert.equal(detail.lastSeenAt, listed.lastSeenAt);
  } finally {
    await close();
  }
});

test("ISS-11317: one unreadable install drops the detail roll-up to the byte answer", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    // `RANGE_INVALID` is a value no clock can name, so the all-or-nothing mirror must
    // drop the WHOLE set back to the byte-wise maximum of the raw text — which is that
    // same dissenter, because it is also the byte-greatest. A half-applied mirror that
    // merely SKIPPED the unreadable value would answer SUB_SECOND instead.
    await db.query(
      `INSERT INTO agent_packs
         (pack_id, harness, install_path, install_kind, detected_at, last_seen_at)
       VALUES ($1, 'claude', $2, 'plugin', $3, $3)`,
      [PACK_ID, `${INSTALL_PATH}/one`, SUB_SECOND]
    );
    await db.query(
      `INSERT INTO agent_packs
         (pack_id, harness, install_path, install_kind, detected_at, last_seen_at)
       VALUES ($1, 'codex', $2, 'plugin', $3, $3)`,
      [PACK_ID, `${INSTALL_PATH}/two`, RANGE_INVALID]
    );

    const detail = await getPack(prisma, PACK_ID);
    assert.ok(detail, "the seeded pack must resolve");
    assert.equal(detail.lastSeenAt, RANGE_INVALID);
  } finally {
    await close();
  }
});

test("ISS-11317: listSkills reports the LATEST invocation instant", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await seedInstall(db, WHOLE_SECOND_CANONICAL, WHOLE_SECOND_CANONICAL);
    await seedSession(db, SESSION_A);
    await seedPromptEvent(db, "ev-whole", SESSION_A, WHOLE_SECOND);
    await seedPromptEvent(db, "ev-sub", SESSION_A, SUB_SECOND);

    const skills = await listSkills(prisma);
    const skill = skills.find((s) => s.name === SKILL_NAME);
    assert.ok(skill, "the seeded skill must be listed");
    assert.equal(skill.invocationCount, 2);
    assert.equal(skill.lastUsedAt, SUB_SECOND_CANONICAL);
  } finally {
    await close();
  }
});

test("ISS-11317: listSkillInvocations leads with the LATEST instant", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await seedInstall(db, WHOLE_SECOND_CANONICAL, WHOLE_SECOND_CANONICAL);
    await seedSession(db, SESSION_A);
    await seedPromptEvent(db, "ev-whole", SESSION_A, WHOLE_SECOND);
    await seedPromptEvent(db, "ev-sub", SESSION_A, SUB_SECOND);

    const invocations = await listSkillInvocations(prisma, SKILL_NAME, {
      limit: 1,
    });
    assert.equal(invocations.length, 1);
    // The page is capped at one row, so the byte order decided WHICH row came
    // back, not merely its position: the unfixed read returned `ev-whole`.
    assert.equal(invocations[0]?.eventId, "ev-sub");
    assert.equal(invocations[0]?.createdAt, SUB_SECOND);
  } finally {
    await close();
  }
});

test("ISS-11317: listPackUsage bounds first/last use by instant", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await seedInstall(db, WHOLE_SECOND_CANONICAL, WHOLE_SECOND_CANONICAL);
    await seedSession(db, SESSION_A);
    await seedPromptEvent(db, "ev-whole", SESSION_A, WHOLE_SECOND);
    await seedPromptEvent(db, "ev-sub", SESSION_A, SUB_SECOND);

    const usage = await listPackUsage(prisma);
    const row = usage.find((u) => u.pack_id === PACK_ID);
    assert.ok(row, "the seeded pack must report usage");
    assert.equal(row.first_used_at, WHOLE_SECOND_CANONICAL);
    assert.equal(row.last_used_at, SUB_SECOND_CANONICAL);
  } finally {
    await close();
  }
});

test("ISS-11317: listPackSessions ranks sessions BETWEEN groups by instant", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await seedInstall(db, WHOLE_SECOND_CANONICAL, WHOLE_SECOND_CANONICAL);
    await seedSession(db, SESSION_A);
    await seedSession(db, SESSION_B);
    // One event each, so the DESC ranking is a comparison BETWEEN the two
    // session groups — the case whose all-or-nothing window must be EMPTY.
    await seedPromptEvent(db, "ev-a", SESSION_A, WHOLE_SECOND);
    await seedPromptEvent(db, "ev-b", SESSION_B, SUB_SECOND);

    const rows = await listPackSessions(prisma, PACK_ID, {
      lookbackDays: WIDE_LOOKBACK_DAYS,
    });
    assert.deepEqual(
      rows.map((r) => r.session_id),
      [SESSION_B, SESSION_A],
      "the LATER instant must lead, not the byte-greater text"
    );
    assert.equal(rows[0]?.last_used_at, SUB_SECOND_CANONICAL);
    assert.equal(rows[1]?.last_used_at, WHOLE_SECOND_CANONICAL);
  } finally {
    await close();
  }
});

test("ISS-11317: catalog reads survive deleting the dead uninstall projection", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await db.query(
      `INSERT INTO pack_catalog (pack_id, display_name, github_url, seed_version)
       VALUES ($1, 'ISS-11317 pack', 'https://example.invalid/p', 1)`,
      [PACK_ID]
    );
    // Two TOMBSTONED installs — the population the removed `MAX(ap.uninstalled_at)`
    // subquery selected — plus one LIVE install with one live skill. The live row is
    // what gives the decoration assertions below any power: an all-tombstoned fixture
    // reads `[]`/`0` whatever the surviving subqueries do, so it could not tell a
    // damaged one from an intact one. (The deletion could never have dropped a ROW
    // either way — both statements select `FROM pack_catalog c` and the subqueries are
    // projections — so "the read comes back short" was never the risk. The risks are a
    // surviving subquery broken by the edit, and a mapper left reading a column that no
    // longer exists; this case pins both.)
    for (const [harness, uninstalledAt] of [
      ["claude", WHOLE_SECOND],
      ["codex", SUB_SECOND],
    ] as const) {
      await db.query(
        `INSERT INTO agent_packs
           (pack_id, harness, install_path, install_kind, detected_at,
            last_seen_at, uninstalled_at)
         VALUES ($1, $2, $3, 'plugin', $4, $4, $5)`,
        [
          PACK_ID,
          harness,
          `${INSTALL_PATH}/${harness}`,
          WHOLE_SECOND_CANONICAL,
          uninstalledAt,
        ]
      );
    }
    await db.query(
      `INSERT INTO agent_packs
         (pack_id, harness, install_path, install_kind, detected_at, last_seen_at)
       VALUES ($1, 'gemini', $2, 'plugin', $3, $3)`,
      [PACK_ID, `${INSTALL_PATH}/gemini`, WHOLE_SECOND_CANONICAL]
    );
    await db.query(
      `INSERT INTO skills (skill_id, pack_id, harness, install_path, name,
         detected_at, last_seen_at)
       VALUES ($1, $2, 'gemini', $3, $4, $5, $5)`,
      [
        `sk-live-${PACK_ID}`,
        PACK_ID,
        `${INSTALL_PATH}/gemini`,
        SKILL_NAME,
        WHOLE_SECOND_CANONICAL,
      ]
    );

    const listed = await listCatalog(prisma);
    const entry = listed.find((e) => e.packId === PACK_ID);
    assert.ok(entry, "the seeded catalog entry must still be listed");
    // The surviving subqueries must still DISCRIMINATE: the live install and its
    // skill, and neither tombstoned one.
    assert.deepEqual(entry.installedHarnesses, ["gemini"]);
    assert.equal(entry.skillCount, 1);
    // The dropped `uninstalled_at` column left no hole in the mapped entry: the key
    // set is exactly `CatalogEntry`'s, with no `uninstalledAt` and nothing
    // `undefined` where the mapper used to read a column.
    assert.ok(
      !Object.hasOwn(entry, "uninstalledAt"),
      "the deleted projection must not have grown a mapped field"
    );
    assert.deepEqual(
      Object.entries(entry)
        .filter(([, value]) => value === undefined)
        .map(([key]) => key),
      [],
      "no mapped field may read a column the deletion removed"
    );

    const single = await getCatalog(prisma, PACK_ID);
    assert.ok(single, "the seeded catalog entry must still resolve singly");
    // getCatalog carries the same deleted subquery, so it owes the same parity —
    // the two statements must map to the same entry, not merely both parse.
    assert.deepEqual(single, entry);
  } finally {
    await close();
  }
});

/**
 * review-soul (class B) on ISS-11317: the case above cannot tell the all-or-nothing fold
 * apart from a HALF-APPLIED one, and that matters twice over.
 *
 * Its dissenter (`RANGE_INVALID`, hour 24) is the byte-GREATEST value seeded, so it wins
 * the raw `MAX` and it also wins a `COALESCE(canonical_created_at, created_at)` mix —
 * canonical where it resolves, raw where it does not. That mix is exactly the shape
 * `allOrNothingCanonicalSortSql` exists to forbid, and the source gate's own contract
 * lists "mixed canonicalization modes outside `allOrNothingCanonicalSortSql`" as NOT
 * COVERED, so nothing mechanical catches it either.
 *
 * A dissenter that is byte-LEAST separates them. With `''` the only dissenter, the correct
 * fold drops the whole window to the raw column and the byte `MAX` is the whole-second
 * text; the `COALESCE` mix instead canonicalizes the sub-second row and returns THAT.
 *
 * The same fixture pins the EMPTY window spec, which the single-session cases leave free:
 * `listPackUsage` compares every event of the pack across sessions, so narrowing the fold
 * to `PARTITION BY session_id` would rank session B's canonical key against session A's
 * raw one. This spreads the rows over two sessions so that substitution changes the
 * answer. Its `ORDER BY`-less shape means half D of the gate cannot see it — that half
 * only fires when a partitioned alias reaches an `ORDER BY` — so this assertion is the
 * only thing holding the spec.
 */
test("ISS-11317: a byte-LEAST dissenter pins the fold and its empty window", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await seedInstall(db, WHOLE_SECOND_CANONICAL, WHOLE_SECOND_CANONICAL);
    await seedSession(db, SESSION_A);
    await seedSession(db, SESSION_B);
    // Session A canonicalizes except for the blank; session B is wholly canonical.
    await seedPromptEvent(db, "ev-a-sub", SESSION_A, SUB_SECOND);
    await seedPromptEvent(db, "ev-a-blank", SESSION_A, "");
    await seedPromptEvent(db, "ev-b-whole", SESSION_B, WHOLE_SECOND);

    const usage = await listPackUsage(prisma);
    const row = usage.find((u) => u.pack_id === PACK_ID);
    assert.ok(row, "the seeded pack must report usage");
    assert.equal(row.first_used_at, "", "raw byte MIN is the empty string");
    // Raw byte MAX across ALL THREE rows. `Z` (0x5A) sorts after `.` (0x2E), so the
    // whole-second text beats the sub-second one on bytes — which is the wrong INSTANT
    // and deliberately so: with a dissenter present, raw is the answer that shipped.
    assert.equal(
      row.last_used_at,
      WHOLE_SECOND,
      "one dissenter drops the WHOLE window to raw, across both sessions"
    );
  } finally {
    await close();
  }
});

test("ISS-11317: one un-canonicalizable row drops the window to the RAW column", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await seedInstall(db, WHOLE_SECOND_CANONICAL, WHOLE_SECOND_CANONICAL);
    await seedSession(db, SESSION_A);
    await seedPromptEvent(db, "ev-whole", SESSION_A, WHOLE_SECOND);
    await seedPromptEvent(db, "ev-sub", SESSION_A, SUB_SECOND);
    // Hour 24: shape-legal to SQLite, declined by the canonicalizer. It is the
    // single dissenter, so `allOrNothingCanonicalSortSql` must hand the whole
    // window the raw column — the byte answer that shipped, verbatim.
    await seedPromptEvent(db, "ev-invalid", SESSION_A, RANGE_INVALID);
    // A blank stored value dissents the same way: non-NULL raw, NULL canonical.
    await seedPromptEvent(db, "ev-blank", SESSION_A, "");

    const usage = await listPackUsage(prisma);
    const row = usage.find((u) => u.pack_id === PACK_ID);
    assert.ok(row, "the seeded pack must still report usage");
    assert.equal(row.first_used_at, "", "raw byte MIN is the empty string");
    assert.equal(
      row.last_used_at,
      RANGE_INVALID,
      "raw byte MAX is the hour-24 text"
    );
  } finally {
    await close();
  }
});
