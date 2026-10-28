/**
 * Type declarations for `stress-node-tests-lib.mjs` (ISS-5303 — tooling
 * coverage reach). The lib is plain ESM JavaScript, so this sidecar is what lets
 * the typechecked `test/` project consume it without `allowJs`. Keep the
 * signatures in step with the `@ts-check` JSDoc on the implementation.
 */

/**
 * Positive-integer environment override, or `fallback` when the variable is
 * unset or does not parse to a positive integer.
 */
export declare function positiveIntEnv(
  name: string,
  fallback: number,
  env?: NodeJS.ProcessEnv
): number;

/** Which runner a stress iteration spawns. */
export declare const StressLane: {
  NodeTest: "node:test";
  Vitest: "vitest";
};

export type StressLane = (typeof StressLane)[keyof typeof StressLane];

/**
 * The lane one stress iteration should run on, taken from the census
 * (ISS-4934) rather than always `tsx --test`.
 */
export declare function stressLane(
  testFile: string,
  census: { vitest: string[] }
): StressLane;

/** The suites a stress run hunts in when `STRESS_FILE` is unset (ISS-6258). */
export declare const DEFAULT_STRESS_FILES: string[];

/**
 * `STRESS_FILE` as a comma-separated list; unset or blank means
 * {@link DEFAULT_STRESS_FILES}.
 */
export declare function stressFiles(value: string | undefined): string[];
