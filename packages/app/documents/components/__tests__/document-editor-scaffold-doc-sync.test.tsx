import { DOC_SYNC_EDITOR_FLAG_KEY } from "@repo/api/src/types/doc-sync-editor-flag";
import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import { generateDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { DocumentEditorScaffold } from "../document-editor-scaffold";
import { FeedArtifactType } from "../feed-sidebar/types";

/**
 * PLN-2189 T-3.2: the scaffold is the editor tree's read of `doc-sync-editor`.
 * The user is signed in, so the Liveblocks room id is active in both cases and
 * only the flag decides whether a `DocSyncRoom` mounts.
 */
vi.mock("@repo/collaboration/client/optional-document-room", () => ({
  OptionalDocumentRoom: ({
    children,
    roomId,
  }: {
    children: ReactNode;
    roomId: string | null;
  }) => (
    <div data-room-id={roomId ?? ""} data-testid="liveblocks-room">
      {children}
    </div>
  ),
}));
vi.mock("@repo/collaboration/client/doc-sync-room", async () => {
  const { createContext, useContext } = await import("react");
  const OnDocSyncContext = createContext(false);
  return {
    DocSyncRoom: ({
      children,
      roomId,
      readOnly,
    }: {
      children: ReactNode;
      roomId: string;
      readOnly: boolean;
    }) => (
      <OnDocSyncContext.Provider value={true}>
        <div
          data-read-only={String(readOnly)}
          data-room-id={roomId}
          data-testid="doc-sync-room"
        >
          {children}
        </div>
      </OnDocSyncContext.Provider>
    ),
    useIsOnDocSync: () => useContext(OnDocSyncContext),
    useDocSyncRoom: () =>
      useContext(OnDocSyncContext) ? { room: null, failed: false } : undefined,
  };
});
vi.mock("@repo/collaboration/client/presence", () => ({
  InlinePresence: () => null,
}));
vi.mock("@repo/collaboration/client/scroll-to-anchor", () => ({
  scrollToAnchor: vi.fn(),
}));

const mockRichTextToolbar = vi.fn(
  (_props: { hasLiveblocksExtension: boolean }) => null
);

vi.mock("@repo/rich-text/rich-text-toolbar", () => ({
  RichTextToolbar: (props: { hasLiveblocksExtension: boolean }) =>
    mockRichTextToolbar(props),
}));
vi.mock("../collaborative-editor-body", () => ({
  CollaborativeEditorBody: () => <div data-testid="editor-body" />,
}));
vi.mock("../move-entity-dialog", () => ({
  MoveEntityDialog: () => null,
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

const mockUseDocumentVersionSignals = vi.fn();

vi.mock("../../hooks/use-document-version-signals", () => ({
  useDocumentVersionSignals: (config: unknown) =>
    mockUseDocumentVersionSignals(config),
}));
vi.mock("../../../users/hooks/use-users", () => ({
  useCurrentUser: () => ({
    data: { id: "user-1", organizationId: "org-1" },
    isLoading: false,
  }),
}));

const ROOM_ID = generateDocumentRoomId("org-1", "PRD-1");

describe("DocumentEditorScaffold doc-sync switch", () => {
  beforeEach(() => {
    mockRichTextToolbar.mockClear();
    mockUseDocumentVersionSignals.mockClear();
  });

  test.each([
    { transport: "doc-sync", flags: [DOC_SYNC_EDITOR_FLAG_KEY] },
    { transport: "Liveblocks", flags: [] },
  ])(
    "listens for version signals on the document on $transport",
    ({ flags }) => {
      renderScaffold(flags);

      expect(mockUseDocumentVersionSignals).toHaveBeenCalledWith({
        document: expect.objectContaining({
          id: "document-1",
          organizationId: "org-1",
        }),
        onRemoteVersionPublished: expect.any(Function),
      });
    }
  );

  test("mounts a DocSyncRoom on the active room when the flag is on", () => {
    renderScaffold([DOC_SYNC_EDITOR_FLAG_KEY]);

    const docSyncRoom = screen.getByTestId("doc-sync-room");
    expect(docSyncRoom).toHaveAttribute("data-room-id", ROOM_ID);
    expect(docSyncRoom).toHaveAttribute("data-read-only", "false");
    expect(screen.getByTestId("liveblocks-room")).toContainElement(docSyncRoom);
    expect(docSyncRoom).toContainElement(screen.getByTestId("editor-body"));
  });

  test("mounts no DocSyncRoom when the flag is off", () => {
    renderScaffold([]);

    expect(screen.getByTestId("liveblocks-room")).toHaveAttribute(
      "data-room-id",
      ROOM_ID
    );
    expect(screen.getByTestId("editor-body")).toBeInTheDocument();
    expect(screen.queryByTestId("doc-sync-room")).toBeNull();
  });

  test("the toolbar's Add Comment control is off under doc-sync and on without it", () => {
    renderScaffold([DOC_SYNC_EDITOR_FLAG_KEY], { editing: true });
    expect(mockRichTextToolbar).toHaveBeenLastCalledWith(
      expect.objectContaining({ hasLiveblocksExtension: false })
    );

    mockRichTextToolbar.mockClear();
    renderScaffold([], { editing: true });
    expect(mockRichTextToolbar).toHaveBeenLastCalledWith(
      expect.objectContaining({ hasLiveblocksExtension: true })
    );
  });
});

function renderScaffold(
  enabledFlags: readonly string[],
  options: { editing?: boolean } = {}
) {
  return render(
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      {scaffoldElement(options)}
    </AppCoreStoryProviders>
  );
}

/**
 * `editing` opens an empty latest version straight into edit mode (ISS-4382),
 * the only state in which the scaffold's toolbar renders.
 */
function scaffoldElement({ editing = false }: { editing?: boolean } = {}) {
  return (
    <DocumentEditorScaffold
      currentVersion={2}
      deleteDialogTitle="PRD"
      detailsSections={() => null}
      document={createDocumentDetail(editing ? "" : "# Body")}
      feedArtifactType={FeedArtifactType.Prd}
      onVersionChange={vi.fn()}
      redirectPath="/org-test/prds"
      renderHeader={() => null}
      startInEditModeWhenEmpty={editing}
    />
  );
}

function createDocumentDetail(content: string): DocumentDetail {
  const now = new Date("2026-10-15T00:00:00.000Z");
  return {
    id: "document-1",
    organizationId: "org-1",
    projectId: "project-1",
    type: DocumentType.Prd,
    title: "Doc-sync doc",
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
