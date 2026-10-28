/**
 * Direct SQLite seeding of `pack_catalog` rows for the Desktop pack-install E2E.
 *
 * The install/uninstall IPC resolves its command text from the catalog row at
 * call time (`getCatalog` in `catalog-store.ts`), so a spec that wants to drive
 * a specific harness/command shape through the REAL IPC boundary has to put that
 * row in the store rather than mock anything. The compiled-in `catalog-seed.json`
 * rows are real product data whose commands would install software on the runner;
 * a purpose-built row keeps the run inert.
 *
 * Uses the shared substrate in `desktop-seed-core` (WAL second connection, the
 * app's own PRAGMAs, and a wait for the asynchronously-applied schema), the same
 * way `seed-branches-db.ts` does. Seeds while the app is RUNNING: `pack_catalog`
 * is read per call, not cached at boot, so no relaunch is needed.
 */

import {
  applyDesktopSeedPragmas,
  openSeedClient,
  SEED_SCHEMA_TIMEOUT_MS,
  waitForTablesPresent,
} from "./desktop-seed-core";

/** A catalog row, in the field names the E2E cares about. */
export type PackCatalogSeed = {
  packId: string;
  displayName: string;
  /** Harness ids the entry claims. */
  harnesses: string[];
  /** Harness id -> install command text. */
  installCommands: Record<string, string>;
  /** Harness id -> uninstall command text. */
  uninstallCommands: Record<string, string>;
  /** Remote-content scrape declaration (`contents`). */
  contents?: Record<string, unknown>;
  /** Mirrors the `single_install` column (gstack's superset semantics). */
  singleInstall?: boolean;
  /**
   * GitHub star count (`stars`). Left NULL when omitted, which is what an
   * un-fetched row looks like — `listCatalog` reads it as 0.
   */
  stars?: number;
  /**
   * Catalog pin position (`pin_order`). `listCatalog` orders pinned rows FIRST
   * and by this value, ahead of its `stars DESC` tie-break, so a spec that needs
   * a producer order independent of any sortable field sets it.
   */
  pinOrder?: number;
  /**
   * Bundled contents for the detail view's Contents tab (`contents_cache`).
   *
   * Only survives the detail view when the app is launched with
   * `SKIP_CATALOG_CONTENTS_FETCH=1`: `get-catalog-contents` refreshes before it
   * reads, and a seeded pack has no GitHub scrape spec, so an unguarded refresh
   * overwrites this with `[]`.
   */
  contentsCache?: PackCatalogSeedContentItem[];
};

/**
 * Upsert one `pack_catalog` row into a launched app's store.
 *
 * `seed_version` is left at the column default so a later real seed pass cannot
 * be skipped because of this row, and the id is expected to be test-only.
 */
export async function seedPackCatalogEntry(
  userDataDir: string,
  seed: PackCatalogSeed
): Promise<void> {
  const client = openSeedClient(userDataDir);
  try {
    await applyDesktopSeedPragmas(client);
    await waitForTablesPresent(
      client,
      ["pack_catalog"],
      SEED_SCHEMA_TIMEOUT_MS
    );
    await client.execute({
      sql: `INSERT INTO pack_catalog (
              pack_id, display_name, github_url, harnesses,
              install_commands, uninstall_commands, single_install, verified,
              stars, pin_order,
              contents, contents_cache, contents_fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
            ON CONFLICT(pack_id) DO UPDATE SET
              display_name      = excluded.display_name,
              harnesses         = excluded.harnesses,
              install_commands  = excluded.install_commands,
              uninstall_commands = excluded.uninstall_commands,
              single_install    = excluded.single_install,
              stars             = excluded.stars,
              pin_order         = excluded.pin_order,
              contents          = excluded.contents,
              contents_cache    = excluded.contents_cache,
              contents_fetched_at = excluded.contents_fetched_at`,
      args: [
        seed.packId,
        seed.displayName,
        `https://github.com/closedloop-ai/${seed.packId}`,
        JSON.stringify(seed.harnesses),
        JSON.stringify(seed.installCommands),
        JSON.stringify(seed.uninstallCommands),
        seed.singleInstall ? 1 : 0,
        seed.stars ?? null,
        seed.pinOrder ?? null,
        seed.contents ? JSON.stringify(seed.contents) : null,
        // A Prisma `Json?` column on SQLite is TEXT holding the serialized
        // value, so the raw seed writes the same string Prisma would. Absent
        // contents stay NULL rather than `[]` — the honest "never fetched".
        seed.contentsCache ? JSON.stringify(seed.contentsCache) : null,
        seed.contentsCache ? new Date().toISOString() : null,
      ],
    });
  } finally {
    client.close();
  }
}

/**
 * One bundled-contents entry. Description is intentionally untrusted so specs
 * can seed malformed persisted cache rows through the real IPC boundary.
 */
export type PackCatalogSeedContentItem = {
  name: string;
  type: "skill" | "command" | "agent" | "plugin";
  description?: unknown;
};
