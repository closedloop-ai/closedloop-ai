import "server-only";

import type {
  AgentDetail,
  AgentSummary,
  AgentVersionDetail,
  AgentVersionSummary,
  BulkIngestAgentResponse,
  ContextPackAgent,
  ContextPackRepoConfig,
} from "@repo/api/src/types/agent";
import { Result } from "@repo/api/src/types/result";
import {
  type Agent,
  type Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { isUuid } from "@/lib/identifier-utils";

type AgentWithCreator = Prisma.AgentGetPayload<{
  include: typeof AGENT_DETAIL_INCLUDE;
}>;

type VersionWithChanger = Prisma.AgentVersionGetPayload<{
  include: typeof VERSION_DETAIL_INCLUDE;
}>;

const AGENT_DETAIL_INCLUDE = {
  createdBy: { select: { id: true, firstName: true, lastName: true } },
} as const;

const VERSION_DETAIL_INCLUDE = {
  changedBy: { select: { id: true, firstName: true, lastName: true } },
} as const;

function agentWhere(idOrSlug: string, organizationId: string) {
  return isUuid(idOrSlug)
    ? { id: idOrSlug, organizationId }
    : { organizationId_slug: { organizationId, slug: idOrSlug } };
}

function toAgentSummary(agent: Agent): AgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    slug: agent.slug,
    role: agent.role,
    description: agent.description,
    enabled: agent.enabled,
    sourceRepo: agent.sourceRepo,
    currentVersion: agent.currentVersion,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function toAgentDetail(agent: AgentWithCreator): AgentDetail {
  return {
    ...toAgentSummary(agent),
    prompt: agent.prompt,
    bootstrapRunId: agent.bootstrapRunId,
    createdBy: agent.createdBy,
  };
}

function toVersionSummary(version: VersionWithChanger): AgentVersionSummary {
  return {
    id: version.id,
    version: version.version,
    name: version.name,
    changeNote: version.changeNote,
    changedBy: version.changedBy,
    createdAt: version.createdAt,
  };
}

function toVersionDetail(version: VersionWithChanger): AgentVersionDetail {
  return {
    ...toVersionSummary(version),
    prompt: version.prompt,
  };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

async function generateUniqueSlug(
  organizationId: string,
  role: string,
  db: TransactionClient
): Promise<string> {
  const base = slugify(role);
  const existing = await db.agent.findUnique({
    where: { organizationId_slug: { organizationId, slug: base } },
    select: { id: true },
  });
  if (!existing) {
    return base;
  }

  let suffix = 2;
  while (suffix <= 100) {
    const candidate = `${base}-${suffix}`;
    const found = await db.agent.findUnique({
      where: { organizationId_slug: { organizationId, slug: candidate } },
      select: { id: true },
    });
    if (!found) {
      return candidate;
    }
    suffix++;
  }
  throw new Error(`Could not generate unique slug for role "${role}"`);
}

export const agentsService = {
  async findAll(
    organizationId: string,
    options?: { enabled?: boolean; search?: string; sourceRepo?: string }
  ): Promise<{ agents: AgentSummary[]; total: number }> {
    const where: Prisma.AgentWhereInput = {
      organizationId,
      ...(options?.enabled === undefined ? {} : { enabled: options.enabled }),
      ...(options?.sourceRepo === undefined
        ? {}
        : { sourceRepo: options.sourceRepo }),
      ...(options?.search
        ? {
            OR: [
              { name: { contains: options.search, mode: "insensitive" } },
              { role: { contains: options.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [agents, total] = await withDb((db) =>
      Promise.all([
        db.agent.findMany({
          where,
          orderBy: { createdAt: "desc" },
        }),
        db.agent.count({ where }),
      ])
    );

    return { agents: agents.map(toAgentSummary), total };
  },

  async findByIdOrSlug(
    idOrSlug: string,
    organizationId: string
  ): Promise<AgentDetail | null> {
    const agent = await withDb((db) =>
      db.agent.findUnique({
        where: agentWhere(idOrSlug, organizationId),
        include: AGENT_DETAIL_INCLUDE,
      })
    );

    return agent ? toAgentDetail(agent) : null;
  },

  async create(
    organizationId: string,
    userId: string,
    input: {
      name: string;
      role: string;
      description?: string;
      prompt: string;
      sourceRepo?: string;
      bootstrapRunId?: string;
    }
  ): Promise<Result<AgentDetail, "conflict">> {
    try {
      const agent = await withDb.tx(async (tx) => {
        const slug = await generateUniqueSlug(organizationId, input.role, tx);

        const created = await tx.agent.create({
          data: {
            organizationId,
            name: input.name,
            slug,
            role: input.role,
            description: input.description,
            prompt: input.prompt,
            sourceRepo: input.sourceRepo,
            bootstrapRunId: input.bootstrapRunId,
            createdById: userId,
          },
          include: AGENT_DETAIL_INCLUDE,
        });

        await tx.agentVersion.create({
          data: {
            agentId: created.id,
            version: 1,
            name: created.name,
            prompt: created.prompt,
            changeNote: "Initial version",
            changedById: userId,
          },
        });

        return created;
      });

      return Result.ok(toAgentDetail(agent));
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2002") {
        return Result.err("conflict");
      }
      throw error;
    }
  },

  async update(
    idOrSlug: string,
    organizationId: string,
    userId: string,
    input: {
      name?: string;
      description?: string;
      prompt?: string;
      enabled?: boolean;
      changeNote?: string;
    }
  ): Promise<AgentDetail | null> {
    const agent = await withDb.tx(async (tx) => {
      const existing = await tx.agent.findUnique({
        where: agentWhere(idOrSlug, organizationId),
        select: { id: true, currentVersion: true },
      });

      if (!existing) {
        return null;
      }

      const needsVersion =
        input.prompt !== undefined || input.name !== undefined;

      // Atomically claim the next version number via increment so concurrent
      // updates can't both read N and both write N+1 (violating the
      // `@@unique([agentId, version])` constraint on AgentVersion).
      const updated = await tx.agent.update({
        where: { id: existing.id },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
          ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(needsVersion ? { currentVersion: { increment: 1 } } : {}),
        },
        include: AGENT_DETAIL_INCLUDE,
      });

      if (needsVersion) {
        await tx.agentVersion.create({
          data: {
            agentId: existing.id,
            version: updated.currentVersion,
            name: updated.name,
            prompt: updated.prompt,
            changeNote: input.changeNote,
            changedById: userId,
          },
        });
      }

      return updated;
    });

    return agent ? toAgentDetail(agent) : null;
  },

  async delete(idOrSlug: string, organizationId: string): Promise<boolean> {
    const deleted = await withDb((db) =>
      db.agent.deleteMany({
        where: isUuid(idOrSlug)
          ? { id: idOrSlug, organizationId }
          : { slug: idOrSlug, organizationId },
      })
    );
    return deleted.count > 0;
  },

  async findVersions(
    idOrSlug: string,
    organizationId: string
  ): Promise<AgentVersionSummary[] | null> {
    const agent = await withDb((db) =>
      db.agent.findUnique({
        where: agentWhere(idOrSlug, organizationId),
        select: {
          versions: {
            include: VERSION_DETAIL_INCLUDE,
            orderBy: { version: "desc" },
          },
        },
      })
    );

    if (!agent) {
      return null;
    }

    return agent.versions.map(toVersionSummary);
  },

  async findVersion(
    idOrSlug: string,
    organizationId: string,
    version: number
  ): Promise<AgentVersionDetail | null> {
    const agent = await withDb((db) =>
      db.agent.findUnique({
        where: agentWhere(idOrSlug, organizationId),
        select: {
          versions: {
            where: { version },
            include: VERSION_DETAIL_INCLUDE,
            take: 1,
          },
        },
      })
    );

    if (!agent) {
      return null;
    }

    const versionRecord = agent.versions[0];
    return versionRecord ? toVersionDetail(versionRecord) : null;
  },

  async bulkIngest(
    organizationId: string,
    userId: string,
    input: {
      agents: Array<{
        name: string;
        role: string;
        description?: string;
        prompt: string;
        sourceRepo?: string;
        bootstrapRunId?: string;
      }>;
      bootstrapRunId: string;
      sourceRepo: string;
      criticGates?: Record<string, unknown>;
    }
  ): Promise<BulkIngestAgentResponse> {
    let created = 0;
    let updated = 0;
    const results: AgentSummary[] = [];

    await withDb.tx(async (tx) => {
      const dedupedAgents = [
        ...new Map(input.agents.map((a) => [a.role, a])).values(),
      ];
      const roles = dedupedAgents.map((a) => a.role);
      const existingAgents = await tx.agent.findMany({
        where: {
          organizationId,
          sourceRepo: input.sourceRepo,
          role: { in: roles },
        },
      });
      const byRole = new Map(existingAgents.map((a) => [a.role, a]));

      for (const agentInput of dedupedAgents) {
        const existingByRole = byRole.get(agentInput.role);

        if (existingByRole) {
          // Atomically claim the next version number via increment so
          // concurrent imports can't both read N and both write N+1
          // (violating the `@@unique([agentId, version])` constraint).
          const updatedAgent = await tx.agent.update({
            where: { id: existingByRole.id },
            data: {
              name: agentInput.name,
              description: agentInput.description,
              prompt: agentInput.prompt,
              sourceRepo: input.sourceRepo,
              bootstrapRunId: input.bootstrapRunId,
              currentVersion: { increment: 1 },
            },
          });

          await tx.agentVersion.create({
            data: {
              agentId: existingByRole.id,
              version: updatedAgent.currentVersion,
              name: agentInput.name,
              prompt: agentInput.prompt,
              changeNote: "Re-generated by bootstrap",
              changedById: userId,
            },
          });

          results.push(toAgentSummary(updatedAgent));
          updated++;
        } else {
          const slug = await generateUniqueSlug(
            organizationId,
            agentInput.role,
            tx
          );

          const createdAgent = await tx.agent.create({
            data: {
              organizationId,
              name: agentInput.name,
              slug,
              role: agentInput.role,
              description: agentInput.description,
              prompt: agentInput.prompt,
              sourceRepo: input.sourceRepo,
              bootstrapRunId: input.bootstrapRunId,
              createdById: userId,
            },
          });

          await tx.agentVersion.create({
            data: {
              agentId: createdAgent.id,
              version: 1,
              name: agentInput.name,
              prompt: agentInput.prompt,
              changeNote: "Initial version from bootstrap",
              changedById: userId,
            },
          });

          results.push(toAgentSummary(createdAgent));
          created++;
        }
      }

      if (input.criticGates) {
        await tx.repoBootstrapConfig.upsert({
          where: {
            organizationId_repoFullName: {
              organizationId,
              repoFullName: input.sourceRepo,
            },
          },
          create: {
            organizationId,
            repoFullName: input.sourceRepo,
            criticGates: input.criticGates as Prisma.InputJsonValue,
            bootstrapRunId: input.bootstrapRunId,
          },
          update: {
            criticGates: input.criticGates as Prisma.InputJsonValue,
            bootstrapRunId: input.bootstrapRunId,
          },
        });
      }
    });

    return { created, updated, agents: results };
  },

  async getContextPackData(
    organizationId: string,
    repoFullNames?: string[]
  ): Promise<{
    agents: ContextPackAgent[];
    repoConfigs: ContextPackRepoConfig[];
  }> {
    const contextPackAgentWhere: Prisma.AgentWhereInput = {
      organizationId,
      enabled: true,
      ...(repoFullNames ? { sourceRepo: { in: ["", ...repoFullNames] } } : {}),
    };

    const [agents, repoConfigs] = await withDb((db) =>
      Promise.all([
        db.agent.findMany({
          where: contextPackAgentWhere,
          select: { slug: true, name: true, prompt: true },
          orderBy: { slug: "asc" },
        }),
        db.repoBootstrapConfig.findMany({
          where: {
            organizationId,
            ...(repoFullNames ? { repoFullName: { in: repoFullNames } } : {}),
          },
          select: { repoFullName: true, criticGates: true },
        }),
      ])
    );

    return {
      agents,
      repoConfigs: repoConfigs.map((c) => ({
        repoFullName: c.repoFullName,
        criticGates: c.criticGates as Record<string, unknown>,
      })),
    };
  },
};
