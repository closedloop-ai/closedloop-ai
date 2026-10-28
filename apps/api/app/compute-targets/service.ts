import { DESKTOP_API_NAMESPACE_CAPABILITY_KEY } from "@repo/api/src/desktop-api-namespace";
import type { JsonObject } from "@repo/api/src/types/common";
import type {
  ComputeTarget,
  ComputeTargetHealthCheckSnapshot,
  RegisterComputeTargetInput,
} from "@repo/api/src/types/compute-target";
import { COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY } from "@repo/api/src/types/compute-target";
import { RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS } from "@repo/api/src/types/relay-heartbeat";
import {
  type Result as DomainResult,
  Result,
} from "@repo/api/src/types/result";
import { type TransactionClient, withDb } from "@repo/database";
import { loadProtectedGateways } from "@/app/compute-targets/protected-gateways";
import {
  buildSecurity,
  COMPUTE_TARGET_RECORD_SELECT,
  type ComputeTargetRecord,
  toComputeTarget,
  toComputeTargetList,
  toJsonObject,
  toRequiredComputeTarget,
} from "@/app/compute-targets/service/compute-target-record";
import { deleteOwnedComputeTarget } from "@/app/compute-targets/service/delete-owned";
import {
  COMPUTE_TARGET_MATERIAL_CHANGE_SELECT,
  hasMaterialHealthCheckFieldChanged,
} from "@/app/compute-targets/service/health-check-material-change";
import { recordRelayPresence } from "@/app/compute-targets/service/relay-presence";
import { isDesktopManagedPopEnforcementEnabled } from "@/lib/auth/desktop-managed-pop";
import { getPrismaErrorCode, matchesPrismaP2002Target } from "@/lib/db-utils";
import { SOCKET_HEARTBEAT_INTERVAL_MS } from "@/lib/desktop-gateway-types";
import type { OrganizationWriteOutcome } from "@/lib/organization-write-receipt";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import {
  COMPUTE_TARGET_HEALTH_CHECK_SELECT,
  toHealthCheckSnapshot,
} from "./health-check-snapshot-record";

/**
 * Silence past which `markStaleTargetsOffline` flips a target to offline.
 *
 * Three check-ins of the SLOWEST periodic writer of `lastSeenAt`, derived rather
 * than re-declared at `90_000`, because it is a timeout on that cadence: set it
 * at or below one interval and every live target is flipped offline between its
 * own check-ins. `recordRelayPresence` enumerates the writers; the periodic ones
 * are paced by two independent knobs — the relay transport's presence heartbeat
 * and the direct Socket.IO server's per-socket timer — which hold the same value
 * today but are separately tunable, so taking the max is what keeps a retune of
 * either from silently eating the headroom.
 */
export const COMPUTE_TARGET_STALE_MS =
  3 *
  Math.max(RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS, SOCKET_HEARTBEAT_INTERVAL_MS);

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

