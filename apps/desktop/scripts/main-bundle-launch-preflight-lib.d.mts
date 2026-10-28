/** One import a main-bundle chunk makes that would fail to load. */
export type UnresolvedBundleImport = {
  importer: string;
  specifier: string;
  reason: string;
};

export declare const IMPORT_META_RESOLVE_FLAG: string;

export declare function missingEntryMessage(entryPath: string): string;

export declare function findUnresolvedBundleImports(
  entryPath: string,
  resolveSpecifier: (specifier: string, parentUrl: string) => string
): UnresolvedBundleImport[];

export declare function unresolvedImportsMessage(
  entryPath: string,
  unresolved: readonly UnresolvedBundleImport[]
): string;

export declare function assertMainBundleLaunchable(entryPath: string): void;
