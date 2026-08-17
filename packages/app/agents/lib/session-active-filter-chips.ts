import type { FilterFacetGroup } from "@repo/design-system/components/ui/table-filters";

/**
 * One removable active-filter chip in the Sessions toolbar chip row (ISS-4605).
 * Derived from the same {@link FilterFacetGroup} model that drives the Filter
 * popover, so the facet label and the per-value label reuse the existing
 * facet→label mapping (no duplicated label strings). Each chip removes exactly
 * one facet *value*; `remove()` toggles that value back off its group.
 */
export type SessionFilterChip = {
  /** Stable key: the facet group id plus the selected value. */
  key: string;
  /** The facet's human label (e.g. "Status", "Owner"). */
  facetLabel: string;
  /** The selected value's human label (e.g. "Completed", "Ada Lovelace"). */
  valueLabel: string;
  /** Remove just this value from its facet (toggles it off). */
  remove: () => void;
};

/**
 * Walk the Filter popover's facet groups and emit one chip per *selected value*
 * across every facet, preserving facet order (Status, Owner, Autonomy, …) and
 * the selection order within each facet. The value label is resolved from the
 * group's own `options` (the same list the popover renders), so labels never
 * drift from the menu. A selected value with no matching option — e.g. an Owner
 * whose usage row dropped out of range — still renders a chip using the raw
 * value, so a selection is always visible and removable (mirroring how the Model
 * facet keeps out-of-range selections uncheckable-proof).
 */
export function deriveSessionFilterChips(
  groups: readonly FilterFacetGroup[]
): SessionFilterChip[] {
  const chips: SessionFilterChip[] = [];
  for (const group of groups) {
    const optionLabelByValue = new Map(
      group.options.map((option) => [option.id, option.label])
    );
    for (const value of group.selectedValues) {
      chips.push({
        key: `${group.id}:${value}`,
        facetLabel: group.label,
        valueLabel: optionLabelByValue.get(value) ?? value,
        remove: () => group.onToggle(value),
      });
    }
  }
  return chips;
}

/** The facet group whose vocabulary the `?userId=` scope shares (ISS-4728). */
const OWNER_FACET_GROUP_ID = "owner";

/**
 * Resolves an org member's display name from a user id, or `undefined` when the
 * id belongs to no org member (or the roster is not loaded/reachable).
 *
 * ISS-4974. Returning `undefined` rather than a placeholder is the contract:
 * this resolver is only ever allowed to ADD a name it actually knows, never to
 * invent one. See `useSessionOwnerNameResolver`.
 */
export type SessionOwnerNameResolver = (userId: string) => string | undefined;

/**
 * The ONE label rule for an Owner value, used by BOTH Owner paths — the facet
 * option list (`ownerOptions`) and the `?userId=` scope chip
 * ({@link buildSessionOwnerScopeChip}).
 *
 * The precedence is the whole point, and it is deliberately ordered by how much
 * the label is known to describe THIS view:
 *
 * 1. `inWindowLabel` — the usage `byUser` display name for the selected date
 *    window. Authoritative, because it is the same name the Owner popover shows
 *    beside a session count the reader can check.
 * 2. `resolveOrgMemberName` — ISS-4974's addition. An owner whose sessions all
 *    fall outside the window (or a `?userId=` scope arriving from a surface that
 *    DID know the name) has no usage row, but is still a nameable person.
 *    Absent when the roster has not loaded or the surface is signed out.
 * 3. The raw id — LAST resort, for an id that belongs to no org member at all.
 *    An opaque `user_2ab…` identifies nobody, but it is at least the value that
 *    is actually narrowing the list, and it stays removable. Never a placeholder
 *    like "Selected user", and never a guessed name.
 *
 * Both paths share this function so the two fallbacks cannot drift apart again —
 * two chips in one row, same facet, must not answer "we don't know this name"
 * two different ways (the invariant #4276 established, pinned by
 * `sessions-active-filters-bar.test.tsx`).
 */
export function resolveOwnerChipLabel(
  userId: string,
  inWindowLabel: string | undefined,
  resolveOrgMemberName?: SessionOwnerNameResolver
): string {
  return inWindowLabel ?? resolveOrgMemberName?.(userId) ?? userId;
}

