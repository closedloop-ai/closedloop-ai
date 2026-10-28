import { describe, expect, it } from "vitest";
import {
  DISPLAYED_STATUS_PARITY_CASES,
  type DisplayedStatusParityCase,
} from "./agent-session-displayed-status-parity.test-fixtures.ts";
import {
  isRecognizedSessionStatus,
  SESSION_STATUS,
  type SessionStatus,
} from "./types/session-status.ts";

/**
 * ISS-7102: the guard on the ORACLE itself.
 *
 * `DISPLAYED_STATUS_PARITY_CASES` is the one table three suites assert against —
 * the cloud DISPLAY projection, the desktop hydrated matcher, and the desktop
 * SQL twin. (It was the cloud FILTER predicate until ISS-10629 deleted it;
 * FILTER parity is now a desktop-only pair.) That is what makes a divergence
 * between two ADAPTERS redden whichever one moved. It is also the failure mode nothing was watching: a wrong row in
 * the table, or a displayed status with no row at all, is a claim all three
 * suites will happily agree with, and they go green together on it. `error` had
 * no row until this ticket, so the second member of the terminal set was
 * unexercised on every surface at once.
 *
 * These assertions therefore do NOT re-derive what the implementations compute.
 * They state the table's own documented invariant back to it — "a row is
 * returned by the facet named by its STORED status, and by no other" (ISS-10741
 * moved that key off the badge) — and pin that the table spans the whole
 * displayed vocabulary.
 */
