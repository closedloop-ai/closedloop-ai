export type Census = {
  /** Files the Vitest node config runs, `test/`-prefixed and sorted. */
  vitest: string[];
  /** Files the temporary node:test runner runs, same shape. */
  nodeTest: string[];
};

export declare const TEST_DIR: string;

export declare const EXCLUDED_TEST_FILES: Set<string>;

export declare const DEFAULT_IMPORT_SPECIFIER: string;

export declare const NAMESPACE_IMPORT_SPECIFIER: string;

export declare const SHIMMED_NODE_TEST_SPECIFIERS: Set<string>;

export declare const SHIMMED_NODE_TEST_PROPERTIES: Set<string>;

export declare const GLOB_METACHARACTERS: RegExp;

/** File name → why `tsx --test`'s runtime, not node:test's API, keeps it there. */
export declare const VITEST_INCOMPATIBLE_FILES: Map<string, string>;

export declare function importsVitest(
  source: string,
  fileName: string,
  helperSpecifiers?: Set<string>
): boolean;

export declare function vitestReachingHelperSpecifiers(
  testDir?: string
): Set<string>;

export declare function installsLoaderHook(
  source: string,
  fileName: string
): boolean;

export declare function isVitestEligible(
  source: string,
  fileName: string,
  helperSpecifiers?: Set<string>
): boolean;

export declare function censusTestFiles(testDir?: string): Census;
