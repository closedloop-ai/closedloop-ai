import { DESKTOP_API_NAMESPACE_CAPABILITY_KEY } from "@repo/api/src/desktop-api-namespace";
import { ArtifactType } from "@repo/api/src/types/artifact";
import type { JsonObject } from "@repo/api/src/types/common";
import type {
  ComputeTarget,
  ComputeTargetHealthCheckSnapshot,
  ComputeTargetSecurity,
  ComputeTargetServerCapabilities,
  HealthCheckResponse,
  RegisterComputeTargetInput,
  UpdateComputeTargetInput,
  UpsertComputeTargetHealthCheckSnapshotInput,
} from "@repo/api/src/types/compute-target";
import {
  COMMAND_SIGNING_REQUIRED_CAPABILITY_KEY,
  DesktopSecurityStatus,
  deriveAvailableHarnesses,
  HarnessType,
} from "@repo/api/src/types/compute-target";
import {
  type Result as DomainResult,
  Result,
} from "@repo/api/src/types/result";
import {
  ApiKeySource,
  type Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";
import { isAgentSessionSyncSupportedForUser } from "@/lib/agent-session-sync-feature";
import { isDesktopManagedPopEnforcementEnabled } from "@/lib/auth/desktop-managed-pop";
import {
  CommandSigningEligibilityStatus,
  loadActiveDesktopManagedGatewayIds,
} from "@/lib/compute-target-signing-eligibility";
import { getPrismaErrorCode, getPrismaP2002Target } from "@/lib/db-utils";
import { parseJsonObject } from "@/lib/json-schema";
import { purgeTranscriptObjectsBestEffort } from "@/lib/transcript-object-purge";

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
  selectedHarness?: string | null;
  createdAt: Date;
  updatedAt: Date;
  user?: {
    clerkId: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null;
};

type ComputeTargetHealthCheckRecord = {
  id: string;
  organizationId: string;
  computeTargetId: string;
  checkedAt: Date;
  expectedMcpUrl: string | null;
  latestVersion: string | null;
  pluginAutoUpdateEnabled: boolean;
  result: unknown;
  allRequiredPassed: boolean;
  requiredFailureIds: unknown;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
};

const VALID_HARNESS_VALUES = new Set<string>(Object.values(HarnessType));

export function parseSelectedHarness(
  value: string | null | undefined
): HarnessType {
  return value != null && VALID_HARNESS_VALUES.has(value)
    ? (value as HarnessType)
    : HarnessType.Claude;
}

function toJsonObject(value: unknown): JsonObject {
  return parseJsonObject(value) ?? {};
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function toHealthCheckSnapshot(
  record: ComputeTargetHealthCheckRecord | null
): ComputeTargetHealthCheckSnapshot | null {
  if (!record) {
    return null;
  }
  return {
    id: record.id,
    organizationId: record.organizationId,
    computeTargetId: record.computeTargetId,
    checkedAt: record.checkedAt,
    expectedMcpUrl: record.expectedMcpUrl,
    latestVersion: record.latestVersion,
    pluginAutoUpdateEnabled: record.pluginAutoUpdateEnabled ?? false,
    result: record.result as HealthCheckResponse,
    allRequiredPassed: record.allRequiredPassed,
    requiredFailureIds: toStringArray(record.requiredFailureIds),
    schemaVersion: record.schemaVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function getRequiredFailureIds(result: HealthCheckResponse): string[] {
  return result.checks
    .filter((check) => check.required && !check.passed)
    .map((check) => check.id)
    .sort();
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForStableJson(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => {
          if (left < right) {
            return -1;
          }
          if (left > right) {
            return 1;
          }
          return 0;
        })
        .map(([key, entry]) => [key, normalizeForStableJson(entry)])
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

function hasMaterialHealthCheckFieldChanged(
  existing: Pick<
    ComputeTargetRecord,
    | "machineName"
    | "platform"
    | "gatewayId"
    | "capabilities"
    | "supportedOperations"
  >,
  next: Partial<
    Pick<
      ComputeTargetRecord,
      | "machineName"
      | "platform"
      | "gatewayId"
      | "capabilities"
      | "supportedOperations"
    >
  >
): boolean {
  if (
    next.machineName !== undefined &&
    next.machineName !== existing.machineName
  ) {
    return true;
  }
  if (next.platform !== undefined && next.platform !== existing.platform) {
    return true;
  }
  if (next.gatewayId !== undefined && next.gatewayId !== existing.gatewayId) {
    return true;
  }
  if (
    next.capabilities !== undefined &&
    stableJson(next.capabilities) !== stableJson(existing.capabilities)
  ) {
    return true;
  }
  if (
    next.supportedOperations !== undefined &&
    stableJson(next.supportedOperations) !==
      stableJson(existing.supportedOperations)
  ) {
    return true;
  }
  return false;
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
  security?: ComputeTargetSecurity,
  serverCapabilities?: ComputeTargetServerCapabilities
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
    serverCapabilities,
    security:
      security ?? buildSecurity(target, viewerUserId, new Set(), false, false),
    ownerName: isOwnedByViewer ? undefined : formatOwnerName(target.user),
    selectedHarness: parseSelectedHarness(target.selectedHarness),
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
  const ownerCapabilityEntries = await Promise.all(
    Array.from(new Set(targets.map((target) => target.userId))).map(
      async (ownerUserId) => {
        const ownerTargets = targets.filter(
          (target) => target.userId === ownerUserId
        );
        const ownerTarget = ownerTargets[0];
        const ownerClerkUserId =
          ownerUserId === viewerUserId
            ? viewerClerkUserId
            : ownerTarget?.user?.clerkId;
        const ownerGatewayIds = ownerTargets.flatMap((target) =>
          target.gatewayId ? [target.gatewayId] : []
        );
        const [signingGatewayResult, agentSessionSync] = await Promise.all([
          ownerTarget
            ? loadActiveDesktopManagedGatewayIds({
                organizationId: ownerTarget.organizationId,
                userId: ownerUserId,
                clerkUserId: ownerClerkUserId,
                gatewayIds: ownerGatewayIds,
              })
            : Promise.resolve({
                status: CommandSigningEligibilityStatus.Ineligible,
                gatewayIds: new Set<string>(),
                reason: "owner_not_found" as const,
              }),
          isAgentSessionSyncSupportedForUser({
            userId: ownerUserId,
            clerkUserId: ownerClerkUserId,
          }),
        ]);
        return [
          ownerUserId,
          { signingGatewayResult, agentSessionSync },
        ] as const;
      }
    )
  );
  const serverCapabilitiesByOwner = new Map(ownerCapabilityEntries);

  return targets.flatMap((target) => {
    const ownerCapabilities = serverCapabilitiesByOwner.get(target.userId);
    const computeTargetSigning =
      ownerCapabilities?.signingGatewayResult.status ===
        CommandSigningEligibilityStatus.Eligible &&
      target.gatewayId !== null &&
      target.gatewayId !== undefined &&
      ownerCapabilities.signingGatewayResult.gatewayIds.has(target.gatewayId);
    const serverCapabilities =
      ownerCapabilities &&
      (computeTargetSigning || ownerCapabilities.agentSessionSync)
        ? {
            ...(computeTargetSigning ? { computeTargetSigning: true } : {}),
            ...(ownerCapabilities.agentSessionSync
              ? { agentSessionSync: true }
              : {}),
          }
        : undefined;
    const mapped = toComputeTarget(
      target,
      viewerUserId,
      buildSecurity(
        target,
        viewerUserId,
        protectedGateways,
        lookupFailed,
        desktopSecurityEnabled
      ),
      serverCapabilities
    );
    return mapped ? [mapped] : [];
  });
}

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
      OR: [{ userId }, { isSharedWithOrg: true }],
    },
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
  gatewayId?: string;
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
  payload: UpdateComputeTargetInput,
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
    ...(payload.gatewayId ? { gatewayId: payload.gatewayId } : {}),
    ...(payload.selectedHarness
      ? { selectedHarness: payload.selectedHarness }
      : {}),
  };
}

function buildMaterialHealthCheckUpdateFields(
  payload: UpdateComputeTargetInput,
  updated: ComputeTargetRecord
) {
  return {
    ...(payload.machineName ? { machineName: payload.machineName } : {}),
    ...(payload.platform ? { platform: payload.platform } : {}),
    ...(payload.gatewayId ? { gatewayId: payload.gatewayId } : {}),
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
  payload: UpdateComputeTargetInput;
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
    payload: RegisterComputeTargetInput
  ): Promise<DomainResult<ComputeTarget, ComputeTargetGatewayConflict>> {
    const now = new Date();
    const capabilities = buildCapabilitiesPayload(payload);

    if (payload.gatewayId) {
      let target: DomainResult<
        ComputeTargetRecord,
        ComputeTargetGatewayConflict
      >;
      try {
        target = await withDb.tx(async (db) => {
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
            const nextFields = {
              machineName: payload.machineName,
              platform: payload.platform,
              capabilities,
              supportedOperations: payload.supportedOperations,
            };
            const shouldInvalidateHealthCheck =
              hasMaterialHealthCheckFieldChanged(gatewayTarget, nextFields);
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
          });
          if (machineTarget) {
            const nextFields = {
              gatewayId: payload.gatewayId,
              platform: payload.platform,
              capabilities,
              supportedOperations: payload.supportedOperations,
            };
            const shouldInvalidateHealthCheck =
              hasMaterialHealthCheckFieldChanged(machineTarget, nextFields);
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
      });
      const nextFields = {
        platform: payload.platform,
        capabilities,
        supportedOperations: payload.supportedOperations,
      };
      if (
        existing &&
        hasMaterialHealthCheckFieldChanged(existing, nextFields)
      ) {
        await db.computeTargetHealthCheck.deleteMany({
          where: { computeTargetId: existing.id },
        });
      }

      return db.computeTarget.upsert({
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
      });
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
        orderBy: [{ isOnline: "desc" }, { updatedAt: "desc" }],
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

  async deleteOwned(
    id: string,
    organizationId: string,
    userId: string
  ): Promise<boolean> {
    const outcome = await withDb.tx(async (tx) => {
      const target = await tx.computeTarget.findFirst({
        where: { id, organizationId, userId },
        select: { id: true },
      });
      if (!target) {
        return { deleted: false, transcriptKeys: [] as string[] };
      }
      // SESSION artifacts reference the compute target with onDelete: Restrict
      // (FEA-1699), so the parent artifacts must be removed first — that cascades
      // to session_detail and its event/token-usage children. Deleting the
      // artifacts here also removes the user-facing session records, which is the
      // intended behavior when a compute target is deleted.
      await tx.artifact.deleteMany({
        where: {
          organizationId,
          type: ArtifactType.Session,
          session: { is: { computeTargetId: id } },
        },
      });
      // Collect the transcript objects' storage keys before dropping the rows
      // that carry them: the raw JSONL bytes live in the transcripts bucket,
      // separate from the row metadata, so once these rows are gone there is no
      // DB record of which objects to purge. The best-effort purge runs after
      // the transaction commits (below) so an S3 failure can never roll back or
      // corrupt the FK-ordering delete.
      const transcripts = await tx.sessionTranscript.findMany({
        where: { computeTargetId: id },
        select: { objectStorageKey: true },
      });
      // session_transcript rows reference the compute target with
      // onDelete: Restrict, so they must be removed explicitly before the
      // target row. Deleting the SESSION artifacts above only NULLs their
      // sessionDetailId (that FK is SetNull) — the transcript rows survive
      // with the RESTRICT link intact, which would otherwise make the final
      // computeTarget delete throw a P2003 and leave the target undeletable.
      await tx.sessionTranscript.deleteMany({
        where: { computeTargetId: id },
      });
      // deleteMany keeps deletion idempotent under concurrency: a parallel
      // delete that wins the race yields count 0 here (-> 404) instead of the
      // P2025 a singular delete would throw.
      const deleted = await tx.computeTarget.deleteMany({ where: { id } });
      return {
        deleted: deleted.count > 0,
        transcriptKeys: transcripts
          .map((t) => t.objectStorageKey)
          .filter((key): key is string => key.length > 0),
      };
    });

    // Purge the transcript objects only after the row delete has committed, so
    // the RESTRICT-FK ordering fix (the reason this method deletes transcripts
    // before the target) is never rolled back by a storage failure. Best-effort:
    // an S3 error is logged with the orphaned keys for follow-up cleanup rather
    // than turned into a delete failure — the target is already gone. The shared
    // helper defers the `@repo/aws` import (which begins with `import
    // "server-only"`) so this module — statically imported by the desktop
    // gateway socket server and loaded under tsx by `server:import-smoke` — keeps
    // the S3 dependency off its eager load graph.
    if (outcome.deleted) {
      await purgeTranscriptObjectsBestEffort(
        outcome.transcriptKeys,
        "[compute-targets] failed to purge transcript objects after target delete",
        { computeTargetId: id, organizationId }
      );
    } else if (outcome.transcriptKeys.length > 0) {
      // Transcript rows were deleted (e.g. in a concurrent race that already
      // removed the compute-target row) but the target row itself was already
      // gone when deleteMany ran, so deleted=false. The transcript S3 objects
      // were NOT purged — log them so orphaned objects are observable.
      log.warn(
        "[compute-targets] transcript rows deleted but compute target row was already gone; S3 objects may be orphaned",
        {
          computeTargetId: id,
          organizationId,
          objectStorageKeys: outcome.transcriptKeys,
        }
      );
    }

    return outcome.deleted;
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
          // FEA-2923: exclude the synthetic per-org "cloud" sentinel target so
          // it never appears as a selectable dispatch target.
          isCloudSentinel: false,
          OR: [{ userId }, { isSharedWithOrg: true }],
        },
        include: {
          user: { select: { clerkId: true, firstName: true, lastName: true } },
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
      });
    });

    return toHealthCheckSnapshot(snapshot);
  },

  async upsertHealthCheckSnapshot(
    organizationId: string,
    userId: string,
    targetId: string,
    payload: UpsertComputeTargetHealthCheckSnapshotInput
  ): Promise<ComputeTargetHealthCheckSnapshot | null> {
    const requiredFailureIds = getRequiredFailureIds(payload.result);
    const allRequiredPassed = requiredFailureIds.length === 0;
    const checkedAt = new Date();
    const availableHarnesses = deriveAvailableHarnesses(payload.result);
    const snapshot = await withDb.tx(async (tx) => {
      const target = await findAccessibleTargetRecord(
        tx,
        targetId,
        organizationId,
        userId
      );
      if (!target) {
        return null;
      }
      const pluginAutoUpdateEnabled =
        (payload.pluginAutoUpdateEnabled ?? false) && target.userId === userId;
      const selectedHarness = parseSelectedHarness(target.selectedHarness);

      if (
        target.userId === userId &&
        availableHarnesses.length > 0 &&
        !availableHarnesses.includes(selectedHarness)
      ) {
        const nextHarness = availableHarnesses.includes(HarnessType.Claude)
          ? HarnessType.Claude
          : availableHarnesses[0];
        await tx.computeTarget.update({
          where: { id: targetId },
          data: { selectedHarness: nextHarness },
        });
      }

      // payload.result is already shape-validated by healthCheckSnapshotValidator
      // (no top-level passthrough), so the casts below only bridge the Zod-typed
      // value into Prisma's JSON column type — they don't widen an unvalidated shape.
      return tx.computeTargetHealthCheck.upsert({
        where: { computeTargetId: targetId },
        create: {
          organizationId,
          computeTargetId: targetId,
          checkedAt,
          expectedMcpUrl: payload.expectedMcpUrl ?? null,
          latestVersion: payload.latestVersion ?? null,
          pluginAutoUpdateEnabled,
          result: payload.result as unknown as Prisma.InputJsonValue,
          allRequiredPassed,
          requiredFailureIds:
            requiredFailureIds as unknown as Prisma.InputJsonValue,
        },
        update: {
          organizationId,
          checkedAt,
          expectedMcpUrl: payload.expectedMcpUrl ?? null,
          latestVersion: payload.latestVersion ?? null,
          pluginAutoUpdateEnabled,
          result: payload.result as unknown as Prisma.InputJsonValue,
          allRequiredPassed,
          requiredFailureIds:
            requiredFailureIds as unknown as Prisma.InputJsonValue,
          schemaVersion: 1,
        },
      });
    });

    return toHealthCheckSnapshot(snapshot);
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

const COMPUTE_TARGET_GATEWAY_ID_UNIQUE_INDEX =
  "compute_targets_gateway_id_unique_idx";
const COMPUTE_TARGET_GATEWAY_ID_UNIQUE_TARGETS = new Set([
  COMPUTE_TARGET_GATEWAY_ID_UNIQUE_INDEX,
  "gatewayId",
  "gateway_id",
]);

function isGatewayUniqueConstraintViolation(error: unknown): boolean {
  const target = getPrismaP2002Target(error);
  return isGatewayUniqueConstraintTarget(target);
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