describe("DISPLAYED_STATUS_PARITY_CASES (ISS-7102)", () => {
  it("carries at least one case for every status a Sessions row can DISPLAY", () => {
    // Typed as a total Record, so a member added to the displayed vocabulary
    // fails `tsc` here rather than silently shipping with no cross-surface
    // case — the AGENTS.md exhaustive-map rule for a widened union. The literal
    // VALUES of that vocabulary are pinned in `types/session-status.test.ts`,
    // which is their dedicated home; this asserts coverage of it, not its
    // contents.
    // ISS-10364 narrowed this Record from the displayed vocabulary to
    // {@link SESSION_STATUS}: the operator ruled on 2026-09-23 that a render
    // speaks the lifecycle set, so those three ARE every status a row can
    // display. `DISPLAYED_SESSION_STATUS` still exists in this step of the
    // stack, which is exactly why the narrowing has to be written rather than
    // inferred.
    const casesByDisplayedStatus: Record<
      SessionStatus,
      DisplayedStatusParityCase[]
    > = {
      [SESSION_STATUS.ACTIVE]: [],
      [SESSION_STATUS.INACTIVE]: [],
      [SESSION_STATUS.ERROR]: [],
    };

    for (const parityCase of DISPLAYED_STATUS_PARITY_CASES) {
      casesByDisplayedStatus[parityCase.displayedStatus].push(parityCase);
    }

    const uncovered = Object.entries(casesByDisplayedStatus)
      .filter(([, cases]) => cases.length === 0)
      .map(([displayedStatus]) => displayedStatus);
    expect(uncovered).toEqual([]);
  });

  it("carries a case that STORES and DISPLAYS each status a Sessions row can store", () => {
    // The DISPLAYED-side check above is not this one, and keying only on the
    // displayed status is how `unknown` came to have no stored case: the two
    // version-skew rows persist an UNRECOGNIZED spelling and already fill the
    // `unknown` DISPLAY bucket, so the check read as complete while the arm that
    // answers the literal value — a different branch of every predicate — had no
    // oracle. `error` was caught by the displayed-side check only because it
    // happens to be both a stored and a displayed word.
    //
    // The SELF-NAMED requirement (`rawStatus === displayedStatus`) is what makes
    // this check able to fail, and it was added because the weaker "some case
    // stores this value" form could not (tamsinb review). `stale` satisfied
    // that form on a row that stores `stale` and displays Waiting — every
    // verdict it pins about the Stale facet is `false` — so the literal-`stale`
    // arm of all three STALE predicates was deletable with this file green.
    // Measured 2026-08-28: deleting it left both desktop suites fully green and
    // reddened only the cloud's two gate-OFF tests, the branches that go away
    // when the rollout graduates.
    //
    // A self-named case is the one shape that cannot be vacuous. It routes to
    // the branch that answers its own literal value, and the per-case
    // assertions below then pin that branch to `true`.
    //
    // ISS-10364 narrowed this Record to {@link SESSION_STATUS}, and the reason is
    // the test's own name: a row can only STORE those three, and since the
    // operator's 2026-09-23 ruling it can only DISPLAY them either. A row that
    // stores `waiting`, `stale` or `unknown` now displays `active`, so no
    // self-named case for those spellings can exist — demanding one would be
    // demanding the fold not happen. The version-skew population is still
    // counted separately below, which is what keeps this from narrowing into
    // vacuity.
    const storableStatuses: Record<SessionStatus, true> = {
      [SESSION_STATUS.ACTIVE]: true,
      [SESSION_STATUS.INACTIVE]: true,
      [SESSION_STATUS.ERROR]: true,
    };

    const uncovered = Object.keys(storableStatuses).filter(
      (storedStatus) =>
        !DISPLAYED_STATUS_PARITY_CASES.some(
          (parityCase) =>
            parityCase.rawStatus === storedStatus &&
            parityCase.displayedStatus === storedStatus
        )
    );
    expect(uncovered).toEqual([]);

    // The version-skew population the Unknown facet exists to serve is a stored
    // shape too, and it is the one the literal `unknown` case is NOT — it takes
    // the other arm of every Unknown predicate.
    const unrecognized = DISPLAYED_STATUS_PARITY_CASES.filter(
      (parityCase) => !isRecognizedSessionStatus(parityCase.rawStatus)
    );
    expect(unrecognized.length).toBeGreaterThan(0);
  });

  for (const parityCase of DISPLAYED_STATUS_PARITY_CASES) {
    it(`claims the row for exactly the facet its stored status names: ${parityCase.name}`, () => {
      // ISS-10741: EXPECTATION CHANGED. The invariant used to be "claimed by
      // exactly the facet its DISPLAYED status names", over six facets. Three of
      // those are retired, and for the three that remain the badge is no longer
      // the key: a row badging Waiting or Stale over a stored `active` is
      // gathered by Active (ISS-9939). So Active keys on the STORED status.
      //
      // ISS-11239 (owner ruling, 2026-09-26): the two terminal facets key on
      // the stored status too, on both hosts. The badge plays no part.
      expect({
        matchedByActiveFacet: parityCase.matchedByActiveFacet,
        matchedByInactiveFacet: parityCase.matchedByInactiveFacet,
        matchedByErrorFacet: parityCase.matchedByErrorFacet,
      }).toEqual({
        matchedByActiveFacet: parityCase.rawStatus === SESSION_STATUS.ACTIVE,
        matchedByInactiveFacet:
          parityCase.rawStatus === SESSION_STATUS.INACTIVE,
        matchedByErrorFacet: parityCase.rawStatus === SESSION_STATUS.ERROR,
      });
    });

    it(`is reachable by a facet exactly when one still exists for it: ${parityCase.name}`, () => {
      // ISS-9939 / ISS-10629: EXPECTATION CHANGED, and the change is the point.
      //
      // This used to assert "reachable by at least one facet", ORing all seven
      // dimensions. Three of those — Waiting, Stale and Unknown — are no longer
      // asserted against ANY implementation on either surface (cloud retired its
      // sweeps in #7603, desktop's in ISS-10629's follow-through), so for a row
      // displaying one of those words the old assertion passed on the strength
      // of a column nothing checks. That is a test staying green under exactly
      // the mutation it existed to catch, which is worse than no test.
      //
      // So it is narrowed to the four dimensions an implementation still
      // asserts. The first narrowing then reached for `displayedStatusIsStillAFacet
      // || matchedByRawStatusFacet` as the expected side, which put
      // `matchedByRawStatusFacet` on BOTH sides of the `toBe`: for the 11 of 22
      // rows where it is true the assertion could not fail in either direction
      // — the same false-green one narrowing up (marisolashgrove, #7663).
      //
      // The expected side is therefore {@link UNGATHERABLE_CASE_NAMES}, written
      // by hand. An expectation derived from the columns it polices cannot
      // police them; a literal list is an independent statement about the table,
      // so flipping any gatherability column reddens this.
      //
      // ISS-10741 closed the divergence this used to record: a row badging
      // Waiting or Stale over a stored `active` is gathered by Active on both
      // surfaces now, so the list below holds only rows badging Waiting over a
      // RETIRED stored spelling.
      expect(
        parityCase.matchedByActiveFacet ||
          parityCase.matchedByInactiveFacet ||
          parityCase.matchedByErrorFacet ||
          parityCase.matchedByRawStatusFacet
      ).toBe(!UNGATHERABLE_CASE_NAMES.has(parityCase.name));
    });
  }

  it("answers the facet named by a stored status identically in both columns", () => {
    // `matchedByRawStatusFacet` asks the facet a row's OWN status names. When
    // that status is one of the three, it is the SAME question as the column
    // beside it, so the consumer loops assert one facet against two expected
    // values and a disagreement is unfailable — it reddens as whichever pair
    // the loop reaches first. ISS-10741 shipped exactly that: five rows flipped
    // to Active kept `matchedByRawStatusFacet: false`.
    // A total Record, so a member added to the lifecycle set fails `tsc` here
    // rather than silently leaving its facet unpaired.
    const facetColumn: Record<
      SessionStatus,
      "matchedByActiveFacet" | "matchedByInactiveFacet" | "matchedByErrorFacet"
    > = {
      [SESSION_STATUS.ACTIVE]: "matchedByActiveFacet",
      [SESSION_STATUS.INACTIVE]: "matchedByInactiveFacet",
      [SESSION_STATUS.ERROR]: "matchedByErrorFacet",
    };

    expect(
      DISPLAYED_STATUS_PARITY_CASES.filter((parityCase) => {
        const column = facetColumn[parityCase.rawStatus as SessionStatus];
        return (
          column !== undefined &&
          parityCase[column] !== parityCase.matchedByRawStatusFacet
        );
      }).map((parityCase) => parityCase.name)
    ).toEqual([]);
  });

  it("spends every name in the ungatherable list on a case that exists", () => {
    // A renamed or deleted case would otherwise leave a dead entry here, and a
    // dead entry silently re-admits the row it used to except.
    const tableNames = new Set(
      DISPLAYED_STATUS_PARITY_CASES.map((parityCase) => parityCase.name)
    );
    expect(
      [...UNGATHERABLE_CASE_NAMES].filter((name) => !tableNames.has(name))
    ).toEqual([]);
  });

  it("returns a row whose stored status IS its displayed status from that status's own filter", () => {
    // The rows where the raw-status facet and the displayed-status facet are the
    // same filter value. Nothing may be excluded from its own spelling, which is
    // the guard on applying a waiting-subtraction to a terminal row.
    const selfNamed = DISPLAYED_STATUS_PARITY_CASES.filter(
      (parityCase) => parityCase.rawStatus === parityCase.displayedStatus
    );

    expect(selfNamed.length).toBeGreaterThan(0);
    expect(
      selfNamed
        .filter((parityCase) => !parityCase.matchedByRawStatusFacet)
        .map((parityCase) => parityCase.name)
    ).toEqual([]);
  });
});

/**
 * The oracle rows no surviving Status facet gathers.
 *
 * Written out rather than computed: an expectation derived from the verdict
 * columns it polices cannot police them.
 *
 * ISS-10741 removed the five rows that stored `active` — those are gathered by
 * Active now. What remains badges Waiting over a RETIRED stored spelling, which
 * the raw-status fallback's `displaysAsWaiting` subtraction still drops. That
 * subtraction was deliberately kept, so these three are the rows that pin it.
 */
const UNGATHERABLE_CASE_NAMES: ReadonlySet<string> = new Set([
  "an unrecognized status that is awaiting input displays Waiting and is NOT double-counted under Unknown",
  "a `stale` row awaiting input displays Waiting and is NOT double-counted under Stale",
  "a row persisted with the literal `unknown` status while awaiting input displays Waiting and is NOT double-counted under Unknown",
]);
