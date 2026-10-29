import { Priority } from "@repo/api/src/types/common";
import type { DocumentDetail } from "@repo/api/src/types/document";
import {
  DocumentStatus,
  DocumentType,
  SnapshotSource,
} from "@repo/api/src/types/document";
import {
  createMemoryNavigation,
  type MemoryNavigation,
} from "@repo/navigation/memory-adapter";
import { fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { DocumentEditorScaffold } from "../document-editor-scaffold";
import { FeedArtifactType } from "../feed-sidebar/types";

/**
 * ISS-8939: the generic-Document editor is a CONFIGURATION of the one shared
 * scaffold, never a second editor. Each case below mounts the SAME
 * `DocumentEditorScaffold` twice — once in the lean DOC configuration
 * `DocumentEditor` composes, once in the rich PRD configuration `PRDEditor`
 * composes — and asserts the same locator in opposite states, so an absence
 * assertion can never be satisfied by a subtree that failed to render.
 *
 * Same leaf stubs as the sibling empty-content suite so the real scaffold
 * mounts in jsdom without Liveblocks or Tiptap; the configuration logic under
 * test runs unmocked.
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
// The body owns three things this suite reads: the scaffold's read-only
// decision, which has no DOM of its own in jsdom; the `headerContent` slot the
// real metadata bar renders into; and `onBodyClick`, which is how a reader asks
// to start editing. The stub forwards that click to a real element so the
// enter-edit path is EXERCISED rather than snapshotted at mount. Tiptap itself
// is what the stub replaces.
const EDITOR_BODY_TESTID = "collaborative-editor-body";
const editorBodyProbe = vi.hoisted(() => ({
  readOnly: undefined as boolean | undefined,
}));
vi.mock("../collaborative-editor-body", () => ({
  CollaborativeEditorBody: (props: {
    readOnly?: boolean;
    headerContent?: ReactNode;
    onBodyClick?: () => void;
  }) => {
    const [draft, setDraft] = useState("");
    editorBodyProbe.readOnly = props.readOnly;
    return (
      <div>
        {props.headerContent}
        <textarea
          data-testid="editor-draft"
          onChange={(event) => setDraft(event.target.value)}
          value={draft}
        />
        <button
          data-testid={EDITOR_BODY_TESTID}
          onClick={props.onBodyClick}
          type="button"
        />
      </div>
    );
  },
}));
vi.mock("../document-sessions-tab", () => ({
  DocumentSessionsTab: () => <div>Scoped sessions</div>,
}));
vi.mock("../document-shell-activity", () => ({
  DocumentShellActivity: () => <div>Shared activity</div>,
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
const userReads = vi.hoisted(() => ({
  organizationUsers: vi.fn(() => ({ data: [] })),
}));
vi.mock("../../../users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: null, isLoading: false }),
  useOrganizationUsers: userReads.organizationUsers,
}));

const PRD_DETAILS_SECTION_TESTID = "prd-details-section";
// The literal `ArtifactRepositoriesSummary` renders for an artifact whose
// snapshot lists nothing — the permanent placeholder an org-level Document
// would always show, and the one ISS-8939 requires be absent for a DOC.
const NO_REPOSITORIES_PLACEHOLDER = "No repositories";

function createDocumentDetail(options: {
  type: DocumentType;
  content: string;
  latestVersion: number;
  currentVersion: number;
}): DocumentDetail {
  const now = new Date("2026-06-12T00:00:00.000Z");
  return {
    id: "document-1",
    organizationId: "org-1",
    projectId: null,
    type: options.type,
    title: "Onboarding notes",
    slug: "onboarding-notes",
    fileName: null,
    status: DocumentStatus.Draft,
    priority: Priority.Medium,
    latestVersion: options.latestVersion,
    latestVersionContent: options.content,
    createdById: "user-1",
    createdBy: null,
    assigneeId: null,
    assignee: null,
    approverId: null,
    approver: null,
    repositorySnapshot: {
      createdAt: now.toISOString(),
      repositories: [],
      source: SnapshotSource.None,
    },
    templateForType: null,
    sortOrder: null,
    createdAt: now,
    updatedAt: now,
    version: {
      id: `version-${options.currentVersion}`,
      documentId: "document-1",
      version: options.currentVersion,
      content: options.content,
      createdById: "user-1",
      createdAt: now,
    },
  };
}

/**
 * The two production configurations, spelled out as whole shapes. `lean` mirrors
 * `apps/app/.../documents/[slug]/document-editor.tsx`; `rich` mirrors
 * the PRD editor `apps/app/.../documents/[slug]/document-editor.tsx` dispatches
 * to. Both go through the same scaffold.
 */
type ScaffoldOptions = {
  configuration: "lean" | "rich";
  content: string;
  latestVersion?: number;
  currentVersion?: number;
  navigation?: MemoryNavigation;
  enabledFlags?: readonly string[];
};

function scaffoldElement(options: ScaffoldOptions) {
  const lean = options.configuration === "lean";
  const latestVersion = options.latestVersion ?? 1;
  const currentVersion = options.currentVersion ?? latestVersion;
  return (
    <AppCoreStoryProviders
      enabledFlags={options.enabledFlags ?? []}
      navigationAdapter={options.navigation?.adapter}
      queryData={[[["document-comments", "document-1"], []]]}
    >
      <DocumentEditorScaffold
        currentVersion={currentVersion}
        deleteDialogTitle={lean ? "Document" : "PRD"}
        detailsSections={() =>
          lean ? null : <div data-testid={PRD_DETAILS_SECTION_TESTID} />
        }
        document={createDocumentDetail({
          type: lean ? DocumentType.Doc : DocumentType.Prd,
          content: options.content,
          latestVersion,
          currentVersion,
        })}
        feedArtifactType={lean ? FeedArtifactType.Doc : FeedArtifactType.Prd}
        hideMoveAction={lean}
        hideRepositoriesInMetadataBar={lean}
        onVersionChange={vi.fn()}
        redirectPath="/acme/documents"
        renderHeader={() => null}
        startInEditModeWhenEmpty={lean}
      />
    </AppCoreStoryProviders>
  );
}

function renderScaffold(options: ScaffoldOptions) {
  return render(scaffoldElement(options));
}

describe("generic-Document editor configuration (ISS-8939)", () => {
  beforeEach(() => {
    editorBodyProbe.readOnly = undefined;
  });

  test("a generic Document renders no repository placeholder in its metadata bar", () => {
    renderScaffold({ configuration: "lean", content: "Some notes." });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Details" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(
      screen.queryByText(NO_REPOSITORIES_PLACEHOLDER)
    ).not.toBeInTheDocument();
  });

  // The sibling that makes the absence above non-vacuous: the SAME locator, in
  // the SAME scaffold, on the PRD configuration, where it does render.
  test("a PRD renders that same repository placeholder in Details", () => {
    renderScaffold({ configuration: "rich", content: "Some notes." });

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Details" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByText(NO_REPOSITORIES_PLACEHOLDER)).toBeInTheDocument();
  });

  // Pins the scaffold's half of the contract only — that a slot returning null
  // puts nothing in the details region. That the generic Document's slot IS the
  // one returning null is a production fact, and it is pinned where production
  // owns it (`apps/app/.../__tests__/document-editor-lean-wiring.test.tsx`),
  // not here, where the harness supplies the slot.
  test("the details region renders nothing when the slot returns null", () => {
    renderScaffold({ configuration: "lean", content: "Some notes." });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Details" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(
      screen.queryByTestId(PRD_DETAILS_SECTION_TESTID)
    ).not.toBeInTheDocument();
  });

  test("a PRD renders its detail sections in that same region", () => {
    renderScaffold({ configuration: "rich", content: "Some notes." });

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Details" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByTestId(PRD_DETAILS_SECTION_TESTID)).toBeInTheDocument();
  });

  test("a blank latest version opens typable rather than read-only", () => {
    renderScaffold({ configuration: "lean", content: "" });

    expect(editorBodyProbe.readOnly).toBe(false);
  });

  // Same locator, opposite state: the configuration that does not ask for it
  // still opens a blank latest version read-only.
  test("the rich configuration leaves a blank latest version read-only", () => {
    renderScaffold({ configuration: "rich", content: "" });

    expect(editorBodyProbe.readOnly).toBe(true);
  });

  test("a historical version stays read-only even when it is blank", () => {
    renderScaffold({
      configuration: "lean",
      content: "",
      latestVersion: 3,
      currentVersion: 1,
    });

    expect(editorBodyProbe.readOnly).toBe(true);
  });

  // AC3's real claim: not merely that a historical version OPENS read-only, but
  // that it cannot be edited in place. Asking to edit it is the only way to
  // observe that; a mount-time snapshot would pass even if the click flipped it.
  test("clicking a historical version's body does not start editing it", () => {
    renderScaffold({
      configuration: "lean",
      content: "",
      latestVersion: 3,
      currentVersion: 1,
    });

    fireEvent.click(screen.getByTestId(EDITOR_BODY_TESTID));

    expect(editorBodyProbe.readOnly).toBe(true);
  });

  // The seed is masked on a historical mount — `isViewingHistorical` forces
  // read-only either way — so mounting historical cannot observe it. Moving to
  // the latest version is what unmasks it: the edit-mode hook is never
  // remounted across a version change, so a seed of `true` taken on the blank
  // historical version drops the reader into edit mode on arrival at a version
  // they only asked to read.
  test("arriving at the latest version from a blank historical one does not start editing", () => {
    const options = {
      configuration: "lean",
      content: "",
      latestVersion: 3,
    } as const;
    const { rerender } = renderScaffold({ ...options, currentVersion: 1 });

    rerender(scaffoldElement({ ...options, currentVersion: 3 }));

    expect(editorBodyProbe.readOnly).toBe(true);
  });

  // The same click on the latest version DOES start editing, so the assertion
  // above cannot be satisfied by a click that never reached the scaffold.
  test("clicking the latest version's body starts editing it", () => {
    renderScaffold({
      configuration: "lean",
      content: "Already written.",
      latestVersion: 3,
      currentVersion: 3,
    });
    expect(editorBodyProbe.readOnly).toBe(true);

    fireEvent.click(screen.getByTestId(EDITOR_BODY_TESTID));

    expect(editorBodyProbe.readOnly).toBe(false);
  });

  test("a populated latest version is not force-edited", () => {
    renderScaffold({ configuration: "lean", content: "Already written." });

    expect(editorBodyProbe.readOnly).toBe(true);
  });
});

