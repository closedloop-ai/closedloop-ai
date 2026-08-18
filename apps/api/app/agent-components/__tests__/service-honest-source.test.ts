/**
 * ISS-5009: honestSource projection on the wired listForOrg path.
 *
 * Split from service.test.ts to keep the grandfathered file from growing.
 */
import { SourceType } from "@repo/api/src/types/agent-component";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  listByArtifactIds: vi.fn(),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: {
    listByArtifactIds: mocks.listByArtifactIds,
  },
}));

import { agentComponentsService } from "../service";
import { buildInventoryRow, buildServiceDb } from "./service-db-double";

function installDb(db: Record<string, unknown>) {
  const dbWithDefaults = buildServiceDb(db);
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  return dbWithDefaults;
}

describe("agentComponentsService.listForOrg — honestSource (ISS-5009)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits honestSource alongside UNCHANGED legacy source/sourceType for a pack row", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          buildInventoryRow({
            packId: "acme-pack",
            sourceUrl: "github.com/acme/repo",
          }),
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    expect(result.items[0].honestSource).toEqual({
      hasProvenance: true,
      source: "acme-pack",
      sourceType: SourceType.Pack,
    });
    expect(result.items[0].source).toBe("acme-pack");
    expect(result.items[0].sourceType).toBe(SourceType.Pack);
  });

  it("separates a scope-backed row from a provenance-less one, both of whose legacy source is the identity echo", async () => {
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          buildInventoryRow({
            id: "ac-scoped",
            componentKey: "scoped-skill",
            name: "Scoped Skill",
            externalComponentId: "skill::scoped-skill",
            scope: "user",
          }),
          buildInventoryRow({
            id: "ac-pathless",
            componentKey: "pathless-skill",
            name: "Pathless Skill",
            externalComponentId: "skill::pathless-skill",
            installPath: "/home/someone/.claude/skills/pathless/SKILL.md",
          }),
        ]),
      },
    });

    const result = await agentComponentsService.listForOrg("org-1", {
      limit: 50,
      offset: 0,
    });

    const byId = new Map(result.items.map((item) => [item.id, item]));
    const scoped = byId.get("ac-scoped");
    const pathless = byId.get("ac-pathless");

    expect(scoped?.source).toBe("scoped-skill");
    expect(scoped?.sourceType).toBe(SourceType.Repo);
    expect(pathless?.source).toBe("pathless-skill");
    expect(pathless?.sourceType).toBe(SourceType.Repo);

    expect(scoped?.honestSource).toEqual({
      hasProvenance: true,
      source: "user",
      sourceType: SourceType.Local,
    });
    expect(pathless?.honestSource).toEqual({
      hasProvenance: false,
      source: null,
      sourceType: SourceType.Local,
    });
  });
});
