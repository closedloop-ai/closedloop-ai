import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  DOCUMENT_STATUS_OPTIONS,
  DocumentStatus,
  DocumentType,
  ISSUE_STATUS_OPTIONS,
  IssueStatus,
} from "@repo/api/src/types/document";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, within } from "@testing-library/react";
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

// The real menu mounts its content only once Radix has opened it, which a jsdom
// render never does. Render it inline so the offered vocabulary is assertable;
// the rest of the module stays real so no other consumer in the row loses an
// export it imports.
vi.mock("@repo/design-system/components/ui/dropdown-menu", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/design-system/components/ui/dropdown-menu")
  >("@repo/design-system/components/ui/dropdown-menu");
  return {
    ...actual,
    DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
      <>{children}</>
    ),
    DropdownMenuContent: ({ children }: { children: ReactNode }) => (
      <div data-testid="status-menu">{children}</div>
    ),
    DropdownMenuItem: ({
      children,
      onClick,
    }: {
      children: ReactNode;
      onClick?: () => void;
    }) => (
      <button data-testid="status-option" onClick={onClick} type="button">
        {children}
      </button>
    ),
  };
});

import type { ArtifactStatus } from "@repo/api/src/types/document";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { ARTIFACT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import {
  DOCUMENT_STATUS_CAPTION,
  ISSUE_STATUS_CAPTION,
  makeArtifact,
} from "@repo/app/shared/test-fixtures/documents";

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

function documentRow(status: ArtifactStatus): DocumentRowItem {
  return {
    kind: "document",
    data: makeArtifact({ status, type: DocumentType.Prd }),
  };
}

function featureRow(status: ArtifactStatus): DocumentRowItem {
  return {
    kind: "document",
    data: makeArtifact({
      id: "feat-1",
      slug: "FEAT-1",
      status,
      type: DocumentType.Feature,
    }),
  };
}

/** The words the menu offers, in order — its text half. */
function offeredStatuses(): string[] {
  return screen
    .getAllByTestId("status-option")
    .map((node) => node.textContent ?? "");
}

/**
 * The GLYPH half of the same list. An icon contributes nothing to
 * `textContent`, so without this every option could draw the row's current
 * status (or the wrong vocabulary's icon entirely) and the text assertions
 * would still pass.
 *
 * `hidden: true` because ISS-8543 marked these glyphs `aria-hidden`: the
 * option's own text already names the status, and leaving the icon's
 * `aria-label` in the tree made each item announce "Triage Triage". The glyph
 * still renders and still carries its label — this reads it as the decorative
 * element it now is. The contract asserted is unchanged.
 */
function offeredStatusIconNames(): string[] {
  return screen
    .getAllByTestId("status-option")
    .map(
      (node) =>
        within(node)
          .getByRole("img", { hidden: true })
          .getAttribute("aria-label") ?? ""
    );
}

function pickStatus(caption: string): HTMLElement {
  const option = screen
    .getAllByTestId("status-option")
    .find((node) => node.textContent === caption);
  if (!option) {
    throw new Error(`expected the status menu to offer ${caption}`);
  }
  return option;
}

/**
 * PRD-495 gives Documents and Features disjoint status vocabularies, and the
 * name cell's editable dropdown is one of the surfaces that has to scope the
 * offered set by row kind. `6dd5d3a21` filtered `TRIAGE` out of the human
 * pickers here — and `c677c42d9`, two commits later, put it back and wrote the
 * rule the code carries today: `TRIAGE` is selectable in every status menu and
 * is excluded only as the human-CREATE default. These cases pin the live rule,
 * in both directions, since the whole risk is one vocabulary leaking into the
 * other row kind.
 */
describe("NameCell editable status menu — offered vocabulary", () => {
  it("offers a feature row the full issue vocabulary, TRIAGE included", () => {
    renderRow(featureRow(IssueStatus.Backlog), { onUpdateStatus: vi.fn() });

    const expected = ISSUE_STATUS_OPTIONS.map(
      (status) => ISSUE_STATUS_CAPTION[status]
    );
    expect(offeredStatuses()).toEqual(expected);
    expect(offeredStatusIconNames()).toEqual(expected);
    expect(offeredStatuses()).toContain("Triage");
  });

  it("offers a document row the document vocabulary, without TRIAGE", () => {
    renderRow(documentRow(DocumentStatus.Draft), { onUpdateStatus: vi.fn() });

    const expected = DOCUMENT_STATUS_OPTIONS.map(
      (status) => DOCUMENT_STATUS_CAPTION[status]
    );
    expect(offeredStatuses()).toEqual(expected);
    expect(offeredStatusIconNames()).toEqual(expected);
    expect(offeredStatuses()).not.toContain(
      ARTIFACT_STATUS_LABELS[IssueStatus.Triage]
    );
  });

  it("lets an agent-triaged feature row move out of TRIAGE", () => {
    const onUpdateStatus = vi.fn();
    renderRow(featureRow(IssueStatus.Triage), { onUpdateStatus });

    // The row's own status control, not the menu's TRIAGE option: since
    // ISS-8543 made the option glyphs decorative, an option's accessible name
    // is exactly its caption, so a bare name lookup now matches both.
    expect(
      screen
        .getAllByRole("button", { name: "Triage" })
        .find((node) => node.dataset.testid !== "status-option")
    ).toBeDefined();

    fireEvent.click(pickStatus("Done"));

    expect(onUpdateStatus).toHaveBeenCalledWith(
      "feat-1",
      IssueStatus.Done,
      ArtifactStatusEditSurface.InlineCell
    );
  });

  it("reports the picked status, not the current one, on a document row", () => {
    const onUpdateStatus = vi.fn();
    renderRow(documentRow(DocumentStatus.Draft), { onUpdateStatus });

    fireEvent.click(pickStatus("Approved"));

    expect(onUpdateStatus).toHaveBeenCalledWith(
      "artifact-1",
      DocumentStatus.Approved,
      ArtifactStatusEditSurface.InlineCell
    );
  });

  it("renders no status menu on a row with no update handler", () => {
    renderRow(featureRow(IssueStatus.Backlog));

    expect(screen.queryByTestId("status-menu")).not.toBeInTheDocument();
  });
});
