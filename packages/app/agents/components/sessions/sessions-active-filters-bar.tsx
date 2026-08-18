"use client";

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { Button } from "@repo/design-system/components/ui/button";
import { FilterChip } from "@repo/design-system/components/ui/filter-chip";
import { useSessionOwnerNameResolver } from "../../hooks/use-session-owner-name-resolver";
import { useSessionProjectNameResolver } from "../../hooks/use-session-project-name-resolver";
import {
  buildSessionOwnerScopeChip,
  deriveSessionFilterChips,
  mergeSessionScopeChips,
} from "../../lib/session-active-filter-chips";
import {
  DEFAULT_SESSION_FACET_FILTERS,
  type SessionFacetFilters,
  sessionFilterFacetGroups,
  withoutOwnerFacetValue,
} from "../../lib/session-filter-adapter";

type SessionsActiveFiltersBarProps = {
  filters: SessionFacetFilters;
  onFiltersChange: (next: SessionFacetFilters) => void;
  /** Usage summary supplies the Owner/Repository/Harness/Model option labels. */
  usage?: AgentSessionUsageSummary;
  /**
   * "Clear all" handler. When provided, it owns the TOTAL clear the host
   * defines — resetting the facets AND the date window / search / selected-user
   * scope — so one control means one thing (the same `handleClearFilters` the
   * empty-state recovery action uses). When omitted, "Clear all" falls back to
   * resetting only the facets to `DEFAULT_SESSION_FACET_FILTERS`.
   */
  onClearAll?: () => void;
  /**
   * ISS-4728: the host's out-of-facet selected-user scope (the web Sessions
   * page's `?userId=` deep link), folded into this row as an Owner chip.
   *
   * Passed as a raw id rather than a prebuilt chip so the row resolves the
   * display name from the SAME Owner option list the popover renders, instead of
   * every host inventing its own label. Omitted (or null) on a surface that has
   * no such scope — the desktop Sessions view has only the Owner facet — in
   * which case the row is exactly what it was.
   */
  scopeUserId?: string | null;
  /**
   * Clears the `scopeUserId` narrower. This is the host's URL-param strip, NOT a
   * facet toggle: the two narrowers reach the query independently, so removing
   * the chip must undo the one it actually names. Required for the chip to
   * render — a chip that names a filter it cannot remove is the badge this
   * replaced.
   *
   * Receives the facet filters the host should write ALONGSIDE the strip, in ONE
   * URL write. When the scoped user is also a selected Owner facet value the two
   * chips collapse into one, so that single click has to drop both narrowers —
   * and it cannot be two writes: both would derive their next URL from the same
   * pre-click search-params snapshot, so the second would restore the param the
   * first stripped and the chip would spring back (review cid 3701353686). When
   * the scope is NOT also a facet value the argument is simply the current
   * filters, i.e. "strip the param, leave the facets alone".
   */
  onRemoveScopeUser?: (nextFilters: SessionFacetFilters) => void;
  /**
   * ISS-5355: include Project among the derived chips. Unlike the Changes/PR
   * roll-out gate below — which the row deliberately ignores because those
   * facets DO narrow the list on every surface — Project is not a dimension the
   * desktop can apply at all, so a chip there would name a filter that never
   * ran. The row therefore follows the host's capability for this one facet.
   */
  includeProjectFilter?: boolean;
};

/**
 * Sessions active-filter chip row (ISS-4605, follow-up from ISS-4481 / PR #4048).
 *
 * Renders one removable chip per active facet *value* — Status, Owner, Autonomy,
 * Harness, Model, Cost, Changes, Pull request, Repository — plus a "Clear all".
 * Without it, a filtered cohort (e.g. Cost = Unknown) reads as a broken column
 * rather than a filtered view: nothing on screen names which filters are active.
 *
 * The chips are derived from the SAME `sessionFilterFacetGroups` model that
 * drives the Filter popover, so the facet labels and per-value labels reuse the
 * existing facet→label mapping (no duplicated label strings) and can never drift
 * from the menu. Removing a chip toggles that one value back off its facet;
 * "Clear all" delegates to the host's `onClearAll` (the total clear that also
 * resets the date window / search / user scope) when provided, else resets every
 * facet to `DEFAULT_SESSION_FACET_FILTERS`. Renders nothing when no facet is
 * active, so the default view keeps a clean toolbar.
 *
 * Many active facets can't crowd the pinned toolbar out of the table: the row
 * caps its height and scrolls internally rather than wrapping to four lines and
 * eating the viewport for good.
 */
