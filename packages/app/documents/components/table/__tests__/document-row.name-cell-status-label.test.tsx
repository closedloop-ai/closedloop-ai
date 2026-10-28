import {
  DOCUMENT_STATUS_OPTIONS,
  DocumentStatus,
  DocumentType,
  ISSUE_STATUS_OPTIONS,
  IssueStatus,
} from "@repo/api/src/types/document";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

// Radix renders the tooltip content into a portal only while open, which a
// hover-less jsdom render never reaches. Rendering it inline is what makes the
// caption assertable at all; the trigger wiring itself is what is under test.
vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

import type { ArtifactStatus } from "@repo/api/src/types/document";
import { DocumentStatusIcon } from "@repo/app/documents/components/document-status-icon";
import { IssueStatusIcon } from "@repo/app/documents/components/issue-status-icon";
// biome-ignore lint/performance/noNamespaceImport: the module's public surface is itself the contract under test (see the "name-cell module surface" cases), and only the namespace object exposes it.
import * as nameCellModule from "@repo/app/documents/components/table/cells/name-cell";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import type { RowEditHandlers } from "@repo/app/documents/components/table/row-edit-context";
import { ARTIFACT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import {
  DOCUMENT_STATUS_CAPTION,
  ISSUE_STATUS_CAPTION,
  makeArtifact,
} from "@repo/app/shared/test-fixtures/documents";

const DOCUMENT_STATUS_CASES: [DocumentStatus, string][] =
  DOCUMENT_STATUS_OPTIONS.map((status): [DocumentStatus, string] => [
    status,
    DOCUMENT_STATUS_CAPTION[status],
  ]);

const ISSUE_STATUS_CASES: [IssueStatus, string][] = ISSUE_STATUS_OPTIONS.map(
  (status): [IssueStatus, string] => [status, ISSUE_STATUS_CAPTION[status]]
);

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

function captions(): string[] {
  return screen
    .getAllByTestId("tooltip-content")
    .map((node) => node.textContent ?? "");
}

/**
 * Selected by the caption rather than by position, so a future icon added
 * elsewhere in the row cannot quietly turn a glyph comparison into a comparison
 * of two copies of some other mark.
 */
function statusIconMarkup(caption: string): string {
  return screen.getByRole("img", { name: caption }).outerHTML;
}

/** The mark one status-icon component draws on its own, for attribution. */
function primitiveMarkup(icon: ReactElement, caption: string): string {
  const view = render(icon);
  const markup = statusIconMarkup(caption);
  view.unmount();
  return markup;
}

/**
 * The name cell picks the row's status VOCABULARY (`DocumentStatusIcon` vs
 * `IssueStatusIcon`, PRD-495) and looks its caption up in
 * `ARTIFACT_STATUS_LABELS`. Both are per-status presentation, and all three of
 * this file's fix commits were presentation fixes, so asserting "an icon
 * rendered" proves nothing — every case below pins the caption the icon and its
 * tooltip must carry FOR THAT status. Cross-vocabulary rows are the teeth: the
 * Document map has no `TRIAGE` and the Issue map no `DRAFT`, so routing a row to
 * the wrong vocabulary degrades the icon's name to the primitives' `"Status"`
 * fallback and reddens the case.
 */
describe("NameCell status icon — read-only rows caption every status", () => {
  it.each(DOCUMENT_STATUS_CASES)(
    "captions a %s document row as '%s'",
    (status, caption) => {
      renderRow(documentRow(status));

      expect(screen.getByRole("img", { name: caption })).toBeInTheDocument();
      expect(captions()).toContain(caption);
    }
  );

  it.each(ISSUE_STATUS_CASES)(
    "captions a %s issue row as '%s'",
    (status, caption) => {
      renderRow(featureRow(status));

      expect(screen.getByRole("img", { name: caption })).toBeInTheDocument();
      expect(captions()).toContain(caption);
    }
  );

  it("renders no status trigger button without an update handler", () => {
    renderRow(documentRow(DocumentStatus.Draft));

    expect(
      screen.queryByRole("button", {
        name: ARTIFACT_STATUS_LABELS[DocumentStatus.Draft],
      })
    ).not.toBeInTheDocument();
  });
});

/**
 * `4e84f3106` fixed the editable status icon being the one status glyph in the
 * table with no tooltip. The dropdown trigger is icon-only, so its caption is
 * also its accessible name — a keyboard or screen-reader user hears the current
 * status only if both survive. Asserting the caption inside the trigger (not
 * merely somewhere on the row) is what keeps the read-only branch's tooltip from
 * satisfying this suite on the editable branch's behalf.
 */
describe("NameCell status icon — editable rows caption every status", () => {
  it.each(DOCUMENT_STATUS_CASES)(
    "captions the %s document dropdown trigger as '%s'",
    (status, caption) => {
      renderRow(documentRow(status), { onUpdateStatus: vi.fn() });

      const trigger = screen.getByRole("button", { name: caption });
      expect(
        within(trigger).getByRole("img", { name: caption })
      ).toBeInTheDocument();
      expect(captions()).toContain(caption);
    }
  );

  it.each(ISSUE_STATUS_CASES)(
    "captions the %s issue dropdown trigger as '%s'",
    (status, caption) => {
      renderRow(featureRow(status), { onUpdateStatus: vi.fn() });

      const trigger = screen.getByRole("button", { name: caption });
      expect(
        within(trigger).getByRole("img", { name: caption })
      ).toBeInTheDocument();
      expect(captions()).toContain(caption);
    }
  );
});

/**
 * `IN_REVIEW` is the single status the Document and Issue vocabularies share,
 * and they share its caption too — so the two `IN_REVIEW` cases above are the
 * only ones a wrong-vocabulary routing bug survives on the caption alone. Their
 * glyphs still differ (a Document in review is a 50% ring, an Issue in review a
 * 75% one), so attribute each row's mark to the component that owns it. Merely
 * asserting the two marks DIFFER would hold just as well if they were swapped.
 */
describe("NameCell status icon — the shared IN_REVIEW caption is not a shared glyph", () => {
  it("draws each IN_REVIEW row in its own vocabulary, not merely a different one", () => {
    const sharedCaption = DOCUMENT_STATUS_CAPTION[DocumentStatus.InReview];
    expect(ISSUE_STATUS_CAPTION[IssueStatus.InReview]).toBe(sharedCaption);

    const documentGlyph = primitiveMarkup(
      <DocumentStatusIcon size={16} status={DocumentStatus.InReview} />,
      sharedCaption
    );
    const issueGlyph = primitiveMarkup(
      <IssueStatusIcon size={16} status={IssueStatus.InReview} />,
      sharedCaption
    );
    // Without this the two identity assertions below could both hold on one
    // shared mark, and the case would be back to proving nothing.
    expect(documentGlyph).not.toBe(issueGlyph);

    const documentView = renderRow(documentRow(DocumentStatus.InReview));
    expect(statusIconMarkup(sharedCaption)).toBe(documentGlyph);
    documentView.unmount();

    renderRow(featureRow(IssueStatus.InReview));
    expect(statusIconMarkup(sharedCaption)).toBe(issueGlyph);
  });
});

/**
 * `968a7e8f3` un-exported the internal `TypeIcon`. Pinning the whole public
 * surface — rather than only `TypeIcon` — is what makes a future re-export red
 * no matter which internal helper leaks out.
 */
describe("name-cell module surface", () => {
  it("exports NameCell and nothing else", () => {
    expect(Object.keys(nameCellModule)).toEqual(["NameCell"]);
  });

  it("keeps TypeIcon internal", () => {
    expect(nameCellModule).not.toHaveProperty("TypeIcon");
  });
});
