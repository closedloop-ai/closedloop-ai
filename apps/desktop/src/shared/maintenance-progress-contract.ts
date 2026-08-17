/**
 * @file maintenance-progress-contract.ts
 * @description ISS-6241: the ONE declaration of the post-boot maintenance
 * payload that crosses from the main process to the renderer, and of the phase
 * vocabulary inside it.
 *
 * WHY IT IS SHARED. The producer (`maintenance-progress-state.ts`) and the
 * renderer's boundary validator (`parse-maintenance-progress.ts`) used to
 * declare the shape independently, so a field added on the producer side still
 * compiled while the validator silently stripped it — the exact drift the
 * validator's keys-covered guard claims to prevent. Both sides now derive from
 * the type below, so adding a field here fails `tsc` at the validator until the
 * validator learns it, and adding one at the producer alone is impossible.
 *
 * Keep this module dependency-free. It is imported by main, by the renderer, and
 * (transitively) by the preload boundary; a runtime import pulled in here would
 * follow it into all three.
 */

/**
 * Which post-boot maintenance pass is holding the db-host: the data-revision
 * rebuild, then the artifact-link backfill.
 *
 * The vocabulary lives here rather than with the chain that produces it because
 * the renderer validates against it — a phase added on one side and not the
 * other is the same drift class as a missing field.
 */
export const MaintenancePhase = {
  Rebuild: "rebuild",
  ArtifactLinks: "artifact-links",
} as const;

export type MaintenancePhase =
  (typeof MaintenancePhase)[keyof typeof MaintenancePhase];

/** Every phase, for the boundary validator's union and for exhaustive maps. */
export const MAINTENANCE_PHASES = Object.values(MaintenancePhase);

/** No maintenance pass is running. */
export type MaintenanceIdlePayload = {
  active: false;
  phase: null;
};

/**
 * A live pass that cannot substantiate a population, so it carries NO counts —
 * the type, not a runtime check, is what makes that pairing unrepresentable
 * (shafty023 review).
 *
 * `phase: null` while `active` is true is the version-skew degrade, not a
 * contradiction: a NEWER main process can name a phase this build has never
 * heard of, and the boundary validator degrades that unsupported DETAIL to
 * `null` while preserving liveness. `active` is the authoritative liveness bit;
 * a consumer must read it rather than inferring "finished" from a null phase.
 */
export type MaintenanceCountlessPayload = {
  active: true;
  phase: Exclude<MaintenancePhase, typeof MaintenancePhase.Rebuild> | null;
};

/**
 * The `rebuild` pass — the ONLY phase with a progress channel, and therefore the
 * only one that may carry counts. The artifact-link backfill runs entirely
 * inside the db-host behind a single awaited op with nothing to report, so
 * counts beside it could only ever be another phase's population mislabelled.
 */
export type MaintenanceRebuildPayload = {
  active: true;
  phase: typeof MaintenancePhase.Rebuild;
  /**
   * ISS-6241: sessions the phase has finished, out of the population it is
   * working. BOTH fields are present or BOTH are absent — never one, and never a
   * zero standing in for "unknown".
   *
   * Absent is the normal state, not a degraded one: even `rebuild` cannot
   * substantiate a population until its stale-session query has returned. A
   * consumer that receives neither field MUST render an indeterminate state
   * rather than synthesize `0 of 0` — ISS-5932 is the bug where a `0/0`
   * denominator became a displayed `100%`.
   *
   * These are OPTIONAL on the wire and must stay omitted when absent rather than
   * serialized as `null`: the payload crosses to a renderer that may be a
   * version-skewed build, and the receiving contract does not declare them
   * nullable.
   */
  processed?: number;
  total?: number;
};

/**
 * The maintenance payload the renderer's first-launch splash surfaces, so the
 * user has feedback during the window after the boot import settles but before
 * the dashboard is fully ready — the residual freeze window (FEA-2264).
 *
 * Discriminated on purpose: counts ride an active `rebuild` or they do not exist
 * at all, so `{ active: true, phase: "artifact-links", processed, total }` —
 * counts rendered beside a phase with no progress channel — cannot be
 * constructed on either side of the wire.
 */
export type MaintenanceProgressPayload =
  | MaintenanceIdlePayload
  | MaintenanceCountlessPayload
  | MaintenanceRebuildPayload;

/**
 * Every key ANY member of the union can carry.
 *
 * `keyof` over a union yields only the keys common to all members, which would
 * quietly drop `processed`/`total` from the boundary validator's keys-covered
 * guard — re-opening the very drift the guard exists to catch. Enumerating the
 * members keeps the guard biting on all of them.
 */
export type MaintenanceProgressWireKey =
  | keyof MaintenanceIdlePayload
  | keyof MaintenanceCountlessPayload
  | keyof MaintenanceRebuildPayload;

/**
 * Whether a `{ processed, total }` pair is a population that can honestly be
 * rendered as "N of M".
 *
 * Shared by the PRODUCER and the renderer's boundary validator so one rule
 * governs both: a count that fails here is rejected to the indeterminate state
 * on whichever side sees it first, never clamped into a believable value.
 * `Number.isSafeInteger` is the whole guard against fractional, non-finite
 * (`NaN`/`Infinity`), and precision-lost counts in one predicate.
 */
export function isCountablePopulation(
  processed: number,
  total: number
): boolean {
  return (
    Number.isSafeInteger(processed) &&
    Number.isSafeInteger(total) &&
    processed >= 0 &&
    total > 0 &&
    processed <= total
  );
}
