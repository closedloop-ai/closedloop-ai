import { CommentSurface } from "@repo/api/src/types/comment";
import { describe, expect, it } from "vitest";
import { makeThread } from "../../components/comments/comments-pane.fixtures";
import {
  COMMENT_RACE_MARKER_TTL_MS,
  CommentsCursorLoopError,
  createCommentRaceMarkers,
  markThread,
  mergeReloadedThreads,
  readArtifactCommentsCollection,
  removedSince,
  threadBelongsToTarget,
  upsertThread,
} from "../artifact-comments-cache";
import {
  ARTIFACT_ID,
  fakeCommentsSource,
  pagedList,
  threadsOf,
} from "./comments-test-source";

describe("readArtifactCommentsCollection", () => {
  it("follows nextCursor through every page of more than 50 threads", async () => {
    const all = threadsOf(120);
    const source = fakeCommentsSource(all);

    const read = await readArtifactCommentsCollection(source, {
      id: "session-ext",
      surface: CommentSurface.SessionDetail,
    });

    expect(read.threads.map(({ id }) => id)).toEqual(all.map(({ id }) => id));
    expect(
      source.list.mock.calls.map(([, options]) => options?.cursor)
    ).toEqual([undefined, "50", "100"]);
    expect(source.list).toHaveBeenCalledWith("session-ext", {
      surface: CommentSurface.SessionDetail,
    });
    expect(read.artifactId).toBe(ARTIFACT_ID);
  });

  it("fails rather than paging forever on a repeated cursor", async () => {
    const source = fakeCommentsSource();
    source.list.mockImplementation(
      pagedList(threadsOf(1), { nextCursor: "same" })
    );

    await expect(
      readArtifactCommentsCollection(source, { id: ARTIFACT_ID })
    ).rejects.toBeInstanceOf(CommentsCursorLoopError);
    expect(source.list).toHaveBeenCalledTimes(2);
  });

  it("names the artifact from a thread when the server predates artifactId", async () => {
    const source = fakeCommentsSource();
    source.list.mockImplementation(
      pagedList(threadsOf(1), { artifactId: undefined })
    );

    await expect(
      readArtifactCommentsCollection(source, { id: ARTIFACT_ID })
    ).resolves.toMatchObject({ artifactId: ARTIFACT_ID });
  });
});

describe("thread merging", () => {
  const at = (revision: number) => makeThread({ id: "thread-a", revision });

  const revisions = (threads: { revision: number }[]) =>
    threads.map(({ revision }) => revision);

  it("never lets a lower revision replace a higher one", () => {
    expect(revisions(upsertThread([at(5)], at(4)))).toEqual([5]);
    expect(revisions(upsertThread([at(5)], at(6)))).toEqual([6]);
  });

  it("keeps the newer held revision over a reload that predates it", () => {
    const merged = mergeReloadedThreads(
      [at(7)],
      [at(6)],
      createCommentRaceMarkers(),
      0
    );

    expect(revisions(merged)).toEqual([7]);
  });

  it("keeps a just-created thread a raced reload left out, until its marker expires", () => {
    const created = makeThread({ id: "thread-new" });
    const markers = createCommentRaceMarkers();
    markThread(markers.created, created.id, 1000);

    expect(mergeReloadedThreads([created], [], markers, 1000)).toEqual([
      created,
    ]);
    expect(
      mergeReloadedThreads(
        [created],
        [],
        markers,
        1000 + COMMENT_RACE_MARKER_TTL_MS
      )
    ).toEqual([]);
  });

  it("keeps a just-removed thread out of a raced reload that still has it", () => {
    const removed = makeThread({ id: "thread-gone" });
    const markers = createCommentRaceMarkers();
    markThread(markers.removed, removed.id, 1000);

    expect(mergeReloadedThreads([], [removed], markers, 1000)).toEqual([]);
    expect(markers.removed.has(removed.id)).toBe(true);
  });

  it("still rejects a single-thread read that predates a removal after a reload without the thread", () => {
    const markers = createCommentRaceMarkers();
    markThread(markers.removed, "thread-gone", 1000);

    mergeReloadedThreads([], [], markers, 1001);

    expect(removedSince(markers, "thread-gone", 999)).toBe(true);
    expect(removedSince(markers, "thread-gone", 1001)).toBe(false);
  });

  it("orders by createdAt, then id, with an unparseable time last", () => {
    const late = makeThread({ id: "b", createdAt: "2026-10-02T00:00:00.000Z" });
    const early = makeThread({
      id: "c",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    const tie = makeThread({ id: "a", createdAt: "2026-10-02T00:00:00.000Z" });
    const broken = makeThread({ id: "0", createdAt: "not a time" });

    const merged = mergeReloadedThreads(
      [],
      [broken, late, early, tie],
      createCommentRaceMarkers(),
      0
    );

    expect(merged.map(({ id }) => id)).toEqual(["c", "a", "b", "0"]);
  });

  it("admits a thread read on its own only into its own surface's collection", () => {
    const detail = makeThread({
      id: "t",
      surface: CommentSurface.BranchDetail,
    });

    expect(
      threadBelongsToTarget(detail, {
        id: ARTIFACT_ID,
        surface: CommentSurface.BranchTimeline,
      })
    ).toBe(false);
    expect(threadBelongsToTarget(detail, { id: ARTIFACT_ID })).toBe(true);
  });
});
