// @vitest-environment jsdom

import { DISPLAYED_ARTIFACT_STATUS } from "@repo/api/src/types/artifact-status";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { ARTIFACT_STATUS_DISPLAY_LABELS } from "@repo/api/src/types/artifact-status-display";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import {
  ArtifactList,
  type ArtifactListProps,
} from "@repo/app/artifacts/components/artifact-list";
import type {
  ArtifactListHostRendering,
  ArtifactListShellController,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-shell-content";
import { ArtifactKind } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { ARTIFACT_LIST_SUMMARY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  controller: undefined as ArtifactListShellController | undefined,
  host: undefined as ArtifactListHostRendering | undefined,
  collaboratorReads: [] as { enabled?: boolean }[],
  renderRealShell: false,
  sort: { sortBy: null as string | null, sortDir: "asc" },
  enabledFlags: new Set<string>(),
}));
vi.mock(
  "@repo/app/shared/feature-flags/use-feature-flag-enabled",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/app/shared/feature-flags/use-feature-flag-enabled")
    >()),
    useFeatureFlagEnabled: (key: string) => captured.enabledFlags.has(key),
    useFeatureFlagEnabledOptional: (key: string) =>
      captured.enabledFlags.has(key),
  })
);
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
const favoritesRead = vi.hoisted(() => ({ isPending: false }));
vi.mock("@repo/app/documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => ({
    data: favoritesRead.isPending ? undefined : [],
    isPending: favoritesRead.isPending,
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
  useUpdateDocument: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));
