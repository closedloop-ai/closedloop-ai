import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import type { CommentThreadDto } from "@repo/api/src/types/comment-thread-dto";
import { type PollLoop, startListenerPoll } from "@repo/realtime-client/poll";
import {
  type RealtimeChannelListener,
  type RealtimeClientPort,
  RealtimeStatus,
} from "@repo/realtime-client/port";
import { CommentSignalType } from "@repo/realtime-contract/signals";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/api-error";
import {
  CommentsPaneLoadStatus,
  NEW_THREAD_DRAFT_KEY,
} from "../../components/comments/comments-pane-model";
import { RealtimeProvider } from "../../realtime/realtime-provider";
import { createTestQueryClient } from "../../test-utils";
import {
  type ArtifactCommentsCollection,
  artifactCommentKeys,
} from "../artifact-comments-cache";
import { useArtifactComments } from "../use-artifact-comments";
import {
  ARTIFACT_ID,
  fakeCommentsSource,
  ORG_ID,
  pagedList,
  threadsOf,
} from "./comments-test-source";

type Joined = { channel: string; listener: RealtimeChannelListener };

/** A port that runs each listener's real poll loop, with liveness the test sets. */
function livenessPort() {
  const joins: Joined[] = [];
  const loops: PollLoop[] = [];
  let live = false;
  const port: RealtimeClientPort = {
    join: (channel, listener) => {
      joins.push({ channel, listener });
      const loop = startListenerPoll(listener, live);
      if (loop) {
        loops.push(loop);
      }
      return () => loop?.stop();
    },
    status: () => RealtimeStatus.Open,
    onStatus: () => () => undefined,
  };
  return {
    port,
    joins,
    setLive(next: boolean) {
      live = next;
      for (const loop of loops) {
        loop.setLive(next);
      }
    },
    listener(): RealtimeChannelListener {
      const [joined] = joins;
      if (!joined) {
        throw new Error("nothing joined");
      }
      return joined.listener;
    },
  };
}

function setup(
  source: ReturnType<typeof fakeCommentsSource>,
  { targetId = ARTIFACT_ID }: { targetId?: string } = {}
) {
  const queryClient = createTestQueryClient();
  const realtime = livenessPort();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <RealtimeProvider client={realtime.port}>{children}</RealtimeProvider>
    </QueryClientProvider>
  );
  const view = renderHook(
    ({ id }: { id: string }) =>
      useArtifactComments(
        { id },
        { dataSource: source, organizationId: ORG_ID }
      ),
    { wrapper, initialProps: { id: targetId } }
  );
  return { ...view, queryClient, realtime };
}

