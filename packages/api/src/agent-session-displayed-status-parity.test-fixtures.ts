/**
 * ISS-4556 / ISS-4559: the SHARED oracle for the Sessions DISPLAYED-status
 * contract — one table of session shapes and, for each, the status the row must
 * display and which Status facets must return it.
 *
 * This exists because the contract is implemented TWICE and cannot be
 * implemented once: the cloud derives it in JS (`projectDisplayedSessionStatus`)
 * plus SQL (`buildStatusFacetPredicate`), while the desktop Local lane derives it
 * in the Electron main process (`shared-agent-session-status.ts`), and this repo
 * deliberately does not import across the `apps/api` ↔ `apps/desktop` boundary.
 * Two implementations asserted against two per-file constants is exactly how
 * FEA-4301's derivations drifted apart in the first place; asserting BOTH against
 * this ONE table means a divergence reddens whichever side moved.
 *
 * Consumers:
 *  - `apps/api/app/agent-sessions/service/displayed-status-parity.test.ts`
 *  - `apps/desktop/test/shared-agent-sessions-status-facet.test.ts`
 *  - `apps/desktop/test/session-aggregate-status-parity.test.ts`
 *
 * Scope note: every `rawStatus` here is a status whose canonical form is IDENTICAL
 * on both surfaces — which, since ISS-5592, is every status there is. This note
 * used to carve out the desktop-local `error`→`failed` alias as a separate
 * storage-vocabulary concern covered by the desktop suite's own alias test;
 * both the alias and that test are gone. `canonicalSharedStatus` now case-folds
 * and nothing else, so there is no surface-specific spelling left to exclude
 * and no reason to think this table is narrower than the contract it pins.
 *
 * ISS-4556: STALENESS is now one of the dimensions ({@link
 * DisplayedStatusParityCase.staleAnchor}), and it is not optional. The ACTIVE
 * predicate carries a `NOT staleAnchor` clause and the STALE predicate carries an
 * awaiting-input clause, so ACTIVE and STALE only partition while BOTH subtract
 * the same awaiting population. Pinning every row to a fresh anchor — which this
 * table used to do, to "keep staleness out of the comparison" — made the oracle
 * blind BY CONSTRUCTION to the one dimension on which those two predicates can
 * disagree, and an ended + awaiting + long-silent row fell through every facet
 * with the whole suite green. A case that cannot see the gap cannot guard it.
 */

import {
  DISPLAYED_SESSION_STATUS,
  type DisplayedSessionStatus,
  SESSION_STATUS,
} from "./types/session-status.ts";

/**
 * A status string no consumer RECOGNIZES — the version-skew case
 * {@link DISPLAYED_SESSION_STATUS.UNKNOWN} exists to serve. Deliberately typed `string`
 * rather than {@link SessionStatus}: the whole point is a value outside the
 * union, written by a producer newer than this reader, so it cannot be spelled
 * as a member of it. Shared here so all three consumers skew on the SAME value.
 */
export const UNRECOGNIZED_SESSION_STATUS = "quantum-flux";

export type DisplayedStatusParityCase = {
  /** What the case demonstrates, used as the test name on both surfaces. */
  readonly name: string;
  /**
   * The raw persisted session status. `string`, not {@link SessionStatus},
   * because the version-skew cases persist a value outside the union — see
   * {@link UNRECOGNIZED_SESSION_STATUS}.
   */
  readonly rawStatus: string;
  /** Whether `awaitingInputSince` is set. */
  readonly awaitingInput: boolean;
  /** Whether the session has ended (`sessionEndedAt` / desktop `endedAt`). */
  readonly ended: boolean;
  /**
   * Whether the row's activity anchor predates
   * `STALE_SESSION_DISPLAY_THRESHOLD_HOURS`. Consumers must express this
   * RELATIVE to now — a hard-coded past literal turns every row stale as the
   * wall clock passes it.
   */
  readonly staleAnchor: boolean;
  /**
   * The status the row MUST display, on both surfaces.
   *
   * ISS-5592 removed the retired vocabulary, so this is just the displayed set.
   * A row storing `completed` would display as `unknown` on both surfaces, like
   * any other spelling neither build recognizes.
   */
  readonly displayedStatus: DisplayedSessionStatus;
  /** Whether the ACTIVE facet MUST return the row. */
  readonly matchedByActiveFacet: boolean;
  /** Whether the WAITING facet MUST return the row. */
  readonly matchedByWaitingFacet: boolean;
  /** Whether the STALE facet MUST return the row. */
  readonly matchedByStaleFacet: boolean;
  /** Whether the UNKNOWN facet MUST return the row. */
  readonly matchedByUnknownFacet: boolean;
  /**
   * Whether a filter for the row's OWN {@link rawStatus} string MUST return it.
   *
   * ISS-4556: the four facet fields above name four of the six branches a status
   * filter can take, and the invariant this table encodes — "returned by the
   * facet named by the status it displays" — was therefore UNVERIFIED for every
   * case displaying `inactive` or a retired spelling. Case 5 proves the blindness:
   * it displays Inactive and the only assertions made about it were that four
   * OTHER facets return false, so deleting the INACTIVE branch outright, or
   * applying an unconditional waiting-exclusion to the raw-status fallback, left
   * all three suites green with the row invisible to every facet.
   *
   * Stated as "the facet named by the row's own stored status" rather than as one
   * field per remaining facet because that is what closes the gap without
   * inventing a cross-surface disagreement: it routes to the INACTIVE branch for
   * an `inactive` row, the WAITING branch for a persisted `waiting` row, and the
   * raw-status fallback for a retired or unrecognized one, and all three
   * implementations agree on every one of those. (The cloud INACTIVE facet's
   * ISS-4586 expansion to the retired spellings is deliberately NOT here: desktop
   * drops that expansion on purpose — its migration 0042 collapses the rows at
   * boot — so it is a documented per-surface difference and belongs in each
   * surface's own suite, not in a table whose whole value is that both sides must
   * answer identically.)
   */
  readonly matchedByRawStatusFacet: boolean;
};

