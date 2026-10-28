import type { ThreadData } from "@liveblocks/client";
import { DocumentThreadAnchorStatus } from "@repo/api/src/types/comment";
import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { DocumentEditorScaffold } from "../document-editor-scaffold";
import { DocumentHostProvider } from "../document-host-context";
import { FeedArtifactType } from "../feed-sidebar/types";

// Stub the heavy collaborative/editor leaves so the real scaffold can mount in
// jsdom without Liveblocks, Tiptap, or a live editor host. The rail's gating
// lives in the scaffold itself and is exercised unmocked.
vi.mock("@repo/collaboration/client/optional-document-room", () => ({
  OptionalDocumentRoom: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@repo/collaboration/client/presence", () => ({
  InlinePresence: () => null,
}));
const mockScrollToAnchor = vi.hoisted(() => vi.fn());
vi.mock("@repo/collaboration/client/scroll-to-anchor", () => ({
  scrollToAnchor: mockScrollToAnchor,
}));
vi.mock("@repo/rich-text/rich-text-toolbar", () => ({
  RichTextToolbar: () => null,
}));
vi.mock("../collaborative-editor-body", () => ({
  CollaborativeEditorBody: () => null,
}));
type CapturedRailProps = {
  enabled: boolean;
  onCommentClick?: (thread: ThreadData) => void;
};
const mockDocumentFeedRail = vi.fn((_props: CapturedRailProps) => null);
vi.mock("../editor/document-feed-rail", () => ({
  DocumentFeedRail: (props: CapturedRailProps) => mockDocumentFeedRail(props),
}));
vi.mock("../editor/document-room-event-listener", () => ({
  DocumentRoomEventListener: () => null,
}));
vi.mock("../editor/editable-document-title", () => ({
  EditableDocumentTitle: () => null,
}));
// A resolved user gives the scaffold an active room, so the rail's `enabled`
// is decided by the scaffold's own gate rather than by a room-less document.
vi.mock("../../../users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: { id: "user-1" }, isLoading: false }),
}));

const capturedActionRedirects = vi.hoisted(() => [] as string[]);
vi.mock("../../hooks/use-document-actions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../hooks/use-document-actions")>();
  return {
    useDocumentActions: (
      config: Parameters<typeof actual.useDocumentActions>[0]
    ) => {
      capturedActionRedirects.push(config.redirectPath);
      return actual.useDocumentActions(config);
    },
  };
});

function createDocumentDetail(): DocumentDetail {
  const now = new Date("2026-06-12T00:00:00.000Z");
  return {
    id: "document-1",
    organizationId: "org-1",
    projectId: "project-1",
    type: DocumentType.Prd,
    title: "Feed rail doc",
    slug: "PRD-1",
    fileName: null,
    status: "DRAFT",
    priority: "MEDIUM",
    latestVersion: 1,
    latestVersionContent: "",
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
      id: "version-1",
      documentId: "document-1",
      version: 1,
      content: "",
      createdById: "user-1",
      createdAt: now,
    },
  };
}

function renderScaffold(
  enabledFlags: readonly string[],
  deleteRedirectPath?: string
) {
  const scaffold = (
    <DocumentEditorScaffold
      currentVersion={1}
      deleteDialogTitle="PRD"
      detailsSections={() => null}
      document={createDocumentDetail()}
      feedArtifactType={FeedArtifactType.Prd}
      onVersionChange={vi.fn()}
      redirectPath="/org-test/prds"
      renderHeader={() => null}
    />
  );
  return render(
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      {deleteRedirectPath === undefined ? (
        scaffold
      ) : (
        <DocumentHostProvider
          deleteRedirectPath={deleteRedirectPath}
          orgSlug="org-test"
        >
          {scaffold}
        </DocumentHostProvider>
      )}
    </AppCoreStoryProviders>
  );
}

function lastRailProps(): CapturedRailProps | undefined {
  return mockDocumentFeedRail.mock.calls.at(-1)?.[0];
}

describe("DocumentEditorScaffold feed rail", () => {
  beforeEach(() => {
    mockDocumentFeedRail.mockClear();
  });

  test("mounts the feed rail enabled when no flags are set", () => {
    renderScaffold([]);

    expect(lastRailProps()?.enabled).toBe(true);
  });
});

describe("DocumentEditorScaffold delete redirect", () => {
  beforeEach(() => {
    capturedActionRedirects.length = 0;
  });

  test("returns to the editor's own path when the host names none", () => {
    renderScaffold([]);

    expect(capturedActionRedirects.at(-1)).toBe("/org-test/prds");
  });

  test("returns to the host's path when the host names one", () => {
    renderScaffold([], "/documents");

    expect(capturedActionRedirects.at(-1)).toBe("/documents");
  });
});

describe("DocumentEditorScaffold anchored comment reveal", () => {
  beforeEach(() => {
    mockScrollToAnchor.mockClear();
  });

  // The editor body is stubbed, so the editor never reports content-ready —
  // the state a direct `?tab=sessions` load is in when the Artifact panel first
  // commits.
  test("does not scroll to an anchor before the editor has content", () => {
    renderScaffold([]);

    act(() => {
      lastRailProps()?.onCommentClick?.({
        id: "thread-1",
        metadata: {
          anchorStatus: DocumentThreadAnchorStatus.Anchored,
          anchorPreview: "quoted text",
        },
      } as unknown as ThreadData);
    });

    expect(mockScrollToAnchor).not.toHaveBeenCalled();
  });
});
