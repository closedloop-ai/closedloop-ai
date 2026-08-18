/**
 * @file timestamp-format-heal.test.ts
 * @description FEA-3743 / ISS-5330: the boot heal that rewrites non-canonical
 * stored timestamp text into the canonical UTC form.
 *
 * ISS-5330 tightened `CANONICAL_UTC_TIMESTAMP_GLOB_SQL` (and its JS mirror
 * `isCanonicalUtcTimestamp`) from "starts with a date and ends in Z" to the
 * exact fixed-width `YYYY-MM-DDTHH:mm:ss.sssZ`, because mixed precision is
 * byte-wise WRONG in the direction that matters: `…:00Z` sorts after
 * `…:00.500Z` while being the EARLIER instant. Tightening a guard can only be
 * safe if the heal that produces canonical text was widened in the same change
 * — otherwise every whole-second 'Z' row falls outside the guard AND outside
 * the heal, and is stranded permanently. These cases pin that pairing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isCanonicalUtcTimestamp } from "../src/main/database/session-timestamp-form.js";
import { normalizeStoredTimestampFormats } from "../src/main/database/timestamp-format-maintenance.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const HEAL_NOW = "2026-06-23T00:00:00.000Z";

const SEED_SESSION_SQL =
  "INSERT INTO sessions (id, status, updated_at, last_activity_at, started_at, data_revision) VALUES ($1, $2, $3, $4, $5, $6)";

type SessionTimestampRow = {
  started_at: string | null;
  last_activity_at: string | null;
};

test("ISS-5330: the heal rewrites a whole-second 'Z' value to millisecond precision", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // Ends in 'Z', so the pre-ISS-5330 `NOT LIKE '%Z'` predicate skipped it —
    // which is precisely how tightening the guard would have stranded it.
    await store.query(SEED_SESSION_SQL, [
      "whole-second",
      "active",
      "2026-06-22T09:00:00.000Z",
      "2026-06-22T10:00:00Z",
      "2026-06-22T08:00:00Z",
      1,
    ]);
    assert.equal(isCanonicalUtcTimestamp("2026-06-22T10:00:00Z"), false);

    const result = await normalizeStoredTimestampFormats(
      prisma,
      () => undefined,
      () => HEAL_NOW
    );

    assert.equal(result.rewritten, 2);
    assert.deepEqual(result.healedSessionIds, ["whole-second"]);
    const rows = await prisma.client.$queryRawUnsafe<SessionTimestampRow[]>(
      "SELECT started_at, last_activity_at FROM sessions WHERE id = 'whole-second'"
    );
    assert.equal(rows[0].started_at, "2026-06-22T08:00:00.000Z");
    assert.equal(rows[0].last_activity_at, "2026-06-22T10:00:00.000Z");
    assert.equal(isCanonicalUtcTimestamp(rows[0].last_activity_at), true);
  } finally {
    await close();
  }
});

/*
 * ISS-5429: the heal's discovery predicate used to require the `T`, which is a
 * narrower notion of "date-shaped" than the columns' own consumers use — the
 * `SESSION_STARTED_AT_FLOOR_SQL` floor and (before ISS-5497 canonicalized it)
 * `recomputeSessionLastActivityAt`'s fold over `events.created_at` both admit a
 * bare `YYYY-MM-DD` prefix. So a
 * date-only value could be written into `last_activity_at`, matched no heal, and
 * left the stale sweep's canonical-only guard holding that session back forever:
 * permanently `active` in the Sessions UI and, never terminal, permanently
 * outside the retention purge. Healing it is what makes the hold-back
 * convergent rather than a life sentence.
 */
test("ISS-5429: the heal rewrites a date-only value, the shape that used to be stranded forever", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await store.query(SEED_SESSION_SQL, [
      "date-only",
      "active",
      "2026-06-22T09:00:00.000Z",
      "2026-06-22",
      "2026-06-22T08:00:00.000Z",
      1,
    ]);
    assert.equal(isCanonicalUtcTimestamp("2026-06-22"), false);

    const result = await normalizeStoredTimestampFormats(
      prisma,
      () => undefined,
      () => HEAL_NOW
    );

    assert.equal(result.rewritten, 1);
    assert.deepEqual(result.healedSessionIds, ["date-only"]);
    const rows = await prisma.client.$queryRawUnsafe<SessionTimestampRow[]>(
      "SELECT started_at, last_activity_at FROM sessions WHERE id = 'date-only'"
    );
    assert.equal(
      rows[0].last_activity_at,
      "2026-06-22T00:00:00.000Z",
      "the date-only value becomes the same instant in canonical form"
    );
    assert.equal(isCanonicalUtcTimestamp(rows[0].last_activity_at), true);
  } finally {
    await close();
  }
});

