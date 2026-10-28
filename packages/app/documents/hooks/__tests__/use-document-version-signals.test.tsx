import type { DocumentDetail } from "@repo/api/src/types/document";
import { createTestQueryClient } from "@repo/app/shared/test-utils";
import { RoomEventType } from "@repo/collaboration/shared/room-events";
import {
  ChannelKind,
  formatChannelAddress,
} from "@repo/realtime-contract/channels";
import { DocumentVersionSignalType } from "@repo/realtime-contract/signals";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeRealtimePort } from "../../../shared/realtime/__tests__/fake-realtime-port";
import { RealtimeProvider } from "../../../shared/realtime/realtime-provider";
import { useDocumentRoomEvents } from "../use-document-room-events";
import { useDocumentVersionSignals } from "../use-document-version-signals";
import { useRemoteVersionPublished } from "../use-remote-version-published";

const ORG_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const DOCUMENT_ID = "01a140d8-7298-7688-8841-0a3cc7d38719";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  toast: vi.fn(),
  roomEventHandler: null as
    | ((data: { event: unknown }) => void | Promise<void>)
    | null,
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: mocks.apiGet }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: (message: string) => mocks.toast(message),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => true,
}));

vi.mock("@liveblocks/react", () => ({
  useEventListener: (
    handler: (data: { event: unknown }) => void | Promise<void>
  ) => {
    mocks.roomEventHandler = handler;
  },
}));

function documentAt(latestVersion: number): DocumentDetail {
  return {
    id: DOCUMENT_ID,
    organizationId: ORG_ID,
    slug: "PLN-7",
    latestVersion,
    version: { content: `v${latestVersion}`, version: latestVersion },
  } as DocumentDetail;
}

/** The scaffold's wiring: one version handler, fed by the signal and the Liveblocks room event. */
function mountEditor({ latestVersion }: { latestVersion: number }) {
  const realtime = createFakeRealtimePort();
  const queryClient = createTestQueryClient();
  const onVersionChange = vi.fn();
  const setEditorContent = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <RealtimeProvider client={realtime.port}>{children}</RealtimeProvider>
    </QueryClientProvider>
  );
  renderHook(
    () => {
      const document = documentAt(latestVersion);
      const { handleRemoteVersionPublished } = useRemoteVersionPublished({
        document,
        currentVersion: latestVersion,
        onVersionChange,
        setEditorContent,
      });
      useDocumentVersionSignals({
        document,
        onRemoteVersionPublished: handleRemoteVersionPublished,
      });
      useDocumentRoomEvents({
        documentId: DOCUMENT_ID,
        onRemoteVersionPublished: handleRemoteVersionPublished,
      });
    },
    { wrapper }
  );
  return { realtime, onVersionChange, setEditorContent };
}

const PUBLISHED_V6 = {
  type: DocumentVersionSignalType.Published,
  data: { version: 6 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.roomEventHandler = null;
  mocks.apiGet.mockResolvedValue(documentAt(6));
});

describe("useDocumentVersionSignals", () => {
  it("joins the document's document-versions channel, and a signal refetches and advances the version", async () => {
    const { realtime, onVersionChange } = mountEditor({ latestVersion: 5 });

    expect(realtime.joins.map((joined) => joined.channel)).toEqual([
      formatChannelAddress(ChannelKind.DocumentVersions, ORG_ID, [DOCUMENT_ID]),
    ]);
    act(() => realtime.onlyListener().onSignal(PUBLISHED_V6));

    await waitFor(() => expect(onVersionChange).toHaveBeenCalledWith(6));
    expect(mocks.apiGet).toHaveBeenCalledWith(`/documents/${DOCUMENT_ID}`);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("refetches and advances on a resync, so a signal missed offline still lands", async () => {
    const { realtime, onVersionChange } = mountEditor({ latestVersion: 5 });

    act(() => realtime.onlyListener().onResync());

    await waitFor(() => expect(onVersionChange).toHaveBeenCalledWith(6));
  });

  it("does nothing for a version the editor already shows", async () => {
    const { realtime, onVersionChange } = mountEditor({ latestVersion: 6 });

    act(() => realtime.onlyListener().onSignal(PUBLISHED_V6));

    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledTimes(1));
    expect(onVersionChange).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("acts once on a version that arrives as both the Liveblocks room event and the signal", async () => {
    const { realtime, onVersionChange } = mountEditor({ latestVersion: 5 });

    await act(async () => {
      await mocks.roomEventHandler?.({
        event: {
          type: RoomEventType.DocumentVersionPublished,
          version: 6,
          publisherId: null,
          publishedAt: "2026-10-20T12:00:00.000Z",
        },
      });
    });
    act(() => realtime.onlyListener().onSignal(PUBLISHED_V6));

    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalledTimes(2));
    expect(onVersionChange).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });
});