function signal(thread: CommentThreadDto, threadRevision: number) {
  return {
    type: CommentSignalType.ThreadUpdated,
    data: { threadId: thread.id, threadRevision },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useArtifactComments: reads and signals", () => {
  it("joins the channel the first read names, though the target was a session id", async () => {
    const source = fakeCommentsSource(threadsOf(2));
    const { result, realtime } = setup(source, { targetId: "ext-session" });

    await waitFor(() =>
      expect(result.current.loadState.status).toBe(CommentsPaneLoadStatus.Ready)
    );

    expect(source.list).toHaveBeenCalledWith("ext-session", expect.anything());
    expect(realtime.joins.map(({ channel }) => channel)).toEqual([
      `comments:${ORG_ID}:${ARTIFACT_ID}`,
    ]);
  });

  it("fetches nothing for a signal at the held revision, and only that thread for a newer one", async () => {
    const [first, second] = threadsOf(2);
    const source = fakeCommentsSource([first, second]);
    source.getThread.mockResolvedValue({ ...first, revision: 2 });
    const { result, realtime } = setup(source);
    await waitFor(() => expect(result.current.threads).toHaveLength(2));

    act(() => realtime.listener().onSignal(signal(first, 1)));
    expect(source.getThread).not.toHaveBeenCalled();

    act(() => realtime.listener().onSignal(signal(first, 2)));
    await waitFor(() => expect(result.current.threads[0]?.revision).toBe(2));
    expect(source.getThread).toHaveBeenCalledTimes(1);
    expect(source.getThread).toHaveBeenCalledWith(first.id);
    expect(source.list).toHaveBeenCalledTimes(1);
    expect(result.current.threads[1]).toEqual(second);
  });

  it("removes a thread whose signal finds it gone", async () => {
    const [first, second] = threadsOf(2);
    const source = fakeCommentsSource([first, second]);
    source.getThread.mockRejectedValue(new ApiError("not_found", 404));
    const { result, realtime } = setup(source);
    await waitFor(() => expect(result.current.threads).toHaveLength(2));

    act(() => realtime.listener().onSignal(signal(first, 5)));

    await waitFor(() =>
      expect(result.current.threads.map(({ id }) => id)).toEqual([second.id])
    );
  });

  it("drops a thread a signal finds moved to another artifact", async () => {
    const [moved, staying] = threadsOf(2);
    const source = fakeCommentsSource([moved, staying]);
    source.getThread.mockResolvedValue({
      ...moved,
      artifactId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a61",
      revision: moved.revision + 1,
    });
    const { result, realtime } = setup(source);
    await waitFor(() => expect(result.current.threads).toHaveLength(2));

    act(() => realtime.listener().onSignal(signal(moved, moved.revision + 1)));

    await waitFor(() =>
      expect(result.current.threads.map(({ id }) => id)).toEqual([staying.id])
    );
  });

  it("reports the last full read as dataLoadedAt, unmoved by a signal patch, and reloads on resync", async () => {
    const [first] = threadsOf(1);
    const source = fakeCommentsSource([first]);
    source.getThread.mockResolvedValue({ ...first, revision: 9 });
    const { result, realtime, queryClient } = setup(source);
    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    const loadedAt = realtime.listener().dataLoadedAt?.();

    act(() => realtime.listener().onSignal(signal(first, 9)));
    await waitFor(() => expect(result.current.threads[0]?.revision).toBe(9));

    expect(loadedAt).toBeGreaterThan(0);
    expect(realtime.listener().dataLoadedAt?.()).toBe(loadedAt);
    expect(
      queryClient.getQueryState(artifactCommentKeys.target({ id: ARTIFACT_ID }))
        ?.dataUpdatedAt
    ).toBe(loadedAt);

    act(() => realtime.listener().onResync());
    await waitFor(() => expect(source.list).toHaveBeenCalledTimes(2));
  });

  it("keeps a thread a signal added while a reload was already in flight", async () => {
    const [first, added] = threadsOf(2);
    const source = fakeCommentsSource([first]);
    source.getThread.mockResolvedValue(added);
    const { result, realtime, queryClient } = setup(source);
    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    let release: () => void = () => undefined;
    source.list.mockImplementationOnce(
      (targetId, options) =>
        new Promise((resolve) => {
          release = () => resolve(pagedList([first])(targetId, options));
        })
    );

    act(() => realtime.listener().onResync());
    await waitFor(() => expect(source.list).toHaveBeenCalledTimes(2));
    act(() => realtime.listener().onSignal(signal(added, added.revision)));
    await waitFor(() => expect(result.current.threads).toHaveLength(2));
    act(() => release());
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    expect(result.current.threads.map(({ id }) => id)).toEqual([
      first.id,
      added.id,
    ]);
  });

  it("polls only while the channel is not live", async () => {
    vi.useFakeTimers();
    const source = fakeCommentsSource(threadsOf(1));
    const { result, realtime } = setup(source);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.threads).toHaveLength(1);
    expect(source.list).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(source.list).toHaveBeenCalledTimes(2);

    act(() => realtime.setLive(true));
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(source.list).toHaveBeenCalledTimes(2);

    act(() => realtime.setLive(false));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(source.list).toHaveBeenCalledTimes(3);
  });

  it("renders a failed read as an error, never as zero comments", async () => {
    const source = fakeCommentsSource();
    source.list.mockRejectedValue(new ApiError("boom", 500));
    const { result } = setup(source);

    await waitFor(() =>
      expect(result.current.loadState.status).toBe(CommentsPaneLoadStatus.Error)
    );
    expect(result.current.capabilities).toBeNull();
  });
});

