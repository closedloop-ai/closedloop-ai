/**
 * ISS-4556 / ISS-4559: the SHARED oracle for the Sessions DISPLAYED-status
 * contract — one table of session shapes and, for each, the status the row must
 * display and which Status facets must return it.
 *
 * This exists because the contract is implemented TWICE and cannot be
 * implemented once: the cloud derives it in JS (`projectDisplayedSessionStatus`),
 * while the desktop Local lane derives it in the Electron main process
 * (`shared-agent-session-status.ts`), and this repo deliberately does not import
 * across the `apps/api` ↔ `apps/desktop` boundary. The cloud SQL half
 * (`buildStatusFacetPredicate`) was a third implementation until ISS-10629
 * retired the displayed-status FILTER on both surfaces.
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
 * ISS-4556: STALENESS is one of the dimensions ({@link
 * DisplayedStatusParityCase.staleAnchor}), and it is not optional. The two
 * predicates it used to hold apart are both gone — ISS-10629 retired the STALE
 * facet, ISS-10741 dropped ACTIVE's staleness subtraction — but the anchor still
 * decides the BADGE, so pinning every row to a fresh one (which this table used
 * to do, to "keep staleness out of the comparison") leaves the whole Stale half
 * of the DISPLAY contract unpinned. A case that cannot see the gap cannot guard
 * it.
 */

import { SESSION_STATUS, type SessionStatus } from "./types/session-status.ts";

/**
 * A status string no consumer RECOGNIZES — the version-skew case this table's
 * `"unknown"`-raw cases exist to serve. Deliberately typed `string` rather
 * than {@link SessionStatus}: the whole point is a value outside the union,
 * written by a producer newer than this reader, so it cannot be spelled as a
 * member of it. Shared here so all three consumers skew on the SAME value.
 *
 * ISS-10364 retired `DISPLAYED_SESSION_STATUS.WAITING`/`STALE`/`UNKNOWN` from
 * the vocabulary itself, so this table spells the legacy/version-skewed
 * `rawStatus` values they used to name as plain literals (`"waiting"`,
 * `"stale"`, `"unknown"`) rather than deriving them from a const this repo no
 * longer defines.
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
   * ISS-10364 narrowed this to {@link SessionStatus}. The operator ruled on
   * 2026-09-23 that `waiting`, `stale` and `unknown` are not display words, so
   * every case that used to expect one now expects ACTIVE — including the cases
   * whose row STORES one of those spellings, which fold like any other value
   * neither build recognizes. The `rawStatus` column keeps those spellings on
   * purpose: what a row stores and what it displays are different questions, and
   * this table is the only place that states both for one shape.
   */
  readonly displayedStatus: SessionStatus;
  /** Whether the ACTIVE facet MUST return the row. */
  readonly matchedByActiveFacet: boolean;
  /**
   * Whether the INACTIVE facet MUST return the row.
   *
   * Its own dimension rather than left to {@link matchedByRawStatusFacet},
   * which answers only the facet the row's OWN status names: without it, a row
   * wrongly gathered by a TERMINAL facet it does not store has no column that
   * can say so, and every consumer loop stays green (whitlockk, PR #6288:
   * "neither terminal facet does").
   *
   * For a row that STORES `inactive` this restates `matchedByRawStatusFacet`.
   */
  readonly matchedByInactiveFacet: boolean;
  /** The ERROR twin of {@link matchedByInactiveFacet}. */
  readonly matchedByErrorFacet: boolean;
  /**
   * Whether a filter for the row's OWN {@link rawStatus} string MUST return it.
   *
   * ISS-4556: the facet fields above name only some of the branches a status
   * filter can take, so the invariant this table encodes was UNVERIFIED for every
   * case displaying `inactive` or a retired spelling. Case 5 proves the blindness:
   * it displays Inactive and the only assertions made about it were that four
   * OTHER facets return false, so deleting the INACTIVE branch outright, or
   * applying an unconditional waiting-exclusion to the raw-status fallback, left
   * all three suites green with the row invisible to every facet.
   *
   * Stated as "the facet named by the row's own stored status" rather than as one
   * field per remaining facet because that is what closes the gap without
   * inventing a cross-surface disagreement: it routes to the INACTIVE branch for
   * an `inactive` row and to the raw-status fallback for everything else — the
   * WAITING branch a persisted `waiting` row used to take went with ISS-10629 —
   * and every implementation still asserting FILTER agrees on all of those. (The cloud INACTIVE facet's
   * ISS-4586 expansion to the retired spellings is deliberately NOT here: desktop
   * drops that expansion on purpose — its migration 0042 collapses the rows at
   * boot — so it is a documented per-surface difference and belongs in each
   * surface's own suite, not in a table whose whole value is that both sides must
   * answer identically.)
   */
  readonly matchedByRawStatusFacet: boolean;
};

