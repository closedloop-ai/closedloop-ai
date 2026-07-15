import type { Loop, StoredLoopEvent } from "@repo/api/src/types/loop";
import { LoopStatus } from "@repo/api/src/types/loop";
import { loopKeys } from "@repo/app/loops/hooks/loop-keys";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useLoopPolling } from "../use-loop-polling";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const LOOP_ID = "loop-123";
// Mirror EVENTS_PAGE_SIZE in use-loop-polling.ts.
const PAGE_SIZE = 500;

function makeEvent(index: number): StoredLoopEvent {
  return {
    id: `evt-${index}`,
    // storedAt ascending so the newest event is the keyset cursor.
    storedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    type: "progress",
    percent: 0,
    stage: `event ${index}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  };
}

function makeTerminalLoop(): Loop {
  // Only `status` is read by the hook for the terminal stop condition; the rest
  // of the Loop shape is irrelevant here.
  return { id: LOOP_ID, status: LoopStatus.Completed } as unknown as Loop;
}

describe("useLoopPolling incremental drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("drains every backlog page in one poll when more than one page is pending", async () => {
    // Seed the events cache with a cursor so the hook takes the keyset-delta
    // path rather than the one-time full fetch.
    const queryClient = createTestQueryClient();
    const seed = makeEvent(0);
    queryClient.setQueryData<StoredLoopEvent[]>(loopKeys.events(LOOP_ID), [
      seed,
    ]);

    // A full first page (=== PAGE_SIZE) signals more may remain; the short
    // second page (which carries the terminal event) means fully drained.
    const firstPage = Array.from({ length: PAGE_SIZE }, (_unused, i) =>
      makeEvent(i + 1)
    );
    const secondPage = [makeEvent(PAGE_SIZE + 1), makeEvent(PAGE_SIZE + 2)];

    // Key the mock on the cursor (sinceId) rather than a call counter so it
    // mirrors the real keyset server: idempotent, and empty once fully drained.
    // This keeps the test correct even if the events query re-executes.
    mockApiClient.get.mockImplementation((path: string) => {
      if (path === `/loops/${LOOP_ID}`) {
        return Promise.resolve(makeTerminalLoop());
      }
      if (path.includes("/events?since=")) {
        if (path.includes(`sinceId=${encodeURIComponent(seed.id)}`)) {
          return Promise.resolve(firstPage);
        }
        if (
          path.includes(`sinceId=${encodeURIComponent(`evt-${PAGE_SIZE}`)}`)
        ) {
          return Promise.resolve(secondPage);
        }
        // Cursor is at/after the last drained row — nothing new.
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useLoopPolling(LOOP_ID), {
      wrapper: createWrapperWithClient(queryClient),
    });

    await waitFor(() =>
      expect(result.current.events.length).toBe(
        1 + firstPage.length + secondPage.length
      )
    );

    const deltaPaths = mockApiClient.get.mock.calls
      .map((c) => String(c[0]))
      .filter((p) => p.includes("/events?since="));

    // Both backlog pages were fetched — the drain advanced the cursor from the
    // seed to the last row of the first full page within a single poll.
    expect(
      deltaPaths.some((p) =>
        p.includes(`sinceId=${encodeURIComponent(seed.id)}`)
      )
    ).toBe(true);
    expect(
      deltaPaths.some((p) =>
        p.includes(`sinceId=${encodeURIComponent(`evt-${PAGE_SIZE}`)}`)
      )
    ).toBe(true);

    // Requests carry the explicit page-size cap so full-page detection is exact.
    expect(deltaPaths.every((p) => p.includes(`limit=${PAGE_SIZE}`))).toBe(
      true
    );

    // Trailing (terminal) events are present, in order, not dropped.
    const events = result.current.events;
    expect(events[0].id).toBe(seed.id);
    expect(events.at(-1)?.id).toBe(`evt-${PAGE_SIZE + 2}`);
  });

  test("does not keep draining after a short page", async () => {
    const queryClient = createTestQueryClient();
    const seed = makeEvent(0);
    queryClient.setQueryData<StoredLoopEvent[]>(loopKeys.events(LOOP_ID), [
      seed,
    ]);

    // Only the seed cursor yields a (short) page; any request past it means the
    // drain loop kept going after a short page and would append a duplicate.
    mockApiClient.get.mockImplementation((path: string) => {
      if (path === `/loops/${LOOP_ID}`) {
        return Promise.resolve(makeTerminalLoop());
      }
      if (path.includes("/events?since=")) {
        if (path.includes(`sinceId=${encodeURIComponent(seed.id)}`)) {
          return Promise.resolve([makeEvent(1)]);
        }
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useLoopPolling(LOOP_ID), {
      wrapper: createWrapperWithClient(queryClient),
    });

    await waitFor(() => expect(result.current.events.length).toBe(2));

    // A short page ends the drain with no duplicate/extra rows: exactly the
    // seed plus the single new event, in order.
    expect(result.current.events.map((e) => e.id)).toEqual([seed.id, "evt-1"]);
  });
});
