/**
 * ISS-10102. `/artifact-links/resolved` is bounded per response now, so
 * `useResolvedArtifactLinks` FOLLOWS the cursor internally and still resolves
 * the whole set.
 *
 * That is the load-bearing half of the change for the product: two shipped
 * surfaces read this hook — `associated-artifacts-section` and
 * `branches-section` — and each renders a document's complete lineage with
 * no paging affordance of its own. A hook that returned only the first page
 * would silently cap both, which is exactly the capability loss the
 * operator ruling chose pagination to avoid. These cases fail if it ever stops
 * at page one.
 */
import type {
  ArtifactLinkEndpoint,
  ArtifactLinkWithEndpoints,
} from "@repo/api/src/types/artifact";
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { useResolvedArtifactLinks } from "@repo/app/documents/hooks/use-artifact-links";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiClient: { get: vi.fn() },
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mocks.apiClient,
}));

function buildEndpoint(id: string): ArtifactLinkEndpoint {
  return {
    id,
    organizationId: "org-1",
    projectId: "project-1",
    status: "ACTIVE",
    priority: null,
    assigneeId: null,
    assignee: null,
    createdById: "user-1",
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    type: ArtifactType.Document,
    subtype: null,
    name: id,
    slug: id,
    externalUrl: null,
    dueDate: null,
    sortOrder: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}

function buildLink(id: string): ArtifactLinkWithEndpoints {
  return {
    id,
    organizationId: "org-1",
    sourceId: "feature-1",
    targetId: `artifact-${id}`,
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    source: buildEndpoint("feature-1"),
    target: buildEndpoint(`artifact-${id}`),
  };
}

function renderResolvedLinks() {
  return renderHook(() => useResolvedArtifactLinks("feature-1"), {
    wrapper: createWrapperWithClient(createTestQueryClient()),
  });
}

function requestedParam(name: string): (string | null)[] {
  return mocks.apiClient.get.mock.calls.map((call) =>
    new URL(String(call[0]), "http://api.test").searchParams.get(name)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useResolvedArtifactLinks — cursor following (ISS-10102)", () => {
  test("reassembles every page into the one array the surfaces render", async () => {
    mocks.apiClient.get
      .mockResolvedValueOnce({
        items: [buildLink("a"), buildLink("b")],
        nextCursor: "1000",
        snapshotId: "00000000-0000-4000-8000-000000000001",
      })
      .mockResolvedValueOnce({
        items: [buildLink("c")],
        nextCursor: "2000",
      })
      .mockResolvedValueOnce({ items: [buildLink("d")] });

    const { result } = renderResolvedLinks();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((link) => link.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(mocks.apiClient.get).toHaveBeenCalledTimes(3);
    expect(requestedParam("cursor")).toEqual([null, "1000", "2000"]);
    expect(requestedParam("snapshotId")).toEqual([
      null,
      "00000000-0000-4000-8000-000000000001",
      null,
    ]);
  });

  test("opts in with paginated=true on every request, not just the first", async () => {
    mocks.apiClient.get
      .mockResolvedValueOnce({ items: [buildLink("a")], nextCursor: "1000" })
      .mockResolvedValueOnce({ items: [buildLink("b")] });

    const { result } = renderResolvedLinks();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestedParam("paginated")).toEqual(["true", "true"]);
  });

  test("stops on an ABSENT cursor, not on a short page", async () => {
    // Page one is neither full nor final. Only the absent cursor ends the walk,
    // so a hook that inferred completeness from page length would drop page two
    // and cap the surface without saying so.
    mocks.apiClient.get
      .mockResolvedValueOnce({ items: [buildLink("a")], nextCursor: "1" })
      .mockResolvedValueOnce({ items: [buildLink("b")] });

    const { result } = renderResolvedLinks();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(2);
    expect(mocks.apiClient.get).toHaveBeenCalledTimes(2);
  });

  test("terminates instead of looping when a cursor fails to advance", async () => {
    mocks.apiClient.get.mockResolvedValue({
      items: [buildLink("a")],
      nextCursor: "7",
    });

    const { result } = renderResolvedLinks();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Two reads: the first learns cursor "7", the second is answered with the
    // same "7" and stops. A hook that trusted the cursor would never resolve.
    expect(mocks.apiClient.get).toHaveBeenCalledTimes(2);
    expect(result.current.data).toHaveLength(2);
  });

  test("degrades to the bare array when the api predates ISS-10102", async () => {
    // `apps/app` and `apps/api` ship independently. An older api ignores
    // `paginated=true` and answers with the array it always did — reading
    // `.items` off that is `undefined`, and spreading it throws. A signed-in
    // user mid-deploy must see links, not an error boundary.
    mocks.apiClient.get.mockResolvedValue([buildLink("a"), buildLink("b")]);

    const { result } = renderResolvedLinks();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((link) => link.id)).toEqual(["a", "b"]);
    expect(mocks.apiClient.get).toHaveBeenCalledTimes(1);
  });
});
