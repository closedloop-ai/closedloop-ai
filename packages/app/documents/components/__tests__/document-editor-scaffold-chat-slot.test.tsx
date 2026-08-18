import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { DocumentEditorScaffold } from "../document-editor-scaffold";
import { FeedArtifactType } from "../feed-sidebar/types";

// Stub the heavy collaborative/editor leaves so the real scaffold can mount in
// jsdom without Liveblocks, Tiptap, or a live editor host. The gating logic
// under test (`!feedEnabled && chatEnabled ? renderChatPanel(ctx) : null`)
// lives in the scaffold itself and is exercised unmocked.
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
// Keep the room-less branch so no RoomProvider is required for the mount.
vi.mock("../../../users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: null, isLoading: false }),
}));

const CHAT_PANEL_TESTID = "legacy-chat-panel";

function createDocumentDetail(): DocumentDetail {
  const now = new Date("2026-06-12T00:00:00.000Z");
  return {
    id: "document-1",
    organizationId: "org-1",
    projectId: "project-1",
    type: DocumentType.Prd,
    title: "Chat slot doc",
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

function renderScaffold(enabledFlags: readonly string[]) {
  return render(
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      <DocumentEditorScaffold
        currentVersion={1}
        deleteDialogTitle="PRD"
        detailsSections={() => null}
        document={createDocumentDetail()}
        feedArtifactType={FeedArtifactType.Prd}
        onVersionChange={vi.fn()}
        redirectPath="/org-test/prds"
        renderChatPanel={() => <div data-testid={CHAT_PANEL_TESTID} />}
        renderChatTab={() => null}
        renderHeader={() => null}
        resizableAutoSaveId="scaffold-test"
      />
    </AppCoreStoryProviders>
  );
}

const INTERACTIVE_CHAT_FLAG = "interactive-chat";
const FEED_SIDEBAR_FLAG = "comments-v2-feed-sidebar";

describe("DocumentEditorScaffold legacy chat panel seam", () => {
  test("renders the injected chat panel only when chat is on and feed is off", () => {
    renderScaffold([INTERACTIVE_CHAT_FLAG]);
    expect(screen.getByTestId(CHAT_PANEL_TESTID)).toBeInTheDocument();
  });

  test("suppresses the legacy panel when the feed sidebar flag is also on", () => {
    renderScaffold([INTERACTIVE_CHAT_FLAG, FEED_SIDEBAR_FLAG]);
    expect(screen.queryByTestId(CHAT_PANEL_TESTID)).not.toBeInTheDocument();
  });

  test("suppresses the legacy panel when chat is off", () => {
    renderScaffold([]);
    expect(screen.queryByTestId(CHAT_PANEL_TESTID)).not.toBeInTheDocument();
  });
});
