import {
  normalizeSessionColumnId,
  SESSIONS_COLUMN_SPECS,
  SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS,
  SESSIONS_ISSUES_COLUMN_ID,
  SESSIONS_PRIORITY_COLUMN_ID,
  SESSIONS_PROJECTS_COLUMN_ID,
  SESSIONS_TAGS_COLUMN_ID,
  type SessionsColumnGateState,
} from "./sessions-table-columns";

/**
 * Which Sessions columns a BUILD and a MOUNT may render: the gate and seam
 * derivation over the canonical `SESSIONS_COLUMN_SPECS` declaration.
 *
 * Split out of `sessions-table-columns.ts` (ISS-10332 / PLN-2086 Milestone 2)
 * along the responsibility seam that module's own docstring already drew: that
 * file declares the column GEOMETRY — ids, labels, tracks, the canonical order
 * and the default-hidden seed — and this one answers, from that declaration,
 * which columns actually render. Both stay dependency-light so the view-state
 * hook can read either without pulling the table's component graph in.
 */

/**
 * ISS-5713: columns whose cell content the presentational table cannot derive on
 * its own — the host must wire a render seam or the column is dropped along with
 * its grid track.
 *
 * Declared beside the derivation that reads it, so the render path and every
 * derived consumer read one set. It is deliberately distinct from a column's `gate`: the gate is a
 * property of the BUILD (is the flag on), this is a property of the MOUNT (does
 * this surface hold the data). Both fields behind `Owning project` and `Linked
 * issues` are cloud-only, so a locally-fed Sessions list must not grow two
 * columns of em dashes just because a flag flipped. A column listed here and
 * gated renders only when BOTH answer yes.
 *
 * ISS-8712: seam-required is no longer a single group, so the set below is the
 * UNION of the per-seam lists rather than a hand-typed list of its own. Until
 * then a consumer could spread the whole set on one host boolean — and did:
 * `SessionsToolbar` offered every seam-required column whenever the host opted
 * into the linked-entity pair. That is correct only while one seam exists.
 */
export const SESSIONS_LINKED_ENTITY_SEAM_COLUMN_IDS: readonly string[] = [
  SESSIONS_PROJECTS_COLUMN_ID,
  SESSIONS_ISSUES_COLUMN_ID,
];

/**
 * ISS-8712: Tags is seam-required for a different reason than the pair above —
 * not because the field is cloud-only, but because the cell is an interactive
 * picker that owns write mutations. A presentational table must not mount one
 * itself: every bare `render(<SessionsTable />)` would then need a query
 * provider it has never had.
 */
export const SESSIONS_TAGS_SEAM_COLUMN_IDS: readonly string[] = [
  SESSIONS_TAGS_COLUMN_ID,
];

/**
 * ISS-10332: Priority is seam-required for the reason Tags is — the cell is
 * `ArtifactPriorityEditor` over a mutation the host supplies through its data
 * source (`useUpdateSessionPriority`), so a presentational table cannot mount
 * it — and for a second one the Tags seam does not need: which SOURCE feeds the
 * mount decides whether the row's `priority` is known at all. The cloud list
 * projects it (PLN-2086 Milestone 1), and the desktop local producer since
 * Milestone 3 supplied both the field and the local write. A host
 * therefore wires this seam only when its source can write, and a mount that
 * cannot never grows a column it could neither fill nor edit.
 */
export const SESSIONS_PRIORITY_SEAM_COLUMN_IDS: readonly string[] = [
  SESSIONS_PRIORITY_COLUMN_ID,
];

export const SESSIONS_SEAM_REQUIRED_COLUMN_IDS: ReadonlySet<string> = new Set([
  ...SESSIONS_LINKED_ENTITY_SEAM_COLUMN_IDS,
  ...SESSIONS_TAGS_SEAM_COLUMN_IDS,
  ...SESSIONS_PRIORITY_SEAM_COLUMN_IDS,
]);

/**
 * The minimum a column has to state for {@link selectOfferableSessionColumns} to
 * judge it. Structural rather than `SessionsColumnSpec` so the derivation can be
 * exercised against a HYPOTHETICAL column gated behind a key this build does not
 * declare yet — which is the only way to prove the rule generalises past the two
 * gated columns that happen to exist today.
 */
export type GatedSessionColumn = { id: string; gate: string | null };

