/**
 * @file recompute-last-activity-canonical.test.ts
 * @description ISS-5497: `recomputeSessionLastActivityAt` re-derives
 * `sessions.last_activity_at` from `events.created_at`, which holds raw harness
 * transcript text verbatim and is the one timestamp column the FEA-3743 heal
 * never repairs. Two defects followed from folding that column with a plain
 * `MAX()` over TEXT:
 *
 *  - the fold was BYTE-wise, so a mixed-precision or offset-form column returned
 *    the EARLIER instant;
 *  - the winning raw text was written straight into `last_activity_at`, which IS
 *    healed — and because the recompute runs on every live hook event and every
 *    import, it re-introduced non-canonical text into the column the heal had
 *    just canonicalized, so the heal was not convergent for an active session.
 *
 * These cases pin both halves — the value is the latest INSTANT, and it is
 * emitted in the canonical UTC form the heal and the stale sweep's guard expect
 * — plus the shapes the canonicalization must decline to touch (the SQLite space
 * form, which the heal also holds back, and an offset spelling SQLite cannot
 * parse), which stay in the comparison as stored rather than being rewritten or
 * dropped from it. The last case drives the REAL heal to prove the pair settles.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { toCanonicalIso } from "../src/main/database/db-helpers.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { sweepExpiredSessions } from "../src/main/database/session-maintenance.js";
import { isCanonicalUtcTimestamp } from "../src/main/database/session-timestamp-form.js";
import { normalizeStoredTimestampFormats } from "../src/main/database/timestamp-format-maintenance.js";
import { healSessionLastActivityAtFloor } from "../src/main/database/token-cost-maintenance.js";
import { recomputeSessionLastActivityAt } from "../src/main/database/write-core.js";
import { openTestPrisma, type RawDb } from "./prisma-test-utils.js";

const SEED_SESSION_SQL =
  "INSERT INTO sessions (id, status, updated_at, last_activity_at, started_at, data_revision) VALUES ($1, 'active', '2026-06-22T09:00:00.000Z', $2, $2, 1)";

const SEED_EVENT_SQL =
  "INSERT INTO events (id, session_id, event_type, created_at) VALUES ($1, $2, 'tool_use', $3)";

/** Pinned clock for the heal's `updated_at` bump, so nothing reads the wall clock. */
const HEAL_NOW = "2026-06-23T00:00:00.000Z";

async function seedSession(
  store: RawDb,
  id: string,
  startedAt: string,
  eventCreatedAts: readonly string[]
): Promise<void> {
  await store.query(SEED_SESSION_SQL, [id, startedAt]);
  for (const [index, createdAt] of eventCreatedAts.entries()) {
    await store.query(SEED_EVENT_SQL, [`${id}-${index}`, id, createdAt]);
  }
}

function recompute(prisma: DesktopPrisma, id: string): Promise<void> {
  return prisma.write((client) =>
    client.$transaction((tx) => recomputeSessionLastActivityAt(tx, id))
  );
}

async function readLastActivityAt(
  prisma: DesktopPrisma,
  id: string
): Promise<string> {
  const rows = await prisma.client.$queryRawUnsafe<
    { last_activity_at: string }[]
  >("SELECT last_activity_at FROM sessions WHERE id = $1", id);
  return rows[0].last_activity_at;
}

/*
 * The reported reproduction: two events one half-second apart, spelled at
 * different precisions. `Z` (0x5A) sorts after `.` (0x2E), so a byte-wise
 * `MAX(e.created_at)` picks the whole-second value — the EARLIER instant.
 */
test("ISS-5497: mixed-precision events fold to the LATER instant, not the higher bytes", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, "mixed-precision", "2026-06-22T08:00:00.000Z", [
      "2026-06-22T10:00:00.500Z",
      "2026-06-22T10:00:00Z",
    ]);

    await recompute(prisma, "mixed-precision");

    assert.equal(
      await readLastActivityAt(prisma, "mixed-precision"),
      "2026-06-22T10:00:00.500Z",
      "the half-second-later event is the real last activity"
    );
  } finally {
    await close();
  }
});

/*
 * The other byte-wise failure on the same column: an offset-form value is a
 * LATER instant than a `Z` value whose text sorts above it. `2026-06-22T09:30`
 * at `-05:00` is 14:30Z — after 10:00Z — yet `'2026-06-22T09:30:00-05:00'` sorts
 * below `'2026-06-22T10:00:00.000Z'`.
 */
