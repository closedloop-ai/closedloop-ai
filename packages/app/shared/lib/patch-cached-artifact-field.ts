import { isRecord } from "@repo/lib/harness/type-guards";

/**
 * The optimistic half of a single-artifact scalar write, over whatever list,
 * page-data or detail payload the query cache holds.
 *
 * Structural rather than keyed on one response shape, because the Sessions and
 * Branches reads each cache the same row under several shapes (`list`,
 * `pageData.list`, a detail) and each shell can inject its own source with its
 * own envelope. Walking the value and rewriting `field` on every record that IS
 * the artifact — by `id` or by `artifactId` — is what lets one mutation settle
 * every view of the row without a per-shape updater that drifts as shapes are
 * added.
 *
 * Only a record that already CARRIES the key is rewritten: a row from a
 * producer that omitted it (an older API or Desktop build) reads as "unknown",
 * and inventing the key on it would turn that into a known value the producer
 * never served. Returns the SAME reference when nothing matched, so an
 * untouched cache entry is not re-rendered.
 *
 * ISS-10332 introduced this walk for `priority`; ISS-8718 generalized it to the
 * field name so the session rename does not carry a second copy of it. The two
 * named wrappers — {@link patchCachedArtifactPriority} and
 * `patchCachedSessionName` — are what callers use; this is the shared mechanism
 * under both. Do not answer a third scalar with another copy of the walk.
 */
export function patchCachedArtifactField<T>(
  value: T,
  artifactId: string,
  field: string,
  next: unknown
): T {
  return patchValue(value, artifactId, field, next, 0) as T;
}

function patchValue(
  value: unknown,
  artifactId: string,
  field: string,
  replacement: unknown,
  depth: number
): unknown {
  if (depth > CACHED_FIELD_SCAN_MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const patched = patchValue(
        item,
        artifactId,
        field,
        replacement,
        depth + 1
      );
      changed ||= patched !== item;
      return patched;
    });
    return changed ? next : value;
  }
  if (!isRecord(value)) {
    return value;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const patched = patchValue(
      child,
      artifactId,
      field,
      replacement,
      depth + 1
    );
    changed ||= patched !== child;
    next[key] = patched;
  }
  if (
    isTargetRecord(value, artifactId) &&
    Object.hasOwn(value, field) &&
    value[field] !== replacement
  ) {
    next[field] = replacement;
    changed = true;
  }
  return changed ? next : value;
}

function isTargetRecord(
  record: Record<string, unknown>,
  artifactId: string
): boolean {
  return record.id === artifactId || record.artifactId === artifactId;
}

const CACHED_FIELD_SCAN_MAX_DEPTH = 8;
