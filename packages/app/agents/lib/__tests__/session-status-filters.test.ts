import { SESSION_STATUS_FILTER_VALUES } from "@repo/api/src/agent-session-filters";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { describe, expect, it } from "vitest";
import {
  isSessionStatusFacetValue,
  SESSION_STATUS_FILTER_OPTIONS,
  SessionStatusFacetValue,
} from "../session-status-filters";

describe("SESSION_STATUS_FILTER_OPTIONS", () => {
  it("binds the Failed label to the canonical ERROR value, never the 'failed' literal", () => {
    const failedOption = SESSION_STATUS_FILTER_OPTIONS.find(
      (option) => option.label === "Failed"
    );
    expect(failedOption?.value).toBe(SESSION_STATUS.ERROR);
  });

  // ISS-9939 / ISS-10629 narrowed the facet to the three PERSISTED
  // SESSION_STATUS values. ISS-10364 later shrank DISPLAYED_SESSION_STATUS to
  // the same three, so this assertion is now an equality, not a proper subset.
  it("only emits DISPLAYED_SESSION_STATUS values across every option", () => {
    const displayedValues = new Set<string>(
      Object.values(DISPLAYED_SESSION_STATUS)
    );
    for (const option of SESSION_STATUS_FILTER_OPTIONS) {
      expect(displayedValues.has(option.value)).toBe(true);
    }
  });

  it("offers the canonical Active/Inactive/Error filters and retires completed/abandoned (ISS-4586)", () => {
    const values = SESSION_STATUS_FILTER_OPTIONS.map((option) => option.value);
    expect(values).toEqual(
      expect.arrayContaining([
        SESSION_STATUS.ACTIVE,
        SESSION_STATUS.INACTIVE,
        SESSION_STATUS.ERROR,
      ])
    );
    // completed/abandoned are retired — the facet no longer offers them, and
    // since ISS-5592 the Inactive predicate no longer reaches them either.
    expect(values).not.toContain("completed");
    expect(values).not.toContain("abandoned");
  });

  // ISS-9939 / ISS-10629 (2026-09-17): Waiting, Stale, and Unknown were retired
  // from the FILTER facet first — they were derived DISPLAY-only projections,
  // not stored statuses, and the operator ruling collapsed FILTER (and SORT,
  // ISS-10262) to the three PERSISTED SESSION_STATUS values. ISS-10364 later
  // retired all three from DISPLAY too, so there is no longer a wider display
  // vocabulary this facet is narrower than.
  it("retires Waiting, Stale, and Unknown from the filter facet (ISS-9939 / ISS-10629)", () => {
    const values = SESSION_STATUS_FILTER_OPTIONS.map((option) => option.value);
    expect(values).not.toContain("waiting");
    expect(values).not.toContain("stale");
    expect(values).not.toContain("unknown");
    expect(values).toEqual([
      SESSION_STATUS.ACTIVE,
      SESSION_STATUS.INACTIVE,
      SESSION_STATUS.ERROR,
    ]);
  });

  it("stays a RUN-status vocabulary — no sync-lane value such as 'syncing' (ISS-4846)", () => {
    // The Status facet and the server-side Status sort share one vocabulary. The
    // sync-state fold deliberately does NOT add to it: sync state is an
    // independent lane (transcript-blob upload), derived per page after
    // pagination, so neither the facet predicate nor the sort ranking can honor
    // it. That is exactly why the fold renders ADDITIVELY and never rewrites a
    // row's `status` — see `session-status-fold.ts`. If a "syncing" facet is ever
    // added here it MUST come with a real server predicate and sort rank, and
    // this test is the tripwire that forces that conversation.
    const values = SESSION_STATUS_FILTER_OPTIONS.map((option) => option.value);
    expect(values).not.toContain("syncing");
  });

  it("never sends the stale 'failed' wire value that matched zero cloud rows", () => {
    expect(
      SESSION_STATUS_FILTER_OPTIONS.some((option) => option.value === "failed")
    ).toBe(false);
  });
});

