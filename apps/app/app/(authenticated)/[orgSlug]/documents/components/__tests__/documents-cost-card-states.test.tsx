import {
  DOCUMENT_COST_CARD_CASES,
  DOCUMENT_COST_CARD_LABELS,
  DOCUMENT_COST_CARDS_SUMMARY,
  documentCostCard,
  hasCostCardSkeleton,
  mountDocumentCostCards,
  settledDocumentCostCard,
} from "@repo/app/artifacts/test-fixtures/artifact-cost-cards";
import {
  DOCUMENTS_SUMMARY_UNAVAILABLE_DETAILS,
  DocumentsSummaryUnavailableReason,
} from "@repo/app/documents/lib/documents-summary-cards";
import { waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-12599 on the web shell: the shared Documents cost cards render every
 * coverage state from the same cloud response, with no per-shell calculation.
 * The client is faked so the real cost hook parses each body.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => api,
}));

const LABELS = [
  DOCUMENT_COST_CARD_LABELS.total,
  DOCUMENT_COST_CARD_LABELS.median,
];

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(DOCUMENT_COST_CARDS_SUMMARY);
});

describe("web Documents cost cards", () => {
  it.each(DOCUMENT_COST_CARD_CASES)(
    "renders the $name state",
    async ({ body, total, caption, median, marker }) => {
      api.post.mockResolvedValue(body);
      mountDocumentCostCards();
      const totalCard = await settledDocumentCostCard(
        DOCUMENT_COST_CARD_LABELS.total
      );
      expect(within(totalCard).getByText(total)).toBeTruthy();
      if (caption) {
        expect(within(totalCard).getByText(caption)).toBeTruthy();
      }
      const medianCard = await settledDocumentCostCard(
        DOCUMENT_COST_CARD_LABELS.median
      );
      expect(within(medianCard).getByText(median)).toBeTruthy();
      const markers = within(medianCard).queryAllByTestId(
        "measured-subset-marker"
      );
      expect(markers.map((element) => element.textContent)).toEqual(
        marker ? [`*${marker}`] : []
      );
    }
  );

  it("skeletons both cards while the cost read is in flight", async () => {
    api.post.mockReturnValue(new Promise(() => undefined));
    mountDocumentCostCards();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    for (const label of LABELS) {
      expect(hasCostCardSkeleton(label)).toBe(true);
    }
  });

  it("states a failed cost read on both cards", async () => {
    api.post.mockRejectedValue(new Error("boom"));
    mountDocumentCostCards();
    const failed =
      DOCUMENTS_SUMMARY_UNAVAILABLE_DETAILS[
        DocumentsSummaryUnavailableReason.ReadFailed
      ];
    for (const label of LABELS) {
      await waitFor(() =>
        expect(within(documentCostCard(label)).getByText(failed)).toBeTruthy()
      );
    }
  });
});
