/**
 * The canonical "data sync level" — the ONE value answering "how much of my data
 * goes to the cloud?" — and the one order every surface renders it in.
 *
 * ISS-6147: this used to be three copies of the same list. The desktop declared
 * `DataSyncLevel` + `DATA_SYNC_LEVELS` in `apps/desktop/src/shared/`, `@repo/app`
 * declared `DataSyncLevelValue` + a ranking beside the copy map because it must
 * not import from `apps/desktop`, and a parity test asserted the two agreed —
 * which is a test that exists only because the duplication does. Both sides
 * import this leaf instead: the desktop main process already consumes
 * `@repo/api/src/types/*`, and so does `@repo/app`.
 *
 * The list is declared in RENDER order (most permissive first), so no consumer
 * sorts or reverses it — a surface showing a subset filters it and is done.
 * Exposure comparisons read the same array: a LOWER index means MORE data
 * leaves the device.
 */
export const DataSyncLevel = {
  Off: "off",
  Metadata: "metadata",
  Redacted: "redacted",
  Full: "full",
} as const;
export type DataSyncLevel = (typeof DataSyncLevel)[keyof typeof DataSyncLevel];

/**
 * Every level, most-permissive first — both the render order and the exposure
 * ranking, because they are the same sequence read from opposite ends.
 */
export const DATA_SYNC_LEVELS: readonly DataSyncLevel[] = [
  DataSyncLevel.Full,
  DataSyncLevel.Redacted,
  DataSyncLevel.Metadata,
  DataSyncLevel.Off,
];

/**
 * The level the product recommends, and the one every surface starts on: full
 * transcripts.
 *
 * ISS-6147 review: this was two constants — a `DEFAULT` (metadata) and an
 * `ELEVATED` (full) — plus two more in the consent module, which is four names
 * for what is now one answer. The chip says "Recommended", the pickers
 * pre-select it, and the desktop settings store falls back to it.
 *
 * Neither the pre-selection nor the desktop's persisted default is an egress
 * decision (ISS-10554). The desktop's first launch seeds this level AND the
 * connectivity booleans it derives, so a fresh profile reports it rather than
 * reconciling down — but it also records an explicit not-consented
 * `syncObservabilityTier`, and that tier, not the level, is what the egress gate
 * reads. A device stays on full and uploads nothing until the user answers.
 */
// Deliberately un-annotated so the literal type survives: the consent surfaces
// accept a NARROWER union than `DataSyncLevel` (no `redacted`), and a widening
// annotation here would make the recommended level unassignable to them.
export const RECOMMENDED_DATA_SYNC_LEVEL = DataSyncLevel.Full;

/**
 * True when `next` sends MORE data to the cloud than `previous`.
 *
 * Reads {@link DATA_SYNC_LEVELS} rather than a second ranking array: the list is
 * ordered most-permissive first, so a lower index is more exposure.
 */
export function isMoreExposedDataSyncLevel(
  next: DataSyncLevel,
  previous: DataSyncLevel
): boolean {
  return DATA_SYNC_LEVELS.indexOf(next) < DATA_SYNC_LEVELS.indexOf(previous);
}

/**
 * ISS-7516 — whether a machine on `level` uploads session TRANSCRIPTS at all.
 *
 * This is a READ of an egress decision made elsewhere, not a second copy of it.
 * The authority is the desktop's `syncTierAllowsTranscripts`
 * (`apps/desktop/src/shared/contracts.ts`), which admits only the `full`
 * observability tier; this states the same predicate over the `DataSyncLevel`
 * vocabulary because `apps/app` cannot import `apps/desktop`. The two are pinned
 * to each other by a parity test over every level
 * (`apps/desktop/test/data-sync-level-transcript-parity.test.ts`) that composes
 * `syncObservabilityTierToDataSyncLevel`, so a change to either side fails there
 * rather than drifting — the ISS-6147 posture, applied where a shared module is
 * impossible rather than merely unwritten.
 *
 * `Redacted` is a DENY: it maps to the `metadata` observability tier, which
 * excludes transcripts exactly as `Metadata` does. Only `Full` allows them, so a
 * reader must never infer "some transcripts" from a non-`Full` level.
 *
 * Deliberately takes a NON-nullable level: absence is not a level, and folding
 * `undefined` in here would let a caller who has no evidence receive a verdict.
 * Callers that may hold no level must branch on that BEFORE asking.
 */
export function dataSyncLevelAllowsTranscripts(level: DataSyncLevel): boolean {
  return level === DataSyncLevel.Full;
}

/**
 * ISS-7516 — narrow an untrusted value to a {@link DataSyncLevel}, or `undefined`.
 *
 * For READ boundaries where the stored type is wider than the contract: the
 * `session_detail.data_sync_level` column is a nullable TEXT, so a row can carry
 * NULL (nothing reported), a valid level, or — only via corruption or a manual
 * write — something else. Every write path runs through the ingest Zod enum, so
 * an unrecognized value is not a skew case to tolerate; it is a bad row.
 *
 * Returns `undefined` for BOTH "absent" and "unrecognized" deliberately. The
 * consumer contract for this field is that absence means "no level reported" and
 * must not produce a verdict, which is exactly the right handling for a value we
 * cannot trust either — the alternative, passing a bad string through as if it
 * were a level, would let corruption pick the copy a user reads. Callers that
 * need to ALERT on corruption must compare against `null` themselves before
 * calling; this helper deliberately does not log, because it is imported by
 * bundle-sensitive client surfaces.
 *
 * Non-throwing on purpose, unlike the desktop's `normalizeDataSyncLevel`, whose
 * job is to reject a hostile renderer at a WRITE boundary.
 */
export function toDataSyncLevel(value: unknown): DataSyncLevel | undefined {
  return DATA_SYNC_LEVELS.find((level) => level === value);
}
