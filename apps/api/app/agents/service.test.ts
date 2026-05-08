import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const withDb = Object.assign(vi.fn(), {
    tx: vi.fn(),
  });
  const isUuid = vi.fn();

  return { withDb, isUuid };
});

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

vi.mock("@/lib/identifier-utils", () => ({
  isUuid: mocks.isUuid,
}));

import { agentsService } from "./service";

const NOW = new Date("2026-04-24T12:00:00Z");

const ORG_ID = "org-11111111-1111-1111-1111-111111111111";
const USER_ID = "user-22222222-2222-2222-2222-222222222222";
const AGENT_ID = "agent-3333-3333-3333-333333333333";

const TEST_USER_SUMMARY = { id: USER_ID, firstName: "Test", lastName: "User" };

const UNIQUE_SLUG_ERROR_PATTERN = /Could not generate unique slug/;

const INGEST_AGENT_INPUT = {
  name: "Frontend Architect",
  role: "frontend-architect",
  prompt: "You are a frontend expert.",
};

const INGEST_BOOTSTRAP_RUN_ID = "run-44444444-4444-4444-4444-444444444444";
const INGEST_SOURCE_REPO = "closedloop-ai/symphony-alpha";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function buildAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    organizationId: ORG_ID,
    name: "Frontend Architect",
    slug: "frontend-architect",
    role: "frontend-architect",
    description: "Specializes in React",
    prompt: "---\nname: frontend-architect\n---\nYou are a frontend expert.",
    enabled: true,
    sourceRepo: "closedloop-ai/symphony-alpha",
    bootstrapRunId: "run-44444444-4444-4444-4444-444444444444",
    currentVersion: 1,
    createdById: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildAgentWithCreator(overrides: Record<string, unknown> = {}) {
  return {
    ...buildAgent(),
    createdBy: TEST_USER_SUMMARY,
    ...overrides,
  };
}

function buildVersionWithChanger(overrides: Record<string, unknown> = {}) {
  return {
    id: "version-55555555-5555-5555-5555-555555555555",
    agentId: AGENT_ID,
    version: 1,
    name: "Frontend Architect",
    prompt: "---\nname: frontend-architect\n---\nYou are a frontend expert.",
    changeNote: "Initial version",
    changedById: USER_ID,
    createdAt: NOW,
    changedBy: TEST_USER_SUMMARY,
    ...overrides,
  };
}

function installDb(db: Record<string, unknown>) {
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(db)
  );
}

function installDbTx(db: Record<string, unknown>) {
  mocks.withDb.tx.mockImplementation((callback: (tx: unknown) => unknown) =>
    callback(db)
  );
}