/**
 * The invariant every case encodes: a row is returned by the facet named by the
 * status it displays, and by no other — so no row can be visible in the
 * unfiltered list yet hidden from every facet, and none can be counted twice.
 */
export const DISPLAYED_STATUS_PARITY_CASES: readonly DisplayedStatusParityCase[] =
  [
    {
      name: "a plain running session displays and filters as Active",
      rawStatus: SESSION_STATUS.ACTIVE,
      awaitingInput: false,
      ended: false,
      staleAnchor: false,
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: true,
      matchedByWaitingFacet: false,
      matchedByStaleFacet: false,
      matchedByUnknownFacet: false,
      matchedByRawStatusFacet: true,
    },
    {
      // ISS-4556: the row desktop rendered as Active while sorting it under
      // Waiting and returning it from the Waiting facet.
      name: "an awaiting-input, not-yet-ended session displays and filters as Waiting",
      rawStatus: SESSION_STATUS.ACTIVE,
      awaitingInput: true,
      ended: false,
      staleAnchor: false,
      displayedStatus: DISPLAYED_SESSION_STATUS.WAITING,
      matchedByActiveFacet: false,
      matchedByWaitingFacet: true,
      matchedByStaleFacet: false,
      matchedByUnknownFacet: false,
      matchedByRawStatusFacet: false,
    },
    {
      // ISS-5592: the replacement for the two deleted retired-spelling cases.
      //
      // It is the ONLY case where the TERMINAL-status test is the deciding
      // condition for the Waiting guard. Every other terminal+awaiting case sets
      // `ended: true`, so `sessionEndedAt IS NOT NULL` excludes it on its own and
      // a surface could drop the status check entirely and stay green. Here
      // `ended` is false, so a run that finished while carrying an inert
      // `awaitingInputSince` must be kept out of Waiting by its status alone —
      // otherwise a session that is OVER advertises itself as blocked on a human,
      // the most actionable signal on the surface.
      name: "a terminal, not-yet-ended session carrying awaitingInputSince stays out of Waiting",
      rawStatus: SESSION_STATUS.INACTIVE,
      awaitingInput: true,
      ended: false,
      staleAnchor: false,
      displayedStatus: SESSION_STATUS.INACTIVE,
      matchedByActiveFacet: false,
      matchedByWaitingFacet: false,
      matchedByStaleFacet: false,
      matchedByUnknownFacet: false,
      matchedByRawStatusFacet: true,
    },
    {
      // ISS-4559: the row that displayed Active and was returned by NEITHER
      // facet. The Waiting projection requires `!ended`, so it displays its raw
      // `active` — and the ACTIVE facet must therefore return it.
      name: "an ended, awaiting-input session displays Active and is returned by the Active facet",
      rawStatus: SESSION_STATUS.ACTIVE,
      awaitingInput: true,
      ended: true,
      staleAnchor: false,
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: true,
      matchedByWaitingFacet: false,
      matchedByStaleFacet: false,
      matchedByUnknownFacet: false,
      matchedByRawStatusFacet: true,
    },
    {
      name: "an ended session that was never awaiting input still displays Active",
      rawStatus: SESSION_STATUS.ACTIVE,
      awaitingInput: false,
      ended: true,
      staleAnchor: false,
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: true,
      matchedByWaitingFacet: false,
      matchedByStaleFacet: false,
      matchedByUnknownFacet: false,
      matchedByRawStatusFacet: true,
    },
    {
      // A terminal status short-circuits the Waiting projection, so an
      // awaiting-input timestamp left behind on a finished row cannot resurrect
      // it into the Waiting facet.
      name: "a terminal session displays Inactive even with an awaiting-input timestamp",
      rawStatus: SESSION_STATUS.INACTIVE,
      awaitingInput: true,
      ended: true,
      staleAnchor: false,
      displayedStatus: SESSION_STATUS.INACTIVE,
      matchedByActiveFacet: false,
      matchedByWaitingFacet: false,
      matchedByStaleFacet: false,
      matchedByUnknownFacet: false,
      matchedByRawStatusFacet: true,
    },
    {
      // ISS-4559 (second door): `waiting` is ALSO a legacy PERSISTED status, kept
      // for version-skew until the vocabulary migration runs. Such a row displays
      // Waiting because the projection returns the raw status when it does not
      // fire — but both facets used to miss it (WAITING demanded
      // `awaitingInputSince`, ACTIVE demands `status = active`), which is the same
      // invisible-row defect as the ended + awaiting case.
      name: "a row persisted with the legacy `waiting` status is returned by the Waiting facet",
      rawStatus: DISPLAYED_SESSION_STATUS.WAITING,
      awaitingInput: false,
      ended: false,
      staleAnchor: false,
      displayedStatus: DISPLAYED_SESSION_STATUS.WAITING,
      matchedByActiveFacet: false,
      matchedByWaitingFacet: true,
      matchedByStaleFacet: false,
      matchedByUnknownFacet: false,
      matchedByRawStatusFacet: true,
    },
    {
      // ISS-5366 baseline: a live-looking row silent past the cutoff BADGES as
      // Stale, so the Active facet must let it go and the Stale facet must take
      // it. No awaiting-input timestamp is involved, so this case held before the
      // ISS-4556 fix and pins the Active/Stale split itself.
      name: "a long-silent running session displays and filters as Stale",
      rawStatus: SESSION_STATUS.ACTIVE,
      awaitingInput: false,
      ended: false,
      staleAnchor: true,
      displayedStatus: DISPLAYED_SESSION_STATUS.STALE,
      matchedByActiveFacet: false,
      matchedByWaitingFacet: false,
      matchedByStaleFacet: true,
      matchedByUnknownFacet: false,
      matchedByRawStatusFacet: false,
    },
    {
      // ISS-4556 — the ACTIVE/STALE invisible row, and the counterfactual this
      // dimension exists for. The Waiting projection needs `!ended`, so this row
      // falls through to the staleness fold and BADGES as Stale. With ACTIVE
      // subtracting "displays as Waiting" but STALE still subtracting the wider
      // "awaiting input", it was dropped from Active by the stale anchor and from
      // Stale by the awaiting test: returned by NO facet, exactly the defect
      // ISS-4559 closed one dimension over. All three implementations were wrong
      // here, and the oracle could not see it while every row was pinned fresh.
      name: "an ended, awaiting-input, long-silent session displays Stale and is returned by the Stale facet",
      rawStatus: SESSION_STATUS.ACTIVE,
      awaitingInput: true,
      ended: true,
      staleAnchor: true,
      displayedStatus: DISPLAYED_SESSION_STATUS.STALE,
      matchedByActiveFacet: false,
      matchedByWaitingFacet: false,
      matchedByStaleFacet: true,
      matchedByUnknownFacet: false,
      matchedByRawStatusFacet: false,
    },
    {
      // `waiting` is deliberately EXEMPT from the staleness fold
      // (`resolveDisplayedSessionStatus`): a run that asked for approval three
      // days ago genuinely IS still awaiting input, and folding it to Stale would
      // destroy the most actionable signal on the surface. So the Stale facet
      // must NOT claim this row even though its anchor is old.
      name: "a long-silent awaiting-input session still displays Waiting, not Stale",
      rawStatus: SESSION_STATUS.ACTIVE,
      awaitingInput: true,
      ended: false,
      staleAnchor: true,
      displayedStatus: DISPLAYED_SESSION_STATUS.WAITING,
      matchedByActiveFacet: false,
      matchedByWaitingFacet: true,
      matchedByStaleFacet: false,
      matchedByUnknownFacet: false,
      matchedByRawStatusFacet: false,
    },
    {
      // ISS-4997 baseline: a status this reader does not recognize displays
      // Unknown and is reached by the Unknown facet's NOT IN predicate.
      name: "an unrecognized status displays and filters as Unknown",
      rawStatus: UNRECOGNIZED_SESSION_STATUS,
      awaitingInput: false,
      ended: false,
      staleAnchor: false,
      displayedStatus: DISPLAYED_SESSION_STATUS.UNKNOWN,
      matchedByActiveFacet: false,
      matchedByWaitingFacet: false,
      matchedByStaleFacet: false,
      matchedByUnknownFacet: true,
      matchedByRawStatusFacet: true,
    },
    {
      // ISS-4556 — the UNKNOWN double-count counterfactual. The awaiting-input
      // projection runs AHEAD of the unrecognized fold, so this row DISPLAYS as
      // Waiting. Before the fix the Unknown facet matched purely on "status not
      // in the recognized list" and returned it too: one row under two facets,
      // one of which contradicts its own badge, in exactly the version-skew case
      // Unknown exists to serve.
      name: "an unrecognized status that is awaiting input displays Waiting and is NOT double-counted under Unknown",
      rawStatus: UNRECOGNIZED_SESSION_STATUS,
      awaitingInput: true,
      ended: false,
      staleAnchor: false,
      displayedStatus: DISPLAYED_SESSION_STATUS.WAITING,
      matchedByActiveFacet: false,
      matchedByWaitingFacet: true,
      matchedByStaleFacet: false,
      matchedByUnknownFacet: false,
      matchedByRawStatusFacet: false,
    },
    /*
     * ISS-4556's two RETIRED-spelling cases were DELETED, not relocated. They
     * pinned that a row STORING `completed`/`abandoned` is reached by a filter
     * for that spelling and is excluded from Waiting.
     *
     * That contract is retired (Chris, 2026-08-14): the ingest fold makes the
     * spelling unwritable and a production count returned 0 rows storing either,
     * so they pinned a population that cannot exist. The REQUEST side went with
     * it — `?status=completed` no longer routes onto the Inactive predicate and
     * now matches nothing, which is the honest answer for a spelling with no rows.
     *
     * What they ALSO pinned, and what the case below preserves: a terminal row
     * carrying an inert `awaitingInputSince` must not surface as Waiting. Their
     * fixture was the only one where the terminal test — not `sessionEndedAt` —
     * was the deciding condition, so without a replacement the desktop half of
     * that guard had no oracle at all.
     */
    {
      // ISS-5656 — the THIRD door onto the same defect: the one arm of the STALE
      // predicate that ISS-4556/ISS-4559 left ungated on all three
      // implementations.
      //
      // `stale` is a DISPLAY-ONLY derivation: no producer writes it and nothing
      // persists it (see the note on `DISPLAYED_SESSION_STATUS.STALE`). It is reachable
      // here for the SAME reason the retired spellings above are — `status` is a
      // free-form column at a trust boundary, so a version-skewed producer can
      // put the word in it — which is why all three predicates already carry an
      // explicit arm for the literal value: "a producer that literally persists
      // `stale` (none does today) keeps the plain equality the fallback branch
      // used to give it".
      //
      // That arm was UNCONDITIONAL. The Waiting projection fires first and does
      // not care what the raw status spells (`stale` folds to `active`, which is
      // non-terminal), so this row BADGES "Waiting" and the Waiting facet
      // returns it — while the Stale facet returned it too, under a name that
      // contradicts its own badge. That is the double-count the unrecognized-
      // status case above pins one status over, through a different door. The
      // raw-status fallback already subtracts `displaysAsWaiting`; the
      // literal-`stale` arm is the one place that subtraction was missing.
      //
      // `staleAnchor` is deliberately FRESH. The OTHER arm of every STALE
      // predicate demands a stored `active`, so the anchor cannot reach this row
      // by either route — pinning it fresh states that the match under test
      // comes from the literal-value arm alone.
      name: "a `stale` row awaiting input displays Waiting and is NOT double-counted under Stale",
      rawStatus: DISPLAYED_SESSION_STATUS.STALE,
      awaitingInput: true,
      ended: false,
      staleAnchor: false,
      displayedStatus: DISPLAYED_SESSION_STATUS.WAITING,
      matchedByActiveFacet: false,
      matchedByWaitingFacet: true,
      matchedByStaleFacet: false,
      matchedByUnknownFacet: false,
      // Routes to the STALE branch — the row's own stored status IS `stale` — so
      // this necessarily restates `matchedByStaleFacet` rather than reaching the
      // raw-status fallback, exactly as the persisted-`waiting` case above
      // restates `matchedByWaitingFacet`.
      matchedByRawStatusFacet: false,
    },
  ];
