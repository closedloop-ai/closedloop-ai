import { DESKTOP_API_NAMESPACE_CAPABILITY_KEY } from "@repo/api/src/desktop-api-namespace";
import type { JsonObject } from "@repo/api/src/types/common";
import type {
  ComputeTarget,
  ComputeTargetSecurity,
  RegisterComputeTargetInput,
  UpdateComputeTargetInput,
} from "@repo/api/src/types/compute-target";
import { DesktopSecurityStatus } from "@repo/api/src/types/compute-target";
import {
  type Result as DomainResult,
  Result,
} from "@repo/api/src/types/result";
import { ApiKeySource, withDb } from "@repo/database";
import { isDesktopManagedPopEnforcementEnabled } from "@/lib/auth/desktop-managed-pop";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { parseJsonObject } from "@/lib/json-schema";

export const COMPUTE_TARGET_STALE_MS = 90_000;
export const DESKTOP_SECURITY_UPGRADE_PROTOCOL_VERSION = 1;

export type ComputeTargetGatewayConflict = "gateway_conflict";

export function isComputeTargetGatewayConflictResult(
  result: DomainResult<unknown, ComputeTargetGatewayConflict>
): result is { ok: false; error: ComputeTargetGatewayConflict } {
  return !result.ok && result.error === "gateway_conflict";
}

function computeTargetGatewayConflictResult<T>(): DomainResult<
  T,
  ComputeTargetGatewayConflict
> {
  return Result.err("gateway_conflict");
}

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
  isSharedWithOrg: boolean;
  gatewayId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  user?: { firstName: string | null; lastName: string | null } | null;
};

