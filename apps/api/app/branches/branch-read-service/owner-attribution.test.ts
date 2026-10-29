import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { describe, expect, it, vi } from "vitest";
import {
  attachSessionOwnerNames,
  attachSessionOwnerProfiles,
  buildBranchByActor,
  collectBranchOwnerIds,
  type OwnerProfile,
  resolveOwnerProfiles,
} from "./owner-attribution";
import type { SessionUsage } from "./session-usage-window";

type BranchOwnerReadClient = Parameters<typeof resolveOwnerProfiles>[0];
type BranchSession = BranchPageDetail["sessions"][number];

describe("collectBranchOwnerIds", () => {
  it("collects every branch's session owner ids, dropping nulls", () => {
    const first = emptyUsage();
    first.sessionOwnerById.set("session-1", "user-a");
    first.sessionOwnerById.set("session-2", null);
    const second = emptyUsage();
    second.sessionOwnerById.set("session-3", "user-b");

    const ids = collectBranchOwnerIds(
      new Map([
        ["branch-a", first],
        ["branch-b", second],
      ])
    );

    expect([...ids].sort()).toEqual(["user-a", "user-b"]);
  });
});

describe("attachSessionOwnerNames", () => {
  it("leaves ownerUserName null for a session with no resolved owner id", () => {
    const usage = emptyUsage();
    const detail = {
      sessions: [sessionRow("session-1")],
    } as unknown as Parameters<typeof attachSessionOwnerNames>[1];

    attachSessionOwnerNames(usage, detail, new Map());

    expect(detail.sessions[0]?.ownerUserId).toBeNull();
    expect(detail.sessions[0]?.ownerUserName).toBeNull();
  });

  it("stamps the resolved display name for a session with a known owner", () => {
    const usage = emptyUsage();
    usage.sessionOwnerById.set("session-1", "user-a");
    const detail = {
      sessions: [sessionRow("session-1")],
    } as unknown as Parameters<typeof attachSessionOwnerNames>[1];

    attachSessionOwnerNames(
      usage,
      detail,
      new Map([["user-a", "Alice Example"]])
    );

    expect(detail.sessions[0]?.ownerUserId).toBe("user-a");
    expect(detail.sessions[0]?.ownerUserName).toBe("Alice Example");
  });

  it("leaves ownerUserName null for a known owner id absent from the resolved name map", () => {
    const usage = emptyUsage();
    usage.sessionOwnerById.set("session-1", "user-unresolved");
    const detail = {
      sessions: [sessionRow("session-1")],
    } as unknown as Parameters<typeof attachSessionOwnerNames>[1];

    attachSessionOwnerNames(usage, detail, new Map());

    expect(detail.sessions[0]?.ownerUserId).toBe("user-unresolved");
    expect(detail.sessions[0]?.ownerUserName).toBeNull();
  });
});

describe("buildBranchByActor", () => {
  it("folds an unattributed session into the null-owner bucket and sorts it after named owners", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "user-a",
        email: "alice@example.com",
        firstName: "Alice",
        lastName: "Example",
        avatarUrl: null,
      },
    ]);
    const db = { user: { findMany } } as unknown as BranchOwnerReadClient;
    const namedUsage = emptyUsage();
    namedUsage.sessions.push(sessionRowWithCost("session-named", 5));
    namedUsage.sessionOwnerById.set("session-named", "user-a");
    const unattributedUsage = emptyUsage();
    unattributedUsage.sessions.push(sessionRowWithCost("session-unowned", 1));
    // No entry in sessionOwnerById for "session-unowned" — falls to the `?? null`
    // unattributed fallback.
    const usageByBranch = new Map([
      ["branch-a", namedUsage],
      ["branch-b", unattributedUsage],
    ]);

    const buckets = await buildBranchByActor(db, "org-1", usageByBranch);

    expect(buckets).toEqual([
      expect.objectContaining({ owner: "Alice Example", estimatedCostUsd: 5 }),
      expect.objectContaining({ owner: null, estimatedCostUsd: 1 }),
    ]);
  });

  it("folds a session with no priced cost into the bucket total as zero", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "user-a",
        email: "alice@example.com",
        firstName: "Alice",
        lastName: "Example",
        avatarUrl: null,
      },
    ]);
    const db = { user: { findMany } } as unknown as BranchOwnerReadClient;
    const usage = emptyUsage();
    usage.sessions.push({
      ...sessionRowWithCost("session-unpriced", null),
      inputTokens: 10,
    });
    usage.sessionOwnerById.set("session-unpriced", "user-a");

    const buckets = await buildBranchByActor(
      db,
      "org-1",
      new Map([["branch-a", usage]])
    );

    expect(buckets).toEqual([
      expect.objectContaining({
        owner: "Alice Example",
        estimatedCostUsd: 0,
        inputTokens: 10,
      }),
    ]);
  });

  it("folds a session whose owner id never resolved to a name into the unattributed bucket", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { user: { findMany } } as unknown as BranchOwnerReadClient;
    const usage = emptyUsage();
    usage.sessions.push(sessionRowWithCost("session-cross-org", 2));
    // The owner id IS recorded, but the User lookup returned nothing for it
    // (unknown or cross-org) — must still fold into the unattributed bucket,
    // not be dropped.
    usage.sessionOwnerById.set("session-cross-org", "user-unresolved");

    const buckets = await buildBranchByActor(
      db,
      "org-1",
      new Map([["branch-a", usage]])
    );

    expect(buckets).toEqual([
      expect.objectContaining({ owner: null, estimatedCostUsd: 2 }),
    ]);
  });

  it("sorts every named bucket ahead of the unattributed bucket over a wide owner set", async () => {
    const ownerIds = Array.from(
      { length: 14 },
      (_unused, index) => `user-${index}`
    );
    const findMany = vi.fn().mockResolvedValue(
      ownerIds.map((id, index) => ({
        id,
        email: `${id}@example.com`,
        firstName: `Owner${index}`,
        lastName: "Example",
        avatarUrl: null,
      }))
    );
    const db = { user: { findMany } } as unknown as BranchOwnerReadClient;
    const usage = emptyUsage();
    for (const [index, ownerId] of ownerIds.entries()) {
      const sessionId = `session-${ownerId}`;
      usage.sessions.push(sessionRowWithCost(sessionId, index + 1));
      usage.sessionOwnerById.set(sessionId, ownerId);
    }
    usage.sessions.push(sessionRowWithCost("session-unowned", 1000));

    const buckets = await buildBranchByActor(
      db,
      "org-1",
      new Map([["branch-a", usage]])
    );

    expect(buckets).toHaveLength(ownerIds.length + 1);
    expect(buckets.at(-1)).toEqual(
      expect.objectContaining({ owner: null, estimatedCostUsd: 1000 })
    );
    expect(buckets.slice(0, -1).every((bucket) => bucket.owner !== null)).toBe(
      true
    );
  });

  it("dedupes a session shared across two branches to a single bucket contribution", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "user-a",
        email: "alice@example.com",
        firstName: "Alice",
        lastName: "Example",
        avatarUrl: null,
      },
    ]);
    const db = { user: { findMany } } as unknown as BranchOwnerReadClient;
    const usageA = emptyUsage();
    usageA.sessions.push(sessionRowWithCost("session-shared", 4));
    usageA.sessionOwnerById.set("session-shared", "user-a");
    const usageB = emptyUsage();
    usageB.sessions.push(sessionRowWithCost("session-shared", 4));
    usageB.sessionOwnerById.set("session-shared", "user-a");
    const usageByBranch = new Map([
      ["branch-a", usageA],
      ["branch-b", usageB],
    ]);

    const buckets = await buildBranchByActor(db, "org-1", usageByBranch);

    expect(buckets).toEqual([
      expect.objectContaining({ owner: "Alice Example", estimatedCostUsd: 4 }),
    ]);
  });
});

