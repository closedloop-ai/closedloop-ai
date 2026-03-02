import type { JsonObject } from "@repo/api/src/types/common";
import type {
  ComputeTarget,
  RegisterComputeTargetInput,
  UpdateComputeTargetInput,
} from "@repo/api/src/types/compute-target";
import { withDb } from "@repo/database";

export const COMPUTE_TARGET_STALE_MS = 90_000;

type ComputeTargetRecord = {
  id: string;
  organizationId: string;
  userId: string;
  machineName: string;
  platform: string;
  capabilities: unknown;
  supportedOperations: unknown;
  lastSeenAt: Date;
  isOnline: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function toComputeTarget(
  target: ComputeTargetRecord | null
): ComputeTarget | null {
  if (!target) {
    return null;
  }

  return {
    id: target.id,
    organizationId: target.organizationId,
    userId: target.userId,
    machineName: target.machineName,
    platform: target.platform,
    capabilities: toJsonObject(target.capabilities),
    supportedOperations: toStringArray(target.supportedOperations),
    lastSeenAt: target.lastSeenAt,
    isOnline: target.isOnline,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  };
}

function toComputeTargetList(targets: ComputeTargetRecord[]): ComputeTarget[] {
  return targets.map((target) => ({
    id: target.id,
    organizationId: target.organizationId,
    userId: target.userId,
    machineName: target.machineName,
    platform: target.platform,
    capabilities: toJsonObject(target.capabilities),
    supportedOperations: toStringArray(target.supportedOperations),
    lastSeenAt: target.lastSeenAt,
    isOnline: target.isOnline,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  }));
}

function buildCapabilitiesPayload(
  payload: RegisterComputeTargetInput
): JsonObject {
  const capabilities = {
    ...(payload.capabilities ?? {}),
  } as JsonObject;

  if (payload.allowedDirectories) {
    capabilities.allowedDirectories = payload.allowedDirectories;
  }
  if (payload.pluginVersion) {
    capabilities.pluginVersion = payload.pluginVersion;
  }

  return capabilities;
}

export const computeTargetsService = {
  async register(
    organizationId: string,
    userId: string,
    payload: RegisterComputeTargetInput
  ): Promise<ComputeTarget> {
    const now = new Date();
    const target = await withDb((db) =>
      db.computeTarget.upsert({
        where: {
          userId_machineName: {
            userId,
            machineName: payload.machineName,
          },
        },
        update: {
          platform: payload.platform,
          capabilities: buildCapabilitiesPayload(payload),
          supportedOperations: payload.supportedOperations,
          isOnline: true,
          lastSeenAt: now,
        },
        create: {
          organizationId,
          userId,
          machineName: payload.machineName,
          platform: payload.platform,
          capabilities: buildCapabilitiesPayload(payload),
          supportedOperations: payload.supportedOperations,
          isOnline: true,
          lastSeenAt: now,
        },
      })
    );

    return toComputeTarget(target as ComputeTargetRecord) as ComputeTarget;
  },

  async listByOwner(
    organizationId: string,
    userId: string
  ): Promise<ComputeTarget[]> {
    const targets = await withDb((db) =>
      db.computeTarget.findMany({
        where: {
          organizationId,
          userId,
        },
        orderBy: [{ isOnline: "desc" }, { updatedAt: "desc" }],
      })
    );

    return toComputeTargetList(targets);
  },

  findById(id: string): Promise<ComputeTargetRecord | null> {
    return withDb((db) =>
      db.computeTarget.findUnique({
        where: { id },
      })
    ) as Promise<ComputeTargetRecord | null>;
  },

  async findOwnedById(
    id: string,
    organizationId: string,
    userId: string
  ): Promise<ComputeTarget | null> {
    const target = await withDb((db) =>
      db.computeTarget.findFirst({
        where: {
          id,
          organizationId,
          userId,
        },
      })
    );

    return toComputeTarget(target as ComputeTargetRecord | null);
  },

  async updateOwned(
    id: string,
    organizationId: string,
    userId: string,
    payload: UpdateComputeTargetInput
  ): Promise<ComputeTarget | null> {
    const target = await withDb((db) =>
      db.computeTarget.findFirst({
        where: { id, organizationId, userId },
        select: { id: true },
      })
    );

    if (!target) {
      return null;
    }

    const updated = await withDb((db) =>
      db.computeTarget.update({
        where: { id },
        data: {
          ...(payload.machineName ? { machineName: payload.machineName } : {}),
          ...(payload.platform ? { platform: payload.platform } : {}),
          ...(payload.capabilities
            ? { capabilities: payload.capabilities }
            : {}),
          ...(payload.supportedOperations
            ? { supportedOperations: payload.supportedOperations }
            : {}),
        },
      })
    );

    return toComputeTarget(updated as ComputeTargetRecord);
  },

  async deleteOwned(
    id: string,
    organizationId: string,
    userId: string
  ): Promise<boolean> {
    const deleted = await withDb((db) =>
      db.computeTarget.deleteMany({
        where: { id, organizationId, userId },
      })
    );
    return deleted.count > 0;
  },

  async heartbeat(
    id: string,
    organizationId: string,
    userId: string
  ): Promise<boolean> {
    const updated = await withDb((db) =>
      db.computeTarget.updateMany({
        where: { id, organizationId, userId },
        data: {
          isOnline: true,
          lastSeenAt: new Date(),
        },
      })
    );

    return updated.count > 0;
  },

  async setOnlineState(
    id: string,
    organizationId: string,
    userId: string,
    isOnline: boolean
  ): Promise<boolean> {
    const updated = await withDb((db) =>
      db.computeTarget.updateMany({
        where: { id, organizationId, userId },
        data: isOnline
          ? {
              isOnline: true,
              lastSeenAt: new Date(),
            }
          : {
              isOnline: false,
            },
      })
    );
    return updated.count > 0;
  },

  async markStaleTargetsOffline(scope?: {
    organizationId?: string;
    userId?: string;
  }): Promise<number> {
    const cutoff = new Date(Date.now() - COMPUTE_TARGET_STALE_MS);
    const updated = await withDb((db) =>
      db.computeTarget.updateMany({
        where: {
          isOnline: true,
          lastSeenAt: { lt: cutoff },
          ...(scope?.organizationId
            ? { organizationId: scope.organizationId }
            : {}),
          ...(scope?.userId ? { userId: scope.userId } : {}),
        },
        data: {
          isOnline: false,
        },
      })
    );

    return updated.count;
  },

  async hasAnyForOwner(
    organizationId: string,
    userId: string
  ): Promise<boolean> {
    const target = await withDb((db) =>
      db.computeTarget.findFirst({
        where: { organizationId, userId },
        select: { id: true },
      })
    );
    return Boolean(target);
  },
};
