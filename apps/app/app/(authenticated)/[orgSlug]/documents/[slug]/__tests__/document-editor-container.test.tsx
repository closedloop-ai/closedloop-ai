import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import { ApiError } from "@repo/app/shared/api/api-error";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ISS-4382: the container fetches the artifact by slug, shows a spinner while
// loading and 404s a genuine miss. These tests drive the real container and
// assert those observable branches.

const { useDocumentBySlug } = vi.hoisted(() => ({
  useDocumentBySlug: vi.fn(),
}));
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocumentBySlug: (slug: string, version: number | undefined) =>
    useDocumentBySlug(slug, version),
  useEnsureDocumentBySlug: () => vi.fn(),
}));

const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({ notFound }));

// The real editor mounts the web host and the collaborative scaffold; the
// container test only cares that it renders with the resolved
// document/version, so use a leaf.
vi.mock("../document-editor", () => ({
  DocumentEditor: ({
    document,
    currentVersion,
  }: {
    document: DocumentDetail;
    currentVersion: number;
  }) => (
    <div
      data-doc-id={document.id}
      data-testid="document-editor"
      data-version={currentVersion}
    />
  ),
}));

import { DocumentEditorContainer } from "../document-editor-container";

const DOCUMENT = {
  id: "doc-1",
  slug: "onboarding",
  type: DocumentType.Doc,
  latestVersion: 4,
  version: { version: 4, content: "hi" },
} as unknown as DocumentDetail;

afterEach(() => {
  vi.clearAllMocks();
});

describe("DocumentEditorContainer (ISS-4382)", () => {
  it("renders a loading spinner while the query is loading", () => {
    useDocumentBySlug.mockReturnValue({ isLoading: true });

    const { container } = render(<DocumentEditorContainer slug="onboarding" />);

    expect(screen.queryByTestId("document-editor")).not.toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("calls notFound() when the query answers 404", () => {
    useDocumentBySlug.mockReturnValue({
      isLoading: false,
      error: new ApiError("Not Found", 404),
      data: undefined,
    });

    expect(() => render(<DocumentEditorContainer slug="onboarding" />)).toThrow(
      "NEXT_NOT_FOUND"
    );
    expect(notFound).toHaveBeenCalled();
  });

  it("renders the editor at the resolved latest version", () => {
    useDocumentBySlug.mockReturnValue({
      isLoading: false,
      error: null,
      data: DOCUMENT,
    });

    render(<DocumentEditorContainer slug="onboarding" />);

    const editor = screen.getByTestId("document-editor");
    expect(editor).toHaveAttribute("data-doc-id", "doc-1");
    expect(editor).toHaveAttribute("data-version", "4");
  });
});
