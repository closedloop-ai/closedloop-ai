import type { JsonObject } from "@repo/api/src/types/common";
import type {
  ComputeTarget,
  ComputeTargetSecurity,
  ComputeTargetServerCapabilities,
} from "@repo/api/src/types/compute-target";
import {
  DesktopSecurityStatus,
  parseSelectedHarness,
} from "@repo/api/src/types/compute-target";
import { isDesktopManagedPopEnforcementEnabled } from "@/lib/auth/desktop-managed-pop";
import {
  CommandSigningEligibilityStatus,
  loadActiveDesktopManagedGatewayIds,
} from "@/lib/compute-target-signing-eligibility";
import { mapWithDbConcurrency } from "@/lib/db-fanout";
import { parseJsonObject } from "@/lib/json-schema";
import { formatUserFullName } from "@/lib/user-display-name";
import { toStringArray } from "../health-check-snapshot-record";
import { loadProtectedGateways } from "../protected-gateways";

/**
 * The stored compute-target row, the `select` that reads it, and the mapping
 * between that row and the `ComputeTarget` the API returns.
 *
 * Split out of `service.ts` (ISS-9189) into the resource's internals directory
 * (`apps/api/AGENTS.md` -> Service Conventions), mirroring
 * `health-check-snapshot-record.ts`: that module owns the health-check row and
 * its mapper, this one owns the compute-target row and its mappers, and
 * `service.ts` is left holding transactions and service methods. The narrowing
 * selects live here because they are only correct relative to the record type
 * they project onto, so the `satisfies` that binds them cannot drift apart from
 * the fields the mappers read.
 */

/** Protocol version a desktop must advertise to be offered the managed upgrade. */
export const DESKTOP_SECURITY_UPGRADE_PROTOCOL_VERSION = 1;

export type ComputeTargetRecord = {
  id: string;
  organizationId: string;
  userId: string;
  machineName: string;
  platform: string;
  capabilities: unknown;
  supportedOperations: unknown;
  lastSeenAt: Date;
  isOnline: boolean;
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

export function toJsonObject(value: unknown): JsonObject {
  return parseJsonObject(value) ?? {};
}

function getDesktopSecurityProtocolVersion(
  target: Pick<ComputeTargetRecord, "capabilities">
): number | null {
  const capabilities = toJsonObject(target.capabilities);
  const value = capabilities.desktopSecurityUpgradeProtocolVersion;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function buildSecurity(
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

function formatOwnerName(
  user: { firstName: string | null; lastName: string | null } | null | undefined
): string {
  // Divergent fallback ("Teammate") kept at the call site per FEA-3506; the
  // name derivation itself routes through the shared SSOT.
  return (user && formatUserFullName(user)) || "Teammate";
}

export function toComputeTarget(
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
    // ISS-12617 retired sharing; the field stays in the wire shape, always
    // false, until ISS-12450 removes it after no older web bundle can read it.
    isSharedWithOrg: false,
    serverCapabilities,
    security:
      security ?? buildSecurity(target, viewerUserId, new Set(), false, false),
    ownerName: isOwnedByViewer ? undefined : formatOwnerName(target.user),
    selectedHarness: parseSelectedHarness(target.selectedHarness),
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  };
}

export function toRequiredComputeTarget(
  target: ComputeTargetRecord
): ComputeTarget {
  const mapped = toComputeTarget(target);
  if (!mapped) {
    throw new Error("Expected persisted compute target");
  }
  return mapped;
}

export async function toComputeTargetList(
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
  // Bounded: one task per distinct compute-target owner. Each task takes pooled
  // connections and holds one across a co-scheduled PostHog call (FEA-3299 /
  // PRD-528). Both list callers are owner-only since ISS-12617, so today that
  // is one task; the bound stays so a multi-owner input cannot drain the pool.
  const ownerCapabilityEntries = await mapWithDbConcurrency(
    Array.from(new Set(targets.map((target) => target.userId))),
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
      const signingGatewayResult = ownerTarget
        ? await loadActiveDesktopManagedGatewayIds({
            organizationId: ownerTarget.organizationId,
            userId: ownerUserId,
            clerkUserId: ownerClerkUserId,
            gatewayIds: ownerGatewayIds,
          })
        : {
            status: CommandSigningEligibilityStatus.Ineligible,
            gatewayIds: new Set<string>(),
            reason: "owner_not_found" as const,
          };
      return [ownerUserId, { signingGatewayResult }] as const;
    }
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
    // ISS-8022: `agentSessionSync` is a server-version capability, advertised
    // unconditionally now that the fail-closed PostHog flag behind it is retired.
    const serverCapabilities = ownerCapabilities
      ? {
          ...(computeTargetSigning ? { computeTargetSigning: true } : {}),
          agentSessionSync: true,
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

/**
 * Every scalar column {@link toComputeTarget} and {@link buildSecurity} read —
 * and no other. `satisfies` is the backstop the reads themselves cannot be:
 * `ComputeTargetRecord.gatewayId` and `selectedHarness` are OPTIONAL, so
 * dropping either key would still assign cleanly and only surface as a runtime
 * `undefined` in the response.
 */
export const COMPUTE_TARGET_RECORD_SELECT = {
  id: true,
  organizationId: true,
  userId: true,
  machineName: true,
  platform: true,
  capabilities: true,
  supportedOperations: true,
  lastSeenAt: true,
  isOnline: true,
  gatewayId: true,
  selectedHarness: true,
  createdAt: true,
  updatedAt: true,
} satisfies Record<keyof Omit<ComputeTargetRecord, "user">, true>;