describe("Document detail tab shell", () => {
  test("honors tab deep links and preserves version parameters during navigation", () => {
    const navigation = createMemoryNavigation({
      initialPath:
        "/org-test/implementation-plans/PLN-1?version=2&tab=activity",
      orgSlug: "org-test",
    });
    renderScaffold({
      configuration: "rich",
      content: "Version two.",
      navigation,
    });
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.queryByTestId("editor-draft")).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Details" }), {
      button: 0,
      ctrlKey: false,
    });
    const search = new URLSearchParams(
      navigation.getCurrentHref().split("?")[1]
    );
    expect(search.get("tab")).toBe("details");
    expect(search.get("version")).toBe("2");
  });

  test("preserves an artifact comment draft when Details is hidden", () => {
    renderScaffold({
      configuration: "rich",
      content: "Existing content.",
      enabledFlags: ["the-one-flag"],
    });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Details" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    fireEvent.change(screen.getByLabelText("Add a comment"), {
      target: { value: "Unposted comment draft" },
    });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Activity" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(userReads.organizationUsers).toHaveBeenLastCalledWith({
      enabled: false,
    });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Details" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(userReads.organizationUsers).toHaveBeenLastCalledWith({
      enabled: true,
    });
    expect(screen.getByLabelText("Add a comment")).toHaveValue(
      "Unposted comment draft"
    );
  });

  test("uses the approved tab order and preserves the editor draft across tabs", () => {
    renderScaffold({ configuration: "rich", content: "Existing content." });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Artifact",
      "Sessions",
      "Details",
      "Activity",
    ]);
    const draft = screen.getByTestId("editor-draft");
    fireEvent.change(draft, { target: { value: "Unsaved document draft" } });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Sessions" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByText("Scoped sessions")).toBeVisible();
    expect(screen.getByTestId("editor-draft")).toBe(draft);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Activity" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByText("Shared activity")).toBeVisible();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Artifact" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByTestId("editor-draft")).toHaveValue(
      "Unsaved document draft"
    );
  });
});
