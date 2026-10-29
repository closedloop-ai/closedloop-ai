// @vitest-environment jsdom

/**
 * ISS-12599 — the Documents Est. Total and Median cost cards keep loading,
 * failed, partial coverage, measured zero and all-unknown distinct. The API is
 * faked at the client, so the real cost hook parses each body through the wire
 * schema before the cards read it. The fixture's copy literals pin the approved
 * strings (Marisol Ashgrove, 2026-10-16) verbatim.
 */
import { artifactCostCoverageCaption } from "@repo/app/artifacts/components/artifact-cost-cards";
import {
  DOCUMENT_COST_CARD_CASES,
  DOCUMENT_COST_CARD_LABELS,
  DOCUMENT_COST_CARDS_SUMMARY,
  DOCUMENT_COSTS_FIXTURES,
  documentCostCard,
  hasCostCardSkeleton,
  mountDocumentCostCards,
  settledDocumentCostCard,
} from "@repo/app/artifacts/test-fixtures/artifact-cost-cards";
import {
  DOCUMENTS_SUMMARY_UNAVAILABLE_DETAILS,
  DocumentsSummaryUnavailableReason,
} from "@repo/app/documents/lib/documents-summary-cards";
import { KPI_NO_VALUE } from "@repo/app/shared/lib/format-utils";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => api,
}));

const LABELS = [
  DOCUMENT_COST_CARD_LABELS.total,
  DOCUMENT_COST_CARD_LABELS.median,
];
const READ_FAILED =
  DOCUMENTS_SUMMARY_UNAVAILABLE_DETAILS[
    DocumentsSummaryUnavailableReason.ReadFailed
  ];

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(DOCUMENT_COST_CARDS_SUMMARY);
});

describe("Documents cost cards", () => {
  it.each(DOCUMENT_COST_CARD_CASES)(
    "renders the $name state on both cards",
    async ({ body, total, caption, median, marker }) => {
      api.post.mockResolvedValue(body);
      mountDocumentCostCards();
      const totalCard = await settledDocumentCostCard(
        DOCUMENT_COST_CARD_LABELS.total
      );
      expect(within(totalCard).getByText(total)).toBeTruthy();
      if (body.coverage) {
        expect(
          within(totalCard).queryByText(
            artifactCostCoverageCaption(body.coverage)
          ) !== null
        ).toBe(caption !== undefined);
      }
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
      for (const card of [totalCard, medianCard]) {
        expect(within(card).queryByText(READ_FAILED)).toBeNull();
      }
    }
  );

  it("never renders an all-unknown population as $0.00", async () => {
    api.post.mockResolvedValue(DOCUMENT_COSTS_FIXTURES.allUnknown);
    mountDocumentCostCards();
    for (const label of LABELS) {
      const card = await settledDocumentCostCard(label);
      expect(within(card).getByText(KPI_NO_VALUE)).toBeTruthy();
      expect(within(card).queryByText("$0.00")).toBeNull();
    }
  });

  it("opens the measured-subset tooltip from the asterisk", async () => {
    api.post.mockResolvedValue(DOCUMENT_COSTS_FIXTURES.partial);
    mountDocumentCostCards();
    const tooltip = DOCUMENT_COST_CARD_CASES.find(
      (entry) => entry.marker
    )?.marker;
    if (!tooltip) {
      throw new Error("no measured-subset case");
    }
    const card = await settledDocumentCostCard(
      DOCUMENT_COST_CARD_LABELS.median
    );
    const marker = within(card).getByRole("button", { name: tooltip });
    await userEvent.hover(marker);
    expect(
      within(await screen.findByRole("tooltip")).getByText(tooltip)
    ).toBeTruthy();
  });

  it("skeletons the value while the cost read is in flight", async () => {
    api.post.mockReturnValue(new Promise(() => undefined));
    mountDocumentCostCards();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    for (const label of LABELS) {
      expect(hasCostCardSkeleton(label)).toBe(true);
      expect(
        within(documentCostCard(label)).queryByText(KPI_NO_VALUE)
      ).toBeNull();
    }
  });

  it("skeletons the value while the listing read is still loading", () => {
    mountDocumentCostCards({ readLoading: true });
    for (const label of LABELS) {
      expect(hasCostCardSkeleton(label)).toBe(true);
    }
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "the cost read fails",
      arrange: () => api.post.mockRejectedValue(new Error("boom")),
      props: {},
    },
    {
      name: "the listing read fails",
      arrange: () =>
        api.post.mockResolvedValue(DOCUMENT_COSTS_FIXTURES.complete),
      props: { readError: true },
    },
  ])("states the failed read when $name", async ({ arrange, props }) => {
    arrange();
    mountDocumentCostCards(props);
    for (const label of LABELS) {
      await waitFor(() =>
        expect(
          within(documentCostCard(label)).getByText(READ_FAILED)
        ).toBeTruthy()
      );
      expect(within(documentCostCard(label)).queryByText("$4.50")).toBeNull();
      expect(documentCostCard(label).className).toContain("opacity-50");
    }
  });

  it.each([
    { range: "30d", line: "Spend from sessions in the last 30 days" },
    { range: "all", line: "Spend for documents from all sessions" },
  ])(
    "states the $range cost-event window in each cost card's info text",
    async ({ range, line }) => {
      api.post.mockResolvedValue(DOCUMENT_COSTS_FIXTURES.complete);
      mountDocumentCostCards({}, range);
      for (const label of LABELS) {
        const trigger = screen.getByRole("button", { name: `About ${label}` });
        fireEvent.click(trigger);
        const dialog = await screen.findByRole("dialog", {
          name: `About ${label}`,
        });
        expect(within(dialog).getByText(new RegExp(` ${line}$`))).toBeTruthy();
        fireEvent.click(trigger);
      }
    }
  );
});