describe("agentsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // findAll
  // ---------------------------------------------------------------------------

  describe("agentsService.findAll", () => {
    it("returns agents and total for an org", async () => {
      const agent = buildAgent();
      installDb({
        agent: {
          findMany: vi.fn().mockResolvedValue([agent]),
          count: vi.fn().mockResolvedValue(1),
        },
      });

      const result = await agentsService.findAll(ORG_ID);

      expect(result.total).toBe(1);
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]?.slug).toBe("frontend-architect");
    });

    it("filters by enabled flag", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      installDb({ agent: { findMany, count } });

      await agentsService.findAll(ORG_ID, { enabled: true });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ enabled: true }),
        })
      );
    });

    it("filters by search term using case-insensitive OR across name and role", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      installDb({ agent: { findMany, count } });

      await agentsService.findAll(ORG_ID, { search: "frontend" });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                name: expect.objectContaining({ mode: "insensitive" }),
              }),
              expect.objectContaining({
                role: expect.objectContaining({ mode: "insensitive" }),
              }),
            ]),
          }),
        })
      );
    });

    it("returns empty agents and zero total when no agents match", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      installDb({ agent: { findMany, count } });

      const result = await agentsService.findAll(ORG_ID, {
        search: "nonexistent",
      });

      expect(result).toEqual({ agents: [], total: 0 });
    });
  });

  // ---------------------------------------------------------------------------
  // findByIdOrSlug
  // ---------------------------------------------------------------------------

  describe("agentsService.findByIdOrSlug", () => {
    it("returns agent detail when found by slug", async () => {
      mocks.isUuid.mockReturnValue(false);
      const agentRow = buildAgentWithCreator();
      const findUnique = vi.fn().mockResolvedValue(agentRow);
      installDb({
        agent: { findUnique },
      });

      const result = await agentsService.findByIdOrSlug(
        "frontend-architect",
        ORG_ID
      );

      expect(result).not.toBeNull();
      expect(result?.slug).toBe("frontend-architect");
      expect(result?.createdBy).toEqual(TEST_USER_SUMMARY);
      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId_slug: {
              organizationId: ORG_ID,
              slug: "frontend-architect",
            },
          },
          include: expect.objectContaining({
            createdBy: expect.objectContaining({ select: expect.anything() }),
          }),
        })
      );
    });

    it("returns agent detail when found by UUID", async () => {
      mocks.isUuid.mockReturnValue(true);
      const agentRow = buildAgentWithCreator();
      const findUnique = vi.fn().mockResolvedValue(agentRow);
      installDb({
        agent: { findUnique },
      });

      const result = await agentsService.findByIdOrSlug(AGENT_ID, ORG_ID);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(AGENT_ID);
      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: AGENT_ID, organizationId: ORG_ID },
          include: expect.objectContaining({
            createdBy: expect.objectContaining({ select: expect.anything() }),
          }),
        })
      );
    });

    it("returns null when agent not found", async () => {
      mocks.isUuid.mockReturnValue(false);
      installDb({
        agent: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      });

      const result = await agentsService.findByIdOrSlug("unknown-slug", ORG_ID);

      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------

  describe("agentsService.create", () => {
    it("creates an agent with initial version", async () => {
      const agentRow = buildAgentWithCreator();
      const agentCreate = vi.fn().mockResolvedValue(agentRow);
      const versionCreate = vi.fn().mockResolvedValue({});
      const agentFindUnique = vi.fn().mockResolvedValue(null);

      installDbTx({
        agent: {
          findUnique: agentFindUnique,
          create: agentCreate,
        },
        agentVersion: {
          create: versionCreate,
        },
      });

      const result = await agentsService.create(ORG_ID, USER_ID, {
        name: "Frontend Architect",
        role: "frontend-architect",
        prompt: "You are a frontend expert.",
      });

      expect(agentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: ORG_ID,
            createdById: USER_ID,
            name: "Frontend Architect",
            role: "frontend-architect",
          }),
        })
      );
      expect(versionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            agentId: agentRow.id,
            version: 1,
            changeNote: "Initial version",
            changedById: USER_ID,
          }),
        })
      );
      expect(result.slug).toBe("frontend-architect");
      expect(result.createdBy).toEqual(TEST_USER_SUMMARY);
    });

    it("generates a unique slug with suffix when base slug is taken", async () => {
      const agentRow = buildAgentWithCreator({ slug: "frontend-architect-2" });
      const agentCreate = vi.fn().mockResolvedValue(agentRow);
      const versionCreate = vi.fn().mockResolvedValue({});
      const findUniqueSequence = vi
        .fn()
        .mockResolvedValueOnce({ id: "existing" })
        .mockResolvedValueOnce(null);

      installDbTx({
        agent: {
          findUnique: findUniqueSequence,
          create: agentCreate,
        },
        agentVersion: {
          create: versionCreate,
        },
      });

      const result = await agentsService.create(ORG_ID, USER_ID, {
        name: "Frontend Architect",
        role: "frontend-architect",
        prompt: "You are a frontend expert.",
      });

      expect(agentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ slug: "frontend-architect-2" }),
        })
      );
      expect(result.slug).toBe("frontend-architect-2");
    });

    it("slugifies special characters in role to hyphens and trims leading/trailing hyphens", async () => {
      const agentRow = buildAgentWithCreator({ slug: "frontend-ui-architect" });
      const agentCreate = vi.fn().mockResolvedValue(agentRow);
      const versionCreate = vi.fn().mockResolvedValue({});
      // findUnique returns null → base slug is available
      const agentFindUnique = vi.fn().mockResolvedValue(null);

      installDbTx({
        agent: {
          findUnique: agentFindUnique,
          create: agentCreate,
        },
        agentVersion: { create: versionCreate },
      });

      await agentsService.create(ORG_ID, USER_ID, {
        name: "Frontend UI Architect",
        role: "  Frontend UI/Architect!!  ",
        prompt: "You are a frontend expert.",
      });

      // Spaces, slashes and punctuation collapse to hyphens; leading/trailing hyphens trimmed
      expect(agentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            slug: "frontend-ui-architect",
          }),
        })
      );
    });

    it("uses base slug when it is not taken", async () => {
      const agentRow = buildAgentWithCreator({ slug: "my-agent" });
      const agentCreate = vi.fn().mockResolvedValue(agentRow);
      const versionCreate = vi.fn().mockResolvedValue({});
      // findUnique always returns null → base slug available immediately
      const agentFindUnique = vi.fn().mockResolvedValue(null);

      installDbTx({
        agent: {
          findUnique: agentFindUnique,
          create: agentCreate,
        },
        agentVersion: { create: versionCreate },
      });

      await agentsService.create(ORG_ID, USER_ID, {
        name: "My Agent",
        role: "my-agent",
        prompt: "You are an agent.",
      });

      expect(agentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ slug: "my-agent" }),
        })
      );
      // Only one findUnique call for the base slug check
      expect(agentFindUnique).toHaveBeenCalledTimes(1);
    });

    it("throws an error when all 100 slug suffix candidates are taken", async () => {
      const agentCreate = vi.fn().mockResolvedValue(buildAgentWithCreator());
      // findUnique always returns an existing agent — every slug candidate is taken
      const agentFindUnique = vi
        .fn()
        .mockResolvedValue({ id: "some-existing" });

      installDbTx({
        agent: {
          findUnique: agentFindUnique,
          create: agentCreate,
        },
      });

      await expect(
        agentsService.create(ORG_ID, USER_ID, {
          name: "Busy Agent",
          role: "busy-agent",
          prompt: "You are busy.",
        })
      ).rejects.toThrow(UNIQUE_SLUG_ERROR_PATTERN);

      expect(agentCreate).not.toHaveBeenCalled();
      expect(agentFindUnique).toHaveBeenCalledTimes(100);
    });
  });

  // ---------------------------------------------------------------------------
  // update
  // ---------------------------------------------------------------------------

  describe("agentsService.update", () => {
    beforeEach(() => {
      mocks.isUuid.mockReturnValue(false);
    });

    it("bumps version and creates a version record when prompt changes", async () => {
      const existingRow = { id: AGENT_ID, currentVersion: 1 };
      const updatedRow = buildAgentWithCreator({ currentVersion: 2 });
      const agentFindUnique = vi.fn().mockResolvedValue(existingRow);
      const agentUpdate = vi.fn().mockResolvedValue(updatedRow);
      const versionCreate = vi.fn().mockResolvedValue({});

      installDbTx({
        agent: {
          findUnique: agentFindUnique,
          update: agentUpdate,
        },
        agentVersion: {
          create: versionCreate,
        },
      });

      const result = await agentsService.update(
        "frontend-architect",
        ORG_ID,
        USER_ID,
        { prompt: "Updated prompt", changeNote: "Improved instructions" }
      );

      expect(agentUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            currentVersion: 2,
            prompt: "Updated prompt",
          }),
        })
      );
      expect(versionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            version: 2,
            changeNote: "Improved instructions",
            changedById: USER_ID,
          }),
        })
      );
      expect(result?.currentVersion).toBe(2);
    });

    it("does not bump version when only enabled flag changes", async () => {
      const existingRow = { id: AGENT_ID, currentVersion: 1 };
      const updatedRow = buildAgentWithCreator({ enabled: false });
      const agentFindUnique = vi.fn().mockResolvedValue(existingRow);
      const agentUpdate = vi.fn().mockResolvedValue(updatedRow);
      const versionCreate = vi.fn().mockResolvedValue({});

      installDbTx({
        agent: {
          findUnique: agentFindUnique,
          update: agentUpdate,
        },
        agentVersion: {
          create: versionCreate,
        },
      });

      await agentsService.update("frontend-architect", ORG_ID, USER_ID, {
        enabled: false,
      });

      expect(agentUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({
            currentVersion: expect.anything(),
          }),
        })
      );
      expect(versionCreate).not.toHaveBeenCalled();
    });

    it("bumps version and creates a version record when name changes", async () => {
      const existingRow = { id: AGENT_ID, currentVersion: 1 };
      const updatedRow = buildAgentWithCreator({
        name: "Renamed Architect",
        currentVersion: 2,
      });
      const agentFindUnique = vi.fn().mockResolvedValue(existingRow);
      const agentUpdate = vi.fn().mockResolvedValue(updatedRow);
      const versionCreate = vi.fn().mockResolvedValue({});

      installDbTx({
        agent: {
          findUnique: agentFindUnique,
          update: agentUpdate,
        },
        agentVersion: {
          create: versionCreate,
        },
      });

      const result = await agentsService.update(
        "frontend-architect",
        ORG_ID,
        USER_ID,
        { name: "Renamed Architect", changeNote: "Renamed agent" }
      );

      expect(agentUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            currentVersion: 2,
            name: "Renamed Architect",
          }),
        })
      );
      expect(versionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            version: 2,
            changeNote: "Renamed agent",
            changedById: USER_ID,
          }),
        })
      );
      expect(result?.currentVersion).toBe(2);
    });

    it("updates without bumping version when only description changes", async () => {
      const existingRow = { id: AGENT_ID, currentVersion: 1 };
      const updatedRow = buildAgentWithCreator({
        description: "Updated description only",
      });
      const agentFindUnique = vi.fn().mockResolvedValue(existingRow);
      const agentUpdate = vi.fn().mockResolvedValue(updatedRow);
      const versionCreate = vi.fn().mockResolvedValue({});

      installDbTx({
        agent: {
          findUnique: agentFindUnique,
          update: agentUpdate,
        },
        agentVersion: {
          create: versionCreate,
        },
      });

      await agentsService.update("frontend-architect", ORG_ID, USER_ID, {
        description: "Updated description only",
      });

      expect(agentUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({
            currentVersion: expect.anything(),
          }),
        })
      );
      expect(versionCreate).not.toHaveBeenCalled();
    });

    it("returns null when agent not found", async () => {
      installDbTx({
        agent: { findUnique: vi.fn().mockResolvedValue(null) },
      });

      const result = await agentsService.update(
        "nonexistent",
        ORG_ID,
        USER_ID,
        {}
      );

      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------

  describe("agentsService.delete", () => {
    it("returns true when agent deleted by slug", async () => {
      mocks.isUuid.mockReturnValue(false);
      const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
      installDb({ agent: { deleteMany } });

      const result = await agentsService.delete("frontend-architect", ORG_ID);

      expect(result).toBe(true);
      expect(deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            slug: "frontend-architect",
            organizationId: ORG_ID,
          }),
        })
      );
    });

    it("returns true when agent deleted by UUID", async () => {
      mocks.isUuid.mockReturnValue(true);
      const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
      installDb({ agent: { deleteMany } });

      const result = await agentsService.delete(AGENT_ID, ORG_ID);

      expect(result).toBe(true);
      expect(deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: AGENT_ID,
            organizationId: ORG_ID,
          }),
        })
      );
    });

    it("returns false when no agent matched", async () => {
      mocks.isUuid.mockReturnValue(false);
      installDb({
        agent: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      });

      const result = await agentsService.delete("nonexistent", ORG_ID);

      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // findVersions
  // ---------------------------------------------------------------------------

  describe("agentsService.findVersions", () => {
    beforeEach(() => {
      mocks.isUuid.mockReturnValue(false);
    });

    it("returns version summaries ordered by version desc", async () => {
      const v2 = buildVersionWithChanger({ version: 2, changeNote: "Updated" });
      const v1 = buildVersionWithChanger({
        version: 1,
        changeNote: "Initial version",
      });
      const findUnique = vi.fn().mockResolvedValue({ versions: [v2, v1] });
      installDb({
        agent: { findUnique },
      });

      const result = await agentsService.findVersions(
        "frontend-architect",
        ORG_ID
      );

      expect(result).not.toBeNull();
      expect(result).toHaveLength(2);
      expect(result?.[0]?.version).toBe(2);
      expect(result?.[1]?.version).toBe(1);
      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            versions: expect.objectContaining({
              include: expect.objectContaining({
                changedBy: expect.objectContaining({
                  select: expect.anything(),
                }),
              }),
            }),
          }),
        })
      );
    });

    it("returns null when agent not found", async () => {
      installDb({
        agent: { findUnique: vi.fn().mockResolvedValue(null) },
      });

      const result = await agentsService.findVersions("nonexistent", ORG_ID);

      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // findVersion
  // ---------------------------------------------------------------------------

  describe("agentsService.findVersion", () => {
    beforeEach(() => {
      mocks.isUuid.mockReturnValue(false);
    });

    it("returns version detail when found", async () => {
      const versionRow = buildVersionWithChanger({ version: 1 });
      installDb({
        agent: {
          findUnique: vi.fn().mockResolvedValue({ versions: [versionRow] }),
        },
      });

      const result = await agentsService.findVersion(
        "frontend-architect",
        ORG_ID,
        1
      );

      expect(result).not.toBeNull();
      expect(result?.version).toBe(1);
      expect(result?.prompt).toContain("frontend-architect");
      expect(result?.changedBy).toEqual(TEST_USER_SUMMARY);
    });

    it("returns null when version not found", async () => {
      installDb({
        agent: {
          findUnique: vi.fn().mockResolvedValue({ versions: [] }),
        },
      });

      const result = await agentsService.findVersion(
        "frontend-architect",
        ORG_ID,
        99
      );

      expect(result).toBeNull();
    });

    it("returns null when agent not found", async () => {
      installDb({
        agent: { findUnique: vi.fn().mockResolvedValue(null) },
      });

      const result = await agentsService.findVersion("nonexistent", ORG_ID, 1);

      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // bulkIngest
  // ---------------------------------------------------------------------------

  describe("agentsService.bulkIngest", () => {
    it("creates new agents and initial versions", async () => {
      const agentRow = buildAgent({ slug: "frontend-architect" });
      const agentFindMany = vi.fn().mockResolvedValue([]);
      const agentFindUnique = vi.fn().mockResolvedValue(null);
      const agentCreate = vi.fn().mockResolvedValue(agentRow);
      const versionCreate = vi.fn().mockResolvedValue({});

      installDbTx({
        agent: {
          findMany: agentFindMany,
          findUnique: agentFindUnique,
          create: agentCreate,
        },
        agentVersion: { create: versionCreate },
      });

      const result = await agentsService.bulkIngest(ORG_ID, USER_ID, {
        agents: [INGEST_AGENT_INPUT],
        bootstrapRunId: INGEST_BOOTSTRAP_RUN_ID,
        sourceRepo: INGEST_SOURCE_REPO,
      });

      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.agents).toHaveLength(1);
      expect(versionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            version: 1,
            changeNote: "Initial version from bootstrap",
            changedById: USER_ID,
          }),
        })
      );
    });

    it("updates existing agents and creates new versions", async () => {
      const existingAgent = buildAgent({ currentVersion: 1 });
      const updatedAgent = buildAgent({ currentVersion: 2 });
      const agentFindMany = vi.fn().mockResolvedValue([existingAgent]);
      const agentUpdate = vi.fn().mockResolvedValue(updatedAgent);
      const versionCreate = vi.fn().mockResolvedValue({});

      installDbTx({
        agent: {
          findMany: agentFindMany,
          update: agentUpdate,
        },
        agentVersion: { create: versionCreate },
      });

      const result = await agentsService.bulkIngest(ORG_ID, USER_ID, {
        agents: [
          {
            name: "Frontend Architect",
            role: "frontend-architect",
            prompt: "Updated prompt.",
          },
        ],
        bootstrapRunId: INGEST_BOOTSTRAP_RUN_ID,
        sourceRepo: INGEST_SOURCE_REPO,
      });

      expect(result.created).toBe(0);
      expect(result.updated).toBe(1);
      expect(agentUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: AGENT_ID },
          data: expect.objectContaining({ currentVersion: 2 }),
        })
      );
      expect(versionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            version: 2,
            changeNote: "Re-generated by bootstrap",
          }),
        })
      );
    });

    it("deduplicates agents by role", async () => {
      const agentFindMany = vi.fn().mockResolvedValue([]);
      const agentFindUnique = vi.fn().mockResolvedValue(null);
      const agentCreate = vi.fn().mockResolvedValue(buildAgent());
      const versionCreate = vi.fn().mockResolvedValue({});

      installDbTx({
        agent: {
          findMany: agentFindMany,
          findUnique: agentFindUnique,
          create: agentCreate,
        },
        agentVersion: { create: versionCreate },
      });

      const result = await agentsService.bulkIngest(ORG_ID, USER_ID, {
        agents: [
          { name: "Frontend v1", role: "frontend-architect", prompt: "v1" },
          { name: "Frontend v2", role: "frontend-architect", prompt: "v2" },
        ],
        bootstrapRunId: INGEST_BOOTSTRAP_RUN_ID,
        sourceRepo: INGEST_SOURCE_REPO,
      });

      expect(agentCreate).toHaveBeenCalledTimes(1);
      expect(result.created).toBe(1);
    });

    it("skips repoBootstrapConfig upsert when criticGates is undefined", async () => {
      const agentFindMany = vi.fn().mockResolvedValue([]);
      const agentFindUnique = vi.fn().mockResolvedValue(null);
      const agentCreate = vi.fn().mockResolvedValue(buildAgent());
      const versionCreate = vi.fn().mockResolvedValue({});
      const configUpsert = vi.fn().mockResolvedValue({});

      installDbTx({
        agent: {
          findMany: agentFindMany,
          findUnique: agentFindUnique,
          create: agentCreate,
        },
        agentVersion: { create: versionCreate },
        repoBootstrapConfig: { upsert: configUpsert },
      });

      await agentsService.bulkIngest(ORG_ID, USER_ID, {
        agents: [INGEST_AGENT_INPUT],
        bootstrapRunId: INGEST_BOOTSTRAP_RUN_ID,
        sourceRepo: INGEST_SOURCE_REPO,
        // criticGates intentionally omitted
      });

      expect(configUpsert).not.toHaveBeenCalled();
    });

    it("uses last duplicate agent entry when deduplicating by role", async () => {
      const agentFindMany = vi.fn().mockResolvedValue([]);
      const agentFindUnique = vi.fn().mockResolvedValue(null);
      const agentCreate = vi
        .fn()
        .mockResolvedValue(buildAgent({ name: "Frontend v2" }));
      const versionCreate = vi.fn().mockResolvedValue({});

      installDbTx({
        agent: {
          findMany: agentFindMany,
          findUnique: agentFindUnique,
          create: agentCreate,
        },
        agentVersion: { create: versionCreate },
      });

      await agentsService.bulkIngest(ORG_ID, USER_ID, {
        agents: [
          {
            name: "Frontend v1",
            role: "frontend-architect",
            prompt: "v1 prompt",
          },
          {
            name: "Frontend v2",
            role: "frontend-architect",
            prompt: "v2 prompt",
          },
        ],
        bootstrapRunId: INGEST_BOOTSTRAP_RUN_ID,
        sourceRepo: INGEST_SOURCE_REPO,
      });

      // Only one create call — the second (last) entry wins deduplication
      expect(agentCreate).toHaveBeenCalledTimes(1);
      expect(agentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: "Frontend v2",
            prompt: "v2 prompt",
          }),
        })
      );
    });

    it("upserts repoBootstrapConfig when criticGates provided", async () => {
      const agentFindMany = vi.fn().mockResolvedValue([]);
      const agentFindUnique = vi.fn().mockResolvedValue(null);
      const agentCreate = vi.fn().mockResolvedValue(buildAgent());
      const versionCreate = vi.fn().mockResolvedValue({});
      const configUpsert = vi.fn().mockResolvedValue({});

      installDbTx({
        agent: {
          findMany: agentFindMany,
          findUnique: agentFindUnique,
          create: agentCreate,
        },
        agentVersion: { create: versionCreate },
        repoBootstrapConfig: { upsert: configUpsert },
      });

      await agentsService.bulkIngest(ORG_ID, USER_ID, {
        agents: [INGEST_AGENT_INPUT],
        bootstrapRunId: INGEST_BOOTSTRAP_RUN_ID,
        sourceRepo: INGEST_SOURCE_REPO,
        criticGates: { gate1: { threshold: 0.8 } },
      });

      expect(configUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId_repoFullName: {
              organizationId: ORG_ID,
              repoFullName: INGEST_SOURCE_REPO,
            },
          },
          create: expect.objectContaining({
            organizationId: ORG_ID,
            repoFullName: INGEST_SOURCE_REPO,
            bootstrapRunId: INGEST_BOOTSTRAP_RUN_ID,
          }),
        })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getContextPackData
  // ---------------------------------------------------------------------------

  describe("agentsService.getContextPackData", () => {
    it("returns enabled agents and repo configs", async () => {
      const agentRows = [
        {
          slug: "frontend-architect",
          name: "Frontend Architect",
          prompt: "You are...",
        },
      ];
      const configRows = [
        {
          repoFullName: "closedloop-ai/symphony-alpha",
          criticGates: { gate1: {} },
        },
      ];
      const agentFindMany = vi.fn().mockResolvedValue(agentRows);
      const configFindMany = vi.fn().mockResolvedValue(configRows);
      installDb({
        agent: { findMany: agentFindMany },
        repoBootstrapConfig: { findMany: configFindMany },
      });

      const result = await agentsService.getContextPackData(ORG_ID);

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]?.slug).toBe("frontend-architect");
      expect(result.repoConfigs).toHaveLength(1);
      expect(result.repoConfigs[0]?.repoFullName).toBe(
        "closedloop-ai/symphony-alpha"
      );
      expect(agentFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: ORG_ID,
            enabled: true,
          }),
          select: expect.objectContaining({
            slug: true,
            name: true,
            prompt: true,
          }),
          orderBy: { slug: "asc" },
        })
      );
      expect(configFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organizationId: ORG_ID }),
        })
      );
    });

    it("returns empty arrays when no data exists", async () => {
      installDb({
        agent: { findMany: vi.fn().mockResolvedValue([]) },
        repoBootstrapConfig: { findMany: vi.fn().mockResolvedValue([]) },
      });

      const result = await agentsService.getContextPackData(ORG_ID);

      expect(result.agents).toHaveLength(0);
      expect(result.repoConfigs).toHaveLength(0);
    });
  });
});
