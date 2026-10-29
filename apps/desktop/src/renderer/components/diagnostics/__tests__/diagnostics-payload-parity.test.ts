/**
 * ISS-10004 — the desktop IPC contract and the shared render contract describe
 * the SAME payload, checked by `tsc`.
 *
 * Two declarations exist on purpose: `apps/desktop/src/shared/diagnostics-contract.ts`
 * compiles into the main process, and `packages/app` is renderer-only. What must
 * not exist is DRIFT — the adapter hands `DiagnosticsData` straight to a surface
 * prop typed `DiagnosticsPayload`.
 *
 * MUTUAL ASSIGNABILITY IS NOT ENOUGH, and that is why it is not what this uses.
 * A type missing an OPTIONAL property is still assignable to one that declares
 * it, so `A extends B` and `B extends A` both hold while one side has gained or
 * lost an optional field. Every field this payload has ever gained is optional
 * by policy (`opencodeWithheld?`, `opencodeWithheldScans?`, `activityCoverage?`
 * — absence is a distinct claim from empty), so that is the ONLY direction drift
 * has ever come from. The invariant-position `Equals` idiom below is exact: it
 * compares the types themselves, optionality included.
 */
import type { DiagnosticsPayload } from "@repo/app/diagnostics/lib/diagnostics-payload";
import { describe, expect, it } from "vitest";
import type { DiagnosticsData } from "../../../../shared/diagnostics-contract";

/**
 * True only when the two types are identical. Conditional types in INVARIANT
 * position (behind `<T>() =>`) compare structurally rather than by assignability,
 * which is what makes an optional-only difference visible.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const PAYLOAD_CONTRACTS_MATCH: Equals<DiagnosticsData, DiagnosticsPayload> =
  true;

/** The key sets, named separately so a failure says WHICH field drifted. */
type ProducerOnlyKeys = Exclude<
  keyof DiagnosticsData,
  keyof DiagnosticsPayload
>;
type SurfaceOnlyKeys = Exclude<keyof DiagnosticsPayload, keyof DiagnosticsData>;

const NO_PRODUCER_ONLY_FIELD: Equals<ProducerOnlyKeys, never> = true;
const NO_SURFACE_ONLY_FIELD: Equals<SurfaceOnlyKeys, never> = true;

describe("desktop diagnostics payload parity", () => {
  it("holds the IPC contract and the render contract to one shape", () => {
    expect([
      PAYLOAD_CONTRACTS_MATCH,
      NO_PRODUCER_ONLY_FIELD,
      NO_SURFACE_ONLY_FIELD,
    ]).toEqual([true, true, true]);
  });
});
