import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import {
  DocumentEditorScaffold,
  editorBodyClassName,
  editorLoaderClassName,
} from "../document-editor-scaffold";
import { FeedArtifactType } from "../feed-sidebar/types";

/**
 * The `renderEmptyContent` seam: the scaffold owns WHEN a stand-in may take the
 * content region, the caller owns WHETHER it has anything to say.
 *
 * Same leaf stubs as the sibling chat-slot suite so the real scaffold mounts in
 * jsdom without Liveblocks or Tiptap. The gating logic under test runs unmocked.
 */
vi.mock("@repo/collaboration/client/optional-document-room", () => ({
  OptionalDocumentRoom: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@repo/collaboration/client/presence", () => ({
  InlinePresence: () => null,
}));
vi.mock("@repo/collaboration/client/scroll-to-anchor", () => ({
  scrollToAnchor: vi.fn(),
}));
vi.mock("@repo/rich-text/rich-text-toolbar", () => ({
  RichTextToolbar: () => null,
}));
vi.mock("../collaborative-editor-body", () => ({
  CollaborativeEditorBody: () => null,
}));
vi.mock("../editor/document-feed-rail", () => ({
  DocumentFeedRail: () => null,
}));
vi.mock("../editor/document-room-event-listener", () => ({
  DocumentRoomEventListener: () => null,
}));
vi.mock("../editor/editable-document-title", () => ({
  EditableDocumentTitle: () => null,
}));
vi.mock("../../../users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: null, isLoading: false }),
}));

const STAND_IN_TESTID = "empty-content-stand-in";

function createDocumentDetail(content: string): DocumentDetail {
  const now = new Date("2026-06-12T00:00:00.000Z");
  return {
    id: "document-1",
    organizationId: "org-1",
    projectId: "project-1",
    type: DocumentType.Prd,
    title: "Stand-in doc",
    slug: "PRD-1",
    fileName: null,
    status: "DRAFT",
    priority: "MEDIUM",
    latestVersion: 2,
    latestVersionContent: content,
    createdById: "user-1",
    createdBy: null,
    assigneeId: null,
    assignee: null,
    approverId: null,
    approver: null,
    repositorySnapshot: {
      createdAt: now.toISOString(),
      repositories: [],
      source: "none",
    },
    templateForType: null,
    sortOrder: null,
    createdAt: now,
    updatedAt: now,
    version: {
      id: "version-2",
      documentId: "document-1",
      version: 2,
      content,
      createdById: "user-1",
      createdAt: now,
    },
  };
}

function renderScaffold(options: {
  content: string;
  currentVersion?: number;
  standIn?: ReactNode;
}) {
  const standIn =
    options.standIn === undefined ? (
      <div data-testid={STAND_IN_TESTID} />
    ) : (
      options.standIn
    );
  return render(
    <AppCoreStoryProviders enabledFlags={[]}>
      <DocumentEditorScaffold
        currentVersion={options.currentVersion ?? 2}
        deleteDialogTitle="PRD"
        detailsSections={() => null}
        document={createDocumentDetail(options.content)}
        feedArtifactType={FeedArtifactType.Prd}
        onVersionChange={vi.fn()}
        redirectPath="/org-test/prds"
        renderEmptyContent={() => standIn}
        renderHeader={() => null}
        resizableAutoSaveId="scaffold-empty-test"
      />
    </AppCoreStoryProviders>
  );
}

describe("DocumentEditorScaffold empty-content stand-in", () => {
  test("takes the content region when the latest version has nothing to read", () => {
    renderScaffold({ content: "" });
    expect(screen.getByTestId(STAND_IN_TESTID)).toBeTruthy();
  });

  test("whitespace-only content still counts as nothing to read", () => {
    renderScaffold({ content: "   \n  " });
    expect(screen.getByTestId(STAND_IN_TESTID)).toBeTruthy();
  });

  test("stays out of the way once the artifact has content", () => {
    renderScaffold({ content: "# A real PRD" });
    expect(screen.queryByTestId(STAND_IN_TESTID)).toBeNull();
  });

  // Reading an older version is a deliberate act. Covering it with a stand-in
  // would hide the thing the user navigated to on purpose.
  test("never covers a historical version the user chose to open", () => {
    renderScaffold({ content: "", currentVersion: 1 });
    expect(screen.queryByTestId(STAND_IN_TESTID)).toBeNull();
  });

  test("falls through to the editor when the caller has nothing to say", () => {
    renderScaffold({ content: "", standIn: null });
    expect(screen.queryByTestId(STAND_IN_TESTID)).toBeNull();
  });

  // NOT asserted here: that the editor is hidden rather than unmounted. It is
  // (see `editorBodyClassName`), and it matters -- unmounting would drop the
  // Liveblocks room and the content controller mid-run. But the editor never
  // reaches `isEditorReady` in jsdom with the leaves stubbed, so it carries the
  // same `invisible h-0` class either way and the assertion would pass whether
  // or not this feature exists. A test that cannot fail for the right reason is
  // worse than no test; the claim is covered by the helper's own shape instead.
});

/**
 * The visibility rule itself, which the mounted suite above cannot distinguish:
 * in jsdom the editor never reaches `isEditorReady`, so it carries the hidden
 * class either way. These assert the decision directly.
 */
describe("editor visibility while a stand-in shows", () => {
  test("hides the editor rather than unmounting it, even once ready", () => {
    expect(editorBodyClassName(true, true)).toBe(
      "invisible h-0 overflow-hidden"
    );
  });

  test("shows the editor normally when no stand-in is present", () => {
    expect(editorBodyClassName(true, false)).toBeUndefined();
  });

  test("keeps the editor hidden while it is still coming up", () => {
    expect(editorBodyClassName(false, false)).toBe(
      "invisible h-0 overflow-hidden"
    );
  });

  // A stand-in already explains the wait; a spinner underneath it is noise.
  test("suppresses the loading spinner behind a stand-in", () => {
    expect(editorLoaderClassName(false, true)).toBe("hidden");
  });

  test("still shows the spinner while loading with no stand-in", () => {
    expect(editorLoaderClassName(false, false)).toBe(
      "flex flex-1 items-center justify-center py-24"
    );
  });
});
