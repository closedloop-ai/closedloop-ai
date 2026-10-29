import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { IssueStatus } from "@repo/api/src/types/document";
import type { ProjectArtifactBoardPageResponse } from "@repo/api/src/types/project-artifact-board-page";
import { ProjectArtifactBoardGroup } from "@repo/api/src/types/project-artifact-board-page";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../shared/api/api-error";
import {
  mergeProjectArtifactBoardPages,
  projectArtifactBoardPageKeys,
  useProjectArtifactBoardPage,
} from "./use-project-artifact-board-page";

const mockApiClient = { get: vi.fn() };

vi.mock("../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const PROJECT_ID = "11111111-1111-7111-8111-111111111111";
const ROOT_A = "22222222-2222-7222-8222-222222222222";
const ROOT_B = "33333333-3333-7333-8333-333333333333";
const REVISION = "a".repeat(64);

function page(
  revision: string,
  rootId: string,
  complete: boolean
): ProjectArtifactBoardPageResponse {
  return {
    lanes: [
      {
        cards: [
          {
            artifact: {
              assignee: null,
              assigneeId: null,
              createdAt: new Date("2026-10-19T00:00:00.000Z"),
              createdById: null,
              dueDate: null,
              externalUrl: null,
              id: rootId,
              name: rootId,
              organizationId: "44444444-4444-7444-8444-444444444444",
              priority: null,
              projectId: PROJECT_ID,
              slug: rootId,
              sortOrder: null,
              status: IssueStatus.Todo,
              subtype: ArtifactSubtype.Feature,
              type: ArtifactType.Document,
              updatedAt: new Date("2026-10-19T00:00:00.000Z"),
            },
            descendantCount: 0,
          },
        ],
        complete,
        count: 2,
        id: IssueStatus.Todo,
        label: IssueStatus.Todo,
      },
    ],
    populationRevision: revision,
    rootIds: [ROOT_A, ROOT_B],
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function wrapperWithClient(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CT-08 board infinite-query merge", () => {
  it("merges pages per lane without duplicate cards and preserves counts", () => {
    const merged = mergeProjectArtifactBoardPages([
      page("revision", "a", false),
      page("revision", "b", true),
      page("revision", "a", true),
    ]);
    expect(merged.lanes[0]?.cards.map((card) => card.artifact.id)).toEqual([
      "a",
      "b",
    ]);
    expect(merged.lanes[0]).toMatchObject({ count: 2, complete: true });
    expect(merged.rootIds).toEqual([ROOT_A, ROOT_B]);
  });

  it("refuses pages from a different population revision", () => {
    const merged = mergeProjectArtifactBoardPages([
      page("old", "a", false),
      page("new", "b", true),
    ]);
    expect(merged.populationRevision).toBe("old");
    expect(merged.lanes[0]?.cards.map((card) => card.artifact.id)).toEqual([
      "a",
    ]);
  });

  it("keeps the first page's placement version as the move fence", () => {
    const merged = mergeProjectArtifactBoardPages([
      { ...page("revision", ROOT_A, false), projectVersion: "first" },
      { ...page("revision", ROOT_B, true), projectVersion: "later" },
    ]);
    expect(merged.projectVersion).toBe("first");
  });

  it("accumulates bounded page root identities without duplicates", () => {
    const first = { ...page("revision", ROOT_A, false), rootIds: [ROOT_A] };
    const second = { ...page("revision", ROOT_B, true), rootIds: [ROOT_B] };

    expect(mergeProjectArtifactBoardPages([first, second]).rootIds).toEqual([
      ROOT_A,
      ROOT_B,
    ]);
  });
});

describe("CT-08 production infinite-query wiring", () => {
  it("sends the bounded request and propagates the opaque continuation", async () => {
    mockApiClient.get
      .mockResolvedValueOnce({
        ...page(REVISION, ROOT_A, false),
        nextCursor: "next",
      })
      .mockResolvedValueOnce(page(REVISION, ROOT_B, true));
    const rendered = renderHook(
      () =>
        useProjectArtifactBoardPage(
          PROJECT_ID,
          ProjectArtifactBoardGroup.Status
        ),
      { wrapper }
    );
    await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true));
    expect(mockApiClient.get).toHaveBeenNthCalledWith(
      1,
      `/projects/${PROJECT_ID}/artifacts/board?groupBy=status&pageSize=40`
    );
    await act(async () => {
      await rendered.result.current.fetchNextPage();
    });
    expect(mockApiClient.get).toHaveBeenNthCalledWith(
      2,
      `/projects/${PROJECT_ID}/artifacts/board?groupBy=status&pageSize=40&cursor=next`
    );
  });

  it("ISS-12929 724-F5 carries the filters on every page request and keys the cache by them", async () => {
    mockApiClient.get
      .mockResolvedValueOnce({
        ...page(REVISION, ROOT_A, false),
        nextCursor: "next",
      })
      .mockResolvedValueOnce(page(REVISION, ROOT_B, true));
    const filters = { hideCompletedItems: true, search: "apollo" };
    const rendered = renderHook(
      () =>
        useProjectArtifactBoardPage(
          PROJECT_ID,
          ProjectArtifactBoardGroup.Status,
          { filters }
        ),
      { wrapper }
    );
    await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true));
    await act(async () => {
      await rendered.result.current.fetchNextPage();
    });
    expect(mockApiClient.get).toHaveBeenNthCalledWith(
      1,
      `/projects/${PROJECT_ID}/artifacts/board?groupBy=status&pageSize=40&search=apollo&hideCompletedItems=true`
    );
    expect(mockApiClient.get).toHaveBeenNthCalledWith(
      2,
      `/projects/${PROJECT_ID}/artifacts/board?groupBy=status&pageSize=40&cursor=next&search=apollo&hideCompletedItems=true`
    );
    expect(
      projectArtifactBoardPageKeys.detail(
        PROJECT_ID,
        ProjectArtifactBoardGroup.Status,
        filters
      )
    ).not.toEqual(
      projectArtifactBoardPageKeys.detail(
        PROJECT_ID,
        ProjectArtifactBoardGroup.Status
      )
    );
  });

  it("fails closed when a skewed response has an unknown shape", async () => {
    mockApiClient.get.mockResolvedValue({
      lanes: [],
      populationRevision: "newer-contract",
      rootIds: [],
      unknown: true,
    });
    const rendered = renderHook(
      () =>
        useProjectArtifactBoardPage(
          PROJECT_ID,
          ProjectArtifactBoardGroup.Status
        ),
      { wrapper }
    );
    await waitFor(() => expect(rendered.result.current.isError).toBe(true));
    expect(rendered.result.current.data).toBeUndefined();
  });

  it("CT-08 restarts from the first page after a stale population revision", async () => {
    mockApiClient.get
      .mockRejectedValueOnce(
        new ApiError("Project ordering changed since it was read", 409, {
          code: "stale_revision",
        })
      )
      .mockResolvedValueOnce(page(REVISION, ROOT_A, true));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const rendered = renderHook(
      () =>
        useProjectArtifactBoardPage(
          PROJECT_ID,
          ProjectArtifactBoardGroup.Status
        ),
      { wrapper: wrapperWithClient(client) }
    );

    await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true));
    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
    expect(mockApiClient.get).toHaveBeenLastCalledWith(
      `/projects/${PROJECT_ID}/artifacts/board?groupBy=status&pageSize=40`
    );
  });

  it("CT-17 reuses a fresh board cache across a list/board remount", async () => {
    mockApiClient.get.mockResolvedValue(page(REVISION, ROOT_A, true));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const first = renderHook(
      () =>
        useProjectArtifactBoardPage(
          PROJECT_ID,
          ProjectArtifactBoardGroup.Status
        ),
      { wrapper: wrapperWithClient(client) }
    );
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    const second = renderHook(
      () =>
        useProjectArtifactBoardPage(
          PROJECT_ID,
          ProjectArtifactBoardGroup.Status
        ),
      { wrapper: wrapperWithClient(client) }
    );
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledTimes(1);
  });
});
