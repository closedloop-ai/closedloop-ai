/**
 * ISS-5474 — an artifact row's lifecycle status stands alone. No run state.
 *
 * ISS-4477 removed Loops as a user-facing concept. #4467 removed the artifact
 * table's Loop column but independently added a REPLACEMENT run-state treatment
 * in the status slot: a destructive `CircleAlert` badge plus a
 * `— last run failed` suffix on the status label, and a `thinking` spinner arc
 * driven by PENDING/QUEUED/RUNNING. That combined two status systems on one row
 * for a product that no longer has a Loops concept, and read worst on a BLOCKED
 * issue, where the legitimate amber Blocked `!` grew a second red `!`.
 *
 * These tests pin the removal the way `loop-column-absent.test.tsx` pins the
 * column's: assert the treatment is ABSENT with a populated row present, so the
 * check cannot pass merely because nothing rendered. They assert the rendered
 * outcome (glyph count, accessible name, tooltip text) rather than the presence
 * of a class, because a class assertion can hold while the pixels do not
 * (ISS-5333), and they locate the control by role and accessible name rather
 * than by index, because an index-based assertion silently drifted on a reorder
 * in #4480.
 */

import type { GenerationStatus } from "@repo/api/src/types/document";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import { ARTIFACT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "./render-with-nav";

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

vi.mock("@repo/app/judges-analytics/hooks/use-judges", () => ({
  useFeatureJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  usePlanJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  usePrdJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  useCodeJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
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
import {
  makeArtifact,
  makeFeatureArtifact,
} from "@repo/app/shared/test-fixtures/documents";

const DRAFT_LABEL = ARTIFACT_STATUS_LABELS[DocumentStatus.Draft];
const BLOCKED_LABEL = ARTIFACT_STATUS_LABELS[IssueStatus.Blocked];
const RUN_STATE_PATTERN = /last run|loop|generat/i;
const ROW_TITLE = "Quarterly rollout PRD";
const BLOCKED_TITLE = "Payments migration is stuck";

function makeGenerationStatus(
  status: GenerationStatus["status"]
): GenerationStatus {
  return {
    status,
    command: "plan",
    htmlUrl: null,
    startedAt: null,
    completedAt: null,
    correlationId: null,
  };
}

function makeDocumentRow(generationStatus?: GenerationStatus): DocumentRowItem {
  return {
    kind: "document",
    data: makeArtifact({
      title: ROW_TITLE,
      status: DocumentStatus.Draft,
      ...(generationStatus && { generationStatus }),
    }),
  };
}

function makeBlockedIssueRow(
  generationStatus?: GenerationStatus
): DocumentRowItem {
  return {
    kind: "document",
    data: makeFeatureArtifact({
      title: BLOCKED_TITLE,
      status: IssueStatus.Blocked,
      ...(generationStatus && { generationStatus }),
    }),
  };
}

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

/**
 * Every status glyph the name cell rendered. The status icons are the only
 * SVGs in the cell that carry an accessible name, so counting them counts
 * status indicators — the thing the bug added a second of.
 */
function statusGlyphNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("svg[aria-label]")).map(
    (node) => node.getAttribute("aria-label") ?? ""
  );
}

afterEach(() => {
  cleanup();
});

describe("artifact row — no run-state treatment (ISS-5474)", () => {
  it("renders a BLOCKED issue with exactly one status indicator, even after a failed run", () => {
    // The reported symptom: the amber Blocked `!` grew a second, red `!`.
    const { container } = renderRow(
      makeBlockedIssueRow(makeGenerationStatus("FAILURE"))
    );

    // Not vacuous — the row really rendered. `getAllByText` because the title
    // renders twice: the visible cell and its own truncation tooltip.
    expect(screen.getAllByText(BLOCKED_TITLE).length).toBeGreaterThan(0);

    expect(statusGlyphNames(container)).toEqual([BLOCKED_LABEL]);
    expect(container.querySelector(".lucide-circle-alert")).toBeNull();
  });

  it("names a BLOCKED issue by its status alone, with no run-state copy", () => {
    renderRow(makeBlockedIssueRow(makeGenerationStatus("FAILURE")), {
      onUpdateStatus: vi.fn(),
    });

    // The editable surfaces render the status icon as a dropdown trigger; that
    // button's accessible name is what a keyboard user hears.
    expect(
      screen.getByRole("button", { name: BLOCKED_LABEL })
    ).toBeInTheDocument();
    for (const text of tooltipTexts()) {
      expect(text).not.toMatch(RUN_STATE_PATTERN);
    }
  });

  it("renders a FAILURE run identically to a row that never ran", () => {
    const { container: failed } = renderRow(
      makeDocumentRow(makeGenerationStatus("FAILURE"))
    );
    const failedGlyphs = statusGlyphNames(failed);
    const failedTooltips = tooltipTexts();
    cleanup();

    const { container: neverRan } = renderRow(makeDocumentRow());

    expect(failedGlyphs).toEqual([DRAFT_LABEL]);
    expect(statusGlyphNames(neverRan)).toEqual(failedGlyphs);
    expect(failedTooltips).toEqual(tooltipTexts());
  });

  it("renders a RUNNING run identically to a row that never ran", () => {
    // The `thinking` spinner arc is the only thing an active run used to change
    // about the glyph, and the ring emits it as a distinct `animate-spin` node.
    const { container: running } = renderRow(
      makeDocumentRow(makeGenerationStatus("RUNNING"))
    );
    const runningHtml = running.innerHTML;
    expect(running.querySelector(".animate-spin")).toBeNull();
    cleanup();

    const { container: neverRan } = renderRow(makeDocumentRow());

    expect(runningHtml).toBe(neverRan.innerHTML);
  });

  it("keeps the status label free of run-state vocabulary in every run state", () => {
    for (const status of [
      "PENDING",
      "QUEUED",
      "RUNNING",
      "FAILURE",
      "SUCCESS",
    ] as const) {
      const { container } = renderRow(
        makeDocumentRow(makeGenerationStatus(status))
      );

      expect(screen.getAllByText(ROW_TITLE).length).toBeGreaterThan(0);
      expect(tooltipTexts()).toContain(DRAFT_LABEL);
      expect(container.textContent ?? "").not.toMatch(RUN_STATE_PATTERN);
      cleanup();
    }
  });
});
