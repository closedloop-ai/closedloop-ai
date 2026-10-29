/**
 * ISS-7039: shared work counters for the lead-time waterfall's phase resolver,
 * held here for the same reason `branch-fixtures.ts` is — the derivation suite
 * (`lib/__tests__`) pins `visibleOutcomeSegments` in isolation and the panel
 * suite (`components/__tests__`) pins the same bound through the rendered
 * component, and the two bounds must not drift.
 *
 * Neither counter is complete on its own, and together they still are not:
 * a rescan spelled as a bare `for` loop over a DERIVED copy of the segments
 * shows up in neither, because the predicate counter sees no predicate and the
 * field counter sees no source read. Reviewing for that shape is not something
 * these tests do.
 */
import type { BranchPhaseAttributionSegment } from "@repo/api/src/types/branch-phase-attribution";

type ScanMethodName = "filter" | "find" | "findIndex" | "some";
type ScanMethod = (
  this: unknown[],
  predicate: (...args: unknown[]) => unknown,
  thisArg?: unknown
) => unknown;

const SCAN_METHOD_NAMES: readonly ScanMethodName[] = [
  "filter",
  "find",
  "findIndex",
  "some",
];

/** A mutable count of source-segment field reads. */
export type FieldReadTally = { reads: number };

/**
 * How many times `run` invoked a per-element array predicate. Wrapping the
 * scanning `Array.prototype` methods is what makes a nested rescan visible from
 * outside the module: the rescan happens on an array the caller never sees, so
 * neither the output nor the input can report it. Restored in `finally` so the
 * patch cannot leak into another test.
 *
 * This counts predicates dispatched through `filter`/`find`/`findIndex`/`some`
 * and NOTHING ELSE — see the caveat at the top of this file.
 */
export function countPredicateInvocations(run: () => void): number {
  let invocations = 0;
  const scans = Array.prototype as unknown as Record<
    ScanMethodName,
    ScanMethod
  >;
  const originals = SCAN_METHOD_NAMES.map(
    (name) => [name, scans[name]] as const
  );
  for (const [name, original] of originals) {
    scans[name] = function patched(predicate, thisArg) {
      return original.call(
        this,
        (...args: unknown[]) => {
          invocations += 1;
          return predicate(...args);
        },
        thisArg
      );
    };
  }
  try {
    run();
  } finally {
    for (const [name, original] of originals) {
      scans[name] = original;
    }
  }
  return invocations;
}

/**
 * The same segment, reporting every read of the three fields the resolver looks
 * at. This is the half `countPredicateInvocations` misses: a rescan that walks
 * the SOURCE segments again with a bare `for` loop dispatches no predicate, but
 * it cannot avoid re-reading these fields. Getters rather than a Proxy so the
 * value stays a plain segment for every other field the fixtures and the
 * component touch.
 */
export function countingSegment(
  segment: BranchPhaseAttributionSegment,
  tally: FieldReadTally
): BranchPhaseAttributionSegment {
  return {
    ...segment,
    get startMs() {
      tally.reads += 1;
      return segment.startMs;
    },
    get endMs() {
      tally.reads += 1;
      return segment.endMs;
    },
    get phase() {
      tally.reads += 1;
      return segment.phase;
    },
  };
}
