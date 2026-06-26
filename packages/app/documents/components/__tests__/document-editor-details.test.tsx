import {
  type DocumentDetail,
  DocumentStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";

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
 * `/test-org/users/...` hrefs.
 */
function renderWithNav(ui: ReactElement) {
  const nav = createMemoryNavigation({ orgSlug: "test-org" });
  return render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
    ),
  });
}

const ARTIFACT_CREATED_AT = new Date("2026-01-05T12:00:00Z");
const ARTIFACT_UPDATED_AT = new Date("2026-01-06T12:00:00Z");
const VERSION_CREATED_AT = new Date("2026-02-10T12:00:00Z");
const COMMENTS_BUTTON_NAME = /comments/i;
const ACTIVITY_BUTTON_NAME = /activity/i;
const CREATED_LABEL = /created:/i;
const UPDATED_LABEL = /updated:/i;
const CREATED_BY_LABEL = /created by:/i;

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
  test("renders child sections, comments, and artifact activity metadata", () => {
    renderWithNav(
      <DocumentEditorDetails
        activity={{
          createdAt: ARTIFACT_CREATED_AT,
          createdBy: artifactCreator,
          updatedAt: ARTIFACT_UPDATED_AT,
        }}
        documentId="artifact-1"
      >
        <div>Relationships section</div>
      </DocumentEditorDetails>
    );

    expect(screen.getByText("Relationships section")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: COMMENTS_BUTTON_NAME })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: ACTIVITY_BUTTON_NAME }));

    expect(screen.getByText(CREATED_LABEL)).toHaveTextContent("Jan 5, 2026");
    expect(screen.getByText(UPDATED_LABEL)).toHaveTextContent("Jan 6, 2026");
    expect(
      screen.getByRole("link", { name: "Artifact Creator" })
    ).toHaveAttribute("href", "/test-org/users/artifact-creator");
  });

  test("renders unknown-user fallback when artifact creator is unavailable", () => {
    renderWithNav(
      <DocumentEditorDetails
        activity={{
          createdAt: ARTIFACT_CREATED_AT,
          createdBy: null,
          updatedAt: ARTIFACT_UPDATED_AT,
        }}
        documentId="artifact-1"
      >
        <div>Evaluation section</div>
      </DocumentEditorDetails>
    );

    fireEvent.click(screen.getByRole("button", { name: ACTIVITY_BUTTON_NAME }));

    expect(screen.getByText(CREATED_BY_LABEL)).toBeInTheDocument();
    expect(screen.getByText("Unknown user")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
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