/**
 * Build the chip for the web Sessions page's `?userId=` deep-link scope
 * (ISS-4728).
 *
 * `?userId=` is a cross-surface narrower that is NOT part of the multi-select
 * facet model: it arrives from another surface's link, the server ANDs it onto
 * the read, and clearing it means stripping the URL param — not toggling a facet
 * value. Before this it had no chip at all; it announced itself with a separate
 * "User filtered" badge inside the scroll area, which named a filter it gave the
 * reader no way to remove and stacked a second visual language on the chip row's
 * job.
 *
 * So the chip borrows the Owner facet's LABEL VOCABULARY (its group label, and
 * its option label for this user) — one row, one way to read "what is narrowing
 * this list" — while `remove` stays the caller's URL write. The two narrowers
 * are reconciled in presentation without their semantics being conflated.
 *
 * `onRemove` MUST be TOTAL: it has to undo every narrowing this one chip claims,
 * in a SINGLE URL/state write. When the same user is also a selected Owner facet
 * value, {@link mergeSessionScopeChips} collapses the two into this one chip and
 * relies on that — it deliberately does NOT chain the facet chip's own remove
 * after this one, because both writers derive their next URL from the same
 * pre-click search-params snapshot and the second replace would put back the
 * param the first one stripped (review cid 3701353686).
 */
export function buildSessionOwnerScopeChip(
  groups: readonly FilterFacetGroup[],
  userId: string,
  onRemove: () => void,
  /**
   * ISS-4974: the org-roster name resolver, consulted only when the Owner option
   * list has no label for this id. Omitted when the flag is off, so the label
   * falls straight through to the raw id exactly as ISS-4728 shipped it.
   */
  resolveOrgMemberName?: SessionOwnerNameResolver
): SessionFilterChip {
  const ownerGroup = groups.find((group) => group.id === OWNER_FACET_GROUP_ID);
  const optionLabel = ownerGroup?.options.find(
    (option) => option.id === userId
  )?.label;
  return {
    // Deliberately the same key shape a selected Owner FACET value produces, so
    // `mergeSessionScopeChips` can recognise the two as one narrowing.
    key: `${OWNER_FACET_GROUP_ID}:${userId}`,
    facetLabel: ownerGroup?.label ?? "Owner",
    valueLabel: resolveOwnerChipLabel(
      userId,
      optionLabel,
      resolveOrgMemberName
    ),
    remove: onRemove,
  };
}

/**
 * Fold out-of-facet scope chips into the facet chip row (ISS-4728).
 *
 * Scopes lead, then the facet chips that no scope already covers. When the same
 * user is BOTH the URL scope and a selected Owner facet value the two collapse
 * into ONE chip — because two chips reading `Owner: Ada Lovelace` side by side,
 * one of which only half-unnarrows the list, is exactly the "which control did
 * what?" confusion the chip row exists to end. Removing that chip removes the
 * narrowing it claims, completely.
 *
 * The surviving chip keeps the SCOPE chip's own `remove` and drops the facet
 * twin's — it does NOT chain the two. Chaining is what made this function lie
 * (review cid 3701353686 / 3701348653 / 3701359129): the scope remover and the
 * facet remover each derive a replacement URL from the same pre-click
 * search-params snapshot, React batches them inside one click with no re-render
 * between, so the second `replace` wins and silently restores the param the
 * first one stripped — the chip reappears and the list stays narrowed. Building
 * a scope chip whose `remove` is TOTAL (one write that drops both narrowers) is
 * therefore the contract, not an optimisation; see
 * {@link buildSessionOwnerScopeChip}.
 */
export function mergeSessionScopeChips(
  scopeChips: readonly SessionFilterChip[],
  facetChips: readonly SessionFilterChip[]
): SessionFilterChip[] {
  const scopeKeys = new Set(scopeChips.map((chip) => chip.key));
  const merged: SessionFilterChip[] = [...scopeChips];
  for (const chip of facetChips) {
    if (!scopeKeys.has(chip.key)) {
      merged.push(chip);
    }
  }
  return merged;
}

/**
 * Resolves an org project's display name from a project id, or `undefined` when
 * the id belongs to no org project (or the list is not loaded/reachable).
 *
 * ISS-5355. Same contract as {@link SessionOwnerNameResolver}: it may only ever
 * ADD a name it actually knows, never invent one.
 */
export type SessionProjectNameResolver = (
  projectId: string
) => string | undefined;

/**
 * The ONE label rule for a Project facet value, mirroring
 * {@link resolveOwnerChipLabel} so the two window-scoped facets cannot answer
 * "we don't know this name" two different ways.
 *
 * 1. `inWindowLabel` — the usage `byProject` name for the active window.
 *    Authoritative: it sits beside a session count the reader can check.
 * 2. `resolveOrgProjectName` — the org project list, which is NOT window-scoped.
 *    This is the case the project-detail strip's link lands in: it counts over
 *    an unbounded window, so the project it selects routinely has no usage row
 *    in the recipient's window.
 * 3. The raw id — LAST resort, for an id belonging to no org project at all. An
 *    opaque uuid identifies nobody, but it is the value actually narrowing the
 *    list and it stays removable. Never a placeholder, never a guess.
 */
export function resolveProjectChipLabel(
  projectId: string,
  inWindowLabel: string | undefined,
  resolveOrgProjectName?: SessionProjectNameResolver
): string {
  return inWindowLabel ?? resolveOrgProjectName?.(projectId) ?? projectId;
}
