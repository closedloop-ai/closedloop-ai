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
  /** Mirrors the `single_install` column (gstack's superset semantics). */
  singleInstall?: boolean;
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
              install_commands, uninstall_commands, single_install, verified
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(pack_id) DO UPDATE SET
              display_name      = excluded.display_name,
              harnesses         = excluded.harnesses,
              install_commands  = excluded.install_commands,
              uninstall_commands = excluded.uninstall_commands,
              single_install    = excluded.single_install`,
      args: [
        seed.packId,
        seed.displayName,
        `https://github.com/closedloop-ai/${seed.packId}`,
        JSON.stringify(seed.harnesses),
        JSON.stringify(seed.installCommands),
        JSON.stringify(seed.uninstallCommands),
        seed.singleInstall ? 1 : 0,
      ],
    });
  } finally {
    client.close();
  }
}