describe("SessionStatusFacetValue (ISS-4696 — one vocabulary declaration)", () => {
  it("is the sole source of the option list, in declaration order", () => {
    // The options are DERIVED, so a value can never be facet-valid here and
    // missing from the menu (the drift ISS-4586 ↔ ISS-4605 produced).
    expect(SESSION_STATUS_FILTER_OPTIONS.map((option) => option.value)).toEqual(
      Object.values(SessionStatusFacetValue)
    );
  });

  it("labels every facet value from the shared badge label map", () => {
    // A chip reads its value label off the option list. Deriving both from
    // SESSION_STATUS_LABELS is what keeps `Status: Failed` on the chip and
    // `Failed` on the row badge from becoming two different words.
    for (const value of Object.values(SessionStatusFacetValue)) {
      const option = SESSION_STATUS_FILTER_OPTIONS.find(
        (candidate) => candidate.value === value
      );
      expect(option?.label).toBe(SESSION_STATUS_LABELS[value]);
    }
  });

  it("excludes the statuses ISS-4586 retired — now gone from the vocabulary too", () => {
    const facetValues: string[] = Object.values(SessionStatusFacetValue);
    expect(facetValues).not.toContain("completed");
    expect(facetValues).not.toContain("abandoned");
    // ISS-4654: they are no longer STORED values either. The facet already
    // excluded them; now the vocabulary does as well, so the distinction this
    // assertion used to draw (facet-excluded but still storable) is closed.
    // ISS-5592 then removed the inbound fold aliases they had survived as, so
    // neither spelling gets special handling any more: an inbound one is
    // observed as unmodelled INPUT and fail-opens to `active` before it is
    // persisted (`normalizeSessionStatus`), so it never survives as a STORED
    // value. The fold itself is pinned by `session-status.test.ts`; these two
    // assertions only pin its premise — that neither spelling is a member.
    expect(Object.values(SESSION_STATUS)).not.toContain("completed");
    expect(Object.values(SESSION_STATUS)).not.toContain("abandoned");
  });

  it("guards facet membership so a retired value can't resolve an option", () => {
    expect(isSessionStatusFacetValue(SessionStatusFacetValue.Inactive)).toBe(
      true
    );
    expect(isSessionStatusFacetValue("completed")).toBe(false);
    expect(isSessionStatusFacetValue("abandoned")).toBe(false);
    expect(isSessionStatusFacetValue("syncing")).toBe(false);
    // ISS-9939 / ISS-10629 retired Waiting/Stale/Unknown as facet values first;
    // ISS-10364 later retired all three from the display vocabulary too, so
    // these are plain literals now rather than `DISPLAYED_SESSION_STATUS`
    // members — still correctly refused either way.
    expect(isSessionStatusFacetValue("waiting")).toBe(false);
    expect(isSessionStatusFacetValue("stale")).toBe(false);
    expect(isSessionStatusFacetValue("unknown")).toBe(false);
  });

  it("every facet value resolves an option, so a chip never falls back to the raw wire string", () => {
    // The ISS-4696 defect in one assertion: a flow that drives a facet value
    // whose option is gone renders `Status: completed` instead of a label.
    for (const value of Object.values(SessionStatusFacetValue)) {
      const option = SESSION_STATUS_FILTER_OPTIONS.find(
        (candidate) => candidate.value === value
      );
      expect(option).toBeDefined();
      expect(option?.label).not.toBe(value);
    }
  });

  it("stays pinned to the shared filter-input SSOT so the facet and the MCP tool can't drift (ISS-4858)", () => {
    // ISS-4696 declares the Status facet vocabulary here (SessionStatusFacetValue);
    // ISS-4858 declares the same filter-input vocabulary in @repo/api
    // (SESSION_STATUS_FILTER_VALUES), consumed by the non-React list-agent-sessions
    // MCP tool. Nothing derives one from the other, so this guard is what makes
    // the two declarations un-driftable: they must list the identical values in
    // the identical order.
    expect(Object.values(SessionStatusFacetValue)).toEqual([
      ...SESSION_STATUS_FILTER_VALUES,
    ]);
  });
});
