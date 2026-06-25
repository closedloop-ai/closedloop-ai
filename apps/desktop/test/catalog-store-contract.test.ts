/**
 * @file catalog-store-contract.test.ts
 * @description FEA-1791 Phase 3 — catalog-store is fully on the single
 * DesktopPrisma client. The reads/writes that map cleanly use typed delegates
 * (`listHistory` findMany, install-runs create/update/findFirst/findMany,
 * `applyFetchResult` updateMany+upsert, `applyContentsFetch` updateMany); only
 * `listCatalog`/`getCatalog` stay on `prisma.client.$queryRawUnsafe` (the
 * `group_concat` installed-harness decoration has no clean typed form).
 *
 * Boots a real libSQL DB via `openTestPrisma` (production migration chain), so
 * this doubles as the re-validation that the typed delegates behave over
 * `@prisma/adapter-libsql`: it pins that the `group_concat`/`COUNT` decoration
 * still maps to the DTO (skillCount Number()-coerced, not bigint), that the
 * `contents_cache` Json round-trips (typed write → raw read), and that the
 * install-run lifecycle (autoincrement id, in-flight lookup, end) works.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyContentsFetch,
  applyFetchResult,
  getCatalog,
  inFlightInstallRun,
  listCatalog,
  listHistory,
  listInstallRuns,
  recordInstallRunEnd,
  recordInstallRunStart,
} from "../src/main/packs/catalog-store.js";
import { openTestPrisma, type RawDb } from "./prisma-test-utils.js";

async function seedPack(
  db: RawDb,
  pack: {
    packId: string;
    displayName: string;
    pinOrder?: number | null;
    stars?: number | null;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO pack_catalog (pack_id, display_name, github_url, pin_order, stars, seed_version)
     VALUES ($1, $2, $3, $4, $5, 1)`,
    [
      pack.packId,
      pack.displayName,
      `https://github.com/acme/${pack.packId}`,
      pack.pinOrder ?? null,
      pack.stars ?? null,
    ]
  );
}

async function seedInstall(
  db: RawDb,
  packId: string,
  harness: string
): Promise<void> {
  await db.query(
    `INSERT INTO agent_packs (pack_id, harness, install_path, install_kind, detected_at, last_seen_at)
     VALUES ($1, $2, $3, 'directory', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
    [packId, harness, `/packs/${packId}-${harness}`]
  );
}

async function setup() {
  const opened = await openTestPrisma();
  const { db } = opened;
  // pinned: pin_order set → sorts first regardless of stars; installed on two
  // harnesses (group_concat fan-out) with one skill.
  await seedPack(db, {
    packId: "pinned",
    displayName: "Pinned",
    pinOrder: 1,
    stars: 1,
  });
  await seedPack(db, { packId: "zeta", displayName: "Zeta", stars: 100 });
  await seedPack(db, { packId: "alpha", displayName: "Alpha", stars: 50 });
  await seedInstall(db, "pinned", "claude");
  await seedInstall(db, "pinned", "codex");
  await db.query(
    `INSERT INTO skills (skill_id, pack_id, harness, install_path, name, detected_at, last_seen_at)
     VALUES ('sk-1', 'pinned', 'claude', '/packs/pinned-claude', 'a', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`
  );
  return opened;
}

test("listCatalog: DTO mapping, group_concat installed harnesses, Number() skillCount, ordering", async () => {
  const { prisma, close } = await setup();
  try {
    const entries = await listCatalog(prisma);
    // pin_order ASC (nulls last) → pinned first; then stars DESC → zeta, alpha.
    assert.deepEqual(
      entries.map((e) => e.packId),
      ["pinned", "zeta", "alpha"]
    );
    const pinned = entries[0]!;
    assert.deepEqual([...pinned.installedHarnesses].sort(), [
      "claude",
      "codex",
    ]);
    assert.equal(pinned.skillCount, 1);
    // COUNT(*) over the $queryRawUnsafe path must not surface as bigint.
    assert.equal(typeof pinned.skillCount, "number");
    assert.deepEqual(entries[1]?.installedHarnesses, []);
    assert.equal(entries[1]?.skillCount, 0);
  } finally {
    await close();
  }
});

test("applyFetchResult: live fields update + history sample; getCatalog/listHistory read them back", async () => {
  const { prisma, close } = await setup();
  try {
    await applyFetchResult(prisma, {
      pack_id: "alpha",
      stars: 222,
      forks: 9,
      description: "live desc",
      last_release: "v2.0.0",
    });
    const entry = await getCatalog(prisma, "alpha");
    assert.equal(entry?.stars, 222);
    assert.equal(entry?.forks, 9);
    assert.equal(entry?.descriptionLive, "live desc");
    assert.equal(entry?.lastRelease, "v2.0.0");
    assert.equal(entry?.history.length, 1);
    assert.equal(entry?.history[0]?.stars, 222);

    const history = await listHistory(prisma, "alpha");
    assert.equal(history.length, 1);
    assert.equal(typeof history[0]?.forks, "number");

    // A null fetch keeps the prior description_live (COALESCE) and writes no
    // history row (stars/forks both null).
    await applyFetchResult(prisma, { pack_id: "alpha", description: null });
    const after = await getCatalog(prisma, "alpha");
    assert.equal(after?.descriptionLive, "live desc");
    assert.equal(after?.history.length, 1);
  } finally {
    await close();
  }
});

test("applyContentsFetch: contents_cache Json round-trips (typed write → raw read)", async () => {
  const { prisma, close } = await setup();
  try {
    await applyContentsFetch(prisma, {
      pack_id: "alpha",
      items: [{ name: "demo", type: "skill" }],
    });
    const entry = await getCatalog(prisma, "alpha");
    assert.equal(entry?.contentsCache?.[0]?.name, "demo");
    assert.equal(entry?.contentsCache?.[0]?.type, "skill");

    // Clearing to null wipes the cache.
    await applyContentsFetch(prisma, { pack_id: "alpha", items: null });
    assert.equal((await getCatalog(prisma, "alpha"))?.contentsCache, null);
  } finally {
    await close();
  }
});

test("install runs: create returns id, in-flight lookup, end clears it, list filters + paginates", async () => {
  const { prisma, close } = await setup();
  try {
    const runId = await recordInstallRunStart(prisma, {
      pack_id: "alpha",
      harness: "claude",
      action: "install",
      command: "echo install",
    });
    assert.equal(typeof runId, "number");

    const inFlight = await inFlightInstallRun(prisma, "alpha");
    assert.equal(inFlight?.id, runId);
    assert.equal(inFlight?.started_at != null, true);

    await recordInstallRunEnd(prisma, runId, {
      exit_code: 0,
      stdout_tail: "ok",
    });
    // Ended → no longer in-flight.
    assert.equal(await inFlightInstallRun(prisma, "alpha"), null);

    const runs = await listInstallRuns(prisma, { pack_id: "alpha" });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.id, runId);
    assert.equal(runs[0]?.exitCode, 0);
    assert.equal(runs[0]?.stdoutTail, "ok");

    // A second run for a different pack; unfiltered list sees both, newest
    // first, and limit/offset paginate.
    await recordInstallRunStart(prisma, {
      pack_id: "zeta",
      harness: "codex",
      action: "install",
      command: "echo install",
    });
    assert.equal((await listInstallRuns(prisma)).length, 2);
    assert.equal((await listInstallRuns(prisma, { limit: 1 })).length, 1);
    assert.equal(
      (await listInstallRuns(prisma, { pack_id: "missing" })).length,
      0
    );
  } finally {
    await close();
  }
});
