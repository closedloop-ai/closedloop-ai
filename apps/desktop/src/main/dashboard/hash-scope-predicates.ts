/**
 * @file hash-scope-predicates.ts
 * @description Pure SQL-fragment builders for content-hash-scoped desktop
 * agent-component usage reads. Extracted verbatim from
 * `shared-agent-components-api.ts` (ISS-4404) to shrink that grandfathered
 * reader — it stays above the 1k line ceiling (still on the Biome grandfather
 * list) pending further extraction, so this is one step down, not the last.
 * These are dependency-free string builders — no Prisma, no I/O —
 * so the module stays a safe leaf on the pglite boot path and is shared by the
 * agent-components detail reader and the Optimization-analytics IPC handlers.
 */

/**
 * FEA-3205: build a `component_key IN (?, ?, …)` fragment plus its bound params
 * for a concrete list of raw keys resolved in JS (see `matchingUsageRawKeys`).
 * The keys are compared trimmed (`trim(COALESCE(component_key, ''))`) so a raw
 * key stored with surrounding whitespace still matches its trimmed variant.
 * Returns a fragment that matches nothing when `rawKeys` is empty.
 *
 * `column` qualifies the key column for queries that alias the usage table
 * (e.g. `acsu.component_key`); it is a caller-supplied literal, never user
 * input. Exported alongside `matchingUsageRawKeys` for the
 * Optimization-analytics IPC handlers (FEA-3264).
 */
export function rawKeyInClause(
  rawKeys: string[],
  column = "component_key"
): {
  clause: string;
  params: string[];
} {
  if (rawKeys.length === 0) {
    // An empty IN-list is invalid SQL; a false predicate matches no rows.
    return { clause: "1 = 0", params: [] };
  }
  const placeholders = rawKeys.map(() => "?").join(", ");
  return {
    clause: `trim(COALESCE(${column}, '')) IN (${placeholders})`,
    params: rawKeys.map((k) => k.trim()),
  };
}

/**
 * FEA-4335: the content-version scope for a desktop detail usage read. Narrows
 * the usage aggregates to exactly one content version. Returns an empty fragment
 * (no predicate) for a legacy name-level route (`fingerprint` null) so the whole
 * name-level identity aggregates as before. The leading space keeps it splice-
 * safe directly after another clause.
 *
 * ISS-10341: the detail read is NO LONGER a caller. Its usage lanes are
 * family-scoped now (matching the cloud, and the list row that links to them), so
 * the only consumers left are the Optimization-analytics IPC handlers below, whose
 * narrowing the panel discloses in its own heading.
 *
 * ISS-4403: `fingerprint` is the value usage rows CARRY —
 * `computeDefinitionHash({ frontmatter: "", body: content, kind })`, stamped at
 * invocation — NOT the raw `agent_components.content_hash` the routable slug is
 * built from. Those are digests of different values and never agree for the same
 * file, so callers pass the recomputed canonical digest (`resolvedUsageScopeHash`,
 * surfaced to the renderer as `AgentComponentDetail.analyticsFingerprint`).
 * Passing a route's own fingerprint here matches no row and empties the read.
 *
 * `column` qualifies the version-hash column for queries that alias the usage
 * table (e.g. `acsu.component_version_hash`); it is a caller-supplied literal,
 * never user input. Also consumed by the Optimization-analytics IPC handlers
 * (ISS-4403), which content-scope their reads so two same-name/different-content
 * components no longer share one component's optimization analytics.
 */
export function versionHashScopeClause(
  fingerprint: string | null,
  column = "component_version_hash"
): {
  clause: string;
  params: string[];
} {
  if (!fingerprint) {
    return { clause: "", params: [] };
  }
  return {
    clause: `\n          AND ${column} = ?`,
    params: [fingerprint],
  };
}
