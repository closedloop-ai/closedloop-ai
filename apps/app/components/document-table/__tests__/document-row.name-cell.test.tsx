import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Mock next/navigation — DocumentRow uses useParams
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
  usePathname: vi.fn(() => "/"),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useParams: vi.fn(() => ({})),
}));

vi.mock("@/hooks/queries/use-judges", () => ({
  usePlanJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  usePrdJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  useCodeJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
}));

// Import after mocks
import type { DocumentWithWorkstream } from "@repo/api/src/types/document";
import { makeProject } from "@/__tests__/fixtures/project";
import type { DocumentRowItem } from "@/components/document-table/document-row";
import { DocumentRow } from "@/components/document-table/document-row";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeArtifact = (
  overrides?: Partial<DocumentWithWorkstream>
): DocumentWithWorkstream => ({
  id: "artifact-1",
  organizationId: "org-1",
  workstreamId: null,
  projectId: "project-1",
  type: DocumentType.Prd,
  title: "My PRD",
  slug: "PRD-1",
  fileName: null,
  status: DocumentStatus.Draft,
  priority: Priority.Medium,
  latestVersion: 1,
  createdById: "user-1",
  assigneeId: null,
  assignee: null,
  approverId: null,
  approver: null,
  tokenUsage: null,
  targetRepo: null,
  targetBranch: null,
  templateForType: null,
  sortOrder: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-02"),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NameCell — Link vs div rendering", () => {
  it("renders artifact NameCell as <a> when href is resolvable", () => {
    // getDocumentRoute returns a path for PRD type with a slug
    const item: DocumentRowItem = { kind: "artifact", data: makeArtifact() };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[]} />
    );

    const anchor = container.querySelector("a");
    expect(anchor).toBeInTheDocument();
    expect(anchor?.tagName).toBe("A");
  });

  it("renders artifact NameCell <a> with the correct href", () => {
    const item: DocumentRowItem = {
      kind: "artifact",
      data: makeArtifact({ slug: "PRD-1", type: DocumentType.Prd }),
    };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[]} />
    );

    const anchor = container.querySelector("a");
    expect(anchor).toHaveAttribute("href", "/prds/PRD-1");
  });

  it("renders feature row NameCell as <a> with correct href", () => {
    const item: DocumentRowItem = {
      kind: "feature",
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
    expect(anchor).toHaveAttribute("href", "/features/FEAT-1");
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
    expect(anchor).toHaveAttribute("href", "/teams/team-1/projects/project-1");
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
      kind: "artifact",
      data: makeArtifact({ type: DocumentType.Template }),
    };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[]} />
    );

    // Non-navigable type → getDocumentRoute returns null → NameCell renders <div>
    expect(container.querySelector("a")).not.toBeInTheDocument();
  });
});
