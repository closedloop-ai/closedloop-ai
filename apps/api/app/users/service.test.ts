import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const databaseMocks = vi.hoisted(() => {
  const withDb = vi.fn() as Mock;
  return { withDb };
});

vi.mock("@repo/database", () => ({
  ArtifactType: { DOCUMENT: "DOCUMENT" },
  GitHubPRState: { MERGED: "MERGED" },
  withDb: databaseMocks.withDb,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
  },
}));

import { usersService } from "./service";

describe("usersService.findByOrganization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters inactive GitHub shadow users at the service database boundary", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "active-user",
        active: true,
        clerkId: "clerk-active",
      },
    ]);
    databaseMocks.withDb.mockImplementation((fn) => fn({ user: { findMany } }));

    const users = await usersService.findByOrganization("org-1");

    expect(users).toHaveLength(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        active: true,
      },
      orderBy: { createdAt: "desc" },
    });
  });
});