test("ISS-5497: an offset-form event wins when it is the later instant, and lands as UTC", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, "offset-form", "2026-06-22T08:00:00.000Z", [
      "2026-06-22T10:00:00.000Z",
      "2026-06-22T09:30:00-05:00",
    ]);

    await recompute(prisma, "offset-form");

    assert.equal(
      await readLastActivityAt(prisma, "offset-form"),
      "2026-06-22T14:30:00.000Z",
      "the offset is applied, so the same instant is stored in canonical UTC"
    );
  } finally {
    await close();
  }
});

/*
 * The convergence half. `sessions.last_activity_at` is in the FEA-3743 heal's
 * `HEALED_COLUMNS`, and this recompute runs on every live hook event and every
 * import — so as long as it copied raw event text back, the heal could never
 * reach a fixed point for an active session and the stale sweep's canonical-only
 * guard could hold that session back indefinitely (ISS-5429's `heldBack`).
 */
test("ISS-5497: the written value is canonical however non-canonical the events are", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, "all-non-canonical", "2026-06-22T08:00:00.000Z", [
      "2026-06-22T10:00:00Z",
      "2026-06-22T09:00:00+02:00",
      "2026-06-22",
    ]);

    await recompute(prisma, "all-non-canonical");
    const first = await readLastActivityAt(prisma, "all-non-canonical");
    assert.equal(isCanonicalUtcTimestamp(first), true);
    assert.equal(first, "2026-06-22T10:00:00.000Z");

    // Idempotent: re-running over the same rows is a fixed point, which is what
    // makes the heal convergent for a session still receiving hook events.
    await recompute(prisma, "all-non-canonical");
    assert.equal(await readLastActivityAt(prisma, "all-non-canonical"), first);
  } finally {
    await close();
  }
});

/*
 * FEA-3591's floor is unchanged: a resumed run whose events were inherited from
 * the parent transcript (before its resume `started_at`) still clamps at the
 * start, so `last_activity_at >= started_at` holds and FEA-3580's derived
 * duration stays non-negative. The floor is canonicalized too — otherwise the
 * outer scalar `MAX` would be comparing an offset-form floor against a canonical
 * activity value byte-wise, which is the same defect one level up.
 */
test("ISS-5497: the started_at floor still clamps, and is itself canonicalized", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // 08:00-05:00 is 13:00Z — AFTER both events, so the floor must win.
    await seedSession(store, "resumed", "2026-06-22T08:00:00-05:00", [
      "2026-06-22T11:00:00.000Z",
      "2026-06-22T10:00:00.000Z",
    ]);
    // No events at all: the COALESCE arm, which must agree with the floor arm.
    await seedSession(store, "event-less", "2026-06-22T08:00:00-05:00", []);

    await recompute(prisma, "resumed");
    await recompute(prisma, "event-less");

    assert.equal(
      await readLastActivityAt(prisma, "resumed"),
      "2026-06-22T13:00:00.000Z"
    );
    assert.equal(
      await readLastActivityAt(prisma, "event-less"),
      "2026-06-22T13:00:00.000Z"
    );
  } finally {
    await close();
  }
});

/*
 * ISS-5497 (review): SQLite is stricter than `Date.parse` — it rejects the
 * BASIC-format offset `+0530`, which JS reads fine. A session whose every event
 * carries such a spelling must NOT collapse onto the `started_at` floor: with an
 * absent/malformed `started_at` that means the 1970 epoch, and
 * `sweepExpiredSessions` then irreversibly purges the terminal session and every
 * child row. Such a value keeps its stored text and is compared byte-wise, which
 * is exactly what every release before this one did.
 */
