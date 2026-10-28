// @vitest-environment jsdom

import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import { ArtifactList } from "@repo/app/artifacts/components/artifact-list";
import type {
  ArtifactListHostRendering,
  ArtifactListShellController,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-shell-content";
import {
  ArtifactKind,
  ArtifactStatus,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { act, render } from "@testing-library/react";
import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  controller: undefined as ArtifactListShellController | undefined,
  host: undefined as ArtifactListHostRendering | undefined,
  collaboratorReads: [] as { enabled?: boolean }[],
  update: vi.fn(),
  updateStatus: vi.fn(),
  renderRealShell: false,
}));
vi.mock("@repo/app/shared/hooks/use-artifact-collaborators", () => ({
  useArtifactCollaborators: (options: { enabled?: boolean }) => {
    captured.collaboratorReads.push(options);
    return {
      data: new Map([
        [
          "issue-1",
          {
            collaborators: {
              availability: BranchIdentityAvailability.Complete,
              people: [],
              sources: {},
            },
            commentCount: 4,
          },
        ],
        [
          "issue-2",
          {
            collaborators: {
              availability: BranchIdentityAvailability.Complete,
              people: [],
              sources: {},
            },
            commentCount: 0,
          },
        ],
      ]),
      isLoading: false,
    };
  },
}));
vi.mock("@repo/app/documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => ({
    data: [],
    isPending: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useIsFavoriteArtifact: () => false,
  useToggleFavoriteArtifact: () => ({ mutate: vi.fn() }),
}));
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => ({
    data: { id: "user-1", firstName: "Ada", lastName: "Lovelace" },
    isPending: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocuments: () => ({
    data: [],
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useUpdateDocument: () => ({ mutate: captured.update, mutateAsync: vi.fn() }),
}));
vi.mock("@repo/app/documents/hooks/use-related-sessions", () => ({
  useRelatedSessionsPage: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("@repo/app/artifacts/components/artifact-summary", () => ({
  ArtifactSummary: () => null,
}));
vi.mock(
  "@repo/app/documents/components/documents-prototype-custom-fields",
  () => ({
    useDocumentsPrototypeCustomFields: () => ({
      columns: [],
      renderCell: () => undefined,
      renderDialog: () => null,
    }),
    documentCustomFieldCreationValues: () => ({}),
  })
);
vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: () => ({
    sortBy: null,
    sortDir: "asc",
    setSort: vi.fn(),
    clearSort: vi.fn(),
  }),
}));
vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => path,
}));
vi.mock(
  "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-shells",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-shells")
      >();
    return {
      ...actual,
      GenericArtifactListView: (props: {
        controller: ArtifactListShellController;
        host: ArtifactListHostRendering;
      }) => {
        captured.controller = props.controller;
        captured.host = props.host;
        return captured.renderRealShell ? (
          <actual.GenericArtifactListView {...props} />
        ) : null;
      },
    };
  }
);

function issue(id: string) {
  return createMockDocument({
    id,
    type: DocumentType.Feature,
    slug: id.toUpperCase(),
    status: IssueStatus.Backlog,
  });
}

function currentController() {
  if (!captured.controller) {
    throw new Error("GenericArtifactListView was not rendered");
  }
  return captured.controller;
}

function mountBoard() {
  render(
    <ArtifactList
      artifactKind={ArtifactKind.Issue}
      documents={[issue("issue-1"), issue("issue-2")]}
      editHandlers={{ onUpdateStatus: captured.updateStatus }}
      filterText=""
      isError={false}
      isFetching={false}
      isLoading={false}
      isServerPaged={false}
      onFilterTextChange={vi.fn()}
      refetch={vi.fn()}
      searchAppliedUpstream={false}
      searchParams={{}}
      setScrollContainer={vi.fn()}
      sortPersistenceKey={null}
      storageKey={null}
    />,
    { wrapper: AppCoreStoryProviders }
  );
  act(() => {
    currentController().setVisibleColumnIds(new Set());
  });
  act(() => {
    currentController().setArtifactListLayout("board");
  });
  return currentController();
}

beforeEach(() => {
  captured.controller = undefined;
  captured.host = undefined;
  captured.collaboratorReads = [];
  captured.update.mockClear();
  captured.updateStatus.mockClear();
  captured.renderRealShell = false;
  localStorage.clear();
});

