import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import { GRID_PREFERENCE_VALUE_MAX_BYTES } from "@repo/api/src/types/grid-preferences";

/**
 * What the server holds for one grid-preference selector, reduced to the two
 * answers the adoption decision turns on. A read that never arrived is not
 * represented: a caller with no answer has nothing to decide and does nothing.
 */
export type GridPreferenceRemoteState =
  | { status: "found"; value: JsonObject; revision: number }
  | { status: "missing" };

export const GridPreferenceImportSkip = {
  /** Nothing on disk for this surface — a first visit has no layout to import. */
  NoLocalView: "no-local-view",
  /** Bytes that do not decode to a JSON object; importing them would fabricate. */
  MalformedLocalView: "malformed-local-view",
  /**
   * Past {@link GRID_PREFERENCE_VALUE_MAX_BYTES}. Daveth's 2026-09-11 decision
   * forbids truncating during import, and the server would refuse the payload
   * anyway, so the record stays local and whole rather than half-imported.
   * Measured on the bytes the REQUEST would carry, not the ones on disk — see
   * {@link isWithinGridPreferenceValueCap}.
   */
  OversizeLocalView: "oversize-local-view",
} as const;

export type GridPreferenceImportSkip =
  (typeof GridPreferenceImportSkip)[keyof typeof GridPreferenceImportSkip];

/**
 * One of: take the server's layout, seed the server from the local one, or do
 * nothing and say why.
 */
export type GridPreferenceAdoptionPlan =
  | { kind: "adopt"; serialized: string }
  | { kind: "import"; value: JsonObject }
  | { kind: "skip"; reason: GridPreferenceImportSkip };

/**
 * Decide what a surface does the first time it reaches the server-backed grid
 * preference store (ISS-9450, Daveth 2026-09-11).
 *
 * **Idempotent by construction.** `import` is reachable from exactly one remote
 * state — `missing` — so the first run seeds the row and every later run reads
 * `found` and adopts instead. Running the adoption twice therefore leaves the
 * same server value, and the second run issues no write at all.
 *
 * **Nothing local is discarded or truncated.** The whole decoded object is
 * handed over, unknown axes and future-build fields included: no schema runs
 * over it here, because this module does not know which keys a newer build
 * writes and a filter it cannot justify is the silent truncation the decision
 * forbids. A record past the shared byte cap is skipped WHOLE rather than
 * trimmed to fit, and the local copy is never deleted by this plan — the caller
 * keeps it until the server confirms.
 */
export function planGridPreferenceAdoption(input: {
  remote: GridPreferenceRemoteState;
  localRaw: string | null;
}): GridPreferenceAdoptionPlan {
  if (input.remote.status === "found") {
    return { kind: "adopt", serialized: JSON.stringify(input.remote.value) };
  }
  if (input.localRaw === null || input.localRaw === "") {
    return { kind: "skip", reason: GridPreferenceImportSkip.NoLocalView };
  }
  const value = parseJsonObject(input.localRaw);
  if (value === null) {
    return {
      kind: "skip",
      reason: GridPreferenceImportSkip.MalformedLocalView,
    };
  }
  // Measured on the PARSED value re-serialized, which is what the request body
  // carries — not on the bytes as they sit on disk. A pretty-printed or
  // escape-heavy record can be well past the cap in `localStorage` and well
  // inside it on the wire, and skipping that one strands a layout the server
  // would have accepted (davetho review, PR #7081).
  if (!isWithinGridPreferenceValueCap(JSON.stringify(value))) {
    return { kind: "skip", reason: GridPreferenceImportSkip.OversizeLocalView };
  }
  return { kind: "import", value };
}

/**
 * Decode serialized view bytes into the opaque `value` the grid-preference API
 * stores, or `null` when they are not a plain JSON object.
 *
 * A trust boundary in both directions: the bytes come from `localStorage`, which
 * any page on the origin can write, and they are about to cross to a server that
 * rejects a non-object root. An array, a scalar and `null` all decode as valid
 * JSON, so `typeof === "object"` alone is not the check.
 */
export function parseJsonObject(raw: string): JsonObject | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as JsonObject;
}

/**
 * Whether serialized view bytes fit inside the server's shared payload cap.
 * Measured in UTF-8 bytes, which is what `GRID_PREFERENCE_VALUE_MAX_BYTES`
 * counts — a view of ASCII column ids is the same number either way, but a
 * feature `extras` blob carrying a non-Latin label is not.
 *
 * Callers must hand it the REQUEST representation — `JSON.stringify(value)` for
 * the value about to be posted — never the bytes as they were read from
 * `localStorage`. The two differ by whitespace and escape style, and the server
 * caps only the former, so measuring the latter refuses records it would take.
 */
export function isWithinGridPreferenceValueCap(serialized: string): boolean {
  return (
    new TextEncoder().encode(serialized).length <=
    GRID_PREFERENCE_VALUE_MAX_BYTES
  );
}

/**
 * The same JSON object, serialized with its keys in a fixed order at every
 * depth.
 *
 * Used to compare what a surface just wrote locally against what the server
 * echoed back. The two are the same layout but not the same bytes: the record
 * crosses a `jsonb` column, which does not preserve key order, so a plain string
 * comparison reports a difference on every page load and provokes a write that
 * changes nothing. `null` when the input is not a JSON object, matching
 * {@link parseJsonObject}.
 */
export function canonicalJsonString(raw: string): string | null {
  const value = parseJsonObject(raw);
  return value === null ? null : JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  // `Object.create(null)`, not `{}`: these keys come from `localStorage`, which
  // any page on the origin can write, and `JSON.parse` makes `__proto__` an OWN
  // property. Assigning it into a plain object invokes the prototype setter
  // instead, so the field vanishes from the canonical form — two distinct
  // layouts collapse to the same string and a future axis stored under such a
  // key is silently dropped from the comparison (davetho review, PR #7081).
  const sorted: JsonObject = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeysDeep(value[key]);
  }
  return sorted;
}