test("ISS-5497: events SQLite cannot parse keep their text, never fall to the epoch", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // `started_at` absent → the floor is the 1970 epoch, so a collapse onto it
    // is retention-purge range. Both events are basic-format offsets.
    await store.query(
      "INSERT INTO sessions (id, status, updated_at, last_activity_at, started_at, data_revision) VALUES ('sqlite-unparseable', 'active', '2026-06-22T09:00:00.000Z', '1970-01-01T00:00:00.000Z', '', 1)"
    );
    await store.query(SEED_EVENT_SQL, [
      "sqlite-unparseable-0",
      "sqlite-unparseable",
      "2026-06-22T10:00:00.000+0530",
    ]);
    await store.query(SEED_EVENT_SQL, [
      "sqlite-unparseable-1",
      "sqlite-unparseable",
      "2026-06-22T09:00:00.000+0530",
    ]);

    await recompute(prisma, "sqlite-unparseable");

    assert.equal(
      await readLastActivityAt(prisma, "sqlite-unparseable"),
      "2026-06-22T10:00:00.000+0530",
      "the byte-wise winner still wins, so the row is never rewound into purge range"
    );
  } finally {
    await close();
  }
});

/*
 * ISS-5497 (review): the canonicalization is PER ROW, not an aggregate over the
 * rows SQLite happens to parse — which is why this is not `MAX(julianday(col))`.
 * An aggregate DROPS the unparseable row, so a session holding one parseable
 * event alongside a later unparseable one would move BACKWARD to the parseable
 * one: an ~18h retreat of the exact cutoff the irreversible retention purge
 * reads, re-derived corpus-wide by the DATA_REVISION bump. Every date-shaped row
 * stays in the comparison.
 */
test("ISS-5497: an unparseable event is never dropped from the fold", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // The +0530 event is 17:30Z — the LATER instant — but SQLite cannot parse
    // the basic-format offset, so only a per-row fold can still see it.
    await seedSession(store, "partly-parseable", "2026-06-22T08:00:00.000Z", [
      "2026-06-22T23:00:00.000+0530",
      "2026-06-22T10:00:00Z",
    ]);

    await recompute(prisma, "partly-parseable");

    assert.equal(
      await readLastActivityAt(prisma, "partly-parseable"),
      "2026-06-22T23:00:00.000+0530",
      "the unparseable event still competes, exactly as it does on main"
    );
  } finally {
    await close();
  }
});

/*
 * ISS-5497 (review): the case that forces the all-or-nothing mode switch, and
 * the reason canonical and raw operands are never mixed in one byte-wise fold.
 *
 * Canonicalizing LOWERS a value's text whenever it applies a positive offset:
 * `2026-06-22T23:00:00+05:00` is 18:00Z and becomes `…T18:00:00.000Z`. Its
 * sibling `2026-06-22T21:00:00.000+0530` is 15:30Z — EARLIER — but SQLite cannot
 * parse the basic-format offset, so it stays raw and its `21` now out-sorts the
 * winner's `18`. Mixing the two modes would therefore move `last_activity_at`
 * 2.5h BACKWARD from where `main` puts it, into range of the irreversible
 * retention purge, corpus-wide via the DATA_REVISION bump.
 */
test("ISS-5497: a session that cannot fully canonicalize matches main exactly", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, "mixed-modes", "2026-06-22T08:00:00.000Z", [
      "2026-06-22T23:00:00+05:00", // 18:00Z — the genuine latest instant
      "2026-06-22T21:00:00.000+0530", // 15:30Z, and unparseable by SQLite
    ]);

    await recompute(prisma, "mixed-modes");

    assert.equal(
      await readLastActivityAt(prisma, "mixed-modes"),
      "2026-06-22T23:00:00+05:00",
      "legacy mode returns main's byte-wise winner, never an earlier instant"
    );
  } finally {
    await close();
  }
});

/*
 * ISS-5497 (review): an OUT-OF-RANGE calendar date, which is what forces the
 * zoned and zone-less `T`-form arms apart. SQLite's `utc` modifier silently
 * BAILS on one — `2026-06-31T10:00:00Z` comes back as
 * `2026-06-31T10:00:00.000Z`, the invalid date re-emitted in canonical SHAPE —
 * where the default parse rolls it over to July 1 exactly as `Date.parse` does.
 * Storing the bailed value would be doubly wrong: the wrong instant, AND a
 * canonical-shaped value that the FEA-3743 heal then permanently skips, so the
 * row could never be repaired by the heal that used to roll it over.
 *
 * This is also the one assertion here that discriminates the two arms on a UTC
 * runner, where local time IS UTC and every other zone-sensitive case is
 * trivially satisfied. CI runs UTC.
 */
