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

  // ISS-5592: the Status facet is a DISPLAY surface, so its vocabulary is
  // DISPLAYED_SESSION_STATUS — the lifecycle trio plus waiting/stale/unknown,
  // each of which the server projects and the badge renders. Pinning it to the
  // stored SESSION_STATUS set instead would forbid exactly the three values the
  // facet exists to gather.
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
    // completed/abandoned collapsed into Inactive — the facet no longer offers
    // them (the Inactive predicate still reaches those stored rows).
    expect(values).not.toContain("completed");
    expect(values).not.toContain("abandoned");
  });

  it("offers Waiting so awaiting-input sessions stay reachable through a status filter", () => {
    const waitingOption = SESSION_STATUS_FILTER_OPTIONS.find(
      (option) => option.value === DISPLAYED_SESSION_STATUS.WAITING
    );
    expect(waitingOption?.label).toBe("Waiting");
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

  it("offers Stale and Unknown so every value the Status column can badge is filterable (ISS-5366)", () => {
    // Retiring `sessions-honest-unknown-states` made the Stale and Unknown
    // badges unconditional. Without these options a user could see a Stale row
    // and have nothing to click to gather the rest — and Status = Active would
    // hand back a page whose badges read Stale. Both now have real server
    // predicates (`buildStatusFacetPredicate`), which is what the vocabulary's
    // "a member here is a promise the server can filter on" rule requires.
    const values = SESSION_STATUS_FILTER_OPTIONS.map((option) => option.value);
    expect(values).toContain(DISPLAYED_SESSION_STATUS.STALE);
    expect(values).toContain(DISPLAYED_SESSION_STATUS.UNKNOWN);
  });

  it("labels Stale and Unknown from the same map the row badge reads", () => {
    // A chip that said "Status: stale" beside a badge that said "Stale" would be
    // the same one-row-two-stories defect in miniature.
    const staleOption = SESSION_STATUS_FILTER_OPTIONS.find(
      (option) => option.value === DISPLAYED_SESSION_STATUS.STALE
    );
    const unknownOption = SESSION_STATUS_FILTER_OPTIONS.find(
      (option) => option.value === DISPLAYED_SESSION_STATUS.UNKNOWN
    );
    expect(staleOption?.label).toBe(
      SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.STALE]
    );
    expect(unknownOption?.label).toBe(
      SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.UNKNOWN]
    );
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
    // They survive only as inbound fold aliases — see the loops-api contract
    // test that pins that, which is what keeps a straggler classified.
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
