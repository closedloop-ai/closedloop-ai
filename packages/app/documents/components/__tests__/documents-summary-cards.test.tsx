import type { DocumentListSummary } from "@repo/api/src/types/document-list-summary";
import { KPI_NO_VALUE } from "@repo/app/shared/lib/format-utils";
import { LIST_SUMMARY_LOADING_DETAIL } from "@repo/app/shared/lib/list-summary-loading-detail";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  DOCUMENTS_SUMMARY_CARD_LABELS,
  DOCUMENTS_SUMMARY_ON_SCREEN_DETAIL,
  DOCUMENTS_SUMMARY_PROVENANCE_ABSENT_DETAIL,
  DOCUMENTS_SUMMARY_UNAVAILABLE_DETAILS,
  DocumentsSummaryCardId,
  DocumentsSummaryUnavailableReason,
} from "../../lib/documents-summary-cards";
import {
  DOCUMENTS_SUMMARY_REGION_LABEL,
  DocumentsSummaryCards,
} from "../documents-summary-cards";

/**
 * ISS-8936 AC2/AC6 — loading, unavailable and true-zero must be visually AND
 * logically distinct, and the proof that matters is the pair of cases at the
 * bottom: the LOADING band and the EMPTY-ORG band must not render the same thing.
 * A card showing `0` before the read settles is the exact defect the honest-loading
 * gate exists for, and it is the one a test that only checked "renders a number"
 * would wave through.
 */
const SUMMARY: DocumentListSummary = {
  total: 1234,
  producedByAgentSessions: 817,
  updatedInWindow: 46,
  neverEdited: 213,
  windowDays: 7,
};

const ZERO_SUMMARY: DocumentListSummary = {
  total: 0,
  producedByAgentSessions: 0,
  updatedInWindow: 0,
  neverEdited: 0,
  windowDays: 7,
};

function renderBand(
  props: Partial<Parameters<typeof DocumentsSummaryCards>[0]> = {}
) {
  return render(
    <DocumentsSummaryCards
      isLoading={false}
      rowFallback={undefined}
      summary={SUMMARY}
      unavailableReason={undefined}
      {...props}
    />
  );
}

