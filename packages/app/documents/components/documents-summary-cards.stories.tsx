import type { DocumentListSummary } from "@repo/api/src/types/document-list-summary";
import type { Meta, StoryObj } from "@storybook/react";
import { DocumentsSummaryUnavailableReason } from "../lib/documents-summary-cards";
import { DocumentsSummaryCards } from "./documents-summary-cards";

/**
 * ISS-8936 — the three states side by side, because the whole acceptance
 * criterion is that no two of them look alike: a shimmering value slot, a muted
 * "No data" under a reason, and a real number (including a real zero).
 */
const SUMMARY: DocumentListSummary = {
  total: 1234,
  producedByAgentSessions: 817,
  updatedInWindow: 46,
  neverEdited: 213,
  windowDays: 7,
};

const meta = {
  title: "Composites v1.0/Documents/Documents Summary Cards",
  tags: ["deprecated"],
  component: DocumentsSummaryCards,
  parameters: { layout: "padded" },
  args: {
    isLoading: false,
    rowFallback: undefined,
    summary: SUMMARY,
    unavailableReason: undefined,
  },
} satisfies Meta<typeof DocumentsSummaryCards>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Settled: Story = {};

/** An organization with no documents yet: four real zeros, not four blanks. */
export const TrueZero: Story = {
  args: {
    summary: {
      total: 0,
      producedByAgentSessions: 0,
      updatedInWindow: 0,
      neverEdited: 0,
      windowDays: 7,
    },
  },
};

export const Loading: Story = {
  args: { isLoading: true, summary: undefined },
};

export const ReadFailed: Story = {
  args: {
    summary: undefined,
    unavailableReason: DocumentsSummaryUnavailableReason.ReadFailed,
  },
};

/**
 * The one term the server refuses (over 200 characters). Three figures are counted
 * from the rows the list is showing; the fourth names the operand the browser has
 * no access to rather than being blanked with the rest.
 */
export const CountedFromRowsShown: Story = {
  args: {
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
  },
};