export function SessionsActiveFiltersBar({
  filters,
  onFiltersChange,
  usage,
  onClearAll,
  scopeUserId,
  onRemoveScopeUser,
  includeProjectFilter,
}: SessionsActiveFiltersBarProps) {
  // Derive chips over the FULL facet set — always including Changes / Pull
  // request — regardless of the `sessions-change-pr-filters` flag that gates the
  // Filter popover. An active `changes=`/`pr=` selection can arrive from a shared
  // list URL while the flag is off for this viewer; gating the chip row on the
  // flag (as the popover does) would leave that filter silently narrowing the
  // list with no chip to name or remove it, and would let "Clear all" wipe a
  // facet the row never showed. The chip row's job is to surface EVERY active
  // filter, so it must not inherit the popover's roll-out gate.
  // ISS-4974: resolves an Owner name off the org roster for a selected owner (or
  // `?userId=` scope) the active date window has no usage row for. Returns
  // `undefined` while its flag is off, the roster has not loaded, or the surface
  // is signed out — and the label then falls through to the raw id exactly as
  // before. The read inside it is gated on an unresolved id actually being on
  // screen, so the default unfiltered view fetches nothing.
  const resolveOwnerName = useSessionOwnerNameResolver({
    scopeUserId,
    selectedUserIds: filters.userIds,
    usage,
  });
  // ISS-5355: the Project counterpart. Same contract — never fabricates a name,
  // never fetches unless a selected project the window cannot name is on screen.
  // Without it a chip arriving from the project-detail strip's link read
  // `Project: 019f8008-19…`, the only facet whose out-of-range fallback was a
  // raw uuid.
  const resolveProjectName = useSessionProjectNameResolver({
    enabled: includeProjectFilter === true,
    selectedProjectIds: filters.projectIds,
    usage,
  });
  const groups = sessionFilterFacetGroups(filters, onFiltersChange, usage, {
    includeChangePrFilters: true,
    includeProjectFilter,
    resolveOwnerName,
    resolveProjectName,
  });
  const facetChips = deriveSessionFilterChips(groups);
  // ISS-4728: the selected-user scope leads the row, so the narrower that came
  // in from another surface's link is named first — it is the one the reader did
  // not set here and is most likely to be surprised by.
  //
  // The scope chip's remove is built TOTAL here rather than chained downstream:
  // this component is the one place that holds BOTH narrowers (the `?userId=`
  // scope and the Owner facet selection), so it is the only place that can hand
  // the host a single next-filters value to write with the param strip. Dropping
  // the scoped user from `userIds` is a no-op when he was never a selected facet
  // value, which is exactly the un-merged case.
  const chips =
    scopeUserId && onRemoveScopeUser
      ? mergeSessionScopeChips(
          [
            buildSessionOwnerScopeChip(
              groups,
              scopeUserId,
              () =>
                onRemoveScopeUser(withoutOwnerFacetValue(filters, scopeUserId)),
              resolveOwnerName
            ),
          ],
          facetChips
        )
      : facetChips;

  if (chips.length === 0) {
    return null;
  }

  const handleClearAll =
    onClearAll ?? (() => onFiltersChange(DEFAULT_SESSION_FACET_FILTERS));

  return (
    // max-h-16 (≈2 rows) + overflow-y-auto so a many-chip row scrolls internally
    // instead of wrapping to several lines and pushing the table out of the
    // pinned toolbar (which sits outside the scroll region on both surfaces).
    <div className="flex max-h-16 flex-wrap items-center gap-1 overflow-y-auto">
      {chips.map((chip) => (
        <FilterChip
          key={chip.key}
          label={`${chip.facetLabel}: ${chip.valueLabel}`}
          onRemove={chip.remove}
        />
      ))}
      <Button
        className="h-auto px-2 py-1 text-xs"
        onClick={handleClearAll}
        variant="ghost"
      >
        Clear all
      </Button>
    </div>
  );
}
