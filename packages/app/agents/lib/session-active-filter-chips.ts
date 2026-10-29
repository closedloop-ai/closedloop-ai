import type {
  FilterFacetGroup,
  FilterMenuGroup,
} from "@repo/design-system/components/ui/table-filters";

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
 * {@link mergeSessionScopeChips}' twin for a chip row built from FACET GROUPS
 * rather than from {@link SessionFilterChip}s (ISS-8037).
 *
 * `ActiveFiltersBar` (v2) derives its chips from the groups themselves — one
 * chip per ACTIVE group, labelled from that group's own options — so a scope
 * chip cannot be appended to a chip list there. Folding the scoped user into the
 * Owner group's selection is the same reconciliation `mergeSessionScopeChips`
 * performs on v1: the two narrowers share the Owner vocabulary, so they read as
 * ONE "Owner: …" chip instead of two chips saying the same thing, only one of
 * which half-unnarrows the list.
 *
 * EVERY facet menu the surface renders takes the folded groups, not just the
 * chip row. Feeding it to one and not the other is the ticket's own defect moved
 * one control over: `FilterPopover` derives its count from
 * `facetGroups.filter(isFilterMenuGroupActive).length`, so an unfolded popover
 * reads a plain "Filter" — no count, no clear-X — beside a chip that says
 * "Owner: …" and an empty state that says "No matching sessions". And
 * `ActiveFiltersBar` menus its own "+ Add filter" off the SAME view model it
 * chips from, so the two menus sat three inches apart disagreeing about whether
 * Owner was filtered. Showing the scope checked is not "offering a toggle the
 * facet writer does not own": `onToggle` below routes that one value to
 * `onRemoveScope`, so unchecking it is the same total removal the chip performs.
 *
 * `onRemoveScope` must be TOTAL, for the reason
 * {@link buildSessionOwnerScopeChip} spells out — it has to undo every narrowing
 * this one chip claims in a single write, including the Owner FACET value when
 * the same user is selected there too. Chaining a second write instead is what
 * makes the chip reappear over a still-narrowed list.
 *
 * Groups with no Owner facet pass through untouched rather than growing one: a
 * chip whose remove reaches no `onToggle` would be a control that does nothing.
 */
export function foldOwnerScopeIntoFacetGroups(
  groups: readonly FilterMenuGroup[],
  scopeUserId: string,
  onRemoveScope: () => void,
  resolveOrgMemberName?: SessionOwnerNameResolver
): FilterMenuGroup[] {
  return groups.map((group) => {
    // ISS-7052 widened this list to carry custom-field RANGE groups alongside
    // the option facets. A range group has no `options`/`selectedValues` to
    // fold a scope into, so it passes through — same treatment as any group
    // that is not the Owner facet.
    if (group.id !== OWNER_FACET_GROUP_ID || group.kind === "range") {
      return group;
    }
    const existingOption = group.options.find(
      (option) => option.id === scopeUserId
    );
    return {
      ...group,
      // An option is REQUIRED, not cosmetic: the bar labels a chip from the
      // options matching its selection, so a scoped id absent from the list
      // renders "Owner:" naming nobody.
      //
      // FIRST, not appended. The chip's label is built by walking `options` and
      // keeping the selected ones, so option order — not selection order — is
      // what the reader sees, and a `FilterChip` truncates. Appended, the scope
      // landed last in "Owner: Alex Chen, Pascoe Birchall" and was the first thing
      // the ellipsis ate: the one narrower the reader did NOT set here, hidden.
      options: [
        existingOption ?? {
          id: scopeUserId,
          label: resolveOwnerChipLabel(
            scopeUserId,
            undefined,
            resolveOrgMemberName
          ),
        },
        ...group.options.filter((option) => option.id !== scopeUserId),
      ],
      // Deduped, which is the merged case: the same user as both the scope and
      // a selected Owner value is ONE narrowing to name and one to remove.
      selectedValues: [
        scopeUserId,
        ...group.selectedValues.filter((value) => value !== scopeUserId),
      ],
      onToggle: (value: string) =>
        value === scopeUserId ? onRemoveScope() : group.onToggle(value),
    };
  });
}

/**
 * The synthetic facet group the `?search=` term rides (ISS-8966).
 *
 * Not a column id and not a `SessionFacetFilters` key — the search is neither —
 * so it collides with nothing the surface looks a group up by. The surface's
 * header-filter lookup matches a group id against a COLUMN id, and there is no
 * `search` column.
 */
const SEARCH_FACET_GROUP_ID = "search";

/** The label the search chip and its menu entry both read. */
const SEARCH_FACET_LABEL = "Search";

/**
 * ISS-8966: fold the host-owned search term into the facet groups, so
 * `ActiveFiltersBar` chips it and `FilterPopover` counts it.
 *
 * The sibling of {@link foldOwnerScopeIntoFacetGroups}, and the same
 * reconciliation: a narrower that is NOT part of the multi-select facet model
 * still has to be NAMED and REMOVABLE in the one row that answers "what is
 * narrowing this list". Expressed as a group rather than as a bespoke chip
 * because `ActiveFiltersBar` derives every chip from a group — a chip appended
 * beside them would be a second visual language for the same job, and would miss
 * that bar's "Clear all", which walks the ACTIVE GROUPS and clears each.
 *
 * A group OF ITS OWN rather than folded into an existing one, unlike the owner
 * scope: the scope shares the Owner facet's vocabulary and would otherwise read
 * as two chips saying the same thing, while a free-text term shares no facet's.
 * FIRST, not appended (Pascoe review): the chip row and the facet menu are both
 * built in group order, and a term the reader typed themselves is usually the
 * strongest narrower on the screen — last is where the eye goes least and where
 * a wrapped chip row truncates.
 *
 * Applied to EVERY facet view model the surface builds, for the reason
 * {@link foldOwnerScopeIntoFacetGroups} documents — `ActiveFiltersBar` menus its
 * "+ Add filter" off the same view model it chips from, so folding one and not
 * the other leaves two menus disagreeing about whether a search is applied.
 *
 * `onClearSearch` must be TOTAL and must be ONE write, for the same reason the
 * scope's remover is: "Clear all" calls it synchronously after
 * `clearAllFilters()` with no render between, so a remover deriving its next
 * state from the pre-click snapshot would put the term straight back.
 *
 * An empty term folds nothing: a group with no selection is not active, so it
 * would render no chip and no count — but it WOULD add an inert "Search" entry
 * to the "+ Add filter" menu offering a value nobody can pick.
 */
export function foldSessionSearchIntoFacetGroups(
  groups: readonly FilterMenuGroup[],
  search: string,
  onClearSearch: () => void
): FilterMenuGroup[] {
  if (search === "") {
    return [...groups];
  }
  return [
    {
      id: SEARCH_FACET_GROUP_ID,
      label: SEARCH_FACET_LABEL,
      // The term is its own option, so the bar labels the chip `Search: deploy`
      // off the same `options`-matching rule every facet chip uses rather than a
      // second label expression. Unchecking it is the same total removal the
      // chip's X performs.
      options: [{ id: search, label: search }],
      selectedValues: [search],
      onToggle: () => onClearSearch(),
    },
    ...groups,
  ];
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