function toJsonObject(value: unknown): JsonObject {
  return parseJsonObject(value) ?? {};
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function getDesktopSecurityProtocolVersion(
  target: Pick<ComputeTargetRecord, "capabilities">
): number | null {
  const capabilities = toJsonObject(target.capabilities);
  const value = capabilities.desktopSecurityUpgradeProtocolVersion;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function buildCapabilitiesPayload(
  payload: RegisterComputeTargetInput | UpdateComputeTargetInput,
  existingCapabilities?: unknown
): JsonObject {
  const payloadCapabilities = toJsonObject(payload.capabilities);
  const capabilities: JsonObject = {
    ...toJsonObject(existingCapabilities),
    ...payloadCapabilities,
  };

  if (
    payload.capabilities !== undefined &&
    !Object.hasOwn(payloadCapabilities, DESKTOP_API_NAMESPACE_CAPABILITY_KEY)
  ) {
    delete capabilities[DESKTOP_API_NAMESPACE_CAPABILITY_KEY];
  }

  if ("allowedDirectories" in payload && payload.allowedDirectories) {
    capabilities.allowedDirectories = payload.allowedDirectories;
  }
  if ("pluginVersion" in payload && payload.pluginVersion) {
    capabilities.pluginVersion = payload.pluginVersion;
  }
  if (payload.desktopSecurityUpgradeProtocolVersion) {
    capabilities.desktopSecurityUpgradeProtocolVersion =
      payload.desktopSecurityUpgradeProtocolVersion;
  }

  return capabilities;
}

function buildSecurity(
  target: ComputeTargetRecord,
  viewerUserId: string | undefined,
  protectedGateways: Set<string>,
  lookupFailed: boolean,
  desktopSecurityEnabled: boolean
): ComputeTargetSecurity {
  if (!desktopSecurityEnabled) {
    return {
      status: DesktopSecurityStatus.LegacyManual,
      reason: "FEATURE_DISABLED",
      upgradeSupported: false,
    };
  }

  const isOwnedByViewer = viewerUserId ? target.userId === viewerUserId : true;
  if (!isOwnedByViewer) {
    return {
      status: DesktopSecurityStatus.UpdateRequired,
      reason: "SHARED_TARGET",
      upgradeSupported: false,
    };
  }
  if (lookupFailed) {
    return {
      status: DesktopSecurityStatus.Unknown,
      reason: "LOOKUP_FAILED",
      upgradeSupported: false,
    };
  }
  if (target.gatewayId && protectedGateways.has(target.gatewayId)) {
    return {
      status: DesktopSecurityStatus.Protected,
      reason: "BOUND_DESKTOP_MANAGED_KEY",
      upgradeSupported: false,
    };
  }
  if (!target.isOnline) {
    return {
      status: DesktopSecurityStatus.LegacyManual,
      reason: "TARGET_OFFLINE",
      upgradeSupported: false,
    };
  }
  if (!target.gatewayId) {
    return {
      status: DesktopSecurityStatus.UpdateRequired,
      reason: "MISSING_GATEWAY_ID",
      upgradeSupported: false,
    };
  }
  if (
    getDesktopSecurityProtocolVersion(target) !==
    DESKTOP_SECURITY_UPGRADE_PROTOCOL_VERSION
  ) {
    return {
      status: DesktopSecurityStatus.UpdateRequired,
      reason: "UNSUPPORTED_DESKTOP_VERSION",
      upgradeSupported: false,
    };
  }
  return {
    status: DesktopSecurityStatus.UpgradeAvailable,
    reason: "NO_BOUND_MANAGED_KEY",
    upgradeSupported: true,
  };
}

async function loadProtectedGateways(
  organizationId: string,
  userId: string,
  gatewayIds: string[]
): Promise<{ protectedGateways: Set<string>; lookupFailed: boolean }> {
  if (gatewayIds.length === 0) {
    return { protectedGateways: new Set(), lookupFailed: false };
  }
  try {
    const keys = await withDb((db) =>
      db.apiKey.findMany({
        where: {
          organizationId,
          userId,
          source: ApiKeySource.DESKTOP_MANAGED,
          revokedAt: null,
          gatewayId: { in: gatewayIds },
          boundPublicKey: { not: null },
        },
        select: { gatewayId: true },
      })
    );
    return {
      protectedGateways: new Set(
        keys.flatMap((key) => (key.gatewayId ? [key.gatewayId] : []))
      ),
      lookupFailed: false,
    };
  } catch {
    return { protectedGateways: new Set(), lookupFailed: true };
  }
}

function formatOwnerName(
  user: { firstName: string | null; lastName: string | null } | null | undefined
): string {
  if (!user) {
    return "Teammate";
  }
  const parts = [user.firstName, user.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "Teammate";
}

function toComputeTarget(
  target: ComputeTargetRecord | null,
  /** When set, ownerName is populated for targets not owned by this user. */
  viewerUserId?: string,
  security?: ComputeTargetSecurity
): ComputeTarget | null {
  if (!target) {
    return null;
  }

  const isOwnedByViewer = viewerUserId ? target.userId === viewerUserId : true;

  return {
    id: target.id,
    organizationId: target.organizationId,
    userId: target.userId,
    machineName: target.machineName,
    platform: target.platform,
    gatewayId: target.gatewayId ?? undefined,
    capabilities: toJsonObject(target.capabilities),
    supportedOperations: toStringArray(target.supportedOperations),
    lastSeenAt: target.lastSeenAt,
    isOnline: target.isOnline,
    isSharedWithOrg: target.isSharedWithOrg,
    security:
      security ?? buildSecurity(target, viewerUserId, new Set(), false, false),
    ownerName: isOwnedByViewer ? undefined : formatOwnerName(target.user),
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  };
}

function toRequiredComputeTarget(target: ComputeTargetRecord): ComputeTarget {
  const mapped = toComputeTarget(target);
  if (!mapped) {
    throw new Error("Expected persisted compute target");
  }
  return mapped;
}

async function toComputeTargetList(
  targets: ComputeTargetRecord[],
  viewerUserId?: string,
  viewerClerkUserId?: string | null
): Promise<ComputeTarget[]> {
  const desktopSecurityEnabled = viewerUserId
    ? await isDesktopManagedPopEnforcementEnabled({
        userId: viewerUserId,
        clerkUserId: viewerClerkUserId,
      })
    : false;
  const viewerOwnedGateways = Array.from(
    new Set(
      targets.flatMap((target) =>
        target.userId === viewerUserId && target.gatewayId
          ? [target.gatewayId]
          : []
      )
    )
  );
  const firstViewerTarget = targets.find(
    (target) => target.userId === viewerUserId
  );
  const { protectedGateways, lookupFailed } =
    firstViewerTarget && viewerUserId && desktopSecurityEnabled
      ? await loadProtectedGateways(
          firstViewerTarget.organizationId,
          viewerUserId,
          viewerOwnedGateways
        )
      : { protectedGateways: new Set<string>(), lookupFailed: false };

  return targets.flatMap((target) => {
    const mapped = toComputeTarget(
      target,
      viewerUserId,
      buildSecurity(
        target,
        viewerUserId,
        protectedGateways,
        lookupFailed,
        desktopSecurityEnabled
      )
    );
    return mapped ? [mapped] : [];
  });
}

export const computeTargetsService = {
  async register(
    organizationId: string,
    userId: string,
    payload: RegisterComputeTargetInput
  ): Promise<DomainResult<ComputeTarget, ComputeTargetGatewayConflict>> {
    const now = new Date();
    const capabilities = buildCapabilitiesPayload(payload);

    if (payload.gatewayId) {
      const target = await withDb(async (db) => {
        const conflictingGateway = await db.computeTarget.findFirst({
          where: {
            gatewayId: payload.gatewayId,
            OR: [
              { organizationId: { not: organizationId } },
              { userId: { not: userId } },
            ],
          },
          select: { id: true },
        });
        if (conflictingGateway) {
          return computeTargetGatewayConflictResult<ComputeTargetRecord>();
        }

        const gatewayTarget = await db.computeTarget.findFirst({
          where: {
            organizationId,
            userId,
            gatewayId: payload.gatewayId,
          },
        });
        if (gatewayTarget) {
          const updated = await db.computeTarget.update({
            where: { id: gatewayTarget.id },
            data: {
              machineName: payload.machineName,
              platform: payload.platform,
              capabilities,
              supportedOperations: payload.supportedOperations,
              isOnline: true,
              lastSeenAt: now,
            },
          });
          return Result.ok<ComputeTargetRecord, ComputeTargetGatewayConflict>(
            updated
          );
        }

        const machineTarget = await db.computeTarget.findFirst({
          where: {
            organizationId,
            userId,
            machineName: payload.machineName,
          },
        });
        if (machineTarget) {
          const updated = await db.computeTarget.update({
            where: { id: machineTarget.id },
            data: {
              gatewayId: payload.gatewayId,
              platform: payload.platform,
              capabilities,
              supportedOperations: payload.supportedOperations,
              isOnline: true,
              lastSeenAt: now,
            },
          });
          return Result.ok<ComputeTargetRecord, ComputeTargetGatewayConflict>(
            updated
          );
        }

        const upserted = await db.computeTarget.upsert({
          where: {
            userId_machineName: {
              userId,
              machineName: payload.machineName,
            },
          },
          update: {
            gatewayId: payload.gatewayId,
            platform: payload.platform,
            capabilities,
            supportedOperations: payload.supportedOperations,
            isOnline: true,
            lastSeenAt: now,
          },
          create: {
            organizationId,
            userId,
            gatewayId: payload.gatewayId,
            machineName: payload.machineName,
            platform: payload.platform,
            capabilities,
            supportedOperations: payload.supportedOperations,
            isOnline: true,
            lastSeenAt: now,
          },
        });
        return Result.ok<ComputeTargetRecord, ComputeTargetGatewayConflict>(
          upserted
        );
      });

      if (isComputeTargetGatewayConflictResult(target)) {
        return target;
      }

      return Result.ok(toRequiredComputeTarget(target.value));
    }

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
          capabilities,
          supportedOperations: payload.supportedOperations,
          isOnline: true,
          lastSeenAt: now,
        },
        create: {
          organizationId,
          userId,
          machineName: payload.machineName,
          platform: payload.platform,
          capabilities,
          supportedOperations: payload.supportedOperations,
          isOnline: true,
          lastSeenAt: now,
        },
      })
    );

    return Result.ok(toRequiredComputeTarget(target));
  },

  async listByOwner(
    organizationId: string,
    userId: string,
    clerkUserId?: string | null
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

    return toComputeTargetList(targets, userId, clerkUserId);
  },

  findById(id: string): Promise<ComputeTargetRecord | null> {
    return withDb((db) =>
      db.computeTarget.findUnique({
        where: { id },
      })
    );
  },

  async findOwnedById(
    id: string,
    organizationId: string,
    userId: string,
    clerkUserId?: string | null
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

    if (!target) {
      return null;
    }
    const desktopSecurityEnabled = await isDesktopManagedPopEnforcementEnabled({
      userId,
      clerkUserId,
    });
    const { protectedGateways, lookupFailed } = desktopSecurityEnabled
      ? await loadProtectedGateways(
          organizationId,
          userId,
          target.gatewayId ? [target.gatewayId] : []
        )
      : { protectedGateways: new Set<string>(), lookupFailed: false };
    return toComputeTarget(
      target,
      userId,
      buildSecurity(
        target,
        userId,
        protectedGateways,
        lookupFailed,
        desktopSecurityEnabled
      )
    );
  },

  async updateOwned(
    id: string,
    organizationId: string,
    userId: string,
    payload: UpdateComputeTargetInput,
    clerkUserId?: string | null
  ): Promise<DomainResult<ComputeTarget | null, ComputeTargetGatewayConflict>> {
    try {
      if (payload.gatewayId) {
        const conflictingGateway = await withDb((db) =>
          db.computeTarget.findFirst({
            where: {
              gatewayId: payload.gatewayId,
              OR: [
                { organizationId: { not: organizationId } },
                { userId: { not: userId } },
                { id: { not: id } },
              ],
            },
            select: { id: true },
          })
        );
        if (conflictingGateway) {
          return computeTargetGatewayConflictResult<ComputeTarget | null>();
        }
      }

      const existing = await withDb((db) =>
        db.computeTarget.findFirst({
          where: { id, organizationId, userId },
          select: { capabilities: true },
        })
      );
      if (!existing) {
        return Result.ok(null);
      }

      const existingCapabilities = existing.capabilities;
      const updated = await withDb((db) =>
        db.computeTarget.update({
          where: { id, organizationId, userId },
          data: {
            ...(payload.machineName
              ? { machineName: payload.machineName }
              : {}),
            ...(payload.platform ? { platform: payload.platform } : {}),
            ...(payload.capabilities !== undefined ||
            payload.desktopSecurityUpgradeProtocolVersion !== undefined
              ? {
                  capabilities: buildCapabilitiesPayload(
                    payload,
                    existingCapabilities
                  ),
                }
              : {}),
            ...(payload.supportedOperations
              ? { supportedOperations: payload.supportedOperations }
              : {}),
            ...(payload.gatewayId ? { gatewayId: payload.gatewayId } : {}),
          },
        })
      );
      const desktopSecurityEnabled =
        await isDesktopManagedPopEnforcementEnabled({
          userId,
          clerkUserId,
        });
      const { protectedGateways, lookupFailed } = desktopSecurityEnabled
        ? await loadProtectedGateways(
            organizationId,
            userId,
            updated.gatewayId ? [updated.gatewayId] : []
          )
        : { protectedGateways: new Set<string>(), lookupFailed: false };
      return Result.ok(
        toComputeTarget(
          updated,
          userId,
          buildSecurity(
            updated,
            userId,
            protectedGateways,
            lookupFailed,
            desktopSecurityEnabled
          )
        )
      );
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2025") {
        return Result.ok(null);
      }
      throw error;
    }
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

  async getStatusSnapshot(
    organizationId: string
  ): Promise<Map<string, boolean>> {
    const targets = await withDb((db) =>
      db.computeTarget.findMany({
        where: { organizationId },
        select: { id: true, isOnline: true },
      })
    );
    return new Map(targets.map((t) => [t.id, t.isOnline]));
  },

  /**
   * Returns the user's own targets plus any shared targets from other org members.
   * Shared targets include the owner's name for display.
   */
  async listAvailableForOrg(
    organizationId: string,
    userId: string,
    clerkUserId?: string | null
  ): Promise<ComputeTarget[]> {
    const targets = await withDb((db) =>
      db.computeTarget.findMany({
        where: {
          organizationId,
          OR: [{ userId }, { isSharedWithOrg: true }],
        },
        include: {
          user: { select: { firstName: true, lastName: true } },
        },
        orderBy: [{ isOnline: "desc" }, { updatedAt: "desc" }],
      })
    );

    return toComputeTargetList(targets, userId, clerkUserId);
  },

  /**
   * Finds a compute target by ID within the org — either owned by the user
   * or shared with the org. Used for dispatch to shared targets.
   */
  async findAccessibleById(
    id: string,
    organizationId: string,
    userId: string
  ): Promise<ComputeTarget | null> {
    const target = await withDb((db) =>
      db.computeTarget.findFirst({
        where: {
          id,
          organizationId,
          OR: [{ userId }, { isSharedWithOrg: true }],
        },
      })
    );

    return toComputeTarget(target);
  },

  async setSharing(
    id: string,
    organizationId: string,
    userId: string,
    isSharedWithOrg: boolean
  ): Promise<{ id: string; isSharedWithOrg: boolean } | null> {
    try {
      const updated = await withDb((db) =>
        db.computeTarget.update({
          where: { id, organizationId, userId },
          data: { isSharedWithOrg },
          select: { id: true, isSharedWithOrg: true },
        })
      );
      return updated;
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2025") {
        return null;
      }
      throw error;
    }
  },
};
