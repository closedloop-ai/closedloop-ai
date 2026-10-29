import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { SESSION_LIST_PARITY_CONFORM_SCENARIO } from "@repo/lib/sessions/__tests__/session-list-parity-conform";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedParityHost } from "@/__tests__/support/agent-sessions/session-list-parity.test-helpers";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { agentSessionsService } from "../service";

const mocks = vi.hoisted(() => ({ flag: vi.fn() }));
vi.mock("@/lib/feature-flag-identity", () => ({
  isFeatureFlagEnabledForAnyIdentity: mocks.flag,
}));

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;
const organizations = createCommittedTestOrganizationTracker();
let organizationId: string;
let viewerId: string;

describeIfDb("D5 cloud Sessions root-order production page", () => {
  beforeAll(async () => {
    const conform = SESSION_LIST_PARITY_CONFORM_SCENARIO.rows;
    const active = conform.find((row) => row.key === "p01");
    const inactive = conform.find((row) => row.key === "p02");
    const error = conform.find((row) => row.key === "p04");
    if (!(active && inactive && error)) {
      throw new Error("missing status corpus rows");
    }
    const host = await seedParityHost(organizations, [
      active,
      { ...active, key: "p01b" },
      inactive,
      error,
    ]);
    organizationId = host.organizationId;
    viewerId = Object.values(host.ownerIds)[0];
    const firstArtifactId = host.artifactIds.get("p01");
    const secondArtifactId = host.artifactIds.get("p01b");
    if (!(firstArtifactId && secondArtifactId)) {
      throw new Error("missing active artifact identities");
    }
    const [higherArtifactId, lowerArtifactId] = [
      firstArtifactId,
      secondArtifactId,
    ].sort((a, b) => b.localeCompare(a));
    const higherIdentity = await withDb((db) =>
      db.sessionDetail.findUniqueOrThrow({
        where: { artifactId: higherArtifactId },
        select: { computeTargetId: true },
      })
    );
    await withDb((db) =>
      db.sessionDetail.update({
        where: { artifactId: higherArtifactId },
        data: { externalSessionId: "a-active" },
        select: { artifactId: true },
      })
    );
    await withDb((db) =>
      db.sessionDetail.update({
        where: { artifactId: lowerArtifactId },
        data: {
          computeTargetId: higherIdentity.computeTargetId,
          externalSessionId: "z-active",
        },
        select: { artifactId: true },
      })
    );
  });
  afterAll(() => organizations.cleanup());

  it.each([
    {
      enabled: true,
      dir: "asc" as const,
      expected: ["z-active", "a-active", "p02", "p04"],
    },
    {
      enabled: true,
      dir: "desc" as const,
      expected: ["p04", "p02", "z-active", "a-active"],
    },
    {
      enabled: false,
      dir: "asc" as const,
      expected: ["a-active", "z-active", "p04", "p02"],
    },
    {
      enabled: false,
      dir: "desc" as const,
      expected: ["p02", "p04", "a-active", "z-active"],
    },
  ])(
    "DT-19: status $dir serves $enabled root-order assignment through Postgres",
    async ({ enabled, dir, expected }) => {
      mocks.flag.mockResolvedValue(enabled);
      const result = await agentSessionsService.findSessions({
        organizationId,
        viewerId,
        filters: { sortBy: "status", sortDir: dir, quality: "all", limit: 25 },
      });
      expect(result.items.map((item) => item.externalSessionId)).toEqual(
        expected
      );
      expect(result.total).toBe(4);
    }
  );
});