/*
 * ISS-5429: the widening must not start churning values this heal cannot
 * re-express as the SAME instant.
 *
 * Three shapes, all left alone. Free text does not match the date prefix at
 * all. A date-PREFIXED but unparseable value is skipped downstream by
 * `toCanonicalIso` returning its input. And the SQLite SPACE form is excluded
 * by the discovery glob ON PURPOSE (review): `Date.parse` reads `2026-06-22` as
 * UTC midnight but `2026-06-22 10:00:00` as LOCAL time, so healing the space
 * form would rewrite it to a different instant — shifted by whatever offset the
 * operator happens to be in — and bump `updated_at` so that shift syncs to the
 * cloud. Holding it back is wrong; silently moving it is worse.
 *
 * ISS-5496 did NOT move the space form into the heal. Its zone-less `T` sibling
 * (`2026-06-22T10:00:00`) was already inside the discovery glob and so was
 * already being shifted; canonicalizing it as UTC stops that. The space form
 * stays outside the glob, and stays untouched — see the zone-less cases below.
 */
test("ISS-5429: the widened discovery glob leaves non-instant text and the local-time space form untouched", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await store.query(SEED_SESSION_SQL, [
      "free-text",
      "active",
      "2026-06-22T09:00:00.000Z",
      "not-a-timestamp",
      "2026-06-22T08:00:00.000Z",
      1,
    ]);
    await store.query(SEED_SESSION_SQL, [
      "date-prefixed-junk",
      "active",
      "2026-06-22T09:00:00.000Z",
      "2026-06-22T99:99:99",
      "2026-06-22T08:00:00.000Z",
      1,
    ]);
    await store.query(SEED_SESSION_SQL, [
      "space-form",
      "active",
      "2026-06-22T09:00:00.000Z",
      "2026-06-22 10:00:00",
      "2026-06-22T08:00:00.000Z",
      1,
    ]);

    const result = await normalizeStoredTimestampFormats(
      prisma,
      () => undefined,
      () => HEAL_NOW
    );

    assert.equal(result.rewritten, 0);
    assert.deepEqual(result.healedSessionIds, []);
    const rows = await prisma.client.$queryRawUnsafe<SessionTimestampRow[]>(
      "SELECT last_activity_at FROM sessions ORDER BY id"
    );
    assert.equal(rows[0].last_activity_at, "2026-06-22T99:99:99");
    assert.equal(rows[1].last_activity_at, "not-a-timestamp");
    assert.equal(
      rows[2].last_activity_at,
      "2026-06-22 10:00:00",
      "the space form keeps its stored text rather than being shifted by the local offset"
    );
  } finally {
    await close();
  }
});

/*
 * ISS-5496: the zone-less `T` form (`2026-06-22T10:00:00`) is admitted by the
 * discovery glob, but `toCanonicalIso` is `Date.parse`, and per ECMA-262 only a
 * date-ONLY string is read as UTC — a date-TIME string with no offset is LOCAL.
 * So the heal used to rewrite this shape to a DIFFERENT instant, shifted by
 * whatever offset the operator happened to be in, and (being a `sessions`
 * column) bump `updated_at` so the shifted value synced to the cloud. It now
 * canonicalizes the value as UTC, which is what SQLite's `unixepoch()` and every
 * lexical comparison over the column already read it as.
 *
 * The invariant is a property of the INSTANT, not of the text, so it has to be
 * pinned in a zone where a shift would actually be visible: under `TZ=UTC` the
 * local offset is zero and a shifted implementation passes vacuously.
 * `process.env.TZ` is assigned rather than passed to the runner so the check
 * travels with the case; Node re-reads it on the next `Date` construction, and
 * node:test runs a file's top-level tests sequentially so the window cannot
 * overlap another case.
 */