function buildCapabilitiesPayload(
  payload: ComputeTargetRegistration | OwnedComputeTargetUpdate,
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
  if (
    payload.capabilities !== undefined &&
    !Object.hasOwn(payloadCapabilities, COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY)
  ) {
    delete capabilities[COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY];
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

/**
 * The caller's own target in the org, or null. Owner-only since ISS-12617
 * retired target sharing: the only consumer that dispatched to a teammate's
 * machine was the deleted Loop resolver (#8800).
 */
function findAccessibleTargetRecord(
  db: TransactionClient,
  id: string,
  organizationId: string,
  userId: string
): Promise<ComputeTargetRecord | null> {
  return db.computeTarget.findFirst({
    where: {
      id,
      organizationId,
      userId,
    },
    select: COMPUTE_TARGET_RECORD_SELECT,
  });
}

async function hasGatewayConflictForOwnedUpdate({
  tx,
  id,
  organizationId,
  userId,
  gatewayId,
}: {
  tx: TransactionClient;
  id: string;
  organizationId: string;
  userId: string;
  gatewayId?: string | null;
}): Promise<boolean> {
  if (!gatewayId) {
    return false;
  }
  const conflictingGateway = await tx.computeTarget.findFirst({
    where: {
      gatewayId,
      OR: [
        { organizationId: { not: organizationId } },
        { userId: { not: userId } },
        { id: { not: id } },
      ],
    },
    select: { id: true },
  });
  return Boolean(conflictingGateway);
}

function buildComputeTargetUpdateData(
  payload: OwnedComputeTargetUpdate,
  existingCapabilities: unknown
) {
  return {
    ...(payload.machineName ? { machineName: payload.machineName } : {}),
    ...(payload.platform ? { platform: payload.platform } : {}),
    ...(payload.capabilities !== undefined ||
    payload.desktopSecurityUpgradeProtocolVersion !== undefined
      ? {
          capabilities: buildCapabilitiesPayload(payload, existingCapabilities),
        }
      : {}),
    ...(payload.supportedOperations
      ? { supportedOperations: payload.supportedOperations }
      : {}),
    ...gatewayIdUpdate(payload.gatewayId),
  };
}

function buildMaterialHealthCheckUpdateFields(
  payload: OwnedComputeTargetUpdate,
  updated: ComputeTargetRecord
) {
  return {
    ...(payload.machineName ? { machineName: payload.machineName } : {}),
    ...(payload.platform ? { platform: payload.platform } : {}),
    ...gatewayIdUpdate(payload.gatewayId),
    ...(payload.supportedOperations
      ? { supportedOperations: payload.supportedOperations }
      : {}),
    ...(payload.capabilities !== undefined ||
    payload.desktopSecurityUpgradeProtocolVersion !== undefined
      ? { capabilities: updated.capabilities }
      : {}),
  };
}

async function updateOwnedComputeTargetInTransaction({
  tx,
  id,
  organizationId,
  userId,
  payload,
}: {
  tx: TransactionClient;
  id: string;
  organizationId: string;
  userId: string;
  payload: OwnedComputeTargetUpdate;
}): Promise<
  DomainResult<ComputeTargetRecord | null, ComputeTargetGatewayConflict>
> {
  if (
    await hasGatewayConflictForOwnedUpdate({
      tx,
      id,
      organizationId,
      userId,
      gatewayId: payload.gatewayId,
    })
  ) {
    return computeTargetGatewayConflictResult<ComputeTargetRecord | null>();
  }

  const existing = await tx.computeTarget.findFirst({
    where: { id, organizationId, userId },
    select: COMPUTE_TARGET_MATERIAL_CHANGE_SELECT,
  });
  if (!existing) {
    return Result.ok<ComputeTargetRecord | null, ComputeTargetGatewayConflict>(
      null
    );
  }

  const updated = await tx.computeTarget.update({
    where: { id, organizationId, userId },
    data: buildComputeTargetUpdateData(payload, existing.capabilities),
  });
  if (
    hasMaterialHealthCheckFieldChanged(
      existing,
      buildMaterialHealthCheckUpdateFields(payload, updated)
    )
  ) {
    await tx.computeTargetHealthCheck.deleteMany({
      where: { computeTargetId: id },
    });
  }
  return Result.ok<ComputeTargetRecord | null, ComputeTargetGatewayConflict>(
    updated
  );
}

export const computeTargetsService = {
  async register(
    organizationId: string,
    userId: string,
    payload: ComputeTargetRegistration,
    recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>
  ): Promise<DomainResult<ComputeTarget, ComputeTargetGatewayConflict>> {
    const now = new Date();
    const capabilities = buildCapabilitiesPayload(payload);

    const { gatewayId } = payload;
    if (gatewayId) {
      let target: DomainResult<
        ComputeTargetRecord,
        ComputeTargetGatewayConflict
      >;
      try {
        target = await withDb.tx(async (db) => {
          const registered = await registerGatewayTargetInTransaction(db, {
            organizationId,
            userId,
            payload,
            gatewayId,
            capabilities,
            now,
          });
          if (!isComputeTargetGatewayConflictResult(registered)) {
            await recordWrite?.(db, { changed: true });
          }
          return registered;
        });
      } catch (error) {
        if (isGatewayUniqueConstraintViolation(error)) {
          return computeTargetGatewayConflictResult<ComputeTarget>();
        }
        throw error;
      }

      if (isComputeTargetGatewayConflictResult(target)) {
        return target;
      }

      return Result.ok(toRequiredComputeTarget(target.value));
    }

    const target = await withDb.tx(async (db) => {
      const existing = await db.computeTarget.findUnique({
        where: {
          userId_machineName: {
            userId,
            machineName: payload.machineName,
          },
        },
        select: COMPUTE_TARGET_MATERIAL_CHANGE_SELECT,
      });
      const nextFields = {
        platform: payload.platform,
        capabilities,
        supportedOperations: payload.supportedOperations,
        ...gatewayIdUpdate(payload.gatewayId),
      };
      if (
        existing &&
        hasMaterialHealthCheckFieldChanged(existing, nextFields)
      ) {
        await db.computeTargetHealthCheck.deleteMany({
          where: { computeTargetId: existing.id },
        });
      }

      const upserted = await db.computeTarget.upsert({
        where: {
          userId_machineName: {
            userId,
            machineName: payload.machineName,
          },
        },
        update: {
          ...nextFields,
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
      });
      await recordWrite?.(db, { changed: true });
      return upserted;
    });

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
          // FEA-2923: exclude the synthetic per-org "cloud" sentinel target
          // (owns backfilled cloud-authored agent_components; not a real device).
          isCloudSentinel: false,
        },
        orderBy: [{ isOnline: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
        select: COMPUTE_TARGET_RECORD_SELECT,
      })
    );

    return toComputeTargetList(targets, userId, clerkUserId);
  },

  findById(id: string): Promise<ComputeTargetRecord | null> {
    return withDb((db) =>
      db.computeTarget.findUnique({
        where: { id },
        include: {
          user: {
            select: { clerkId: true, firstName: true, lastName: true },
          },
        },
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
        select: COMPUTE_TARGET_RECORD_SELECT,
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
    payload: OwnedComputeTargetUpdate,
    clerkUserId?: string | null
  ): Promise<DomainResult<ComputeTarget | null, ComputeTargetGatewayConflict>> {
    try {
      const updateResult: DomainResult<
        ComputeTargetRecord | null,
        ComputeTargetGatewayConflict
      > = await withDb.tx((tx) =>
        updateOwnedComputeTargetInTransaction({
          tx,
          id,
          organizationId,
          userId,
          payload,
        })
      );

      if (isComputeTargetGatewayConflictResult(updateResult)) {
        return updateResult;
      }
      if (!updateResult.value) {
        return Result.ok(null);
      }

      const updated = updateResult.value;
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
      if (isGatewayUniqueConstraintViolation(error)) {
        return computeTargetGatewayConflictResult<ComputeTarget | null>();
      }
      throw error;
    }
  },

  // The FK/lock-ordered teardown lives in `service/delete-owned.ts` — see there
  // for why each delete is where it is.
  deleteOwned(
    id: string,
    organizationId: string,
    userId: string,
    recordWrite?: RecordWriteInTransaction<OrganizationWriteOutcome>
  ): Promise<boolean> {
    return deleteOwnedComputeTarget(id, organizationId, userId, recordWrite);
  },
  // ISS-8897: the relay-presence clock lives in `service/relay-presence.ts` —
  // see there for why it is a separate writer and not a flag on `heartbeat`.
  recordRelayPresence(
    id: string,
    organizationId: string,
    userId: string
  ): Promise<boolean> {
    return recordRelayPresence(id, organizationId, userId);
  },
  /**
   * Any desktop-originated check-in, on any transport.
   *
   * NOT a presence clock (ISS-8897): two callers reach this — the direct
   * Socket.IO server's 30s timer and its `desktop.presence` event — and neither
   * drives the presence-triggered command drain. A reader that needs "is the relay presence
   * trigger covering this target" wants `presenceAt`, not `lastSeenAt`.
   */
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
        where: {
          organizationId,
          userId,
          // FEA-2923: exclude the synthetic per-org "cloud" sentinel target so
          // a "has a real device?" gate is not satisfied by the sentinel that
          // owns cloud-authored agent components. Matches the exclusion in
          // listByOwner / listAvailableForOrg / the compliance denominator.
          isCloudSentinel: false,
        },
        select: { id: true },
      })
    );
    return Boolean(target);
  },

  /**
   * PRD-536 §5: org-wide "has any real desktop compute target ever registered?"
   * signal for the Sessions onboarding empty state. Unlike `listAvailableForOrg`
   * (which filters to the viewer's own targets), this counts every
   * target in the org so a teammate's desktop still counts as
   * "connected" — the Sessions list is an org-wide view, so its
   * onboarding-vs-filters decision must be org-wide too. Excludes the synthetic
   * cloud sentinel to match the "real device?" semantics of `hasAnyForOwner`.
   */
  async hasAnyForOrg(organizationId: string): Promise<boolean> {
    const target = await withDb((db) =>
      db.computeTarget.findFirst({
        where: {
          organizationId,
          isCloudSentinel: false,
        },
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
   * Returns the user's own targets in the org. Owner-only since ISS-12617
   * retired target sharing.
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
          // FEA-2923: exclude the synthetic per-org "cloud" sentinel target so
          // it never appears as a selectable dispatch target.
          isCloudSentinel: false,
          userId,
        },
        include: {
          user: { select: { clerkId: true, firstName: true, lastName: true } },
        },
        orderBy: [{ isOnline: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
      })
    );

    return toComputeTargetList(targets, userId, clerkUserId);
  },

  /**
   * Finds a compute target by ID within the org that the user owns. Unlike
   * {@link findOwnedById} it skips the command-signing eligibility lookup.
   */
  async findAccessibleById(
    id: string,
    organizationId: string,
    userId: string
  ): Promise<ComputeTarget | null> {
    const target = await withDb((db) =>
      findAccessibleTargetRecord(db, id, organizationId, userId)
    );

    return toComputeTarget(target);
  },

  async getLatestHealthCheckForTarget(
    organizationId: string,
    userId: string,
    targetId: string
  ): Promise<ComputeTargetHealthCheckSnapshot | null> {
    const snapshot = await withDb(async (db) => {
      const target = await findAccessibleTargetRecord(
        db,
        targetId,
        organizationId,
        userId
      );
      if (!target) {
        return null;
      }

      return db.computeTargetHealthCheck.findUnique({
        where: { computeTargetId: targetId },
        select: COMPUTE_TARGET_HEALTH_CHECK_SELECT,
      });
    });

    return toHealthCheckSnapshot(snapshot);
  },
};

const COMPUTE_TARGET_GATEWAY_ID_UNIQUE_INDEX =
  "compute_targets_gateway_id_unique_idx";
const COMPUTE_TARGET_GATEWAY_ID_UNIQUE_TARGETS = new Set([
  COMPUTE_TARGET_GATEWAY_ID_UNIQUE_INDEX,
  "gatewayId",
  "gateway_id",
]);

function isGatewayUniqueConstraintViolation(error: unknown): boolean {
  return matchesPrismaP2002Target(error, isGatewayUniqueConstraintTarget);
}

function isGatewayUniqueConstraintTarget(target: unknown): boolean {
  if (typeof target === "string") {
    return COMPUTE_TARGET_GATEWAY_ID_UNIQUE_TARGETS.has(target);
  }
  if (Array.isArray(target)) {
    return target.some(isGatewayUniqueConstraintTarget);
  }
  return false;
}

/**
 * ISS-12032: `gatewayId: null` is a hello that declared no gateway, and clears
 * the stored one so a Desktop that never upgrades is not left addressed by a
 * stale id; an omitted gatewayId leaves the column alone. The hello handlers
 * are the only callers.
 */
type OwnedComputeTargetUpdate = Partial<
  Pick<
    RegisterComputeTargetInput,
    | "machineName"
    | "platform"
    | "capabilities"
    | "supportedOperations"
    | "desktopSecurityUpgradeProtocolVersion"
  >
> & {
  gatewayId?: string | null;
};

type ComputeTargetRegistration = Omit<
  RegisterComputeTargetInput,
  "gatewayId"
> & {
  gatewayId?: string | null;
};

function gatewayIdUpdate(gatewayId: string | null | undefined): {
  gatewayId?: string | null;
} {
  if (gatewayId === null) {
    return { gatewayId: null };
  }
  return gatewayId ? { gatewayId } : {};
}

/**
 * Register or refresh the caller's target for a Desktop gateway identity:
 * refuse a gateway bound to another owner, else update the target already
 * holding the gateway or machine name, else upsert by machine name.
 */
async function registerGatewayTargetInTransaction(
  db: TransactionClient,
  {
    organizationId,
    userId,
    payload,
    gatewayId,
    capabilities,
    now,
  }: {
    organizationId: string;
    userId: string;
    payload: ComputeTargetRegistration;
    gatewayId: string;
    capabilities: ReturnType<typeof buildCapabilitiesPayload>;
    now: Date;
  }
): Promise<DomainResult<ComputeTargetRecord, ComputeTargetGatewayConflict>> {
  const conflictingGateway = await db.computeTarget.findFirst({
    where: {
      gatewayId,
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
      gatewayId,
    },
    select: COMPUTE_TARGET_MATERIAL_CHANGE_SELECT,
  });
  if (gatewayTarget) {
    const nextFields = {
      machineName: payload.machineName,
      platform: payload.platform,
      capabilities,
      supportedOperations: payload.supportedOperations,
    };
    const shouldInvalidateHealthCheck = hasMaterialHealthCheckFieldChanged(
      gatewayTarget,
      nextFields
    );
    const updated = await db.computeTarget.update({
      where: { id: gatewayTarget.id },
      data: {
        ...nextFields,
        isOnline: true,
        lastSeenAt: now,
      },
    });
    if (shouldInvalidateHealthCheck) {
      await db.computeTargetHealthCheck.deleteMany({
        where: { computeTargetId: gatewayTarget.id },
      });
    }
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
    select: COMPUTE_TARGET_MATERIAL_CHANGE_SELECT,
  });
  if (machineTarget) {
    const nextFields = {
      gatewayId,
      platform: payload.platform,
      capabilities,
      supportedOperations: payload.supportedOperations,
    };
    const shouldInvalidateHealthCheck = hasMaterialHealthCheckFieldChanged(
      machineTarget,
      nextFields
    );
    const updated = await db.computeTarget.update({
      where: { id: machineTarget.id },
      data: {
        ...nextFields,
        isOnline: true,
        lastSeenAt: now,
      },
    });
    if (shouldInvalidateHealthCheck) {
      await db.computeTargetHealthCheck.deleteMany({
        where: { computeTargetId: machineTarget.id },
      });
    }
    return Result.ok<ComputeTargetRecord, ComputeTargetGatewayConflict>(
      updated
    );
  }

  await db.computeTargetHealthCheck.deleteMany({
    where: {
      computeTarget: {
        userId,
        machineName: payload.machineName,
      },
    },
  });
  const upserted = await db.computeTarget.upsert({
    where: {
      userId_machineName: {
        userId,
        machineName: payload.machineName,
      },
    },
    update: {
      gatewayId,
      platform: payload.platform,
      capabilities,
      supportedOperations: payload.supportedOperations,
      isOnline: true,
      lastSeenAt: now,
    },
    create: {
      organizationId,
      userId,
      gatewayId,
      machineName: payload.machineName,
      platform: payload.platform,
      capabilities,
      supportedOperations: payload.supportedOperations,
      isOnline: true,
      lastSeenAt: now,
    },
  });
  return Result.ok<ComputeTargetRecord, ComputeTargetGatewayConflict>(upserted);
}