vi.mock("@repo/app/documents/hooks/use-related-sessions", () => ({
  useRelatedSessionsPage: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("@repo/app/artifacts/components/artifact-summary", () => ({
  ArtifactSummary: () => <div data-testid="artifact-summary" />,
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
    ...captured.sort,
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
        if (captured.renderRealShell) {
          return <actual.GenericArtifactListView {...props} />;
        }
        captured.controller = props.controller;
        captured.host = props.host;
        const firstArtifact = props.controller.artifacts[0];
        return (
          <>
            {props.host.summary}
            <div data-testid="narrow-production-lead">
              {firstArtifact
                ? props.host.renderLead?.(firstArtifact, { isNarrowList: true })
                : null}
            </div>
          </>
        );
      },
    };
  }
);

function mountServerPaged(
  onListReadChange: ArtifactListProps["onListReadChange"],
  editHandlers: ArtifactListProps["editHandlers"] = {}
) {
  const navigation = createMemoryNavigation({
    initialPath: "/org/artifacts",
    orgSlug: "org",
  });
  render(
    <NavigationProvider adapter={navigation.adapter}>
      <ArtifactList
        artifactKind={ArtifactKind.Issue}
        documents={[
          createMockDocument({
            id: "issue-1",
            type: DocumentType.Feature,
            status: IssueStatus.Backlog,
          }),
        ]}
        editHandlers={editHandlers}
        filterText=""
        isError={false}
        isFetching={false}
        isLoading={false}
        isServerPaged
        onFilterTextChange={vi.fn()}
        onListReadChange={onListReadChange}
        refetch={vi.fn()}
        searchAppliedUpstream={false}
        searchParams={{}}
        setScrollContainer={vi.fn()}
        sortPersistenceKey={null}
        storageKey={null}
      />
    </NavigationProvider>,
    { wrapper: AppCoreStoryProviders }
  );
}

beforeEach(() => {
  favoritesRead.isPending = false;
  captured.controller = undefined;
  captured.host = undefined;
  captured.renderRealShell = false;
  captured.sort = { sortBy: null, sortDir: "asc" };
  captured.enabledFlags = new Set();
});

describe("ArtifactList read report", () => {
  it("keeps the compact document status editable before its narrow title", async () => {
    const user = userEvent.setup();
    const onUpdateStatus = vi.fn();
    mountServerPaged(vi.fn(), { onUpdateStatus });
    const lead = screen.getByTestId("narrow-production-lead");
    const status = lead.querySelector("[data-slot='status-icon']");
    const title = within(lead).getByText("Test Artifact");

    expect(captured.host?.renderLead).toBeDefined();
    expect(status).not.toBeNull();
    expect(
      status?.compareDocumentPosition(title) ?? Node.DOCUMENT_POSITION_PRECEDING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const trigger = status?.closest("button");
    expect(trigger).toHaveClass("h-7", "w-7");
    if (!trigger) {
      throw new Error("Missing narrow status trigger");
    }
    await user.click(trigger);
    await user.click(
      await screen.findByRole("menuitem", {
        name: ARTIFACT_STATUS_DISPLAY_LABELS[
          DISPLAYED_ARTIFACT_STATUS.InReview
        ],
      })
    );
    expect(onUpdateStatus).toHaveBeenCalledExactlyOnceWith(
      "issue-1",
      IssueStatus.InReview,
      ArtifactStatusEditSurface.InlineCell
    );
  });

  it("hands the shared star an unread favorites list as unavailable, not empty", () => {
    favoritesRead.isPending = true;
    mountServerPaged(vi.fn());
    expect(captured.controller?.favoritesUnavailable).toBe(true);
    expect(captured.controller?.favoriteArtifactIds.size).toBe(0);
    expect(captured.controller?.pendingFavoriteArtifactIds?.size).toBe(0);
  });

  it("hands the shared star a settled favorites list as available", () => {
    mountServerPaged(vi.fn());
    expect(captured.controller?.favoritesUnavailable).toBe(false);
  });

  it("reports the server-paged read while nothing needs every row", () => {
    const onListReadChange = vi.fn();
    mountServerPaged(onListReadChange);
    expect(onListReadChange).toHaveBeenLastCalledWith({
      completeRead: false,
      sortBy: null,
      sortDir: "asc",
    });
  });

  it("reports the complete read and the rendered order once a sort is active", () => {
    captured.sort = { sortBy: "currentVersion", sortDir: "desc" };
    const onListReadChange = vi.fn();
    mountServerPaged(onListReadChange);
    expect(onListReadChange).toHaveBeenLastCalledWith({
      completeRead: true,
      sortBy: "currentVersion",
      sortDir: "desc",
    });
  });

  it("clears selected ids when filtering to no results replaces the grid", () => {
    captured.renderRealShell = true;
    const document = createMockDocument({
      id: "issue-1",
      type: DocumentType.Feature,
      status: IssueStatus.Backlog,
    });
    const props = {
      artifactKind: ArtifactKind.Issue,
      documents: [document],
      editHandlers: {},
      isError: false,
      isFetching: false,
      isLoading: false,
      isServerPaged: false,
      onFilterTextChange: vi.fn(),
      refetch: vi.fn(),
      searchAppliedUpstream: false,
      searchParams: {},
      setScrollContainer: vi.fn(),
      sortPersistenceKey: null,
      storageKey: null,
    } satisfies Omit<ArtifactListProps, "filterText">;
    const rendered = render(<ArtifactList {...props} filterText="" />, {
      wrapper: AppCoreStoryProviders,
    });
    const cell = rendered.container.querySelector<HTMLElement>(
      '[data-grid-row-id="issue-1"] [data-column-id="updated"]'
    );
    if (!cell) {
      throw new Error("Expected the real Artifact List row");
    }
    fireEvent.click(cell);
    expect(artifactRow(document.id)).toHaveAttribute("aria-selected", "true");

    rendered.rerender(<ArtifactList {...props} filterText="no match" />);
    expect(
      rendered.container.querySelector('[data-grid-row-id="issue-1"]')
    ).toBeNull();
    expect(
      screen.getByRole("status", { name: "No artifacts selected" })
    ).toBeInTheDocument();

    rendered.rerender(<ArtifactList {...props} filterText="" />);

    expect(artifactRow(document.id)).toHaveAttribute("aria-selected", "false");
  });
});

function artifactRow(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-grid-row-id="${id}"]`);
  if (!row) {
    throw new Error(`Expected Artifact List row ${id}`);
  }
  return row;
}

describe("ArtifactList summary row flag", () => {
  it("renders no summary row while the flag is off", () => {
    mountServerPaged(vi.fn());
    expect(screen.queryByTestId("artifact-summary")).toBeNull();
  });

  it("renders the summary row once the flag is on", async () => {
    captured.enabledFlags = new Set([ARTIFACT_LIST_SUMMARY_FEATURE_FLAG_KEY]);
    mountServerPaged(vi.fn());
    expect(await screen.findByTestId("artifact-summary")).toBeTruthy();
  });
});
