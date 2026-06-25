import { DocumentStatus } from "@repo/api/src/types/document";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "./render-with-nav";

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

vi.mock("@repo/app/judges-analytics/hooks/use-judges", () => ({
  useFeatureJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  usePlanJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  usePrdJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
}));

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";

function renderRow(item: DocumentRowItem, editHandlers?: RowEditHandlers) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <DocumentRow
        editHandlers={editHandlers}
        item={item}
        visibleColumns={[]}
      />
    </QueryClientProvider>
  );
}

function tooltipTexts(): string[] {
  return screen
    .getAllByTestId("tooltip-content")
    .map((node) => node.textContent ?? "");
}

function hasTooltipText(text: string): boolean {
  return screen
    .getAllByTestId("tooltip-content")
    .some((node) => node.textContent?.includes(text));
}

describe("NameCell status icon tooltip", () => {
  it("shows 'Draft' tooltip for DRAFT status in read-only mode", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ status: DocumentStatus.Draft }),
    };

    renderRow(item);

    expect(hasTooltipText("Draft")).toBe(true);
  });

  it("shows 'In Progress' tooltip for IN_PROGRESS status in read-only mode", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ status: DocumentStatus.InProgress }),
    };

    renderRow(item);

    expect(hasTooltipText("In Progress")).toBe(true);
  });

  it("renders tooltip-content element for read-only status icon", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ status: DocumentStatus.Draft }),
    };

    renderRow(item);

    const tooltips = tooltipTexts();
    expect(tooltips.some((t) => t === "Draft")).toBe(true);
  });

  it("does not render status tooltip when onUpdateStatus is provided", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ status: DocumentStatus.Draft }),
    };

    renderRow(item, { onUpdateStatus: vi.fn() });

    const allTooltips = tooltipTexts();
    const statusTooltip = allTooltips.find((t) => t === "Draft");
    expect(statusTooltip).toBeUndefined();
  });
});
