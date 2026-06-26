/**
 * @file pack-catalog-seed.test.ts
 * @description FEA-1791 / PLN-886 Phase 3 — upsertCatalogSeed converted to the
 * typed Prisma client (catalog-store.ts). Proves the conversion is faithful to
 * the prior raw SQL:
 *  - JSON columns round-trip (Prisma write → raw read);
 *  - absent JSON fields persist as SQL NULL (Prisma.DbNull, not JSON null);
 *  - seed_version gating skips rows whose stored version is already >= incoming;
 *  - a seed re-apply updates seed-owned fields but PRESERVES fetcher-owned live
 *    fields (stars/forks/description_live) — the update block lists only
 *    seed-owned columns;
 *  - the REAL bundled catalog-seed.json populates the visible catalog through
 *    the Prisma path (guards the boot-seed regression where first-run users
 *    would otherwise see an empty Packs page — seed failures are caught+logged
 *    at the runtime call site, so this is the enforced check that seeding
 *    actually fills the catalog).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import catalogSeed from "../src/main/packs/catalog-seed.json" with {
  type: "json",
};
import {
  listCatalog,
  upsertCatalogSeed,
} from "../src/main/packs/catalog-store.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const SEED_PACK = {
  pack_id: "demo",
  display_name: "Demo",
  github_url: "https://github.com/acme/demo",
  category: "tools",
  harnesses: ["claude", "codex"],
  install_commands: { claude: "echo install" },
  contents: { type: "skills" },
  detection_patterns: ["demo"],
  post_install: { message: "done" },
  verified: true,
  pin_order: 1,
  project_scoped: true,
};

test("seeds a new pack and round-trips JSON columns through a raw read", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const stats = await upsertCatalogSeed(prisma, {
      seed_version: 2,
      packs: [SEED_PACK],
    });
    assert.deepEqual(stats, { inserted: 1, updated: 0, skipped: 0 });

    const entries = await listCatalog(prisma);
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.packId, "demo");
    assert.equal(entry.displayName, "Demo");
    assert.deepEqual(entry.harnesses, ["claude", "codex"]);
    assert.equal(entry.installCommands?.claude, "echo install");
    assert.equal(entry.contents?.type, "skills");
    assert.deepEqual(entry.detectionPatterns, ["demo"]);
    assert.equal(entry.verified, true);
    assert.equal(entry.pinOrder, 1);
    assert.equal(entry.projectScoped, true);
  } finally {
    await close();
  }
});

test("absent JSON fields persist as SQL NULL", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await upsertCatalogSeed(prisma, {
      seed_version: 1,
      packs: [
        {
          pack_id: "bare",
          display_name: "Bare",
          github_url: "https://example.test/bare",
        },
      ],
    });
    const result = await db.query<{
      harnesses: unknown;
      install_commands: unknown;
      post_install: unknown;
    }>(
      "SELECT harnesses, install_commands, post_install FROM pack_catalog WHERE pack_id = $1",
      ["bare"]
    );
    assert.equal(result.rows[0]?.harnesses, null);
    assert.equal(result.rows[0]?.install_commands, null);
    assert.equal(result.rows[0]?.post_install, null);
  } finally {
    await close();
  }
});

test("skips packs whose stored seed_version is already >= incoming", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await upsertCatalogSeed(prisma, { seed_version: 5, packs: [SEED_PACK] });
    const stats = await upsertCatalogSeed(prisma, {
      seed_version: 4,
      packs: [{ ...SEED_PACK, display_name: "Should Not Apply" }],
    });
    assert.deepEqual(stats, { inserted: 0, updated: 0, skipped: 1 });

    const result = await db.query<{
      display_name: string;
      seed_version: number;
    }>(
      "SELECT display_name, seed_version FROM pack_catalog WHERE pack_id = $1",
      ["demo"]
    );
    assert.equal(result.rows[0]?.display_name, "Demo");
    assert.equal(result.rows[0]?.seed_version, 5);
  } finally {
    await close();
  }
});

test("re-seed updates seed-owned fields but preserves fetcher-owned live fields", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await upsertCatalogSeed(prisma, { seed_version: 1, packs: [SEED_PACK] });

    // Simulate the fetcher writing live fields (owned by applyFetchResult).
    await db.query(
      `UPDATE pack_catalog
         SET stars = $1, forks = $2, description_live = $3, last_fetched_at = $4
       WHERE pack_id = $5`,
      [42, 7, "live description", "2026-06-17T00:00:00.000Z", "demo"]
    );

    const stats = await upsertCatalogSeed(prisma, {
      seed_version: 2,
      packs: [{ ...SEED_PACK, display_name: "Demo v2" }],
    });
    assert.deepEqual(stats, { inserted: 0, updated: 1, skipped: 0 });

    const result = await db.query<{
      display_name: string;
      seed_version: number;
      stars: number | null;
      forks: number | null;
      description_live: string | null;
    }>(
      `SELECT display_name, seed_version, stars, forks, description_live
       FROM pack_catalog WHERE pack_id = $1`,
      ["demo"]
    );
    const row = result.rows[0];
    // Seed-owned fields updated.
    assert.equal(row?.display_name, "Demo v2");
    assert.equal(row?.seed_version, 2);
    // Fetcher-owned live fields preserved.
    assert.equal(row?.stars, 42);
    assert.equal(row?.forks, 7);
    assert.equal(row?.description_live, "live description");
  } finally {
    await close();
  }
});

test("the real bundled catalog seed populates the visible catalog via Prisma", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const seedPackCount = catalogSeed.packs.length;
    assert.ok(
      seedPackCount > 0,
      "bundled catalog-seed.json should contain packs"
    );

    const stats = await upsertCatalogSeed(prisma, catalogSeed);
    // Fresh DB: every valid seed pack is inserted, none skipped.
    assert.equal(stats.skipped, 0);
    assert.equal(stats.updated, 0);
    assert.equal(stats.inserted, seedPackCount);

    // The Packs page reads through listCatalog — assert the seed is visible
    // there (the boot path's catch-and-log would otherwise hide an empty page).
    const entries = await listCatalog(prisma);
    assert.equal(entries.length, seedPackCount);
    // A known, stable seeded pack renders with its display name.
    const rtk = entries.find((entry) => entry.packId === "rtk");
    assert.equal(rtk?.displayName, "RTK (Rust Token Killer)");
  } finally {
    await close();
  }
});