test("ISS-5497: an out-of-range date rolls over, as toCanonicalIso rolls it", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, "out-of-range", "2026-06-21T08:00:00.000Z", [
      "2026-06-31T10:00:00Z",
    ]);

    await recompute(prisma, "out-of-range");

    const stored = await readLastActivityAt(prisma, "out-of-range");
    assert.equal(
      stored,
      toCanonicalIso("2026-06-31T10:00:00Z"),
      "the invalid date rolls to July 1, never re-emitted verbatim"
    );
    assert.equal(stored, "2026-07-01T10:00:00.000Z");
  } finally {
    await close();
  }
});

/*
 * ISS-5497 (review): a ZONE-LESS `T`-form value is read as UTC — the digits at
 * face value — because that is what ISS-5496 settled for the FEA-3743 heal
 * (`canonicalizeStoredTimestamp` supplies the missing `Z` before `Date.parse`),
 * what SQLite's `unixepoch()` in local-insights.ts reads, and what every lexical
 * comparison over these TEXT columns already assumes. The recompute and the heal
 * write the SAME column — one on every hook event, one on every boot — so a
 * disagreement here is not an inaccuracy, it is a permanent ping-pong that bumps
 * `updated_at` and re-syncs an alternating instant.
 *
 * Pinned under a NON-UTC zone, because that is the only place the wrong reading
 * is visible: SQLite's `utc` modifier (the mistake this replaces) is the identity
 * when the host offset is zero, so under CI's `TZ=UTC` a host-local
 * implementation passes vacuously. `process.env.TZ` is assigned rather than
 * passed to the runner so the check travels with the case; libSQL re-reads it
 * per statement, and node:test runs a file's top-level tests sequentially so the
 * window cannot overlap another case.
 */
test("ISS-5497: a zone-less event is read as UTC, matching the ISS-5496 heal", async () => {
  const originalTz = process.env.TZ;
  process.env.TZ = "America/Chicago";
  try {
    // Guard the guard: if the harness zone ever stops shifting a zone-less
    // parse, the assertion below would pass against a host-local implementation.
    assert.equal(
      new Date(Date.parse("2026-06-22T23:00:00")).toISOString(),
      "2026-06-23T04:00:00.000Z",
      "the harness zone must actually shift a zone-less parse"
    );
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      await seedSession(store, "zone-less", "2026-06-22T08:00:00.000Z", [
        "2026-06-22T23:00:00",
      ]);

      await recompute(prisma, "zone-less");

      const stored = await readLastActivityAt(prisma, "zone-less");
      assert.equal(isCanonicalUtcTimestamp(stored), true);
      assert.equal(
        stored,
        "2026-06-22T23:00:00.000Z",
        "the digits are read at face value, not shifted by the operator's offset"
      );
      assert.equal(
        stored,
        toCanonicalIso("2026-06-22T23:00:00Z"),
        "which is exactly what canonicalizeStoredTimestamp (the heal) produces"
      );
    } finally {
      await close();
    }
  } finally {
    if (originalTz === undefined) {
      Reflect.deleteProperty(process.env, "TZ");
    } else {
      process.env.TZ = originalTz;
    }
  }
});

/*
 * ISS-5497 (review): the one OUT-OF-RANGE FIELD SQLite accepts — an hour of
 * exactly 24. Every other one (hour >= 25, minute or second >= 60, month 13)
 * yields NULL and falls to legacy mode on its own, and an out-of-range calendar
 * DATE rolls over (the case above). `T24:` does neither: SQLite parses it and
 * `strftime` re-emits the fields VERBATIM, so `…T24:30:00Z` would canonicalize
 * to `2026-06-22T24:30:00.000Z` — text that MATCHES the canonical glob, so the
 * FEA-3743 heal skips it forever, while denoting an instant (00:30 on the 23rd)
 * whose genuine canonical spelling `2026-06-23T00:30:00.000Z` sorts ABOVE it.
 * Storing it would move `last_activity_at` (and so the irreversible retention
 * cutoff) BACKWARD relative to every real canonical value for that instant.
 *
 * The `24:30` fixture is built so the guard is LOAD-BEARING: its sibling is an
 * event the bogus text OUT-sorts, so with the range-invalid arm neutered the
 * canonical-shaped `2026-06-22T24:30:00.000Z` wins and is what gets stored. A
 * sibling that out-sorts the bogus value would win either way and prove nothing.
 *
 * Both `24:30` and `24:00` are rejected into legacy mode. They differ in V8 —
 * `Date.parse` accepts `24:00` and rejects `24:30` — and that difference is
 * exactly why neither is special-cased: legacy mode is the one reading the
 * recompute and the heal can both hold for the pair.
 */
