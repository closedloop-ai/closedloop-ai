/** One artifact `build:prereqs` produces, and the script that produces it. */
export type GeneratedPrerequisite = {
  /** Repo-relative, POSIX-separated, as it appears in imports. */
  file: string;
  /** The npm script and generator that produce {@link file}. */
  producedBy: string;
};

export declare const GENERATED_PREREQUISITES: readonly GeneratedPrerequisite[];

/**
 * The `build:deps` build-output directories, derived from each workspace
 * dependency's own `exports`/`main` map rather than hardcoded.
 */
export declare function dependencyBuildPrerequisites(
  repoRoot: string
): readonly GeneratedPrerequisite[];

/** Both halves of `build:prereqs`, in the order the refusal should read. */
export declare function allPrerequisites(
  repoRoot: string
): readonly GeneratedPrerequisite[];

export declare function missingPrerequisites(
  desktopDir: string
): readonly GeneratedPrerequisite[];

export declare function prerequisiteProblem(
  desktopDir: string
): string | undefined;
