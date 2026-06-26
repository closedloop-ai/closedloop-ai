import { DocumentType } from "@repo/api/src/types/document";
import { describe, expect, it, vi } from "vitest";
import { render } from "./render-with-nav";

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

vi.mock("@repo/app/judges-analytics/hooks/use-judges", () => ({
  usePlanJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  usePrdJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  useCodeJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
}));

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import { makeArtifact } from "@repo/app/shared/test-fixtures/documents";
// Import after mocks
import { makeProject } from "@repo/app/shared/test-fixtures/project";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NameCell — Link vs div rendering", () => {
  it("renders artifact NameCell as <a> when href is resolvable", () => {
    // getDocumentRoute returns a path for PRD type with a slug
    const item: DocumentRowItem = { kind: "document", data: makeArtifact() };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[]} />
    );

    const anchor = container.querySelector("a");
    expect(anchor).toBeInTheDocument();
    expect(anchor?.tagName).toBe("A");
  });

  it("renders artifact NameCell <a> with the correct href", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ slug: "PRD-1", type: DocumentType.Prd }),
    };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[]} />
    );

    const anchor = container.querySelector("a");
    expect(anchor).toHaveAttribute("href", "/test-org/prds/PRD-1");
  });

  it("renders feature row NameCell as <a> with correct href", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({
        id: "feat-1",
        slug: "FEAT-1",
        type: DocumentType.Feature,
      }),
    };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[]} />
    );

    const anchor = container.querySelector("a");
    expect(anchor).toBeInTheDocument();
    expect(anchor).toHaveAttribute("href", "/test-org/features/FEAT-1");
  });

  it("renders project NameCell as <a> when team context is available", () => {
    const item: DocumentRowItem = {
      kind: "project",
      data: makeProject({
        id: "project-1",
        teams: [{ id: "team-1", name: "Team One" }],
      }),
    };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[]} />
    );

    const anchor = container.querySelector("a");
    expect(anchor).toBeInTheDocument();
    expect(anchor).toHaveAttribute(
      "href",
      "/test-org/teams/team-1/projects/project-1"
    );
  });

  it("renders project NameCell as div when no team is available", () => {
    const item: DocumentRowItem = {
      kind: "project",
      data: makeProject({ id: "project-1", teams: [] }),
    };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[]} />
    );

    // No <a> tag should be rendered in the NameCell when href cannot be resolved
    expect(container.querySelector("a")).not.toBeInTheDocument();
  });

  it("renders artifact NameCell as div when document type is non-navigable", () => {
    // getDocumentRoute returns null for document types outside the navigable set
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ type: DocumentType.Template }),
    };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[]} />
    );

    // Non-navigable type → getDocumentRoute returns null → NameCell renders <div>
    expect(container.querySelector("a")).not.toBeInTheDocument();
  });
});