describe("DocumentsSummaryCards", () => {
  it("names the band as one region so four numbers are not four orphans", () => {
    renderBand();

    expect(
      screen.getByRole("region", {
        // Anchored, not a bare string: `ByRole`'s `name` is a TextMatch, and an
        // unanchored one would pass against any region whose label merely
        // CONTAINS this phrase — the substring collision the Sessions v2 rollout
        // paid for. `exact` is a `ByText` option and is not accepted here.
        name: exactName(DOCUMENTS_SUMMARY_REGION_LABEL),
      })
    ).toBeTruthy();
  });

  it("renders every count under its own label when settled", () => {
    renderBand();

    // `exact: true`: a substring match would let "Documents" collide with
    // "Produced by sessions" if either label were reworded, which is the
    // Sessions-v2 lesson about `getByRole({ name })` defaulting to substring.
    for (const label of Object.values(DOCUMENTS_SUMMARY_CARD_LABELS)) {
      expect(screen.getByText(label, { exact: true })).toBeTruthy();
    }
    expect(screen.getByText("1,234", { exact: true })).toBeTruthy();
    expect(screen.getByText("817", { exact: true })).toBeTruthy();
    expect(screen.getByText("46", { exact: true })).toBeTruthy();
    expect(screen.getByText("213", { exact: true })).toBeTruthy();
  });

  it("states a measured zero as a real zero", () => {
    renderBand({ summary: ZERO_SUMMARY });

    expect(screen.getAllByText("0", { exact: true })).toHaveLength(4);
    expect(screen.queryByText(KPI_NO_VALUE)).toBeNull();
    expect(screen.queryByText(LIST_SUMMARY_LOADING_DETAIL)).toBeNull();
  });

  it("states NO number while loading, and says the row is loading", () => {
    renderBand({ isLoading: true, summary: undefined });

    // The distinction AC2 turns on: a loading band must not be able to be read
    // as an empty one. Every label is present (it is known before the read); no
    // digit is.
    for (const label of Object.values(DOCUMENTS_SUMMARY_CARD_LABELS)) {
      expect(screen.getByText(label, { exact: true })).toBeTruthy();
    }
    expect(screen.queryByText("0", { exact: true })).toBeNull();
    expect(screen.queryByText(KPI_NO_VALUE)).toBeNull();
    expect(
      screen.getAllByText(LIST_SUMMARY_LOADING_DETAIL).length
    ).toBeGreaterThan(0);
  });

  it("keeps a previous payload out of the band while a new scope loads", () => {
    // `keepPreviousData` leaves a settled summary in hand for a population the
    // reader has already left. Loading must win, or the band states the previous
    // search's counts as the current one's.
    renderBand({ isLoading: true, summary: SUMMARY });

    expect(screen.queryByText("1,234", { exact: true })).toBeNull();
    expect(
      screen.getAllByText(LIST_SUMMARY_LOADING_DETAIL).length
    ).toBeGreaterThan(0);
  });

  it("withdraws the numbers but keeps every card when the read failed", () => {
    renderBand({
      summary: undefined,
      unavailableReason: DocumentsSummaryUnavailableReason.ReadFailed,
    });

    for (const label of Object.values(DOCUMENTS_SUMMARY_CARD_LABELS)) {
      expect(screen.getByText(label, { exact: true })).toBeTruthy();
    }
    expect(screen.getAllByText(KPI_NO_VALUE)).toHaveLength(4);
    expect(screen.queryByText("0", { exact: true })).toBeNull();
    expect(
      screen.getAllByText(
        DOCUMENTS_SUMMARY_UNAVAILABLE_DETAILS[
          DocumentsSummaryUnavailableReason.ReadFailed
        ]
      )
    ).toHaveLength(4);
  });

  it("counts what it can from the rows shown when the server refuses the term", () => {
    // AGENTS.md → "Never Delete a Capability You Cannot Compute": for a term the
    // endpoint rejects, three of the four operands are on the rows the list is
    // already showing, so withholding those three would be the defect. Only the
    // provenance count has no operand in the browser, and it says so.
    renderBand({
      isLoading: true,
      rowFallback: {
        filterText: "runbook",
        now: new Date("2026-09-20T12:00:00.000Z"),
        rows: [
          {
            title: "Runbook: deploys",
            slug: "DOC-1",
            latestVersion: 3,
            updatedAt: "2026-09-19T00:00:00.000Z",
          },
          {
            title: "Runbook: oncall",
            slug: "DOC-2",
            latestVersion: 1,
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
          {
            title: "Unrelated charter",
            slug: "DOC-3",
            latestVersion: 2,
            updatedAt: "2026-09-20T00:00:00.000Z",
          },
        ],
      },
      summary: undefined,
      unavailableReason: undefined,
    });

    // Two of three rows match "runbook"; of those, one is inside the 7-day window
    // and one is on its creation version. Literals, not re-derived arithmetic — and
    // a corpus where the non-matching row would change every answer if the filter
    // were dropped.
    expect(screen.getByText("2", { exact: true })).toBeTruthy();
    expect(screen.getAllByText("1", { exact: true })).toHaveLength(2);
    // The fallback is a SETTLED answer, so it outranks the pending state a disabled
    // query never leaves — otherwise the band shimmers forever.
    expect(screen.queryByText(LIST_SUMMARY_LOADING_DETAIL)).toBeNull();
    // Exactly one card withdrawn, and its caption names the missing operand.
    expect(screen.getAllByText(KPI_NO_VALUE)).toHaveLength(1);
    expect(
      screen.getByText(DOCUMENTS_SUMMARY_PROVENANCE_ABSENT_DETAIL)
    ).toBeTruthy();
    expect(screen.getByText(DOCUMENTS_SUMMARY_ON_SCREEN_DETAIL)).toBeTruthy();
  });

  it("offers each card's derivation on an accessibly-named trigger", () => {
    renderBand();

    // Icon-only control, so the accessible name is the whole affordance.
    expect(
      screen.getByRole("button", {
        name: exactName(
          `About ${DOCUMENTS_SUMMARY_CARD_LABELS[DocumentsSummaryCardId.ProducedBySessions]}`
        ),
      })
    ).toBeTruthy();
  });
});

/**
 * An accessible-name matcher that is the WHOLE name, not a substring of it.
 *
 * `ByRole`'s `name` takes a TextMatch and does not accept `exact`, so anchoring
 * is the only way to say so. The metacharacters are escaped because a label is
 * ordinary prose and a stray `.` or `(` would otherwise widen the very matcher
 * this exists to narrow.
 */
function exactName(name: string): RegExp {
  return new RegExp(`^${name.replace(ESCAPE_PATTERN, String.raw`\$&`)}$`);
}

const ESCAPE_PATTERN = /[.*+?^${}()|[\]\\]/g;
