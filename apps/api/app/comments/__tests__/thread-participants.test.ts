/**
 * Unit tests for deriveThreadAuthorship — the shared, pure derivation of a
 * document thread's author + participant set that keeps the REST resolve guard
 * and the Liveblocks webhook guard in parity (FEA-4092).
 */
import { describe, expect, it } from "vitest";
import {
  deriveThreadAuthorship,
  unionProviderParticipants,
} from "../thread-participants";

describe("deriveThreadAuthorship", () => {
  it("uses createdById as the author and includes every comment author as a participant", () => {
    const { authorId, participantIds } = deriveThreadAuthorship({
      createdById: "author-1",
      comments: [{ authorId: "author-1" }, { authorId: "replier-2" }],
    });

    expect(authorId).toBe("author-1");
    expect([...participantIds].sort()).toEqual(["author-1", "replier-2"]);
  });

  it("falls back to the oldest comment's author when createdById is unset", () => {
    const { authorId, participantIds } = deriveThreadAuthorship({
      createdById: null,
      comments: [{ authorId: "author-1" }, { authorId: "replier-2" }],
    });

    expect(authorId).toBe("author-1");
    expect(participantIds.has("author-1")).toBe(true);
    expect(participantIds.has("replier-2")).toBe(true);
  });

  it("de-duplicates a participant who authored multiple comments", () => {
    const { participantIds } = deriveThreadAuthorship({
      createdById: "author-1",
      comments: [
        { authorId: "author-1" },
        { authorId: "author-1" },
        { authorId: "replier-2" },
      ],
    });

    expect(participantIds.size).toBe(2);
  });

  it("fails closed with a null author and empty participant set when unattributable", () => {
    const { authorId, participantIds } = deriveThreadAuthorship({
      createdById: null,
      comments: [],
    });

    expect(authorId).toBeNull();
    expect(participantIds.size).toBe(0);
  });
});

describe("unionProviderParticipants", () => {
  it("adds provider comment authors (userId) that the DB projection missed, without changing authorId", () => {
    const base = deriveThreadAuthorship({
      createdById: "author-1",
      comments: [{ authorId: "author-1" }],
    });

    const { authorId, participantIds } = unionProviderParticipants(base, [
      { userId: "author-1" },
      { userId: "replier-2" },
    ]);

    expect(authorId).toBe("author-1");
    expect([...participantIds].sort()).toEqual(["author-1", "replier-2"]);
  });

  it("does not mutate the input authorship set", () => {
    const base = deriveThreadAuthorship({
      createdById: "author-1",
      comments: [{ authorId: "author-1" }],
    });

    unionProviderParticipants(base, [{ userId: "replier-2" }]);

    expect(base.participantIds.has("replier-2")).toBe(false);
    expect(base.participantIds.size).toBe(1);
  });

  it("promotes a provider-only replier to a participant even when the projection is empty", () => {
    const base = deriveThreadAuthorship({ createdById: null, comments: [] });

    const { participantIds } = unionProviderParticipants(base, [
      { userId: "replier-2" },
    ]);

    expect(participantIds.has("replier-2")).toBe(true);
  });
});