test("ISS-5497: a T24: hour falls to legacy mode, never a canonical-shaped 24:xx", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // The sibling is deliberately one the bogus text OUT-sorts byte-wise
    // (`…T24:` > `…T23:`), so the range-invalid arm is the ONLY thing standing
    // between this row and a stored `2026-06-22T24:30:00.000Z` — canonical in
    // shape, which no heal can ever revisit. Legacy mode instead reproduces
    // main's byte-wise winner over the RAW text, which keeps its non-canonical
    // spelling and so stays discoverable.
    await seedSession(store, "hour-24-30", "2026-06-22T08:00:00.000Z", [
      "2026-06-22T24:30:00Z",
      "2026-06-22T23:00:00.000Z",
    ]);
    // 24:00 alone, so the rejection is visible in the stored text rather than
    // masked by a sibling that out-sorts it.
    await seedSession(store, "hour-24-00", "2026-06-22T08:00:00.000Z", [
      "2026-06-22T24:00:00Z",
    ]);

    await recompute(prisma, "hour-24-30");
    await recompute(prisma, "hour-24-00");

    assert.equal(
      await readLastActivityAt(prisma, "hour-24-30"),
      "2026-06-22T24:30:00Z",
      "legacy mode returns main's byte-wise winner over the raw text, in its raw spelling — not the canonical-shaped 24:30 the fold would emit"
    );
    assert.equal(
      await readLastActivityAt(prisma, "hour-24-00"),
      "2026-06-22T24:00:00Z",
      "the stored text is kept verbatim, never re-emitted in canonical shape"
    );
    // The invariant behind both: a `24:xx` value never lands in CANONICAL SHAPE,
    // which is the form every heal and the stale sweep's guard treat as already
    // repaired and so never revisit. Left in its stored spelling it stays
    // discoverable, exactly as it is on main.
    for (const id of ["hour-24-30", "hour-24-00"]) {
      const stored = await readLastActivityAt(prisma, id);
      assert.ok(
        !(isCanonicalUtcTimestamp(stored) && stored.includes("T24:")),
        `${id} stored a canonical-shaped 24:xx value: ${stored}`
      );
    }
  } finally {
    await close();
  }
});

/*
 * ...and the SQLite SPACE form is the one shape that must stay untouched: the
 * heal deliberately holds it back rather than move it by the operator's offset
 * (see the ISS-5429 note on its discovery glob), so the stored text IS the fixed
 * point here. Canonicalizing it would be this expression doing exactly what that
 * heal refuses to do.
 */
test("ISS-5497: the SQLite space form is left alone, as the heal leaves it", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // A floor that loses byte-wise to the space form, so the event is what the
    // expression actually returns rather than the clamp.
    await seedSession(store, "space-form", "2026-06-21T08:00:00.000Z", [
      "2026-06-22 23:00:00",
    ]);

    await recompute(prisma, "space-form");

    assert.equal(
      await readLastActivityAt(prisma, "space-form"),
      "2026-06-22 23:00:00"
    );
  } finally {
    await close();
  }
});

/*
 * The convergence claim, end to end and against the REAL heal rather than a JS
 * mirror of its predicate. This is the whole point of ISS-5497: the recompute
 * runs on every live hook event and every import, the heal runs on every boot,
 * and they write the same column — so any shape the two spell differently
 * alternates forever, bumping `updated_at` and re-syncing the alternation, which
 * is the non-convergence the ticket reports. Driving both in sequence is what
 * proves the pair settles; asserting the recompute's output in isolation cannot.
 *
 * The basic-format offset is deliberately NOT in this list — it is the one shape
 * that still alternates, and the case below pins that residual explicitly rather
 * than letting its absence here read as coverage.
 */
