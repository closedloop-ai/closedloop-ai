import { CommentSurface, ThreadStatus } from "@repo/api/src/types/comment";
import { describe, expect, it, vi } from "vitest";
import {
  FULL_CAPABILITIES,
  makeThread,
} from "../../components/comments/comments-pane.fixtures";
import {
  CommentsResponseInvalidError,
  createHttpCommentsDataSource,
} from "../comments-data-source";
import { ARTIFACT_ID } from "./comments-test-source";

function client(body: unknown) {
  return {
    get: vi.fn((_path: string, _options?: unknown) => Promise.resolve(body)),
    post: vi.fn((_path: string, _data: unknown) => Promise.resolve(body)),
    patch: vi.fn((_path: string, _data: unknown) => Promise.resolve(body)),
    delete: vi.fn((_path: string) => Promise.resolve(body)),
  };
}

describe("createHttpCommentsDataSource", () => {
  it("reads a page from the unified list route with its filters", async () => {
    const page = {
      artifactId: ARTIFACT_ID,
      capabilities: FULL_CAPABILITIES,
      threads: [makeThread({ id: "thread-1" })],
      nextCursor: null,
    };
    const api = client(page);

    const read = await createHttpCommentsDataSource(api).list("ext-1", {
      cursor: "c1",
      surface: CommentSurface.SessionDetail,
      status: ThreadStatus.Open,
    });

    expect(read).toEqual(page);
    expect(api.get).toHaveBeenCalledWith(
      "/artifacts/ext-1/comments?surface=session_detail&status=OPEN&cursor=c1",
      { cache: "no-store" }
    );
  });

  it("fails a list whose body breaks the contract instead of reading it as no comments", async () => {
    const api = client({
      capabilities: FULL_CAPABILITIES,
      threads: "none",
      nextCursor: null,
    });

    await expect(
      createHttpCommentsDataSource(api).list(ARTIFACT_ID)
    ).rejects.toBeInstanceOf(CommentsResponseInvalidError);
  });

  it("validates a write's thread and a delete's acknowledgement", async () => {
    const source = createHttpCommentsDataSource(client({ id: "thread-1" }));

    await expect(source.resolve("thread-1")).rejects.toBeInstanceOf(
      CommentsResponseInvalidError
    );
    await expect(source.delete("comment-1")).rejects.toBeInstanceOf(
      CommentsResponseInvalidError
    );
    await expect(
      createHttpCommentsDataSource(client({ deleted: true })).delete(
        "comment-1"
      )
    ).resolves.toBeUndefined();
  });
});