test("ISS-5496: a zone-less T value heals to UTC, not to the operator's local offset", async () => {
  const originalTz = process.env.TZ;
  process.env.TZ = "America/Chicago";
  try {
    // Guard the guard: if this ever stops shifting, the assertions below would
    // pass against the buggy implementation too.
    assert.equal(
      new Date(Date.parse("2026-06-22T10:00:00")).toISOString(),
      "2026-06-22T15:00:00.000Z",
      "the harness zone must actually shift a zone-less parse"
    );
    const { db: store, prisma, close } = await openTestPrisma();
    try {
      await store.query(SEED_SESSION_SQL, [
        "zone-less-t",
        "active",
        "2026-06-22T09:00:00.000Z",
        "2026-06-22T10:00:00",
        // A minute-precision sibling, to pin that the zone is all that is
        // supplied — the seconds/millis still come from `toISOString`.
        "2026-06-22T08:00",
        1,
      ]);
      // The one zone-less shape whose canonical form is the stored text plus
      // exactly the 'Z' (review). It heals like any other, but a canonicalizer
      // that inferred "unparseable" from `canonical === value + 'Z'` would read
      // this heal as a parse failure and strand the whole 3-digit-millis family
      // permanently — the ISS-5429 non-convergence, re-created.
      await store.query(SEED_SESSION_SQL, [
        "zone-less-t-millis",
        "active",
        "2026-06-22T09:00:00.000Z",
        "2026-06-22T11:00:00.123",
        "2026-06-22T08:00:00.000Z",
        1,
      ]);

      const result = await normalizeStoredTimestampFormats(
        prisma,
        () => undefined,
        () => HEAL_NOW
      );

      assert.equal(result.rewritten, 3);
      assert.deepEqual(result.healedSessionIds, [
        "zone-less-t",
        "zone-less-t-millis",
      ]);
      const rows = await prisma.client.$queryRawUnsafe<SessionTimestampRow[]>(
        "SELECT started_at, last_activity_at FROM sessions ORDER BY id"
      );
      assert.equal(
        rows[0].last_activity_at,
        "2026-06-22T10:00:00.000Z",
        "the stored wall-clock digits are read as UTC, not shifted to 15:00Z"
      );
      assert.equal(rows[0].started_at, "2026-06-22T08:00:00.000Z");
      assert.equal(isCanonicalUtcTimestamp(rows[0].last_activity_at), true);
      assert.equal(
        rows[1].last_activity_at,
        "2026-06-22T11:00:00.123Z",
        "a zone-less value already at millisecond precision heals to exactly its own digits plus the 'Z'"
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
 * ISS-5496: the same value must heal to the same text on every machine. A
 * zone-dependent heal is not merely wrong once — it makes two desktops in
 * different zones store DIFFERENT text for the same row, and (because the
 * `sessions` arm bumps `updated_at`) each one re-syncs its own spelling over
 * the other's. Running the identical store through both zones is what pins
 * determinism rather than just the UTC reading.
 */
test("ISS-5496: healing a zone-less T value is zone-independent", async () => {
  const originalTz = process.env.TZ;
  const healedPerZone: (string | null)[] = [];
  try {
    for (const zone of ["America/Chicago", "Asia/Tokyo"]) {
      process.env.TZ = zone;
      const { db: store, prisma, close } = await openTestPrisma();
      try {
        await store.query(SEED_SESSION_SQL, [
          "zone-less-t",
          "active",
          "2026-06-22T09:00:00.000Z",
          "2026-06-22T10:00:00",
          "2026-06-22T08:00:00.000Z",
          1,
        ]);
        await normalizeStoredTimestampFormats(
          prisma,
          () => undefined,
          () => HEAL_NOW
        );
        const rows = await prisma.client.$queryRawUnsafe<SessionTimestampRow[]>(
          "SELECT started_at, last_activity_at FROM sessions WHERE id = 'zone-less-t'"
        );
        healedPerZone.push(rows[0].last_activity_at);
      } finally {
        await close();
      }
    }
  } finally {
    if (originalTz === undefined) {
      Reflect.deleteProperty(process.env, "TZ");
    } else {
      process.env.TZ = originalTz;
    }
  }
  assert.deepEqual(healedPerZone, [
    "2026-06-22T10:00:00.000Z",
    "2026-06-22T10:00:00.000Z",
  ]);
});

test("ISS-5330: an already-canonical store stays a no-op, and an offset form still heals", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await store.query(SEED_SESSION_SQL, [
      "canonical",
      "active",
      "2026-06-22T09:00:00.000Z",
      "2026-06-22T10:00:00.000Z",
      "2026-06-22T08:00:00.000Z",
      1,
    ]);
    await store.query(SEED_SESSION_SQL, [
      "offset-form",
      "active",
      "2026-06-22T09:00:00.000Z",
      "2026-06-22T05:00:00-05:00",
      "2026-06-22T08:00:00.000Z",
      1,
    ]);

    const result = await normalizeStoredTimestampFormats(
      prisma,
      () => undefined,
      () => HEAL_NOW
    );

    assert.equal(result.rewritten, 1, "only the offset row is rewritten");
    assert.deepEqual(result.healedSessionIds, ["offset-form"]);
    const rows = await prisma.client.$queryRawUnsafe<SessionTimestampRow[]>(
      "SELECT started_at, last_activity_at FROM sessions ORDER BY id"
    );
    assert.equal(rows[0].last_activity_at, "2026-06-22T10:00:00.000Z");
    assert.equal(rows[1].last_activity_at, "2026-06-22T10:00:00.000Z");
  } finally {
    await close();
  }
});

const SEED_ARTIFACT_SQL = `INSERT INTO artifacts
  (id, identity_key, kind, branch_name, first_pushed_at, observed_at,
   created_at, last_seen_at)
  VALUES ($1, $2, 'branch', $3, $4, $4, $5, $5)`;

const SEED_PULL_REQUEST_SQL = `INSERT INTO pull_requests
  (id, session_id, pr_url, pr_number, repo_full_name, observed_at, created_at)
  VALUES ($1, $2, $3, $4, 'closedloop-ai/symphony-alpha', $5, $6)`;

const SEED_LINK_SQL = `INSERT INTO session_artifact_links
  (id, session_id, artifact_id, relation, method, evidence, is_primary, status,
   extractor_version, observed_at, created_at)
  VALUES ($1, $2, $3, 'created', 'git_push', '{}', 0, 'candidate', 1, $4, $5)`;

type LinkObservedAtRow = { id: string; observed_at: string };

/**
 * ISS-5427: `session_artifact_links.observed_at` stopped being the (canonical)
 * import wall clock in ISS-5236 and became the harness-supplied instant, which
 * the resolver only VALIDATED. Offset-form values therefore landed in a TEXT
 * column that SQLite compares lexically, and neither the DATA_REVISION rebuild
 * (it re-reads the same raw transcript) nor the set-once `first_pushed_at` slot
 * self-heals. These cases pin the boot heal that repairs the rows written in
 * between, and the sync re-queue that carries the correction to the cloud.
 */
test("ISS-5427: the heal canonicalizes artifact-link observed_at and re-queues its session for sync", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const staleUpdatedAt = "2026-06-20T00:00:00.000Z";
    await store.query(SEED_SESSION_SQL, [
      "s-offset",
      "active",
      staleUpdatedAt,
      "2026-06-22T10:00:00.000Z",
      "2026-06-22T08:00:00.000Z",
      1,
    ]);
    await store.query(SEED_SESSION_SQL, [
      "s-canonical",
      "active",
      staleUpdatedAt,
      "2026-06-22T10:00:00.000Z",
      "2026-06-22T08:00:00.000Z",
      1,
    ]);
    await store.query(SEED_ARTIFACT_SQL, [
      "a1",
      "branch:feat/iss-5427",
      "feat/iss-5427",
      // Set-once, earliest-wins push state seeded from the same bad instant.
      "2026-06-22T05:00:00-05:00",
      "2026-06-22T09:00:00.000Z",
    ]);
    await store.query(SEED_LINK_SQL, [
      "l-offset",
      "s-offset",
      "a1",
      "2026-06-22T05:00:00-05:00",
      "2026-06-22T09:00:00.000Z",
    ]);
    await store.query(SEED_LINK_SQL, [
      "l-canonical",
      "s-canonical",
      "a1",
      "2026-06-22T10:00:00.000Z",
      "2026-06-22T09:00:00.000Z",
    ]);
    await store.query(SEED_PULL_REQUEST_SQL, [
      "pr-1",
      "s-offset",
      "https://github.com/closedloop-ai/symphony-alpha/pull/5427",
      5427,
      "2026-06-22T05:00:00-05:00",
      "2026-06-22T09:00:00.000Z",
    ]);

    const result = await normalizeStoredTimestampFormats(
      prisma,
      () => undefined,
      () => HEAL_NOW
    );

    // One link + first_pushed_at + artifacts.observed_at + the PR row; the
    // already-canonical link is untouched.
    assert.equal(result.rewritten, 4);
    const links = await prisma.client.$queryRawUnsafe<LinkObservedAtRow[]>(
      "SELECT id, observed_at FROM session_artifact_links ORDER BY id"
    );
    assert.equal(links[0].observed_at, "2026-06-22T10:00:00.000Z");
    assert.equal(links[1].observed_at, "2026-06-22T10:00:00.000Z");
    assert.ok(isCanonicalUtcTimestamp(links[1].observed_at));

    // `first_pushed_at` is set-once, so a non-canonical value would keep every
    // later `MIN(COALESCE(first_pushed_at, $2), $2)` comparing mixed formats.
    // `artifacts.observed_at` feeds local-insights' lexical BETWEEN scans.
    const artifacts = await prisma.client.$queryRawUnsafe<
      { first_pushed_at: string; observed_at: string }[]
    >("SELECT first_pushed_at, observed_at FROM artifacts WHERE id = 'a1'");
    assert.equal(artifacts[0].first_pushed_at, "2026-06-22T10:00:00.000Z");
    assert.equal(artifacts[0].observed_at, "2026-06-22T10:00:00.000Z");

    // `pull_requests.observed_at` orders the newest-PR-per-branch pick.
    const prs = await prisma.client.$queryRawUnsafe<{ observed_at: string }[]>(
      "SELECT observed_at FROM pull_requests WHERE id = 'pr-1'"
    );
    assert.equal(prs[0].observed_at, "2026-06-22T10:00:00.000Z");

    // The link row is a SYNCED child projection, and sync selection is driven by
    // `sessions.updated_at` — without the bump the cloud keeps the old form.
    const sessions = await prisma.client.$queryRawUnsafe<
      { id: string; updated_at: string }[]
    >("SELECT id, updated_at FROM sessions ORDER BY id");
    assert.equal(sessions[0].updated_at, staleUpdatedAt, "s-canonical");
    assert.equal(sessions[1].updated_at, HEAL_NOW, "s-offset");
  } finally {
    await close();
  }
});

test("ISS-5427: an all-canonical artifact-link store is a pure no-op", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const staleUpdatedAt = "2026-06-20T00:00:00.000Z";
    await store.query(SEED_SESSION_SQL, [
      "s-1",
      "active",
      staleUpdatedAt,
      "2026-06-22T10:00:00.000Z",
      "2026-06-22T08:00:00.000Z",
      1,
    ]);
    await store.query(SEED_ARTIFACT_SQL, [
      "a1",
      "branch:feat/iss-5427",
      "feat/iss-5427",
      "2026-06-22T10:00:00.000Z",
      "2026-06-22T09:00:00.000Z",
    ]);
    await store.query(SEED_LINK_SQL, [
      "l-1",
      "s-1",
      "a1",
      "2026-06-22T10:00:00.000Z",
      "2026-06-22T09:00:00.000Z",
    ]);

    const result = await normalizeStoredTimestampFormats(
      prisma,
      () => undefined,
      () => HEAL_NOW
    );

    assert.equal(result.rewritten, 0);
    // No spurious re-sync: an untouched store must not churn the sync cursor.
    const sessions = await prisma.client.$queryRawUnsafe<
      { updated_at: string }[]
    >("SELECT updated_at FROM sessions WHERE id = 's-1'");
    assert.equal(sessions[0].updated_at, staleUpdatedAt);
  } finally {
    await close();
  }
});

