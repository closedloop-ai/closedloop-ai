// @vitest-environment jsdom

import {
  ArtifactList,
  type ArtifactListProps,
} from "@repo/app/artifacts/components/artifact-list";
import type {
  ArtifactListHostRendering,
  ArtifactListShellController,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-shell-content";
import { ARTIFACT_LIST_SUMMARY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { createWrapper } from "@repo/app/shared/test-utils";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  documents: vi.fn(),
  favorites: vi.fn(),
  user: vi.fn(),
  summary: vi.fn(),
  costs: vi.fn(),
  retryFavorites: vi.fn(),
  retryUser: vi.fn(),
  retryDocuments: vi.fn(),
}));
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) =>
    key === ARTIFACT_LIST_SUMMARY_FEATURE_FLAG_KEY,
  useFeatureFlagEnabledOptional: () => false,
}));
vi.mock("@repo/app/shared/hooks/use-artifact-collaborators", () => ({
  useArtifactCollaborators: () => ({ data: new Map(), isLoading: false }),
}));
vi.mock("../../hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: mocks.favorites,
  useToggleFavoriteArtifact: () => ({ mutate: vi.fn() }),
}));
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: mocks.user,
}));
vi.mock("../../hooks/use-documents", () => ({
  useDocuments: (...args: unknown[]) => {
    mocks.documents(...args);
    return {
      data: [],
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: mocks.retryDocuments,
    };
  },
  useUpdateDocument: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));
vi.mock("../../hooks/use-related-sessions", () => ({
  useRelatedSessionsPage: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("../../hooks/use-documents-summary", () => ({
  useDocumentsSummary: mocks.summary,
}));
vi.mock("../../hooks/use-documents-costs", () => ({
  useDocumentsCosts: mocks.costs,
}));
vi.mock("../documents-prototype-custom-fields", () => ({
  useDocumentsPrototypeCustomFields: () => ({
    columns: [],
    renderCell: () => undefined,
    renderDialog: () => null,
  }),
  documentCustomFieldCreationValues: () => ({}),
}));
vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: () => ({
    sortBy: null,
    sortDir: "asc",
    setSort: vi.fn(),
    clearSort: vi.fn(),
  }),
}));
vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ push: vi.fn() }),
}));
vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => path,
}));
vi.mock(
  "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-shells",
  () => ({
    GenericArtifactListView: ({
      controller,
      host,
    }: {
      controller: ArtifactListShellController;
      host: ArtifactListHostRendering;
    }) => (
      <>
        <button
          onClick={() =>
            controller.setFilters((filters) => ({
              ...filters,
              favoritesOnly: true,
            }))
          }
          type="button"
        >
          Favorites
        </button>
        <button
          onClick={() =>
            controller.setFilters((filters) => ({ ...filters, mineOnly: true }))
          }
          type="button"
        >
          Mine
        </button>
        {host.summary}
        {host.resultsState ??
          controller.displayedArtifacts.map((artifact) => (
            <div key={artifact.id}>{artifact.title}</div>
          ))}
        {host.resultsNotice}
      </>
    ),
  })
);

const document = createMockDocument({
  id: "document-1",
  title: "Actual document",
  assigneeId: "user-1",
  updatedAt: new Date(),
  createdAt: new Date(),
});
function mount(overrides: Partial<ArtifactListProps> = {}) {
  const props: ArtifactListProps = {
    documents: [document],
    filterText: "",
    onFilterTextChange: vi.fn(),
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: mocks.retryDocuments,
    searchAppliedUpstream: false,
    editHandlers: {},
    setScrollContainer: vi.fn(),
    searchParams: {},
    isServerPaged: false,
    sortPersistenceKey: null,
    storageKey: null,
    ...overrides,
  };
  return render(<ArtifactList {...props} />, { wrapper: createWrapper() });
}
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
  localStorage.clear();
  mocks.favorites.mockReturnValue({
    data: [],
    isPending: false,
    isFetching: false,
    isError: false,
    refetch: mocks.retryFavorites,
  });
  mocks.user.mockReturnValue({
    data: { id: "user-1", firstName: "Ada", lastName: "Lovelace" },
    isPending: false,
    isFetching: false,
    isError: false,
    refetch: mocks.retryUser,
  });
  mocks.summary.mockReturnValue({
    data: { total: 1, producedByAgentSessions: 1, updatedInWindow: 1 },
    isLoading: false,
    isError: false,
  });
  mocks.costs.mockImplementation((ids: string[]) => ({
    data: {
      totalEstimatedCost: ids.length ? 1 : 0,
      medianEstimatedCost: ids.length ? 1 : undefined,
    },
    isLoading: false,
    isError: false,
  }));
});
describe("production list dependent filters", () => {
  for (const filter of ["Favorites", "Mine"]) {
    for (const pending of [true, false]) {
      it(`${filter} withholds empty metrics when its supporting read is ${pending ? "pending" : "failed"}`, () => {
        const dependent = filter === "Favorites" ? mocks.favorites : mocks.user;
        const retry =
          filter === "Favorites" ? mocks.retryFavorites : mocks.retryUser;
        dependent.mockReturnValue({
          data: undefined,
          isPending: pending,
          isFetching: pending,
          isError: !pending,
          refetch: retry,
        });
        mount();
        // An unrelated unresolved dependency does not block the initial population.
        expect(screen.getByText("Actual document")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: filter }));
        expect(screen.queryByText("$0.00")).toBeNull();
        expect(screen.queryByText("0")).toBeNull();
        expect(serverRead(mocks.costs)?.[2]).toEqual({ enabled: false });
        if (pending) {
          expect(screen.getByText("Loading documents…")).toBeTruthy();
        } else {
          expect(screen.getByText("Couldn't load documents")).toBeTruthy();
          expect(
            screen.queryByText("No documents match your search")
          ).toBeNull();
          fireEvent.click(screen.getByRole("button", { name: "Try again" }));
          expect(retry).toHaveBeenCalledTimes(1);
        }
      });
    }
  }
  it("renders a real empty Favorites result after its supporting read succeeds", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Favorites" }));
    expect(screen.getByText("No documents match your search")).toBeTruthy();
    expect(screen.getByText("$0.00")).toBeTruthy();
    expect(serverRead(mocks.costs)?.[2]).toEqual({ enabled: true });
  });
});

it("leaves the unbounded read disabled on a paged default view with both cost cards visible", () => {
  mount({ isServerPaged: true });
  expect(mocks.documents).toHaveBeenCalledWith(expect.anything(), {
    enabled: false,
  });
});

/**
 * The cards issue their server-scope read, then the (normally disabled)
 * complete-cohort fallback read, on every render (ISS-12600).
 */
function serverRead(mock: { mock: { calls: unknown[][] } }) {
  return mock.mock.calls.at(-2);
}
