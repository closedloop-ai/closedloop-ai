import {
  RETIRED_DISPLAY_FACET_SPELLINGS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS as CANONICAL_SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";

/**
 * Canonical Agent Sessions status-filter contract (single source of truth for
 * every shared surface — Sessions filter menu, monitoring analytics toolbar,
 * and the kanban columns).
 *
 * **ISS-9939 / ISS-10629 (2026-09-17): the facet is now exactly the three
 * PERSISTED `SESSION_STATUS` lifecycle values.** `waiting`, `stale`, and
 * `unknown` — display-only projections drawn from `DISPLAYED_SESSION_STATUS`
 * — are retired from this facet. ISS-10262 made the same collapse for SORT;
 * this closes the FILTER half of the same operator ruling (ISS-9939). ISS-10364
 * then retired the three words from DISPLAY too, so a row that once badged
 * Waiting or Stale now badges Active — the value it stores and has always
 * matched the Active filter on.
 *
 * Do not narrow a filter INPUT to `SessionStatusFacetValue`, though: a
 * bookmarked URL or saved view can still carry a legacy
 * `completed`/`abandoned`, which the server falls through to an exact match on
 * a column that stores none of them and returns nothing. A restored `waiting`,
 * `stale` or `unknown` does NOT survive that far — the ruling removed those
 * chips outright, so {@link dedupeSessionStatusFacetValues} drops them at the
 * parse boundary. That is why a filter input stays typed `string`.
 * Both data sources reconcile the requested value at their own boundary:
 *   • cloud HTTP filters `artifact.status` directly (stores "error"), and
 *   • the desktop-local adapter case-folds the row status and the requested
 *     filter through `canonicalSharedStatus`, symmetrically — which is what
 *     keeps the two comparable. ISS-5592 removed the alias rewriting that used
 *     to sit on top of that case-fold; nothing is aliased now.
 * No surface may send a non-canonical literal (e.g. "failed"), which matched
 * zero rows on the cloud source and split the contract across surfaces.
 *
 * The user-facing label stays "Failed" for the ERROR value to preserve the
 * existing UX vocabulary.
 */
export type SessionStatusFilterOption = {
  value: string;
  label: string;
};

export const SESSION_STATUS_LABELS = CANONICAL_SESSION_STATUS_LABELS;

/**
 * ISS-4696 — the ONE declaration of the Status **facet** vocabulary.
 *
 * ISS-4586 retired `completed`/`abandoned` from the facet, and ISS-4985 widened
 * the server-side facet predicate so a selected `inactive` still reached
 * not-yet-migrated rows. ISS-5592 removed that widening: the Inactive predicate
 * is a plain equality on the canonical value, and a retired spelling is an
 * ordinary unrecognized one.
 * ISS-4605 then shipped the active-filter chip row, which resolves a
 * chip's value label from the facet option list — so a flow or fixture that
 * drives a RETIRED value gets no option, and the chip falls back to rendering
 * the raw wire string (`Status: completed`).
 *
 * **ISS-9939 / ISS-10629 (2026-09-17): Waiting, Stale, and Unknown are retired
 * from this facet.** They were derived/display-only projections
 * (`buildStatusFacetPredicate`, which forked the same five-ticket-invariant
 * logic the row badge uses and has since been deleted); the operator ruling
 * collapsed both FILTER and SORT (ISS-10262 did SORT) to the three PERSISTED
 * `SESSION_STATUS` values, so the facet no longer needs — or offers — a
 * separate option for a display-only sub-state. DISPLAY is unchanged: a row
 * still badges Waiting/Stale exactly as before, it is simply no longer
 * isolatable as its own filter value. History kept below for the retired
 * members' reasoning; do not resurrect them without a new ruling.
 *
 * The two tickets had drifted apart because the vocabulary was only ever
 * spelled out inside {@link SESSION_STATUS_FILTER_OPTIONS}, leaving every test
 * and flow to hand-pick a `SESSION_STATUS` member and hope it was still a facet
 * option. This const is that missing name: the facet vocabulary declared once,
 * with the option list DERIVED from it, so a value cannot be facet-valid in one
 * place and retired in another.
 *
 * A member here is a promise that the server has a predicate for it. Do not add
 * one for a lane the query cannot filter on — see the `syncing` tripwire in
 * this module's tests.
 *
 * NOT every value that can reach a surface: a legacy bookmarked URL may still
 * carry a retired `completed`/`abandoned`/`waiting`/`stale`/`unknown`, and the
 * facet offers no option for any of them. Do not read "no option" as "no
 * predicate", though — since ISS-10629 the server answer splits two ways:
 *
 *   • CLOUD names the three display-only values and writes an unsatisfiable
 *     `status = { in: [] }` (`applyStatusFacetFilter`), deliberately chosen over
 *     the fallthrough so a retired request cannot widen to the whole population.
 *   • Everything else, and every value on DESKTOP, does fall through to an exact
 *     match — which on desktop is not a match on nothing, because the local
 *     column CAN hold a literal `waiting` (migration 0042 left the spelling).
 *
 * This const answers only "is there a facet option?"; for what a raw wire
 * value resolves to, ask `normalizeSessionStatus` / `resolveDisplayedSessionStatus`.
 */
export const SessionStatusFacetValue = {
  Active: SESSION_STATUS.ACTIVE,
  /** Terminal-but-not-failed. Matched by exact equality since ISS-5592. */
  Inactive: SESSION_STATUS.INACTIVE,
  /** Labelled "Failed" — the display vocabulary keeps the older word. */
  Error: SESSION_STATUS.ERROR,
} as const;
export type SessionStatusFacetValue =
  (typeof SessionStatusFacetValue)[keyof typeof SessionStatusFacetValue];

/**
 * The Status facet's options, derived from {@link SessionStatusFacetValue} so
 * the vocabulary has exactly one declaration site, and labelled from the shared
 * {@link SESSION_STATUS_LABELS} so the option text cannot drift from the badge
 * the table renders for the same value.
 */
export const SESSION_STATUS_FILTER_OPTIONS: readonly SessionStatusFilterOption[] =
  Object.values(SessionStatusFacetValue).map((value) => ({
    value,
    label: SESSION_STATUS_LABELS[value],
  }));

/**
 * Is `value` a status the Status facet can actually offer?
 *
 * The narrowing is the point: a caller that guards on this may then resolve a
 * facet option (and therefore a chip label) for the value without a fallback.
 */
export function isSessionStatusFacetValue(
  value: string
): value is SessionStatusFacetValue {
  return (Object.values(SessionStatusFacetValue) as string[]).includes(value);
}

/**
 * The display-only statuses ISS-10629 retired as facet values.
 *
 * ISS-10364 (operator ruling, 2026-09-23/24) retired `waiting`/`stale`/
 * `unknown` from `DISPLAYED_SESSION_STATUS` itself, so this can no longer be
 * derived as "displayed minus persisted" — that difference is now EMPTY, since
 * the two vocabularies share every member. Deriving it that way silently
 * stopped dropping these three from a restored URL/saved view (the exact
 * regression ISS-10629 exists to prevent), because the set it filtered against
 * no longer named them.
 *
 * Read from {@link RETIRED_DISPLAY_FACET_SPELLINGS} rather than restated: the
 * server's `resolvePersistedStatusFilter` refuses the same three, and a second
 * hand-written copy is how web and the API come to disagree about which values
 * a Status request may carry. Held as a `Set` here only because this is the hot
 * per-value filter.
 */
const RETIRED_STATUS_FACET_VALUES: ReadonlySet<string> = new Set(
  RETIRED_DISPLAY_FACET_SPELLINGS
);

/**
 * Normalize a Status-facet selection list read from a URL or a saved view:
 * de-duplicate, and drop the values ISS-10629 retired.
 *
 * The two kinds of non-offered value are treated differently ON PURPOSE.
 * `waiting`/`stale`/`unknown` are values this facet ITSELF used to offer, and
 * the ruling removed those chips entirely rather than keeping them read-only
 * over an empty result — restoring one would render a chip the menu can neither
 * produce nor re-add after the user clears it. An arbitrary unrecognized
 * spelling (`completed`, a future producer's value) was never a facet option, so
 * it is still returned unchanged: dropping it would hide what the URL actually
 * asked for, and ISS-5592 settled that it stays visible and removable.
 *
 * Kept as a named function rather than inlining the `Set`: the call site in
 * `session-filter-adapter.tsx` documents the boundary this crosses.
 */
export function dedupeSessionStatusFacetValues(
  values: readonly string[]
): string[] {
  return [...new Set(values)].filter(
    (value) => !RETIRED_STATUS_FACET_VALUES.has(value)
  );
}