test("ISS-5427: an unparseable observed_at is left alone, never loops, and never re-queues its session", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    const staleUpdatedAt = "2026-06-20T00:00:00.000Z";
    await store.query(SEED_SESSION_SQL, [
      "s-junk",
      "active",
      staleUpdatedAt,
      "2026-06-22T10:00:00.000Z",
      "2026-06-22T08:00:00.000Z",
      1,
    ]);
    await store.query(SEED_ARTIFACT_SQL, [
      "a1",
      "branch:feat/iss-5427",
      "feat/iss-5427",
      null,
      "2026-06-22T09:00:00.000Z",
    ]);
    // Date-shaped enough to pass the GLOB, but not a parseable instant — the
    // rowid keyset cursor is what stops this from being re-selected forever.
    const junk = "2026-06-22Tnot-a-time";
    await store.query(SEED_LINK_SQL, [
      "l-junk",
      "s-junk",
      "a1",
      junk,
      "2026-06-22T09:00:00.000Z",
    ]);

    const result = await normalizeStoredTimestampFormats(
      prisma,
      () => undefined,
      () => HEAL_NOW
    );

    assert.equal(result.rewritten, 0);
    const links = await prisma.client.$queryRawUnsafe<LinkObservedAtRow[]>(
      "SELECT id, observed_at FROM session_artifact_links"
    );
    assert.equal(links[0].observed_at, junk);
    // A row the heal will never rewrite must not re-queue its session either:
    // it stays non-canonical forever, so a predicate-scoped bump would re-sync
    // this session on EVERY boot rather than once.
    const sessions = await prisma.client.$queryRawUnsafe<
      { updated_at: string }[]
    >("SELECT updated_at FROM sessions WHERE id = 's-junk'");
    assert.equal(sessions[0].updated_at, staleUpdatedAt);
  } finally {
    await close();
  }
});
