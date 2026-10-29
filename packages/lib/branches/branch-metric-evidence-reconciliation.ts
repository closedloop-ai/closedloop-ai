/**
 * Deduplicating repeated evidence rows by their own identity, and saying so when
 * two rows claiming one identity disagree.
 *
 * Extracted from `branch-list-metrics.ts` (ISS-10363), where it sat between the
 * metric derivations it serves. A conflict is surfaced rather than resolved:
 * this cannot know which of two disagreeing rows is right, so it drops both and
 * reports it, and the caller degrades the metric instead of picking a winner.
 */
export type ReconciledEvidence<Value> = {
  values: Value[];
  conflicted: boolean;
};

export function reconcileByIdentity<Value>(
  values: readonly Value[],
  keyFor: (value: Value) => string
): ReconciledEvidence<Value> {
  const deduped = new Map<string, Value>();
  const conflictedKeys = new Set<string>();
  let conflicted = false;
  for (const value of values) {
    const key = keyFor(value);
    if (!key) {
      conflicted = true;
      continue;
    }
    if (conflictedKeys.has(key)) {
      continue;
    }
    const existing = deduped.get(key);
    if (existing === undefined) {
      deduped.set(key, value);
      continue;
    }
    if (stableValue(existing) !== stableValue(value)) {
      conflicted = true;
      conflictedKeys.add(key);
      deduped.delete(key);
    }
  }
  return { values: [...deduped.values()], conflicted };
}

function stableValue(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

/**
 * One reconciliation per evidence array, however many windows fold over it
 * (ISS-10363, tamsinb review on #7448).
 *
 * Every reconciliation this module serves is a pure function of ONE array and
 * nothing else — the window filter runs on its output, never on its input, and
 * deliberately so: filtering first would hide a disagreement about a row that
 * fell outside the window from the only pass that detects it. So a per-window
 * fold re-derives an identical result each time, and the series added by
 * ISS-10363 turned two of those folds into fourteen. Keyed on the array's own
 * identity, one request's evidence is reconciled once and every bucket after
 * the first pays only its own filter.
 *
 * A `WeakMap` and not a cache: an entry is reachable exactly as long as the
 * caller's array is, so this cannot grow with request volume and there is no
 * sweep to get wrong.
 */
export function memoizePerEvidenceArray<Input extends object, Result>(
  derive: (input: Input) => Result
): (input: Input) => Result {
  const memo = new WeakMap<Input, Result>();
  return (input: Input) => {
    const cached = memo.get(input);
    if (cached !== undefined) {
      return cached;
    }
    const result = derive(input);
    memo.set(input, result);
    return result;
  };
}
