import { Priority } from "@repo/api/src/types/common";
import {
  DocumentStatus,
  DocumentType,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { PRDEditor } from "../prd-editor";

const mockClearDecomposeTargetState = vi.fn();
const mockHandleDecomposeFeatures = vi.fn();
const mockUsePrdActions = vi.fn();
const SELECT_TARGET_BUTTON_NAME = /select target/i;

vi.mock("@/hooks/document-editing/use-prd-actions", () => ({
  usePrdActions: () => mockUsePrdActions(),
}));

vi.mock("@/components/document-editor/document-editor-scaffold", () => ({
  DocumentEditorScaffold: ({
    floatingChildren,
  }: {
    floatingChildren: (ctx: unknown) => ReactNode;
  }) => <div>{floatingChildren(createScaffoldContext())}</div>,
}));

vi.mock("@/components/engineer/LoopDispatchTargetSelector", () => ({
  LoopDispatchTargetSelector: ({
    availableTargets,
    onSelect,
  }: {
    availableTargets: Array<{ id: string; machineName: string }>;
    onSelect: (targetId: string) => void;
  }) => (
    <button onClick={() => onSelect(availableTargets[0].id)} type="button">
      Select {availableTargets[0].machineName}
    </button>
  ),
}));

vi.mock("@repo/app/documents/components/rename-dialog", () => ({
  RenameDialog: () => null,
}));

vi.mock(
  "@/app/(authenticated)/[orgSlug]/implementation-plans/components/new-plan-modal",
  () => ({
    NewPlanModal: () => null,
  })
);

vi.mock(
  "@/app/(authenticated)/[orgSlug]/implementation-plans/components/request-changes-modal",
  () => ({
    RequestChangesModal: () => null,
  })
);

vi.mock("@/components/document-editor/document-chat-tab", () => ({
  DocumentChatTab: () => null,
}));

vi.mock("@/components/document-editor/evaluation-section", () => ({
  EvaluationSection: () => null,
}));

vi.mock("@repo/app/documents/components/generation-status-banner", () => ({
  GenerationStatusBanner: () => null,
}));

vi.mock("@repo/app/judges-analytics/hooks/use-judges", () => ({
  usePrdJudgesFeedback: () => ({ data: null }),
}));

vi.mock("@repo/app/documents/hooks/use-prd-modals", () => ({
  usePrdModals: () => ({
    generatePlan: {
      mountKey: "generate-plan",
      onOpenChange: vi.fn(),
      open: false,
      openModal: vi.fn(),
    },
    rename: { open: false, openModal: vi.fn(), setOpen: vi.fn() },
    requestChanges: { open: false, openModal: vi.fn(), setOpen: vi.fn() },
  }),
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDismissDocumentGenerationStatus: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
  useDocumentGenerationStatus: () => ({
    data: null,
    invalidateCache: vi.fn(),
    isLoading: false,
  }),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "org",
}));

vi.mock("../components/associated-artifacts-section", () => ({
  AssociatedArtifactsSection: () => null,
}));

vi.mock("../components/prd-editor-header", () => ({
  PRDEditorHeader: () => null,
}));

describe("PRDEditor decompose target replay", () => {
  it("clears visible selector state before replaying with the selected target", () => {
    mockUsePrdActions.mockReturnValue(createPrdActions());

    render(
      <PRDEditor
        currentVersion={1}
        document={createDocument()}
        onVersionChange={vi.fn()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: SELECT_TARGET_BUTTON_NAME })
    );

    expect(mockClearDecomposeTargetState).toHaveBeenCalledOnce();
    expect(mockHandleDecomposeFeatures).toHaveBeenCalledWith("target-1");
    expect(
      mockClearDecomposeTargetState.mock.invocationCallOrder[0]
    ).toBeLessThan(mockHandleDecomposeFeatures.mock.invocationCallOrder[0]);
  });
});

function createPrdActions() {
  return {
    clearDecomposeTargetState: mockClearDecomposeTargetState,
    decomposeTargetState: {
      availableTargets: [
        { id: "target-1", machineName: "Target One", status: "online" },
      ],
    },
    handleDecomposeFeatures: mockHandleDecomposeFeatures,
    handleEvaluatePrd: vi.fn(),
    handleGeneratePrd: vi.fn(),
    handleRequestChanges: vi.fn(),
    isDecomposing: false,
    isEvaluating: false,
    isGenerating: false,
    isRequestingChanges: false,
    multiTargetState: null,
    selectTarget: vi.fn(),
  };
}

function createDocument() {
  return {
    id: "prd-1",
    approver: null,
    approverId: null,
    assignee: null,
    assigneeId: null,
    content: "PRD content",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    createdById: "user-1",
    currentVersion: 1,
    fileName: "prd.md",
    latestVersion: 1,
    latestVersionContent: "PRD content",
    organizationId: "org-1",
    priority: Priority.Medium,
    project: null,
    projectId: null,
    repositorySnapshot: {
      repositories: [],
      source: SnapshotSource.None,
    },
    slug: "prd-1",
    status: DocumentStatus.Draft,
    sortOrder: null,
    templateForType: null,
    title: "Test PRD",
    tokenUsage: null,
    type: DocumentType.Prd,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    version: {
      id: "version-1",
      content: "PRD content",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      createdById: "user-1",
      documentId: "prd-1",
      version: 1,
    },
  };
}

function createScaffoldContext() {
  return {
    actions: {
      handleDownload: vi.fn(),
      handleRename: vi.fn(),
    },
    chatEnabled: false,
    chrome: {
      openDeleteDialog: vi.fn(),
      openMoveDialog: vi.fn(),
      openRenameDialog: vi.fn(),
      toggleMetadataPanel: vi.fn(),
    },
    contentController: {
      restoreVersion: vi.fn(),
    },
    document: createDocument(),
    feedEnabled: false,
    isPending: false,
    session: {
      isViewingHistorical: false,
    },
  };
}
