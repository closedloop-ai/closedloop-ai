/**
 * @file discarded-write-narrowing-packs.test.ts
 * @description ISS-6321 (batch 5/6) — the five discarded wide writes under
 * `main/packs/`, run against a real libSQL store.
 *
 * ALL FIVE are `upsert`, so option (b) is not a preference here, it is the only
 * option: Prisma ships no `upsertMany`, and an upsert has no P2025 to preserve
 * in the first place (an absent row is created, not rejected). The parity
 * contract each test pins is therefore the CREATE-vs-UPDATE branch: adding a
 * `select` must not change which branch runs or what it writes.
 *
 * These sites are also where the desktop schema's compound keys bite. Only
 * `Skill` (`skillId`) and `PackCatalog` (`packId`) have a single-column key,
 * and NEITHER is called `id` — `AgentPack` is keyed on
 * `[packId, harness, installPath]`, `ProjectPackAssociation` on
 * `[projectPath, packId]`, `PackCatalogHistory` on `[packId, fetchedAt]`. The
 * cloud batches' `select: { id: true }` does not compile against any of them.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFetchResult,
  upsertCatalogSeed,
} from "../src/main/packs/catalog-store.js";
import {
  upsertPack,
  upsertProjectAssociation,
  upsertSkill,
} from "../src/main/packs/pack-store.js";
import {
  assertNarrowedTo,
  recordDesktopWrites,
} from "./discarded-write-narrowing-utils.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const PACK_ID = "iss6321-pack";
const HARNESS = "claude";
const INSTALL_PATH = "/tmp/iss6321/pack";

async function open() {
  const opened = await openTestPrisma();
  return { ...opened, recorded: recordDesktopWrites(opened.prisma) };
}

async function rowsOf<T extends Record<string, unknown>>(
  db: Awaited<ReturnType<typeof openTestPrisma>>["db"],
  sql: string
): Promise<T[]> {
  const result = await db.query<T>(sql);
  return result.rows;
}

const packRow = (version: string) => ({
  pack_id: PACK_ID,
  harness: HARNESS,
  install_path: INSTALL_PATH,
  install_kind: "git",
  source_url: "https://github.com/acme/demo",
  version,
});

// ───────────────────────── upsertPack (pack-store 65) ─────────────────────────

test("PARITY: upsertPack creates then updates the same compound-keyed row", async () => {
  const { db, recorded, close } = await open();
  try {
    await upsertPack(recorded.prisma, packRow("1.0.0"));
    await upsertPack(recorded.prisma, packRow("2.0.0"));

    const rows = await rowsOf<{ pack_id: string; version: string | null }>(
      db,
      "SELECT pack_id, version FROM agent_packs"
    );
    assert.equal(rows.length, 1, "the second upsert must UPDATE, not insert");
    assert.equal(rows[0].version, "2.0.0");
  } finally {
    await close();
  }
});

test("NARROWING: upsertPack RETURNINGs only its compound primary key", async () => {
  const { recorded, close } = await open();
  try {
    await upsertPack(recorded.prisma, packRow("1.0.0"));

    assertNarrowedTo(
      recorded.only("agentPack", "upsert"),
      { packId: true, harness: true, installPath: true },
      "upsertPack"
    );
  } finally {
    await close();
  }
});

// ──────────────────────── upsertSkill (pack-store 122) ────────────────────────

/**
 * `upsertSkill`'s update block deliberately PRESERVES `name` (and `harness`,
 * `install_path`, `detected_at`) while COALESCE-ing `version` — mirroring the
 * raw `ON CONFLICT` it replaced. Pinning both halves is what would catch a
 * `select` change that quietly swapped the update payload.
 */
test("PARITY: upsertSkill re-upserts in place, refreshing version but preserving name", async () => {
  const { db, recorded, close } = await open();
  try {
    const row = {
      skill_id: "iss6321-skill",
      harness: HARNESS,
      install_path: INSTALL_PATH,
      name: "demo skill",
      version: "1.0.0",
    };
    await upsertSkill(recorded.prisma, row);
    await upsertSkill(recorded.prisma, {
      ...row,
      name: "renamed skill",
      version: "2.0.0",
    });

    const rows = await rowsOf<{
      skill_id: string;
      name: string;
      version: string | null;
    }>(db, "SELECT skill_id, name, version FROM skills");
    assert.equal(rows.length, 1, "the second upsert must UPDATE, not insert");
    assert.equal(rows[0].name, "demo skill", "name is preserved on conflict");
    assert.equal(rows[0].version, "2.0.0", "version is refreshed on conflict");
  } finally {
    await close();
  }
});

