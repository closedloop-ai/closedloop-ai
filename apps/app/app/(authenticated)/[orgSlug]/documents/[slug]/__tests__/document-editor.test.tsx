import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ISS-12855: the web `/documents/[slug]` editor mounts the editor matching the
// loaded document's type, and a Template renders not-found (PRD-799 "Template
// UI is absent"). The shared editors are leaves here; their own suites cover
// them.

const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({ notFound }));

vi.mock("@/hooks/use-org-slug", () => ({ useOrgSlug: () => "acme" }));
vi.mock("@/app/(authenticated)/components/mobile-search-overlay", () => ({
  MobileSearchOverlay: () => null,
}));

vi.mock("@repo/app/documents/editors/prds/detail/prd-editor", () => ({
  PRDEditor: () => <div data-testid="prd-editor" />,
}));
vi.mock(
  "@repo/app/documents/editors/implementation-plans/detail/plan-editor",
  () => ({ PlanEditor: () => <div data-testid="plan-editor" /> })
);
vi.mock("@repo/app/documents/editors/issues/detail/issue-editor", () => ({
  IssueEditor: () => <div data-testid="issue-editor" />,
}));
vi.mock("@repo/app/documents/editors/documents/detail/document-editor", () => ({
  DocumentEditor: () => <div data-testid="doc-editor" />,
}));

import { DocumentEditor } from "../document-editor";

function documentOf(type: DocumentType): DocumentDetail {
  return { id: "doc-1", slug: "DOC-1", type } as unknown as DocumentDetail;
}

function renderEditor(type: DocumentType) {
  return render(
    <DocumentEditor
      currentVersion={1}
      document={documentOf(type)}
      onVersionChange={vi.fn()}
    />
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("web DocumentEditor (/documents/[slug])", () => {
  it("mounts the editor the shared dispatcher picks for the document", () => {
    renderEditor(DocumentType.Prd);

    expect(screen.getByTestId("prd-editor")).toBeInTheDocument();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("renders not-found for a Template", () => {
    expect(() => renderEditor(DocumentType.Template)).toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });
});