test("ISS-5497: recompute output is a fixed point of the FEA-3743 heal", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const shapes = [
      "2026-06-22T10:00:00Z", // whole-second Z — heal rewrites
      "2026-06-22T09:30:00-05:00", // extended offset — heal rewrites
      "2026-06-22T23:00:00", // zone-less T — heal rewrites, reading it as UTC
      "2026-06-22 22:00:00", // SQLite space form — heal holds it back
      "2026-06-22", // exact date-only — heal rewrites to UTC midnight
    ];
    for (const [index, created] of shapes.entries()) {
      await seedSession(
        store,
        `fixed-point-${index}`,
        "2026-06-21T08:00:00.000Z",
        [created]
      );
      await recompute(prisma, `fixed-point-${index}`);
    }

    const settled = await Promise.all(
      shapes.map((_, index) =>
        readLastActivityAt(prisma, `fixed-point-${index}`)
      )
    );

    // Every seeded `started_at` here is already canonical, so the only thing the
    // heal could rewrite is what the recompute just wrote.
    await normalizeStoredTimestampFormats(
      prisma,
      () => undefined,
      () => HEAL_NOW
    );

    for (const [index, created] of shapes.entries()) {
      const id = `fixed-point-${index}`;
      assert.equal(
        await readLastActivityAt(prisma, id),
        settled[index],
        `the heal rewrote the recompute's output for ${created}`
      );

      // ...and re-deriving over the same events after the heal reproduces it,
      // which is the other direction of the same round trip.
      await recompute(prisma, id);
      assert.equal(await readLastActivityAt(prisma, id), settled[index]);
    }
  } finally {
    await close();
  }
});

/*
 * ISS-5497 KNOWN RESIDUAL, pinned so it is a documented gap and not a forgotten
 * one. The BASIC-format offset is the single shape where the heal and the
 * recompute still disagree: V8 parses it so `toCanonicalIso` rewrites it, SQLite
 * does not so the fold stays in legacy mode and writes the raw text back. The
 * pair therefore alternates forever, bumping `updated_at` and re-syncing each
 * boot — exactly as on `main`, which is why this is a residual and not a
 * regression. Closing it means teaching the SQL this spelling or teaching the
 * heal to decline it; either is its own change. If a later change makes this
 * test fail, the residual closed and the prose above it should say so.
 */
test("ISS-5497 KNOWN RESIDUAL: the basic-format offset still alternates with the heal", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, "residual", "2026-06-21T08:00:00.000Z", [
      "2026-06-22T23:00:00.000+0530",
    ]);

    await recompute(prisma, "residual");
    assert.equal(
      await readLastActivityAt(prisma, "residual"),
      "2026-06-22T23:00:00.000+0530",
      "legacy mode writes the raw text, as it always has"
    );

    await normalizeStoredTimestampFormats(
      prisma,
      () => undefined,
      () => HEAL_NOW
    );
    const healed = await readLastActivityAt(prisma, "residual");
    assert.equal(healed, toCanonicalIso("2026-06-22T23:00:00.000+0530"));

    // ...and the very next recompute undoes it. That is the alternation.
    await recompute(prisma, "residual");
    assert.equal(
      await readLastActivityAt(prisma, "residual"),
      "2026-06-22T23:00:00.000+0530",
      "the recompute writes the raw text back over the healed value"
    );
  } finally {
    await close();
  }
});

/*
 * The un-canonicalizable floor. A `started_at` the floor's date-prefix GLOB
 * admits but SQLite cannot parse has no instant to canonicalize to, so the
 * expression preserves the stored text rather than substituting the epoch.
 * Substituting would move the row's `last_activity_at` BACKWARD to 1970 and so
 * into range of the irreversible retention purge; preserving it leaves the row
 * where it already sits — outside the stale sweep's canonical-only guard, which
 * is a stall the FEA-3743 heal converges on, not data loss.
 */
test("ISS-5497: an unparseable started_at is preserved, never rewritten to the epoch", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, "unparseable", "2026-13-01", []);

    await recompute(prisma, "unparseable");

    assert.equal(await readLastActivityAt(prisma, "unparseable"), "2026-13-01");
  } finally {
    await close();
  }
});

