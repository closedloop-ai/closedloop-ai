/**
 * @file stream-run-db-fixture.ts
 * @description Shared `streamRun` database double for the pack install/uninstall
 * suites. Extracted from `install-orchestrator-auto-harness.test.ts` (ISS-6882)
 * so the pack-IPC rescan suite drives the SAME double the orchestrator suite
 * does, instead of carrying a second copy of the ~25-column catalog row shape.
 */

import type { streamRun } from "../../src/main/packs/install-orchestrator.js";
import type { makeCatalogEntry } from "./catalog-entry-fixture.js";

/** The run id `recordPackInstallRunStart` hands back. */
export const FAKE_RUN_ID = 7;

/** The newest open `pack_install_runs` row, as `inFlightInstallRun` reads it. */
export type FakeOpenRun = {
  command: string | null;
  harness: string | null;
  id: number;
  startedAt: string;
};

export type FakeStreamRunDb = Parameters<typeof streamRun>[0] & {
  /** What the concurrency guard's lookup returns; `null` means no open run. */
  openRun: FakeOpenRun | null;
  startedCommands: string[];
};

/**
 * Minimal `streamRun` database double. `getCatalog` reads the catalog through
 * `$queryRawUnsafe` and maps a snake_case row, so the double returns that row
 * shape rather than a `CatalogEntry`.
 */
export function makeStreamRunFakeDb(
  entry: ReturnType<typeof makeCatalogEntry>
): FakeStreamRunDb {
  const startedCommands: string[] = [];
  const row = {
    category: entry.category,
    contents: null,
    contents_cache: null,
    description: entry.description,
    description_live: entry.descriptionLive,
    detection_patterns: null,
    display_name: entry.displayName,
    forks: null,
    github_url: entry.githubUrl,
    harness_agnostic: 0,
    harnesses: JSON.stringify(entry.harnesses),
    install_commands: JSON.stringify(entry.installCommands),
    install_notes: null,
    installed_harnesses: null,
    installed_skill_count: 0,
    last_release: null,
    marketplace_url: null,
    pack_id: entry.packId,
    pin_order: null,
    placeholder_reason: null,
    post_install: null,
    project_scoped: 0,
    seed_version: 1,
    single_install: entry.singleInstall ? 1 : 0,
    stars: null,
    uninstall_commands: JSON.stringify(entry.uninstallCommands),
    verified: 1,
  };

  const db = {
    openRun: null,
    prisma: {
      client: {
        $queryRawUnsafe: () => Promise.resolve([row]),
        packCatalogHistory: { findMany: () => Promise.resolve([]) },
        packInstallRun: { findFirst: () => Promise.resolve(db.openRun) },
      },
    },
    recordPackInstallRunEnd: () => Promise.resolve(),
    recordPackInstallRunStart: (input: { command: string }) => {
      startedCommands.push(input.command);
      return Promise.resolve(FAKE_RUN_ID);
    },
    startedCommands,
  } as unknown as FakeStreamRunDb;
  return db;
}
