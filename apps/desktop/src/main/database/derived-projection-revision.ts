/**
 * @file derived-projection-revision.ts
 * @description ISS-8741: the durable representation that tells a record's LAST
 * KNOWN-GOOD derived projection apart from a CANDIDATE replacement, and stamps
 * each with the source revision it was derived at.
 *
 * WHY IT IS A SEPARATE AXIS. `sessions.data_revision` answers "which derivation
 * semantics produced the rows that are here", and the rebuild selects on it. It
 * cannot answer "did the projection those rows form ever satisfy the view that
 * consumes them", because it is stamped by the writer regardless. Nor can it
 * distinguish a projection that is standing because it is good from one that is
 * standing because a replacement attempt was interrupted. Those are the two
 * questions a safe schema evolution has to answer before it retires anything,
 * so they get their own two columns.
 *
 * KNOWN-GOOD AND CANDIDATE ARE STRUCTURAL, NOT A STORED WORD. There is no state
 * enum here on purpose: which of the two columns is non-null IS the state. That
 * is one fewer vocabulary to keep honest, and it makes the ISS-7708 ruling true
 * by construction rather than by discipline — a schema-evolution state cannot
 * leak into `SESSION_STATUS` (`active` / `inactive` / `error`) or
 * `DISPLAYED_SESSION_STATUS` because no such string is ever written.
 *
 * WHY THE REVISION IS A STRING AND NOT A NUMBER. A projection's provenance is
 * more than one independently-bumped counter — the derivation revision, the two
 * version-gated parser passes that re-derive parts of it outside that revision,
 * and the record schema it is shaped to. A single integer cannot say which of
 * them moved, and a fixed struct cannot absorb a fifth without a migration. A
 * sorted `name=version` list is comparable by equality, cheap to store, and
 * additively extensible: a descriptor written by an older build simply does not
 * equal the current one, which is exactly the "this projection was built by a
 * different thing" answer a reader wants.
 *
 * WRITE-SIDE ONLY, DELIBERATELY. Nothing here reads a stored descriptor back,
 * because nothing in this repo reads one yet: the rebuild still selects its
 * cohort on `data_revision` alone. A parser for the format belongs with the
 * first consumer that needs it (ISS-8742's resumable worker), not ahead of it.
 */

/** Separator between components in a formatted revision descriptor. */
const REVISION_COMPONENT_SEPARATOR = ";";

/** Separator between a component's name and its version. */
const REVISION_NAME_VALUE_SEPARATOR = "=";

/** Rejects a component name that would collide with the encoding itself. */
const REVISION_COMPONENT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * The view models a derived record projects into, and therefore the things a
 * bad replacement can destroy. Named so a rejection can say WHICH view refused
 * the candidate rather than reporting an anonymous failure.
 */
export const ProjectionTarget = {
  Sessions: "sessions",
  Branches: "branches",
  Owner: "owner",
  Aggregate: "aggregate",
} as const;
export type ProjectionTarget =
  (typeof ProjectionTarget)[keyof typeof ProjectionTarget];

/** One independently-bumped input to a projection's source revision. */
export type DerivedProjectionRevisionComponent = {
  readonly name: string;
  readonly version: number;
};

/**
 * Format a set of revision components into the durable descriptor.
 *
 * Sorted by name so two equal component sets always produce the same bytes —
 * the descriptor is compared by string equality, so declaration order must not
 * be able to make an unchanged projection look stale.
 *
 * Returns `null` rather than a repaired string when any component is unusable
 * (non-finite, negative, non-integer version, or a name the encoding cannot
 * round-trip). A normalized value is valid-or-absent: a caller that gets `null`
 * must decline to stamp, never persist an approximation of a revision it could
 * not compute.
 */
export function formatDerivedProjectionRevision(
  components: readonly DerivedProjectionRevisionComponent[]
): string | null {
  if (components.length === 0) {
    return null;
  }
  const seen = new Set<string>();
  const encoded: string[] = [];
  for (const component of components) {
    if (!REVISION_COMPONENT_NAME_PATTERN.test(component.name)) {
      return null;
    }
    if (seen.has(component.name)) {
      return null;
    }
    if (
      !Number.isSafeInteger(component.version) ||
      component.version < 0 ||
      component.version > MAX_REVISION_COMPONENT_VERSION
    ) {
      return null;
    }
    seen.add(component.name);
    encoded.push(
      `${component.name}${REVISION_NAME_VALUE_SEPARATOR}${component.version}`
    );
  }
  encoded.sort();
  return encoded.join(REVISION_COMPONENT_SEPARATOR);
}

/**
 * Upper bound on a single component's version. Well above any counter this
 * repo maintains (the largest is in the low hundreds) and far below
 * `Number.MAX_SAFE_INTEGER`, so a corrupt read is rejected instead of stored.
 */
const MAX_REVISION_COMPONENT_VERSION = 1_000_000;
