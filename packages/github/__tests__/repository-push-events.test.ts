import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { describe, expect, it, vi } from "vitest";
import { getRecentBranchPushEvents } from "../repository-push-events";

const BEFORE_SHA = "a".repeat(40);
const AFTER_SHA = "b".repeat(40);
const INPUT = {
  owner: "closedloop-ai",
  repo: "closedloop-ai",
  branchName: "feature/collaborators",
};

function event(
  changes: {
    id?: string;
    type?: string;
    repositoryName?: string;
    ref?: string;
    before?: string;
    head?: string;
    actor?: { id: number; login: string } | null;
  } = {}
) {
  return {
    id: changes.id ?? "event-1",
    type: changes.type ?? "PushEvent",
    actor:
      changes.actor === undefined ? { id: 123, login: "alice" } : changes.actor,
    repo: { name: changes.repositoryName ?? "closedloop-ai/closedloop-ai" },
    payload: {
      push_id: 456,
      ref: changes.ref ?? "refs/heads/feature/collaborators",
      before: changes.before ?? BEFORE_SHA,
      head: changes.head ?? AFTER_SHA,
    },
    created_at: "2026-09-29T20:00:00Z",
  };
}

describe("getRecentBranchPushEvents", () => {
  it("keeps the GitHub-reported account only on the exact repository and ref", async () => {
    const request = vi.fn().mockResolvedValue({
      data: [
        event(),
        event({ id: "other-ref", ref: "refs/heads/other" }),
        event({
          id: "other-repo",
          repositoryName: "another-owner/closedloop-ai",
        }),
        event({ id: "tag", ref: "refs/tags/feature/collaborators" }),
        event({ id: "not-push", type: "PullRequestEvent" }),
      ],
    });

    const result = await getRecentBranchPushEvents({ request } as never, INPUT);

    expect(result).toEqual({
      events: [
        {
          eventId: "event-1",
          pushId: "456",
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          providerUserId: "123",
          providerLogin: "alice",
          observedAt: new Date("2026-09-29T20:00:00Z"),
        },
      ],
      availability: BranchIdentityAvailability.Incomplete,
    });
    expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/events", {
      owner: INPUT.owner,
      repo: INPUT.repo,
      per_page: 100,
      page: 1,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not admit deletion, unchanged, anonymous, ghost, or malformed transitions", async () => {
    const request = vi.fn().mockResolvedValue({
      data: [
        event({ id: "deleted", head: "0".repeat(40) }),
        event({ id: "unchanged", head: BEFORE_SHA }),
        event({ id: "anonymous", actor: null }),
        event({ id: "ghost", actor: { id: 123, login: "ghost" } }),
        event({ id: "bad-sha", head: "not-a-sha" }),
        event({ id: "bad-actor", actor: { id: -1, login: "alice" } }),
      ],
    });

    const result = await getRecentBranchPushEvents({ request } as never, INPUT);

    expect(result.events).toEqual([]);
    expect(result.availability).toBe(BranchIdentityAvailability.Incomplete);
  });

  it("pages a full response and deduplicates a repeated event", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      event({ id: `other-${index}`, ref: "refs/heads/other" })
    );
    firstPage[0] = event();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({ data: [event()] });

    const result = await getRecentBranchPushEvents({ request } as never, INPUT);

    expect(result.events).toHaveLength(1);
    expect(request).toHaveBeenNthCalledWith(
      2,
      "GET /repos/{owner}/{repo}/events",
      expect.objectContaining({ page: 2 })
    );
    expect(result.availability).toBe(BranchIdentityAvailability.Incomplete);
  });

  it("reports an unreadable first page as unavailable", async () => {
    const request = vi.fn().mockRejectedValue(new Error("provider denied"));

    await expect(
      getRecentBranchPushEvents({ request } as never, INPUT)
    ).resolves.toEqual({
      events: [],
      availability: BranchIdentityAvailability.Unavailable,
    });
  });

  it("preserves known events when a later page fails", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      event({ id: `other-${index}`, ref: "refs/heads/other" })
    );
    firstPage[0] = event();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: firstPage })
      .mockRejectedValueOnce(new Error("provider denied"));

    const result = await getRecentBranchPushEvents({ request } as never, INPUT);

    expect(result.events).toHaveLength(1);
    expect(result.availability).toBe(BranchIdentityAvailability.Incomplete);
  });
});
