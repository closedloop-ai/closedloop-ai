import {
  type DocumentDetail,
  DocumentStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { ApiAdapterProvider } from "../../../shared/api/provider";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";

vi.mock("@repo/app/shared/feature-flags/feature-flagged", () => ({
  FeatureFlagged: ({ children }: { children: unknown }) => children,
}));

import {
  DocumentEditorDetails,
  getDocumentActivityMetadata,
} from "../document-editor-details";

/**
 * Renders inside the memory navigation adapter so the embedded `UserLink`'s
 * `useOrgPath` builder resolves; the org slug drives the expected
 * `/test-org/users/...` hrefs. Also mounts the query, auth, and API ports the
 * embedded (collapsed) `CommentsSection` depends on — its read is disabled
 * while collapsed, so no request is issued.
 */
function renderWithNav(ui: ReactElement) {
  const nav = createMemoryNavigation({ orgSlug: "test-org" });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <NavigationProvider adapter={nav.adapter}>
          <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
            <ApiAdapterProvider
              adapter={{ resolveApiOrigin: () => "http://test.invalid" }}
            >
              {children}
            </ApiAdapterProvider>
          </AuthAdapterProvider>
        </NavigationProvider>
      </QueryClientProvider>
    ),
  });
}

const ARTIFACT_CREATED_AT = new Date("2026-01-05T12:00:00Z");
const ARTIFACT_UPDATED_AT = new Date("2026-01-06T12:00:00Z");
const VERSION_CREATED_AT = new Date("2026-02-10T12:00:00Z");
const COMMENTS_BUTTON_NAME = /comments/i;
const ACTIVITY_BUTTON_NAME = /activity/i;

const artifactCreator: BasicUser = {
  id: "artifact-creator",
  email: "artifact.creator@example.com",
  firstName: "Artifact",
  lastName: "Creator",
  avatarUrl: null,
};

describe("getDocumentActivityMetadata", () => {
  test.each([
    ["PRD", DocumentType.Prd],
    ["implementation plan", DocumentType.ImplementationPlan],
    ["feature", DocumentType.Feature],
  ])("returns artifact provenance for %s details", (_label, type) => {
    const document = createDocumentDetail(type);

    const metadata = getDocumentActivityMetadata(document);

    expect(metadata).toEqual({
      createdAt: ARTIFACT_CREATED_AT,
      updatedAt: ARTIFACT_UPDATED_AT,
      createdBy: artifactCreator,
    });
    expect(metadata.createdAt).not.toBe(document.version.createdAt);
    expect(metadata.createdBy?.id).not.toBe(document.version.createdById);
  });
});

describe("DocumentEditorDetails", () => {
  test("renders child sections and comments without duplicating Sessions or Activity", () => {
    renderWithNav(
      <DocumentEditorDetails documentId="artifact-1">
        <div>Relationships section</div>
      </DocumentEditorDetails>
    );
    expect(screen.getByText("Relationships section")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: COMMENTS_BUTTON_NAME })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ACTIVITY_BUTTON_NAME })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Related Sessions")).not.toBeInTheDocument();
  });

  test("resets the comment draft when the document changes without unmounting", () => {
    const { rerender } = renderWithNav(
      <DocumentEditorDetails documentId="artifact-1">
        <div>Relationships section</div>
      </DocumentEditorDetails>
    );

    // Expand the section so the composer renders, then type a draft. The
    // artifact composer's textarea is named by its visible "Comment on the
    // whole document" label.
    fireEvent.click(screen.getByRole("button", { name: COMMENTS_BUTTON_NAME }));
    const composer = screen.getByLabelText("Add a comment");
    fireEvent.change(composer, { target: { value: "Draft on the first doc" } });
    expect(screen.getByLabelText("Add a comment")).toHaveValue(
      "Draft on the first doc"
    );

    // Navigate to a different document in the same mounted details container.
    rerender(
      <DocumentEditorDetails documentId="artifact-2">
        <div>Relationships section</div>
      </DocumentEditorDetails>
    );

    // key={documentId} remounts the section: the section is collapsed again and
    // the stale draft is gone rather than carrying across documents.
    expect(screen.queryByLabelText("Add a comment")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: COMMENTS_BUTTON_NAME }));
    expect(screen.getByLabelText("Add a comment")).toHaveValue("");
  });
});

function createDocumentDetail(type: DocumentType): DocumentDetail {
  return {
    ...createMockDocument({
      type,
      status: DocumentStatus.Draft,
      createdAt: ARTIFACT_CREATED_AT,
      updatedAt: ARTIFACT_UPDATED_AT,
      createdById: artifactCreator.id,
      createdBy: artifactCreator,
    }),
    latestVersionContent: "Version content",
    version: {
      id: "version-1",
      documentId: "artifact-1",
      version: 2,
      content: "Version content",
      createdById: "version-author",
      createdAt: VERSION_CREATED_AT,
    },
  };
}