/*
 * ISS-5497 (review): the ORDERING half of this ticket, and the reason the
 * DATA_REVISION bump is not on its own a fix. The rebuild that re-derives
 * `last_activity_at` runs from POST-BOOT maintenance, after
 * `openSqliteAgentDatabase` has already run `sweepExpiredSessions` on the OLD
 * value — so a session whose wrong old winner sits BEFORE the retention cutoff
 * while its true instant sits AFTER it would be purged, irreversibly, with every
 * child row, before revision 75 could repair it. The pre-sweep heal is what
 * closes that: it is source-independent (it reads the session's stored events,
 * not a transcript, so it also reaches the missing-source sessions the rollup
 * bridge stamps without recomputing) and it runs before both sweeps.
 *
 * The mixed-precision reproduction is used because it is the smallest shape
 * where the OLD byte-wise winner is the EARLIER instant: `…10:00:00Z` beats
 * `…10:00:00.500Z` on bytes (`Z` 0x5A > `.` 0x2E).
 */
test("ISS-5497: the pre-sweep heal corrects the cursor before the retention purge", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // 90d window from HEAL_NOW (2026-06-23) → cutoff 2026-03-25. The events
    // straddle it: the byte-wise winner is 5 days BEFORE the cutoff (purge
    // eligible), the true latest instant is a day AFTER it (must survive).
    await store.query(
      "INSERT INTO sessions (id, status, updated_at, last_activity_at, started_at, data_revision) VALUES ('purge-window', 'inactive', '2026-03-20T00:00:00.000Z', '2026-03-20T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)"
    );
    await store.query(SEED_EVENT_SQL, [
      "purge-window-0",
      "purge-window",
      "2026-03-20T00:00:00Z",
    ]);
    await store.query(SEED_EVENT_SQL, [
      "purge-window-1",
      "purge-window",
      "2026-03-26T00:00:00.500Z",
    ]);

    const { healed, failedChunks } = await healSessionLastActivityAtFloor(
      prisma,
      HEAL_NOW,
      () => undefined
    );
    assert.equal(failedChunks, 0);
    assert.equal(healed, 1, "the disagreement is discovered without a rebuild");
    assert.equal(
      await readLastActivityAt(prisma, "purge-window"),
      "2026-03-26T00:00:00.500Z",
      "the cursor now names the genuinely-latest event"
    );

    const { purged } = await sweepExpiredSessions(prisma, HEAL_NOW, 90);
    assert.equal(
      purged,
      0,
      "the session survives the sweep it would have lost"
    );

    // Convergent: the healed value equals the fold, so the next boot is a no-op
    // and the row does not churn the sync cursor every launch.
    assert.deepEqual(
      await healSessionLastActivityAtFloor(prisma, HEAL_NOW, () => undefined),
      { healed: 0, failedChunks: 0 }
    );
  } finally {
    await close();
  }
});

/*
 * ...and the heal must stay OFF the sessions this ticket does not correct. A
 * session in LEGACY mode (here: an event SQLite cannot parse) folds to exactly
 * what `main` folds to, so there is nothing to heal — and discovering it would
 * mean comparing across mixed forms, the byte-wise judgement the FEA-3743 guard
 * on the original arm exists to refuse. An all-canonical session is the other
 * half of the same claim: it is the overwhelmingly common row, and it must not
 * even reach the fold.
 */
test("ISS-5497: the pre-sweep heal leaves legacy-mode and already-correct rows alone", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // Legacy mode: the basic-format offset SQLite cannot parse.
    await seedSession(store, "legacy-mode", "2026-06-21T08:00:00.000Z", [
      "2026-06-22T23:00:00.000+0530",
    ]);
    // All-canonical, and already holding the fold's answer.
    await seedSession(store, "already-right", "2026-06-21T08:00:00.000Z", [
      "2026-06-22T10:00:00.000Z",
    ]);
    await recompute(prisma, "legacy-mode");
    await recompute(prisma, "already-right");
    const legacyBefore = await readLastActivityAt(prisma, "legacy-mode");
    const rightBefore = await readLastActivityAt(prisma, "already-right");

    const { healed, failedChunks } = await healSessionLastActivityAtFloor(
      prisma,
      HEAL_NOW,
      () => undefined
    );

    assert.deepEqual({ healed, failedChunks }, { healed: 0, failedChunks: 0 });
    assert.equal(await readLastActivityAt(prisma, "legacy-mode"), legacyBefore);
    assert.equal(
      await readLastActivityAt(prisma, "already-right"),
      rightBefore
    );
  } finally {
    await close();
  }
});
