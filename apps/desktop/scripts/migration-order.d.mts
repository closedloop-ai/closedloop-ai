export declare const legacyMigrationSortKeys: ReadonlyMap<string, string>;

export declare function compareMigrationDirNames(
  left: string,
  right: string
): number;

export declare function migrationSortKey(name: string): string;

export declare const lastContiguousMigrationDirName: string;

export declare function describeNewMigrationDirNameRule(): string;

export declare function findMigrationDirNameViolations(
  dirNames: readonly string[]
): string[];
