/**
 * Curated ClosedLoop catalog seed (T-14.7 / AC-015).
 *
 * Seeds three global CatalogItem rows for the ClosedLoop-curated plugin
 * defaults (RTK, GStack, Web Command Enablement Pack).  These items are:
 *  - source='curated'  — read-only to orgs; only ClosedLoop mutates them.
 *  - scope='global'    — visible to all organizations (organizationId IS NULL).
 *  - targetKind='plugin' — distributable plugin bundles.
 *  - Asset keys are null placeholders; ClosedLoop provides assets separately.
 *
 * Idempotency: each row is upserted on its deterministic UUID, derived from
 * the stable key "curated:<name>".  Re-running this seed never creates
 * duplicates and preserves any field updates already applied in production.
 *
 * Usage: called from the seed runner (`scripts/seed/index.ts`, inside
 * `runSeedModules`) so every seed path — direct CLI (`scripts/seed.ts`) and the
 * preview-schema subprocess (`scripts/preview-seed.ts`, which spawns the same
 * CLI) — lands these global curated rows. Accepts either a `PrismaClient` or a
 * transaction client so it can participate in the seed's single transaction.
 */
import type { PrismaClient } from "../../generated/client";
import type { TransactionClient } from "../../generated/internal/prismaNamespace";
import { deterministicUuid } from "../../scripts/seed/helpers";

// ---------------------------------------------------------------------------
// Curated catalog item definitions
// ---------------------------------------------------------------------------
const CURATED_CATALOG_ITEMS = [
  {
    name: "RTK",
    description: "Rust Token Killer — token-optimized CLI proxy",
    sortOrder: 1,
  },
  {
    name: "GStack",
    description: "GStack desktop plugin",
    sortOrder: 2,
  },
  {
    name: "Web Command Enablement Pack",
    description: "Web command enablement for Claude",
    sortOrder: 3,
  },
] as const;

// ---------------------------------------------------------------------------
// Seed function — exported for programmatic use and called below for CLI use
// ---------------------------------------------------------------------------

export async function seedCuratedCatalog(
  prisma: PrismaClient | TransactionClient
): Promise<void> {
  console.log("[catalog-seed] Seeding curated ClosedLoop catalog items...");

  for (const item of CURATED_CATALOG_ITEMS) {
    // Stable ID derived from name+source so re-runs are idempotent.
    const id = deterministicUuid(`curated:${item.name}`);

    await prisma.catalogItem.upsert({
      where: { id },
      create: {
        id,
        organizationId: null,
        targetKind: "plugin",
        source: "curated",
        scope: "global",
        name: item.name,
        description: item.description,
        sortOrder: item.sortOrder,
        enabled: true,
        archived: false,
        // Asset keys are null — ClosedLoop provides assets separately.
        zipAssetBucket: null,
        zipAssetKey: null,
        logoAssetBucket: null,
        logoAssetKey: null,
        filesAssetKey: null,
      },
      update: {
        // On re-run: refresh mutable fields; preserve the stable id/source/scope.
        description: item.description,
        sortOrder: item.sortOrder,
        enabled: true,
        archived: false,
      },
      select: { id: true },
    });

    console.log(
      `[catalog-seed]   upserted CatalogItem id=${id} name="${item.name}"`
    );
  }

  console.log("[catalog-seed] Curated catalog seed complete.");
}
