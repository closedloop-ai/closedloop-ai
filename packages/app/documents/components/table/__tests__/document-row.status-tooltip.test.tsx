import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import { DISPLAYED_SESSION_STATUS } from "@repo/api/src/types/session-status";
import { makeRawArtifact } from "@repo/app/shared/test-fixtures/documents";
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
import { makeProject } from "@repo/app/shared/test-fixtures/project";

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
      data: makeArtifact({
        type: DocumentType.Feature,
        status: IssueStatus.InProgress,
      }),
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

  it("shows status tooltip on the editable status dropdown trigger", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ status: DocumentStatus.Draft }),
    };

    renderRow(item, { onUpdateStatus: vi.fn() });

    expect(tooltipTexts().some((t) => t === "Draft")).toBe(true);
  });

  it("gives the editable status trigger an accessible name from the status icon", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ status: DocumentStatus.Draft }),
    };

    renderRow(item, { onUpdateStatus: vi.fn() });

    // The icon-only trigger is named by its status icon content
    // (role="img" + aria-label on the status primitives), so keyboard and
    // screen-reader users hear the current status, not an unnamed button.
    expect(screen.getByRole("button", { name: "Draft" })).toBeInTheDocument();
  });

  it("shows feature status tooltip on the editable status dropdown trigger", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({
        type: DocumentType.Feature,
        status: IssueStatus.InProgress,
      }),
    };

    renderRow(item, { onUpdateStatus: vi.fn() });

    expect(tooltipTexts().some((t) => t === "In Progress")).toBe(true);
  });

  it("shows branch status tooltip and matching accessible name", () => {
    const item: DocumentRowItem = {
      kind: "branch",
      data: makeRawArtifact(ArtifactType.Branch, {
        id: "branch-1",
        name: "Merged branch",
        status: GitHubPRState.Merged,
      }),
    };

    renderRow(item);

    expect(hasTooltipText("Merged")).toBe(true);
    expect(screen.getByRole("img", { name: "Merged" })).toBeInTheDocument();
  });

  it("shows session status tooltip and matching accessible name", () => {
    const item: DocumentRowItem = {
      kind: "session",
      data: makeRawArtifact(ArtifactType.Session, {
        id: "session-1",
        name: "Waiting session",
        status: DISPLAYED_SESSION_STATUS.WAITING,
      }),
    };

    renderRow(item);

    expect(hasTooltipText("Waiting")).toBe(true);
    expect(screen.getByRole("img", { name: "Waiting" })).toBeInTheDocument();
  });
});

/**
 * ISS-4636: the ring's percentage is computed over the project's DOCUMENT
 * artifacts only — documents and issues — while its branch and session
 * artifacts are in neither the numerator nor the denominator. The copy must
 * name that population, and only that population. The noun itself is pinned to
 * the counted artifact type in
 * `packages/app/projects/lib/__tests__/project-constants.test.ts`.
 */
describe("NameCell project completion ring", () => {
  it("names documents and issues, not all artifacts, as the population it summarizes", () => {
    const item: DocumentRowItem = {
      kind: "project",
      data: makeProject({ completionPercentage: 49 }),
    };

    renderRow(item);

    expect(hasTooltipText("49% of documents and issues complete")).toBe(true);
    expect(tooltipTexts().some((text) => text.includes("artifacts"))).toBe(
      false
    );
  });

  it("gives the ring the same accessible name as its tooltip", () => {
    const item: DocumentRowItem = {
      kind: "project",
      data: makeProject({ completionPercentage: 49 }),
    };

    renderRow(item);

    expect(
      screen.getByRole("img", { name: "49% of documents and issues complete" })
    ).toBeInTheDocument();
  });

  it("rounds the rendered percentage", () => {
    const item: DocumentRowItem = {
      kind: "project",
      data: makeProject({ completionPercentage: 66.6 }),
    };

    renderRow(item);

    expect(hasTooltipText("67% of documents and issues complete")).toBe(true);
  });
});