/**
 * ISS-5713 / ISS-5770: the ONE answer to "may this build + this mount offer this
 * column at all", independent of whether the user has it hidden.
 *
 * Both consumers of gatedness go through here — {@link resolveRenderedSessionColumnIds}
 * (what the TABLE renders) and `sessionsToggleableColumns` (what the VIEW MENU
 * offers). They previously answered it separately, and the menu's copy was a
 * hand-maintained `projects`/`issues` exclusion list rather than a read of
 * `spec.gate`: a column added behind any other gate would have compiled, stayed
 * hidden in the table, and shown a dead switch in the menu — the same
 * declaration-versus-consumer drift this ticket exists to remove, surviving in
 * the one path it had not been applied to.
 *
 * Generic in the spec type so callers get their own element type back (labels
 * included) rather than a widened one.
 */
export function selectOfferableSessionColumns<T extends GatedSessionColumn>(
  specs: readonly T[],
  {
    enabledGates,
    hostSuppliedColumnIds,
  }: {
    enabledGates: Readonly<Record<string, boolean | undefined>>;
    hostSuppliedColumnIds?: readonly string[];
  }
): readonly T[] {
  const hostSupplied = new Set(
    (hostSuppliedColumnIds ?? []).map(normalizeSessionColumnId)
  );
  return specs.filter((spec) => {
    // `null` is the ungated sentinel (see `SessionsColumnSpec["gate"]`), so a
    // gate string that this build has not enabled shuts the column — for EVERY
    // gate key, not just the one the linked-entity pair happens to use.
    if (spec.gate !== null && !enabledGates[spec.gate]) {
      return false;
    }
    // The host filter applies ONLY to seam-required columns. Applied to every
    // column it would mean "a caller that names no seams renders no table",
    // which is the opposite of the default this helper needs.
    return !(
      SESSIONS_SEAM_REQUIRED_COLUMN_IDS.has(spec.id) &&
      !hostSupplied.has(spec.id)
    );
  });
}

/**
 * ISS-5713: the ONE derivation of "which columns does this build actually
 * render", given the flag state and the hidden-column set.
 *
 * This is the field the ticket asks for. Before it, gatedness was a property of
 * `SessionsTable`'s render path only, so {@link SESSIONS_COLUMN_SPECS} declared
 * what COULD render while every consumer needing what DOES render kept its own
 * hand-maintained exclusion list — `e2e/sessions-list-surface.spec.ts` grew a
 * `FLAG_GATED_COLUMN_IDS` literal for exactly that reason, and a PR that added
 * two gated columns broke all five of that spec's tests without touching the
 * file. A consumer now asks the question and gets an answer that cannot drift,
 * because one place knows.
 *
 * `enabledGates` is a per-key map rather than a boolean so adding a second gate
 * key later does not change this signature or silently re-interpret an existing
 * caller's argument.
 *
 * The `hostSuppliedColumnIds` seam is deliberately separate from the gate: a
 * column can be shut because the BUILD has its flag off, or because THIS MOUNT
 * cannot supply the cell (the agent-detail Sessions tab supplies no linked
 * entities). Those are different questions with different answers per mount, and
 * collapsing them onto one flag is what grows a column of em dashes on a surface
 * whose producer never emits the field.
 */
export function resolveRenderedSessionColumnIds({
  enabledGates,
  hiddenColumnIds = SESSIONS_DEFAULT_HIDDEN_COLUMN_IDS,
  hostSuppliedColumnIds,
}: {
  enabledGates: SessionsColumnGateState;
  hiddenColumnIds?: readonly string[];
  hostSuppliedColumnIds?: readonly string[];
}): readonly string[] {
  const hidden = new Set(hiddenColumnIds.map(normalizeSessionColumnId));
  return selectOfferableSessionColumns(SESSIONS_COLUMN_SPECS, {
    enabledGates,
    ...(hostSuppliedColumnIds ? { hostSuppliedColumnIds } : {}),
  })
    .filter((spec) => !hidden.has(spec.id))
    .map((spec) => spec.id);
}

/**
 * ISS-5770: the columns a brand-new Sessions view shows, in render order — the
 * prototype's ten default-ON columns.
 *
 * Derived from the declaration plus the default-hidden set rather than typed out
 * again, so this cannot state a set the table does not render. Gates are treated
 * as OFF here because closed-by-default is the policy every remaining gate key
 * ships under, which makes this exactly what a new user sees.
 */
export const SESSIONS_DEFAULT_VISIBLE_COLUMN_IDS: readonly string[] =
  resolveRenderedSessionColumnIds({ enabledGates: {} });
