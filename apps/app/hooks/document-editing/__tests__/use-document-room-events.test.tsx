import type { DocumentDetail } from "@repo/api/src/types/document";
import { useDocumentRoomEvents } from "@repo/app/documents/hooks/use-document-room-events";
import { RoomEventType } from "@repo/collaboration/shared/room-events";
import { QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@/hooks/queries/__tests__/test-utils";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let registeredHandler:
  | ((data: { event: unknown }) => void | Promise<void>)
  | null = null;

vi.mock("@liveblocks/react", () => ({
  useEventListener: (
    cb: (data: { event: unknown }) => void | Promise<void>
  ) => {
    registeredHandler = cb;
  },
}));

const mockApiGet = vi.fn();
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: mockApiGet }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUpdatedDoc(
  overrides: Partial<DocumentDetail> = {}
): DocumentDetail {
  return {
    id: "doc-1",
    slug: "PRD-42",
    latestVersion: 5,
    version: { content: "# new content", version: 5 },
    ...overrides,
  } as DocumentDetail;
}

function renderTheHook(onRemoteVersionPublished: (d: DocumentDetail) => void) {
  const queryClient = createTestQueryClient();
  const wrapper = createWrapperWithClient(queryClient);
  renderHook(
    () =>
      useDocumentRoomEvents({
        documentId: "doc-1",
        onRemoteVersionPublished,
      }),
    { wrapper }
  );
  return { queryClient };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useDocumentRoomEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandler = null;
    mockApiGet.mockResolvedValue(buildUpdatedDoc());
  });

  it("reacts to events even when publisherId matches the current user (no user-level dedup)", async () => {
    // Regression guard: the hook must NOT short-circuit on
    // `publisherId === currentUser`. A headless client acting as the user
    // (e.g. an MCP agent creating a version) shares the user's id but never
    // ran this browser's mutation onSuccess, so suppressing the event here
    // would leave the user's open editor stuck on stale content. Idempotency
    // for the tab that did publish is enforced downstream in the scaffold's
    // onRemoteVersionPublished, not by skipping the refetch here.
    const updated = buildUpdatedDoc({ latestVersion: 6 });
    mockApiGet.mockResolvedValueOnce(updated);
    const callback = vi.fn();
    renderTheHook(callback);

    await registeredHandler?.({
      event: {
        type: RoomEventType.DocumentVersionPublished,
        version: 6,
        publisherId: "current-user-1",
        publishedAt: "2026-05-26T18:00:00.000Z",
      },
    });

    await waitFor(() => {
      expect(callback).toHaveBeenCalledWith(updated);
    });
    expect(mockApiGet).toHaveBeenCalledWith("/documents/doc-1");
  });

  it("refetches and invokes callback for events from other users", async () => {
    const updated = buildUpdatedDoc({ latestVersion: 6 });
    mockApiGet.mockResolvedValueOnce(updated);
    const callback = vi.fn();
    renderTheHook(callback);

    await registeredHandler?.({
      event: {
        type: RoomEventType.DocumentVersionPublished,
        version: 6,
        publisherId: "other-user",
        publishedAt: "2026-05-26T18:00:00.000Z",
      },
    });

    await waitFor(() => {
      expect(callback).toHaveBeenCalledWith(updated);
    });
    expect(mockApiGet).toHaveBeenCalledWith("/documents/doc-1");
  });

  it("refetches and invokes callback for system-driven events (publisherId=null)", async () => {
    const updated = buildUpdatedDoc({ latestVersion: 7 });
    mockApiGet.mockResolvedValueOnce(updated);
    const callback = vi.fn();
    renderTheHook(callback);

    await registeredHandler?.({
      event: {
        type: RoomEventType.DocumentVersionPublished,
        version: 7,
        publisherId: null,
        publishedAt: "2026-05-26T18:00:00.000Z",
      },
    });

    await waitFor(() => {
      expect(callback).toHaveBeenCalledWith(updated);
    });
  });

  it("ignores events with an unknown type", async () => {
    const callback = vi.fn();
    renderTheHook(callback);

    await registeredHandler?.({
      event: {
        type: "some-other-event",
        version: 5,
        publisherId: "other-user",
        publishedAt: "2026-05-26T18:00:00.000Z",
      },
    });

    expect(mockApiGet).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it("refetches over the network even when a cached entry exists (refetch() bypasses staleTime)", async () => {
    // Regression for the global QueryClient staleTime:60s — useDocument's
    // refetch() must always hit the network. If the hook ever switched
    // back to fetchQuery without an explicit staleTime override, this
    // test would catch it: a cached pre-publish entry would be returned
    // instead of the fresh server payload.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: 60 * 1000 },
        mutations: { retry: false },
      },
    });
    const cachedStale = buildUpdatedDoc({
      latestVersion: 4,
      version: {
        id: "v-stale",
        documentId: "doc-1",
        version: 4,
        content: "# stale",
        createdById: "other-user",
        createdAt: new Date("2026-05-26T17:00:00.000Z"),
      },
    });
    queryClient.setQueryData(["documents", "detail", "doc-1"], cachedStale);

    const fresh = buildUpdatedDoc({
      latestVersion: 5,
      version: {
        id: "v-fresh",
        documentId: "doc-1",
        version: 5,
        content: "# fresh",
        createdById: "other-user",
        createdAt: new Date("2026-05-26T18:00:00.000Z"),
      },
    });
    mockApiGet.mockResolvedValueOnce(fresh);

    const callback = vi.fn();
    const wrapper = createWrapperWithClient(queryClient);
    renderHook(
      () =>
        useDocumentRoomEvents({
          documentId: "doc-1",
          onRemoteVersionPublished: callback,
        }),
      { wrapper }
    );

    await registeredHandler?.({
      event: {
        type: RoomEventType.DocumentVersionPublished,
        version: 5,
        publisherId: "other-user",
        publishedAt: "2026-05-26T18:00:00.000Z",
      },
    });

    await waitFor(() => {
      expect(callback).toHaveBeenCalledWith(fresh);
    });
    expect(mockApiGet).toHaveBeenCalledWith("/documents/doc-1");
  });

  it("primes the document detail cache with the fetched payload", async () => {
    const updated = buildUpdatedDoc({ latestVersion: 8 });
    mockApiGet.mockResolvedValueOnce(updated);
    const { queryClient } = renderTheHook(() => undefined);

    await registeredHandler?.({
      event: {
        type: RoomEventType.DocumentVersionPublished,
        version: 8,
        publisherId: "other-user",
        publishedAt: "2026-05-26T18:00:00.000Z",
      },
    });

    await waitFor(() => {
      const cached = queryClient.getQueryData(["documents", "detail", "doc-1"]);
      expect(cached).toEqual(updated);
    });
  });
});
