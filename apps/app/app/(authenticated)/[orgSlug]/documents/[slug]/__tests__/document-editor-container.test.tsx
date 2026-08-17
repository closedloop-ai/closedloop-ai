import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ISS-4382: the DOC container fetches the artifact by slug, shows a spinner
// while loading, 404s a genuine miss, and — when the server route already
// resolved the document — hands it to useDocumentBySlug as initialData so the
// editor renders without a second by-slug request on mount. These tests drive
// the real container and assert those observable branches plus the exact
// hook-call shape that carries the hydration seed.

const { useDocumentBySlug } = vi.hoisted(() => ({
  useDocumentBySlug: vi.fn(),
}));
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocumentBySlug: (
    slug: string,
    version: number | undefined,
    options: unknown
  ) => useDocumentBySlug(slug, version, options),
}));

const { notFound } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({ notFound }));

// The real editor mounts the collaborative scaffold; the container test only
// cares that it renders with the resolved document/version, so use a leaf.
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

  it("calls notFound() when the query errors", () => {
    useDocumentBySlug.mockReturnValue({
      isLoading: false,
      error: new Error("boom"),
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

  it("seeds initialData from the server-resolved document for the latest-version query", () => {
    useDocumentBySlug.mockReturnValue({
      isLoading: false,
      error: null,
      data: DOCUMENT,
    });

    render(
      <DocumentEditorContainer initialDocument={DOCUMENT} slug="onboarding" />
    );

    // No specific version requested -> the hook is called for the latest-version
    // key with the server document as initialData, so the editor can render
    // immediately without a second by-slug request on mount.
    expect(useDocumentBySlug).toHaveBeenCalledWith(
      "onboarding",
      undefined,
      expect.objectContaining({ initialData: DOCUMENT })
    );
  });

  it("does NOT seed initialData when a specific historical version is requested", () => {
    useDocumentBySlug.mockReturnValue({
      isLoading: false,
      error: null,
      data: DOCUMENT,
    });

    render(
      <DocumentEditorContainer
        initialDocument={DOCUMENT}
        slug="onboarding"
        version={2}
      />
    );

    // The server fetch was version-agnostic, so it is not a valid seed for a
    // historical selection — initialData must be undefined for version 2.
    expect(useDocumentBySlug).toHaveBeenCalledWith(
      "onboarding",
      2,
      expect.objectContaining({ initialData: undefined })
    );
  });
});
