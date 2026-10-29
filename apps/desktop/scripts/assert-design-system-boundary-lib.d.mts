/**
 * Type declarations for `assert-design-system-boundary-lib.mjs` (ISS-7240 — the
 * design-system boundary gate's decision half). The lib is plain ESM
 * JavaScript, so this sidecar is what lets the typechecked `test/` project
 * consume it without `allowJs`. Keep the signatures in step with the
 * `@ts-check` JSDoc on the implementation.
 */

/** Lowest module count a healthy cruise of `src` may report. */
export const MODULE_FLOOR: number;

/** The transpiler dependency-cruiser must have to see `.ts` at all. */
export const REQUIRED_TRANSPILER: string;

export type TranspilerAvailability = {
  name: string;
  /** The range dependency-cruiser accepts. */
  version: string;
  available: boolean;
  /**
   * What actually resolved. Present at runtime but absent from
   * dependency-cruiser's published `IAvailableTranspiler`, so it is optional
   * here — which is also what makes `getAvailableTranspilers()` output
   * assignable to this type.
   */
  currentVersion?: string;
};

export type BoundaryVerdict = {
  ok: boolean;
  /** Operator-facing refusal, absent when ok. */
  reason?: string;
};

export type BoundaryViolation = {
  /** `severity` is optional because the report is parsed JSON, not our type. */
  rule: { name: string; severity?: string };
  from: string;
  to: string;
  via?: readonly { name: string }[];
};

/** Decide whether dependency-cruiser can see TypeScript. */
export function checkTypeScriptVisible(
  transpilers: readonly TranspilerAvailability[]
): BoundaryVerdict;

/** Render violations as severity, rule, endpoints, then the hops in between. */
export function formatViolations(
  violations: readonly BoundaryViolation[]
): string;

/** Split violations into blocking (`error`) and non-blocking counts. */
export function tallyViolations(violations: readonly BoundaryViolation[]): {
  blocking: number;
  nonBlocking: number;
};

/** Decide whether a cruise actually inspected the module graph. */
export function checkModuleFloor(
  totalCruised: number,
  floor?: number
): BoundaryVerdict;
