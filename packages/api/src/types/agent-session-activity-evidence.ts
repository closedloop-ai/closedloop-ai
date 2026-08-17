/**
 * FEA-3568: coerce a persisted/queried `evidenceLayers` JSON value to the wire
 * `string[]` shape, dropping any non-string entry defensively so a corrupt row
 * can never inject a non-string onto the wire. Shared by BOTH sides of the
 * contract — the cloud detail read (Prisma `Json`) and the desktop sync assembly
 * (parsed SQLite JSON) — so the read and write mappers can't silently drift.
 *
 * ISS-6005: hoisted out of `agent-session.ts`. That file is on the
 * `noExcessiveLinesPerFile` grandfather list, which is SHRINK-ONLY, and this
 * change added `recordUpdatedAt` to it — so a cohesive unit comes out in the
 * same commit (AGENTS.md → "File Size and Organization"). This was the module's
 * only runtime function among ~2000 lines of type declarations, which makes it
 * the natural seam: a parse-boundary coercion has different concerns from a
 * wire-shape declaration, and its own test file already sat beside it. The file
 * remains grandfathered — this pays down a slice of that debt, it does not
 * clear it.
 */
export function normalizeActivitySegmentEvidenceLayers(
  value: unknown
): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
