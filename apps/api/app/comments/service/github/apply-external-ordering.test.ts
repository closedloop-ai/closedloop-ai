import { describe, expect, it } from "vitest";
import { MAX_TRUSTED_FUTURE_SKEW_MS } from "@/lib/trusted-timestamp";
import {
  CommentWriteVerdict,
  decideCommentWrite,
  type StoredGitHubComment,
  strongestRejection,
} from "./apply-external-ordering";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const KEY = new Date("2026-09-01T10:00:00.000Z");

function stored(over: Partial<StoredGitHubComment> = {}): StoredGitHubComment {
  return {
    commentId: "comment-1",
    threadId: "thread-1",
    key: KEY,
    body: "body",
    deleted: false,
    deletedAt: null,
    revision: 0,
    writtenAt: null,
    ...over,
  };
}

function decide(
  input: Partial<Parameters<typeof decideCommentWrite>[0]>
): CommentWriteVerdict {
  return decideCommentWrite({
    stored: stored(),
    incomingKey: KEY,
    incomingBody: "body",
    reviveDeletedBefore: null,
    listedAt: null,
    now: NOW,
    ...input,
  });
}

describe("decideCommentWrite (PLN-2122 decisions 1 and 2)", () => {
  it("applies a comment it has never stored", () => {
    expect(decide({ stored: null })).toBe(CommentWriteVerdict.Apply);
  });

  it("ignores a key older than the stored one", () => {
    expect(decide({ incomingKey: new Date(KEY.getTime() - 1) })).toBe(
      CommentWriteVerdict.RejectOlder
    );
  });

  it("applies a newer key", () => {
    expect(decide({ incomingKey: new Date(KEY.getTime() + 1) })).toBe(
      CommentWriteVerdict.Apply
    );
  });

  it("treats an equal key and identical body as the same write", () => {
    expect(decide({})).toBe(CommentWriteVerdict.Same);
  });

  it("applies an equal key with a different body", () => {
    expect(decide({ incomingBody: "edited" })).toBe(CommentWriteVerdict.Apply);
  });

  it("keeps a body written after the list was read over the list's equal-key body", () => {
    const listedAt = new Date("2026-09-01T11:00:00.000Z");

    expect(
      decide({
        stored: stored({ writtenAt: listedAt }),
        incomingBody: "listed",
        listedAt,
      })
    ).toBe(CommentWriteVerdict.RejectOlder);
    expect(
      decide({
        stored: stored({ writtenAt: new Date(listedAt.getTime() - 1) }),
        incomingBody: "listed",
        listedAt,
      })
    ).toBe(CommentWriteVerdict.Apply);
  });

  it("keeps a stored body over a first version's body at an equal key", () => {
    expect(decide({ incomingBody: "submitted", firstVersion: true })).toBe(
      CommentWriteVerdict.RejectOlder
    );
    expect(decide({ firstVersion: true })).toBe(CommentWriteVerdict.Same);
    expect(
      decide({
        incomingKey: new Date(KEY.getTime() + 1),
        incomingBody: "submitted",
        firstVersion: true,
      })
    ).toBe(CommentWriteVerdict.Apply);
  });

  it("applies over a stored row that has no key yet", () => {
    expect(
      decide({
        stored: stored({ key: null }),
        incomingKey: new Date(KEY.getTime() - 1),
      })
    ).toBe(CommentWriteVerdict.Apply);
  });

  it("keeps a deleted comment deleted unless a complete list read after the delete revives it", () => {
    const deletedAt = new Date("2026-09-01T11:00:00.000Z");
    const deleted = stored({ deleted: true, deletedAt });
    const later = new Date(KEY.getTime() + 60_000);

    expect(decide({ stored: deleted, incomingKey: later })).toBe(
      CommentWriteVerdict.RejectDeleted
    );
    expect(
      decide({
        stored: deleted,
        reviveDeletedBefore: new Date(deletedAt.getTime() + 1),
      })
    ).toBe(CommentWriteVerdict.Apply);
    expect(decide({ stored: deleted, reviveDeletedBefore: deletedAt })).toBe(
      CommentWriteVerdict.RejectDeleted
    );
  });

  it("rejects a key past the trusted future boundary, and accepts the boundary itself", () => {
    const boundary = new Date(NOW.getTime() + MAX_TRUSTED_FUTURE_SKEW_MS);

    expect(
      decide({ stored: null, incomingKey: new Date(boundary.getTime() + 1) })
    ).toBe(CommentWriteVerdict.RejectFuture);
    expect(decide({ stored: null, incomingKey: boundary })).toBe(
      CommentWriteVerdict.Apply
    );
  });

  it("reports the most serious rejection of an event", () => {
    expect(
      strongestRejection([
        CommentWriteVerdict.RejectOlder,
        CommentWriteVerdict.RejectDeleted,
      ])
    ).toBe(CommentWriteVerdict.RejectDeleted);
    expect(
      strongestRejection([
        CommentWriteVerdict.RejectDeleted,
        CommentWriteVerdict.RejectFuture,
      ])
    ).toBe(CommentWriteVerdict.RejectFuture);
  });
});