describe("useArtifactComments: writes", () => {
  it("sends one create while one is pending, and holds its key as pending", async () => {
    const [created] = threadsOf(1);
    const source = fakeCommentsSource([]);
    let land: (thread: CommentThreadDto) => void = () => undefined;
    source.createThread.mockImplementation(
      () =>
        new Promise<CommentThreadDto>((resolve) => {
          land = resolve;
        })
    );
    const { result } = setup(source);
    await waitFor(() =>
      expect(result.current.loadState.status).toBe(CommentsPaneLoadStatus.Ready)
    );
    const input = {
      anchor: created.anchor ?? { kind: CommentAnchorKind.Artifact },
      body: "hello",
      mentions: ["user-2"],
    };

    let firstWrite: Promise<void> = Promise.resolve();
    let secondWrite: Promise<void> = Promise.resolve();
    act(() => {
      firstWrite = result.current.onCreateThread(input);
      secondWrite = result.current.onCreateThread(input);
    });
    await waitFor(() =>
      expect(result.current.pendingDraftKeys).toEqual([NEW_THREAD_DRAFT_KEY])
    );

    expect(secondWrite).toBe(firstWrite);
    expect(source.createThread).toHaveBeenCalledTimes(1);
    expect(source.createThread).toHaveBeenCalledWith(ARTIFACT_ID, {
      anchor: input.anchor,
      body: "hello",
      mentions: ["user-2"],
      clientId: expect.any(String),
    });

    await act(async () => {
      land(created);
      await firstWrite;
    });
    expect(result.current.pendingDraftKeys).toEqual([]);
    expect(result.current.threads.map(({ id }) => id)).toEqual([created.id]);
  });

  it("re-reads a thread after deleting a comment, removing it when it is gone", async () => {
    const [first] = threadsOf(1);
    const source = fakeCommentsSource([first]);
    source.delete.mockResolvedValue(undefined);
    source.getThread.mockRejectedValue(new ApiError("not_found", 404));
    const { result } = setup(source);
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    await act(() =>
      result.current.onDelete({
        commentId: first.comments[0]?.id ?? "",
        threadId: first.id,
      })
    );

    expect(result.current.threads).toEqual([]);
  });

  it("keeps a deleted thread out when a re-read that began before the delete lands after it", async () => {
    const [first] = threadsOf(1);
    const source = fakeCommentsSource([first]);
    let landStale: (thread: CommentThreadDto) => void = () => undefined;
    const staleRead = new Promise<CommentThreadDto>((resolve) => {
      landStale = resolve;
    });
    source.getThread
      .mockReturnValueOnce(staleRead)
      .mockRejectedValueOnce(new ApiError("not_found", 404));
    source.delete.mockResolvedValue(undefined);
    const { result, realtime, queryClient } = setup(source);
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    act(() => realtime.listener().onSignal(signal(first, first.revision + 1)));
    await waitFor(() => expect(source.getThread).toHaveBeenCalledTimes(1));
    await act(() =>
      result.current.onDelete({
        commentId: first.comments[0]?.id ?? "",
        threadId: first.id,
      })
    );
    expect(result.current.threads).toEqual([]);
    // The refresh awaited this read first, so it has applied it by the time
    // this await resumes.
    await act(async () => {
      landStale({ ...first, revision: first.revision + 1 });
      await staleRead;
    });

    expect(
      queryClient.getQueryData<ArtifactCommentsCollection>(
        artifactCommentKeys.target({ id: ARTIFACT_ID })
      )?.threads
    ).toEqual([]);
  });

  it("mints a new idempotency id for a changed draft and reuses it for a retry of the same one", async () => {
    const [first] = threadsOf(1);
    const source = fakeCommentsSource([first]);
    // The write committed, but its response was lost.
    source.createThread.mockRejectedValue(new ApiError("boom", 500));
    source.reply.mockRejectedValue(new ApiError("boom", 500));
    const { result } = setup(source);
    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    const anchor = { kind: CommentAnchorKind.Artifact };

    for (const body of ["first", "first", "second"]) {
      await act(() =>
        result.current.onCreateThread({ anchor, body }).catch(() => undefined)
      );
      await act(() =>
        result.current.onReply(first.id, { body }).catch(() => undefined)
      );
    }

    for (const calls of [
      source.createThread.mock.calls.map(([, input]) => input.clientId),
      source.reply.mock.calls.map(([, input]) => input.clientId),
    ]) {
      expect(calls).toHaveLength(3);
      expect(calls[1]).toBe(calls[0]);
      expect(calls[2]).not.toBe(calls[0]);
    }
  });

  it("reports a delete that landed as done though the re-read after it failed", async () => {
    const [first] = threadsOf(1);
    const source = fakeCommentsSource([first]);
    source.delete.mockResolvedValue(undefined);
    source.getThread.mockRejectedValue(new ApiError("boom", 500));
    const { result } = setup(source);
    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    await expect(
      act(() =>
        result.current.onDelete({
          commentId: first.comments[0]?.id ?? "",
          threadId: first.id,
        })
      )
    ).resolves.toBeUndefined();
  });

  it("scopes in-flight keys to their target, so a switch neither blocks nor clears the next target's create", async () => {
    const [created] = threadsOf(1);
    const source = fakeCommentsSource([]);
    const lands: ((thread: CommentThreadDto) => void)[] = [];
    source.createThread.mockImplementation(
      () =>
        new Promise<CommentThreadDto>((resolve) => {
          lands.push(resolve);
        })
    );
    const { result, rerender } = setup(source);
    await waitFor(() =>
      expect(result.current.loadState.status).toBe(CommentsPaneLoadStatus.Ready)
    );
    const input = { anchor: { kind: CommentAnchorKind.Artifact }, body: "hi" };
    let onFirstTarget: Promise<void> = Promise.resolve();
    act(() => {
      onFirstTarget = result.current.onCreateThread(input);
    });
    await waitFor(() =>
      expect(result.current.pendingDraftKeys).toEqual([NEW_THREAD_DRAFT_KEY])
    );

    rerender({ id: "other-target" });
    expect(result.current.pendingDraftKeys).toEqual([]);
    act(() => {
      result.current.onCreateThread(input).catch(() => undefined);
    });
    await waitFor(() => expect(source.createThread).toHaveBeenCalledTimes(2));
    await act(async () => {
      lands[0]?.(created);
      await onFirstTarget;
    });

    expect(result.current.pendingDraftKeys).toEqual([NEW_THREAD_DRAFT_KEY]);
  });
});