test("NARROWING: upsertSkill RETURNINGs only its skill id", async () => {
  const { recorded, close } = await open();
  try {
    await upsertSkill(recorded.prisma, {
      skill_id: "iss6321-skill",
      harness: HARNESS,
      install_path: INSTALL_PATH,
      name: "demo skill",
    });

    assertNarrowedTo(
      recorded.only("skill", "upsert"),
      { skillId: true },
      "upsertSkill"
    );
  } finally {
    await close();
  }
});

// ─────────────── upsertProjectAssociation (pack-store 162) ───────────────

test("PARITY + NARROWING: upsertProjectAssociation is idempotent and RETURNINGs its compound key", async () => {
  const { db, recorded, close } = await open();
  try {
    const row = { project_path: "/tmp/iss6321/project", pack_id: PACK_ID };
    await upsertProjectAssociation(recorded.prisma, row);
    await upsertProjectAssociation(recorded.prisma, row);

    const rows = await rowsOf<{ project_path: string; pack_id: string }>(
      db,
      "SELECT project_path, pack_id FROM project_pack_associations"
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pack_id, PACK_ID);

    assertNarrowedTo(
      recorded.callsFor("projectPackAssociation", "upsert")[0],
      { projectPath: true, packId: true },
      "upsertProjectAssociation"
    );
  } finally {
    await close();
  }
});

// ─────────────── upsertCatalogSeed (catalog-store 413) ───────────────

const SEED_PACK = {
  pack_id: PACK_ID,
  display_name: "Demo",
  github_url: "https://github.com/acme/demo",
  category: "tools",
  harnesses: [HARNESS],
  contents: { type: "skills" },
};

test("PARITY: upsertCatalogSeed inserts the catalog row and reports it inserted", async () => {
  const { db, recorded, close } = await open();
  try {
    const stats = await upsertCatalogSeed(recorded.prisma, {
      seed_version: 1,
      packs: [SEED_PACK],
    });
    assert.equal(stats.inserted, 1);
    assert.equal(stats.updated, 0);

    const rows = await rowsOf<{ pack_id: string; display_name: string }>(
      db,
      "SELECT pack_id, display_name FROM pack_catalog"
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].display_name, "Demo");
  } finally {
    await close();
  }
});

/**
 * The stats counters are derived from a READ that precedes the write, so they
 * are exactly the shape batch 4 refused to convert: they would report work the
 * write never did. Narrowing the RETURNING must leave them untouched.
 */
test("PARITY: a re-applied seed still reports updated, not inserted", async () => {
  const { recorded, close } = await open();
  try {
    await upsertCatalogSeed(recorded.prisma, {
      seed_version: 1,
      packs: [SEED_PACK],
    });
    const again = await upsertCatalogSeed(recorded.prisma, {
      seed_version: 2,
      packs: [{ ...SEED_PACK, display_name: "Demo v2" }],
    });

    assert.equal(again.inserted, 0);
    assert.equal(again.updated, 1);
  } finally {
    await close();
  }
});

test("NARROWING: upsertCatalogSeed RETURNINGs only the catalog pack id", async () => {
  const { recorded, close } = await open();
  try {
    await upsertCatalogSeed(recorded.prisma, {
      seed_version: 1,
      packs: [SEED_PACK],
    });

    assertNarrowedTo(
      recorded.only("packCatalog", "upsert"),
      { packId: true },
      "upsertCatalogSeed"
    );
  } finally {
    await close();
  }
});

// ─────────────── applyFetchResult history (catalog-store 581) ───────────────

test("PARITY: applyFetchResult writes live stats and appends a history sample", async () => {
  const { db, recorded, close } = await open();
  try {
    await upsertCatalogSeed(recorded.prisma, {
      seed_version: 1,
      packs: [SEED_PACK],
    });
    await applyFetchResult(recorded.prisma, {
      pack_id: PACK_ID,
      stars: 42,
      forks: 7,
      description: "live description",
    });

    const catalog = await rowsOf<{ stars: number | null }>(
      db,
      "SELECT stars FROM pack_catalog"
    );
    assert.equal(Number(catalog[0].stars), 42);

    const history = await rowsOf<{ pack_id: string; stars: number | null }>(
      db,
      "SELECT pack_id, stars FROM pack_catalog_history"
    );
    assert.equal(history.length, 1);
    assert.equal(Number(history[0].stars), 42);
  } finally {
    await close();
  }
});

test("NARROWING: the history sample RETURNINGs only its compound primary key", async () => {
  const { recorded, close } = await open();
  try {
    await upsertCatalogSeed(recorded.prisma, {
      seed_version: 1,
      packs: [SEED_PACK],
    });
    recorded.reset();
    await applyFetchResult(recorded.prisma, {
      pack_id: PACK_ID,
      stars: 42,
      forks: 7,
    });

    assertNarrowedTo(
      recorded.only("packCatalogHistory", "upsert"),
      { packId: true, fetchedAt: true },
      "applyFetchResult history"
    );
  } finally {
    await close();
  }
});
