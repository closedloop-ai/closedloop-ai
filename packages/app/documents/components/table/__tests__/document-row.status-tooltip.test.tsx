import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import { makeRawArtifact } from "@repo/app/shared/test-fixtures/documents";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

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

/**
 * The check glyph's own `d`, owned by `FilledCheckCircle` in
 * `packages/design-system/components/ui/internal/status-icon-shared.tsx`. It is
 * the one element only the complete mark draws, so it separates "the row shows
 * the project as done" from "the row shows a ring" without asserting a colour.
 */
const COMPLETE_CHECK_PATH = 'path[d="M6.5 10.5L9.5 13.5L14 7.5"]';

function hasCompleteCheck(container: HTMLElement): boolean {
  return container.querySelector(COMPLETE_CHECK_PATH) !== null;
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

  // ISS-10364 (operator ruling, 2026-09-23/24): a stored `waiting` row (legacy
  // spelling — the member is retired) now folds to Active like any other
  // non-terminal status, rather than rendering its own "Waiting" word.
  it("folds a legacy stored `waiting` status to Active", () => {
    const item: DocumentRowItem = {
      kind: "session",
      data: makeRawArtifact(ArtifactType.Session, {
        id: "session-1",
        name: "Waiting session",
        status: "waiting",
      }),
    };

    renderRow(item);

    expect(hasTooltipText("Active")).toBe(true);
    expect(screen.getByRole("img", { name: "Active" })).toBeInTheDocument();
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

  it("leaves the mid-range on the value it has always rendered", () => {
    // Per the 2026-09-18 ruling only 100 is reserved, so 2/3 stays 67. An
    // earlier cut of this PR floored the whole range and moved this to 66,
    // which is a rendered-number change on roughly half of all partial rows
    // that the ticket never asked for.
    const item: DocumentRowItem = {
      kind: "project",
      data: makeProject({ completionPercentage: 66.6 }),
    };

    renderRow(item);

    expect(hasTooltipText("67% of documents and issues complete")).toBe(true);
  });

  it("does not claim 100% on the row while a document is outstanding (ISS-9922)", () => {
    // THIS IS THE CLIENT'S OWN RESERVE, NOT THE SHIPPED WIRE PATH (tamsinb
    // review). After this PR the API sends 99 for 199 of 200 and never 99.5, so
    // no route produces the value below — it is fed here to prove the client
    // refuses to promote it on its own, which is what protects the row against
    // a producer that has not caught up (a stale API during a deploy, the
    // desktop cache, a third-party client). Read it as the second line of
    // defence; the wire path is covered in `apps/api/__tests__`.
    //
    // The ticket reports three channels — the filled check, the ring's
    // accessible name and the tooltip — so all three are asserted.
    // `completionPercentage` reaches the label and the mark by two separate
    // expressions in `name-cell.tsx`, and pinning only the tooltip leaves a
    // rounding reintroduced on the `value` side invisible.
    const { container } = renderRow({
      kind: "project",
      data: makeProject({ completionPercentage: 99.5 }),
    });

    expect(hasCompleteCheck(container)).toBe(false);
    expect(
      screen.getByRole("img", {
        name: "99% of documents and issues complete",
      })
    ).toBeInTheDocument();
    expect(hasTooltipText("99% of documents and issues complete")).toBe(true);
    expect(hasTooltipText("100% of documents and issues complete")).toBe(false);
  });

  it("still claims 100% on the row when the population really is complete", () => {
    // The positive sibling of every locator above, so an absence at 99.5 proves
    // the mark and the name are gone rather than that they match nothing.
    const { container } = renderRow({
      kind: "project",
      data: makeProject({ completionPercentage: 100 }),
    });

    expect(hasCompleteCheck(container)).toBe(true);
    expect(
      screen.getByRole("img", {
        name: "100% of documents and issues complete",
      })
    ).toBeInTheDocument();
    expect(hasTooltipText("100% of documents and issues complete")).toBe(true);
  });

  it("states a sub-1% fraction as 0% rather than inventing a 1%", () => {
    // 1 of 250 documents, and the same second-line-of-defence note as above:
    // the API sends 0 for this, never 0.4.
    //
    // Per the 2026-09-18 ruling the low end is NOT reserved. An earlier cut
    // floored this up to "1% complete", which is the same unmeasured claim the
    // ticket is about pointed the other way — nobody counted 1% of anything
    // here. The started-ness lives in the arc, which `arcOffsetOf` separates
    // from a genuine zero in the design-system suite.
    renderRow({
      kind: "project",
      data: makeProject({ completionPercentage: 0.4 }),
    });

    expect(
      screen.getByRole("img", { name: "0% of documents and issues complete" })
    ).toBeInTheDocument();
    expect(hasTooltipText("0% of documents and issues complete")).toBe(true);
    expect(hasTooltipText("1% of documents and issues complete")).toBe(false);
  });

  it("still says 0% on the row when nothing has started", () => {
    renderRow({
      kind: "project",
      data: makeProject({ completionPercentage: 0 }),
    });

    expect(
      screen.getByRole("img", { name: "0% of documents and issues complete" })
    ).toBeInTheDocument();
    expect(hasTooltipText("0% of documents and issues complete")).toBe(true);
  });
});