describe("ArtifactList board comment counts", () => {
  it("carries each artifact's comment count onto the board cards", () => {
    const controller = mountBoard();
    expect(controller.layout).toBe("board");
    const items = (controller.groupedArtifacts ?? []).flatMap(
      (group) => group.items
    );
    expect(
      Object.fromEntries(items.map((item) => [item.id, item.commentCount]))
    ).toEqual({ "issue-1": 4, "issue-2": 0 });
  });

  it("reads interactions on the board even with the comment columns hidden", () => {
    mountBoard();
    expect(captured.collaboratorReads.at(-1)?.enabled).toBe(true);
  });

  it("attributes the shared inline rename adapter to the inline-cell surface", () => {
    const controller = mountBoard();

    act(() => controller.updateArtifactTitle("issue-1", "Renamed issue"));

    expect(captured.update).toHaveBeenCalledWith({
      id: "issue-1",
      title: "Renamed issue",
      surface: ArtifactStatusEditSurface.InlineCell,
    });
  });

  it("keeps board status-menu provenance distinct from grid provenance", () => {
    const controller = mountBoard();
    const menu = captured.host?.renderBoardStatusMenu?.(
      controller.artifacts[0]!
    );
    if (!isValidElement<{ surface: ArtifactStatusEditSurface }>(menu)) {
      throw new Error("expected the production board status menu adapter");
    }
    expect(menu.props.surface).toBe(ArtifactStatusEditSurface.Board);

    act(() =>
      controller.changeArtifactStatus(
        "issue-1",
        ArtifactStatus.Done,
        ArtifactStatusEditSurface.Board
      )
    );
    act(() =>
      controller.changeArtifactStatus(
        "issue-1",
        ArtifactStatus.Done,
        ArtifactStatusEditSurface.InlineCell
      )
    );

    expect(captured.updateStatus).toHaveBeenNthCalledWith(
      1,
      "issue-1",
      IssueStatus.Done,
      ArtifactStatusEditSurface.Board
    );
    expect(captured.updateStatus).toHaveBeenNthCalledWith(
      2,
      "issue-1",
      IssueStatus.Done,
      ArtifactStatusEditSurface.InlineCell
    );
  });

  it("keeps board group-drop provenance distinct from grid provenance", () => {
    const controller = mountBoard();

    act(() =>
      controller.applyGroupDrop(
        "issue-1",
        "status",
        ARTIFACT_STATUS_ROOT.Done,
        undefined,
        undefined,
        undefined,
        ArtifactStatusEditSurface.Board
      )
    );
    act(() =>
      controller.applyGroupDrop(
        "issue-1",
        "status",
        ARTIFACT_STATUS_ROOT.Done,
        undefined,
        undefined,
        undefined,
        ArtifactStatusEditSurface.InlineCell
      )
    );

    expect(captured.update).toHaveBeenNthCalledWith(1, {
      id: "issue-1",
      status: IssueStatus.Done,
      surface: ArtifactStatusEditSurface.Board,
    });
    expect(captured.update).toHaveBeenNthCalledWith(2, {
      id: "issue-1",
      status: IssueStatus.Done,
      surface: ArtifactStatusEditSurface.InlineCell,
    });
  });

  it("does not write when a card is dropped onto its current status", () => {
    const controller = mountBoard();

    act(() =>
      controller.applyGroupDrop(
        "issue-1",
        "status",
        IssueStatus.Backlog,
        undefined,
        undefined,
        undefined,
        ArtifactStatusEditSurface.Board
      )
    );

    expect(captured.update).not.toHaveBeenCalled();
  });

  it("clears selected rows when board layout unmounts the list grid", () => {
    captured.renderRealShell = true;
    const controller = mountBoard();
    act(() => controller.setArtifactListLayout("list"));
    act(() => controller.setSelectedArtifactIds(new Set(["issue-1"])));
    expect(currentController().selectedArtifactIds).toEqual(
      new Set(["issue-1"])
    );

    act(() => currentController().setArtifactListLayout("board"));

    expect(currentController().selectedArtifactIds).toEqual(new Set());
  });
});
