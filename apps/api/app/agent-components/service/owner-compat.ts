/**
 * FEA-4098 (codex P1): the additive, skew-safe `owner` compatibility alias for a
 * resolved authors set — the DISCOVERER (first/leading author), or an empty
 * spread when there are no authors. Emitted as a partial so `owner` is OMITTED
 * (never `null`) when absent, keeping old clients that still read it from ever
 * seeing an `undefined`/`null` they might crash on (`initialsOf`). New code reads
 * `collaborators`; this exists only for version-skewed older readers.
 *
 * Shared by the list read (`service.ts`) and the detail read (`detail-read.ts`)
 * so both surfaces emit the identical `owner` compat shape.
 */
export function ownerCompat(collaborators: readonly string[]): {
  owner?: string;
} {
  return collaborators.length > 0 ? { owner: collaborators[0] } : {};
}
