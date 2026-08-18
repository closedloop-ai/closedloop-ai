// Hand-maintained declarations for generate-migrations-manifest-lib.mjs
// (ISS-5303) so the desktop node:test suite consumes it typed — there is no
// `allowJs` anywhere in the desktop tsconfig chain.
export type MigrationManifestEntry = {
  name: string;
  checksum: string;
  sql: string;
};

/** Sink for the generator's progress and diagnostic lines. */
export type ManifestWriteLine = (line: string) => void;

export declare function legacyManifestPath(appDir: string): string;

export declare function healLegacyManifest(
  appDir: string,
  writeLine?: ManifestWriteLine
): void;

export declare function readMigrationDirNames(migrationsDir: string): string[];

export declare function buildMigrationEntries(
  migrationDirNames: readonly string[],
  paths: { appDir: string; migrationsDir: string }
): MigrationManifestEntry[];

export declare function renderManifest(
  entries: readonly MigrationManifestEntry[]
): string;

export declare function writeManifestIfChanged(options: {
  appDir: string;
  outFile: string;
  contents: string;
  migrationCount: number;
  writeLine?: ManifestWriteLine;
}): boolean;

export declare function generateMigrationsManifest(options: {
  appDir: string;
  migrationsDir: string;
  outFile: string;
  writeLine?: ManifestWriteLine;
}): {
  entries: MigrationManifestEntry[];
  contents: string;
  wrote: boolean;
};