/**
 * The invariant every case encodes: a row is returned by the facet named by its
 * STORED status, and by no other. ISS-10741 made the stored status the key where
 * the badge used to be. The rows still gathered by nothing are enumerated by
 * hand in the consumer's `UNGATHERABLE_CASE_NAMES`, and each of them badges
 * Waiting over a RETIRED stored spelling.
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
      matchedByInactiveFacet: false,
      matchedByErrorFacet: false,
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
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: true,
      matchedByInactiveFacet: false,
      matchedByErrorFacet: false,
      matchedByRawStatusFacet: true,
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
      matchedByInactiveFacet: true,
      matchedByErrorFacet: false,
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
      matchedByInactiveFacet: false,
      matchedByErrorFacet: false,
      matchedByRawStatusFacet: true,
    },
    {
      // The counterfactual for OVER-exclusion: a predicate that subtracts every
      // `sessionEndedAt IS NOT NULL` row from Active reddens here.
      name: "an ended session that was never awaiting input still displays Active",
      rawStatus: SESSION_STATUS.ACTIVE,
      awaitingInput: false,
      ended: true,
      staleAnchor: false,
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: true,
      matchedByInactiveFacet: false,
      matchedByErrorFacet: false,
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
      matchedByInactiveFacet: true,
      matchedByErrorFacet: false,
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
      rawStatus: "waiting",
      awaitingInput: false,
      ended: false,
      staleAnchor: false,
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: false,
      matchedByInactiveFacet: false,
      matchedByErrorFacet: false,
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
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: true,
      matchedByInactiveFacet: false,
      matchedByErrorFacet: false,
      matchedByRawStatusFacet: true,
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
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: true,
      matchedByInactiveFacet: false,
      matchedByErrorFacet: false,
      matchedByRawStatusFacet: true,
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
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: true,
      matchedByInactiveFacet: false,
      matchedByErrorFacet: false,
      matchedByRawStatusFacet: true,
    },
    {
      // ISS-4997 baseline: a status this reader does not recognize displays
      // Unknown and is reached by the Unknown facet's NOT IN predicate.
      name: "an unrecognized status displays and filters as Unknown",
      rawStatus: UNRECOGNIZED_SESSION_STATUS,
      awaitingInput: false,
      ended: false,
      staleAnchor: false,
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: false,
      matchedByInactiveFacet: false,
      matchedByErrorFacet: false,
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
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: false,
      matchedByInactiveFacet: false,
      matchedByErrorFacet: false,
      matchedByRawStatusFacet: false,
    },
    /*
     * ISS-4556's two RETIRED-spelling cases were DELETED, not relocated. They
     * pinned that a row STORING `completed`/`abandoned` is reached by a filter
     * for that spelling and is excluded from Waiting.
     *
     * That contract is retired (Cosimo, 2026-08-14): the ingest fold makes the
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
      rawStatus: "stale",
      awaitingInput: true,
      ended: false,
      staleAnchor: false,
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: false,
      matchedByInactiveFacet: false,
      matchedByErrorFacet: false,
      // A `stale` request reaches the raw-status fallback, whose
      // `displaysAsWaiting` subtraction answers `false`. ISS-10741 kept that
      // subtraction when ACTIVE lost its own, and this row pins it.
      matchedByRawStatusFacet: false,
    },
    {
      // ISS-7102 (tamsinb review): the row that STORES `stale` and DISPLAYS it.
      //
      // The awaiting case immediately above was the only stored-`stale` row in
      // the table, and every verdict it pins about the Stale facet is `false` —
      // it badges Waiting. So the literal-`stale` arm of all three STALE
      // predicates could be DELETED with the shared oracle sweep green on every
      // surface: measured 2026-08-28, removing it from `buildStatusFacetPredicate`,
      // the desktop `matchesStatusFilter` and its SQL twin left both desktop
      // suites fully green and reddened only the cloud's two gate-OFF tests —
      // the branches that go away when the rollout graduates. The stored-status
      // coverage check counted `stale` as covered on a case that cannot fail
      // when the arm covering it disappears.
      //
      // Non-awaiting and fresh-anchored, which is what makes it that arm's
      // oracle: the OTHER arm of every STALE predicate demands a stored `active`
      // past the cutoff, so neither the anchor nor the awaiting projection can
      // reach this row. The only thing that can return it from Stale is the
      // equality on the literal value.
      name: "a row persisted with the literal `stale` status displays Stale and is returned by the Stale facet",
      rawStatus: "stale",
      awaitingInput: false,
      ended: false,
      staleAnchor: false,
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: false,
      matchedByInactiveFacet: false,
      matchedByErrorFacet: false,
      // ISS-10629 retired the STALE arm this used to route to, so a `stale`
      // request now reaches the raw-status fallback and its equality on the
      // literal value answers `true`. That equality is all that keeps a stored
      // `stale` row gatherable at all, which is what this case pins.
      matchedByRawStatusFacet: true,
    },
    {
      // ISS-7102: `error` had NO case at all, so the SECOND member of the
      // terminal set was unexercised by the oracle while `inactive` carried it
      // alone. This is the base row it was missing.
      name: "a failed session displays and filters as Error",
      rawStatus: SESSION_STATUS.ERROR,
      awaitingInput: false,
      ended: true,
      staleAnchor: false,
      displayedStatus: SESSION_STATUS.ERROR,
      matchedByActiveFacet: false,
      matchedByInactiveFacet: false,
      matchedByErrorFacet: true,
      matchedByRawStatusFacet: true,
    },
    {
      // ISS-7102 — the `error` twin of the terminal + awaiting + NOT-ended case
      // above, and the reason both terminals need one.
      //
      // Every predicate on both surfaces asks whether a row is terminal through
      // a SET (`TERMINAL_SESSION_STATUSES` on cloud, `TERMINAL_SHARED_STATUSES`
      // on desktop and in its SQL twin), and until this case the oracle only
      // ever put `inactive` through it. Narrowing that set to `{inactive}` left
      // all three suites green while an errored run carrying an inert
      // `awaitingInputSince` moved into the Waiting facet, out of its own Error
      // facet, and badged "Waiting" — a run that FAILED advertising itself as
      // blocked on a human.
      //
      // `ended` is false for the same reason it is on the `inactive` twin: with
      // it true the `sessionEndedAt`/`endedAt` guard excludes the row on its
      // own, and the terminal test — the thing under test — could be deleted
      // outright without reddening anything.
      name: "a failed, not-yet-ended session carrying awaitingInputSince stays out of Waiting",
      rawStatus: SESSION_STATUS.ERROR,
      awaitingInput: true,
      ended: false,
      staleAnchor: false,
      displayedStatus: SESSION_STATUS.ERROR,
      matchedByActiveFacet: false,
      matchedByInactiveFacet: false,
      matchedByErrorFacet: true,
      matchedByRawStatusFacet: true,
    },
    {
      // ISS-7102: the row that STORES the literal `unknown`, which no case did.
      //
      // The gap is the same shape as the `error` one above but on the other
      // vocabulary: `error` was a displayed status with no case, this is a
      // STORED one. The version-skew cases persist
      // {@link UNRECOGNIZED_SESSION_STATUS} and reach the Unknown facet through
      // its "not in the recognized list" arm; the literal value reaches it
      // through the OTHER arm, and that arm had no oracle at all. Deleting it —
      // `canonicalStatus === DISPLAYED_SESSION_STATUS.UNKNOWN` in the desktop
      // `matchesUnknownFacet`, or the `!== DISPLAYED_SESSION_STATUS.UNKNOWN`
      // filter that builds each surface's excluded list — left every suite green
      // with this row badging "Unknown" and returned by no facet: ACTIVE and
      // STALE want a stored `active`, INACTIVE wants `inactive`, and a request
      // for `unknown` dispatches to the Unknown branch rather than the
      // raw-status fallback. The ISS-4559 invisible row, one status over.
      //
      // Reachable for exactly the reason the unrecognized cases are: `status` is
      // a free-form column at a trust boundary, so a version-skewed producer can
      // put the word in it — which is why all three predicates already carry the
      // arm that answers it.
      name: "a row persisted with the literal `unknown` status is returned by the Unknown facet",
      rawStatus: "unknown",
      awaitingInput: false,
      ended: false,
      staleAnchor: false,
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: false,
      matchedByInactiveFacet: false,
      matchedByErrorFacet: false,
      // ISS-10629 retired the UNKNOWN arm this used to route to, so an `unknown`
      // request now reaches the raw-status fallback and its equality on the
      // literal value answers `true`.
      matchedByRawStatusFacet: true,
    },
    {
      // ISS-7102 (codex P2): the awaiting twin of the literal-`unknown` case
      // above, and the sixth cloud gate-OFF divergence.
      //
      // `unknown` folds to `active` (non-terminal), so the Waiting projection
      // fires ahead of everything and this row BADGES "Waiting" — the same door
      // the unrecognized + awaiting case walks through one vocabulary over. The
      // difference is which arm of the Unknown predicate answers it:
      // `UNKNOWN_EXCLUDED_STATUS_VALUES` deliberately keeps the literal
      // `unknown` OUT of the excluded list, so the `NOT IN` matches this row on
      // its own, with no unrecognized spelling involved. Gate ON, the
      // waiting-subtraction removes it; gate OFF there is no subtraction and the
      // Waiting and Unknown facets both return it — enumerated in
      // `GATE_OFF_DIVERGENT_CASE_NAMES` rather than left to be discovered.
      //
      // The non-awaiting case above cannot stand in for this one: its verdicts
      // are identical in both gate states, so it says nothing about the
      // subtraction at all.
      name: "a row persisted with the literal `unknown` status while awaiting input displays Waiting and is NOT double-counted under Unknown",
      rawStatus: "unknown",
      awaitingInput: true,
      ended: false,
      staleAnchor: false,
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: false,
      matchedByInactiveFacet: false,
      matchedByErrorFacet: false,
      // As above: the raw-status fallback's `displaysAsWaiting` subtraction
      // answers `false`, and this row pins it.
      matchedByRawStatusFacet: false,
    },
    {
      name: "an ended, long-silent session with no activity after the end still displays Active",
      rawStatus: SESSION_STATUS.ACTIVE,
      awaitingInput: false,
      ended: true,
      staleAnchor: true,
      displayedStatus: SESSION_STATUS.ACTIVE,
      matchedByActiveFacet: true,
      matchedByInactiveFacet: false,
      matchedByErrorFacet: false,
      matchedByRawStatusFacet: true,
    },
  ];
