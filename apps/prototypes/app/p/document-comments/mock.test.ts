import { describe, expect, it } from "vitest";
import {
  type CommentThread,
  canResolveThread,
  currentUser,
  mentionableUsers,
  mentionLabelFor,
  ThreadScope,
  threads,
} from "./mock";

const marcus = mentionableUsers.find((user) => user.name === "Marcus Lee");

function threadAuthoredBy(authorId: string): CommentThread {
  return {
    id: "th-test",
    scope: ThreadScope.Artifact,
    anchorText: null,
    author: { ...currentUser, id: authorId },
    body: "body",
    createdAt: "2026-07-24T00:00:00Z",
    resolved: false,
    replies: [],
  };
}

describe("canResolveThread", () => {
  it("allows the thread author to resolve", () => {
    const thread = threadAuthoredBy(currentUser.id);
    expect(canResolveThread(thread, currentUser.id)).toBe(true);
  });

  it("allows a replier who is not the author to resolve", () => {
    const thread: CommentThread = {
      ...threadAuthoredBy("u-dana"),
      replies: [
        {
          id: "rp-1",
          author: { ...currentUser, id: "u-marcus", name: "Marcus Lee" },
          body: "answered",
          createdAt: "2026-07-24T01:00:00Z",
        },
      ],
    };
    expect(canResolveThread(thread, "u-marcus")).toBe(true);
  });

  it("denies a viewer who is neither author nor participant", () => {
    const thread = threadAuthoredBy("u-dana");
    expect(canResolveThread(thread, "u-outsider")).toBe(false);
  });
});

describe("mentionLabelFor", () => {
  it("resolves a known user id to their display name", () => {
    expect(marcus).toBeDefined();
    if (marcus) {
      expect(mentionLabelFor(marcus.id)).toBe("Marcus Lee");
    }
  });

  it("falls back to a generic label for an unknown id", () => {
    expect(mentionLabelFor("u-nobody")).toBe("Unknown user");
  });
});

describe("seed threads", () => {
  it("are all authored by the current viewer so the empty state is reachable by deleting each", () => {
    // Delete is author-only; every seed thread being the viewer's makes
    // delete-to-empty a real interaction (prototype.meta empty-state claim).
    expect(threads.every((thread) => thread.author.id === currentUser.id)).toBe(
      true
    );
  });

  it("include a resolved thread so the resolved-group toggle has content", () => {
    expect(threads.some((thread) => thread.resolved)).toBe(true);
  });

  it("include inline-anchored threads for the body highlight anchors", () => {
    const inline = threads.filter(
      (thread) => thread.scope === ThreadScope.Inline
    );
    expect(inline.length).toBeGreaterThan(0);
    expect(inline.every((thread) => thread.anchorText !== null)).toBe(true);
  });
});
