/**
 * ISS-8936 — the card model: which number lands on which card, and what a card
 * says when there is no number.
 *
 * The corpus is deliberately four DISTINCT counts under a total none of them
 * equals, so a field swapped between two cards fails rather than passing on a
 * shared value, and every expected literal is written out rather than re-derived
 * from the summary the code just read.
 */
import type { DocumentListSummary } from "@repo/api/src/types/document-list-summary";
import { describe, expect, it } from "vitest";
import {
  buildDocumentsSummaryCards,
  buildDocumentsSummaryCardsFromRows,
  buildUnavailableDocumentsSummaryCards,
  DOCUMENTS_SUMMARY_CARD_IDS,
  DOCUMENTS_SUMMARY_ON_SCREEN_DETAIL,
  DOCUMENTS_SUMMARY_PROVENANCE_ABSENT_DETAIL,
  DOCUMENTS_SUMMARY_TOTAL_DETAIL,
  DocumentsSummaryCardId,
  documentsSummaryWindowDetail,
} from "../documents-summary-cards";

const SUMMARY: DocumentListSummary = {
  total: 1234,
  producedByAgentSessions: 817,
  updatedInWindow: 46,
  neverEdited: 213,
  windowDays: 7,
};

function cardById(
  cards: readonly { id: string; value: number | null; detail: string }[],
  id: string
) {
  const card = cards.find((entry) => entry.id === id);
  if (card === undefined) {
    throw new Error(`no card for ${id}`);
  }
  return card;
}

describe("buildDocumentsSummaryCards", () => {
  it("puts each count on its own card", () => {
    const cards = buildDocumentsSummaryCards(SUMMARY);

    expect(cardById(cards, DocumentsSummaryCardId.Total).value).toBe(1234);
    expect(
      cardById(cards, DocumentsSummaryCardId.ProducedBySessions).value
    ).toBe(817);
    expect(cardById(cards, DocumentsSummaryCardId.UpdatedInWindow).value).toBe(
      46
    );
    expect(cardById(cards, DocumentsSummaryCardId.NeverEdited).value).toBe(213);
  });

  it("paints every registered card, in strip order", () => {
    const cards = buildDocumentsSummaryCards(SUMMARY);

    expect(cards.map((card) => card.id)).toEqual([
      ...DOCUMENTS_SUMMARY_CARD_IDS,
    ]);
  });

  it("states the shared denominator under every sub-count", () => {
    const cards = buildDocumentsSummaryCards(SUMMARY);

    // The reconciliation AC1 asks for, rendered: a reader checks 817 against
    // "Of 1,234 in this view" without arithmetic across two screens.
    expect(
      cardById(cards, DocumentsSummaryCardId.ProducedBySessions).detail
    ).toBe("Of 1,234 in this view");
    expect(cardById(cards, DocumentsSummaryCardId.NeverEdited).detail).toBe(
      "Of 1,234 in this view"
    );
    expect(cardById(cards, DocumentsSummaryCardId.Total).detail).toBe(
      DOCUMENTS_SUMMARY_TOTAL_DETAIL
    );
  });

  it("names the window the SERVER measured, not a client-side constant", () => {
    const cards = buildDocumentsSummaryCards({ ...SUMMARY, windowDays: 30 });

    expect(cardById(cards, DocumentsSummaryCardId.UpdatedInWindow).detail).toBe(
      "In the last 30 days"
    );
  });

  it("renders a measured zero as a real zero, never as an absent value", () => {
    const cards = buildDocumentsSummaryCards({
      total: 0,
      producedByAgentSessions: 0,
      updatedInWindow: 0,
      neverEdited: 0,
      windowDays: 7,
    });

    // `null` is what the band reserves for "we do not know". An empty org knows
    // its answer, so every card must carry the number 0 — `MetricCard` renders a
    // nullish value as its muted no-data slot, so a `null` here would present a
    // measured fact as a failed read.
    for (const card of cards) {
      expect(card.value).toBe(0);
    }
    expect(cardById(cards, DocumentsSummaryCardId.NeverEdited).detail).toBe(
      "Of 0 in this view"
    );
  });
});

describe("buildUnavailableDocumentsSummaryCards", () => {
  it("keeps every card and withdraws only the numbers", () => {
    const cards = buildUnavailableDocumentsSummaryCards("nope");

    expect(cards.map((card) => card.id)).toEqual([
      ...DOCUMENTS_SUMMARY_CARD_IDS,
    ]);
    for (const card of cards) {
      expect(card.value).toBeNull();
      expect(card.label).not.toBe("");
      // The info popover survives too: the derivation is still true when the
      // number is missing, and it is what tells the reader what did not arrive.
      expect(card.info.how).not.toBe("");
    }
  });
});

describe("documentsSummaryWindowDetail", () => {
  it("says day, singular, at a one-day window", () => {
    expect(documentsSummaryWindowDetail(1)).toBe("In the last day");
  });
});

describe("buildDocumentsSummaryCardsFromRows", () => {
  const NOW = new Date("2026-09-20T12:00:00.000Z");
  const ROWS = [
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
      latestVersion: 1,
      updatedAt: "2026-09-20T00:00:00.000Z",
    },
  ];

  it("narrows by the term before counting, so it matches the rows on screen", () => {
    const cards = buildDocumentsSummaryCardsFromRows({
      filterText: "runbook",
      now: NOW,
      rows: ROWS,
    });

    // Two of three match. Every expected value is a written literal, and the
    // non-matching row differs on BOTH sub-counts, so dropping the filter would
    // change all three answers rather than none.
    expect(cardById(cards, DocumentsSummaryCardId.Total).value).toBe(2);
    expect(cardById(cards, DocumentsSummaryCardId.UpdatedInWindow).value).toBe(
      1
    );
    expect(cardById(cards, DocumentsSummaryCardId.NeverEdited).value).toBe(1);
    expect(cardById(cards, DocumentsSummaryCardId.Total).detail).toBe(
      DOCUMENTS_SUMMARY_ON_SCREEN_DETAIL
    );
  });

  it("names the one operand it cannot reach instead of blanking the row", () => {
    const cards = buildDocumentsSummaryCardsFromRows({
      filterText: "runbook",
      now: NOW,
      rows: ROWS,
    });

    const provenance = cardById(
      cards,
      DocumentsSummaryCardId.ProducedBySessions
    );
    expect(provenance.value).toBeNull();
    expect(provenance.detail).toBe(DOCUMENTS_SUMMARY_PROVENANCE_ABSENT_DETAIL);
    // Exactly one figure withheld — the other three are published beside it.
    expect(cards.filter((card) => card.value === null)).toHaveLength(1);
  });

  it("counts every row when the term matches everything", () => {
    const cards = buildDocumentsSummaryCardsFromRows({
      filterText: "",
      now: NOW,
      rows: ROWS,
    });

    expect(cardById(cards, DocumentsSummaryCardId.Total).value).toBe(3);
    expect(cardById(cards, DocumentsSummaryCardId.NeverEdited).value).toBe(2);
  });
});