describe("resolveOwnerProfiles", () => {
  it("omits avatarUrl for a user with no persisted picture", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "user-a",
        email: "alice@example.com",
        firstName: "Alice",
        lastName: "Example",
        avatarUrl: null,
      },
    ]);
    const db = { user: { findMany } } as unknown as BranchOwnerReadClient;

    const profiles = await resolveOwnerProfiles(db, "org-1", ["user-a"]);

    expect(Object.hasOwn(profiles.get("user-a") ?? {}, "avatarUrl")).toBe(
      false
    );
  });

  it("includes avatarUrl for a user with a persisted picture", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "user-a",
        email: "alice@example.com",
        firstName: "Alice",
        lastName: "Example",
        avatarUrl: "https://example.com/a.png",
      },
    ]);
    const db = { user: { findMany } } as unknown as BranchOwnerReadClient;

    const profiles = await resolveOwnerProfiles(db, "org-1", ["user-a"]);

    expect(profiles.get("user-a")?.avatarUrl).toBe("https://example.com/a.png");
  });

  it("reads owners org-scoped to the caller", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { user: { findMany } } as unknown as BranchOwnerReadClient;

    await resolveOwnerProfiles(db, "org-1", ["user-a"]);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["user-a"] }, organizationId: "org-1" },
      })
    );
  });
});

describe("attachSessionOwnerProfiles", () => {
  it("does not stamp a profile for an owner id absent from the resolved directory", () => {
    const usage = emptyUsage();
    usage.sessionOwnerById.set("session-1", "user-unresolved");

    attachSessionOwnerProfiles(new Map([["branch-a", usage]]), new Map());

    expect(usage.sessionOwnerProfileById.has("session-1")).toBe(false);
  });

  it("does not stamp a profile for a session with no owner id at all", () => {
    const usage = emptyUsage();
    usage.sessionOwnerById.set("session-1", null);

    attachSessionOwnerProfiles(
      new Map([["branch-a", usage]]),
      new Map([["user-a", { name: "Alice Example" } as OwnerProfile]])
    );

    expect(usage.sessionOwnerProfileById.has("session-1")).toBe(false);
  });

  it("stamps the resolved profile for a session with a known owner id", () => {
    const usage = emptyUsage();
    usage.sessionOwnerById.set("session-1", "user-a");
    const profile: OwnerProfile = { name: "Alice Example" };

    attachSessionOwnerProfiles(
      new Map([["branch-a", usage]]),
      new Map([["user-a", profile]])
    );

    expect(usage.sessionOwnerProfileById.get("session-1")).toBe(profile);
  });
});

function emptyUsage(): SessionUsage {
  return {
    sessionIds: [],
    sessions: [],
    sessionOwnerById: new Map(),
    sessionBillingModeById: new Map(),
    sessionDisplayInputsById: new Map(),
    sessionOwnerProfileById: new Map(),
    lifecycleEventsBySession: new Map(),
    sessionRowsById: new Map(),
    writeSessionIds: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
    hasPricedCost: false,
  };
}

function sessionRow(sessionId: string): BranchSession {
  return sessionRowWithCost(sessionId, null);
}

function sessionRowWithCost(
  sessionId: string,
  estimatedCostUsd: number | null
): BranchSession {
  return {
    sessionId,
    slug: null,
    name: null,
    harness: "claude",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: null,
    isPrimary: false,
    estimatedCostUsd,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ownerUserId: null,
    ownerUserName: null,
  };
}
