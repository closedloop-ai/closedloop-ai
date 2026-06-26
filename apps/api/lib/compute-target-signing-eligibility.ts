import { ApiKeySource, withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  type ComputeTargetSigningIdentity,
  getComputeTargetSigningFeatureSupport,
} from "./command-signing-feature";

export const CommandSigningEligibilityStatus = {
  Eligible: "eligible",
  Ineligible: "ineligible",
  Unknown: "unknown",
} as const;
export type CommandSigningEligibilityStatus =
  (typeof CommandSigningEligibilityStatus)[keyof typeof CommandSigningEligibilityStatus];

export const COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_REASON =
  "command_signing_eligibility_unknown" as const;
export const COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_ERROR =
  "Command signing eligibility could not be verified for this compute target" as const;

export const CommandSigningRequirementStatus = {
  Required: "required",
  NotRequired: "not_required",
  Unknown: "unknown",
} as const;
export type CommandSigningRequirementStatus =
  (typeof CommandSigningRequirementStatus)[keyof typeof CommandSigningRequirementStatus];

export type CommandSigningRequirementResult =
  | { status: typeof CommandSigningRequirementStatus.Required }
  | { status: typeof CommandSigningRequirementStatus.NotRequired }
  | { status: typeof CommandSigningRequirementStatus.Unknown };

export type ComputeTargetSigningEligibilityResult =
  | { status: typeof CommandSigningEligibilityStatus.Eligible }
  | {
      status: typeof CommandSigningEligibilityStatus.Ineligible;
      reason:
        | "missing_gateway"
        | "feature_disabled"
        | "inactive_user"
        | "inactive_organization"
        | "owner_not_found"
        | "no_active_managed_key";
    }
  | {
      status: typeof CommandSigningEligibilityStatus.Unknown;
      reason: typeof COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_REASON;
    };

/**
 * Result for owner-level command-signing pre-checks plus the subset of supplied
 * gateway IDs that have active desktop-managed write keys. `Eligible` means the
 * owner passed feature/account checks; callers must still require
 * `gatewayIds.has(targetGatewayId)` before treating a target as signable.
 */
export type ActiveDesktopManagedGatewayIdsResult =
  | {
      status: typeof CommandSigningEligibilityStatus.Eligible;
      gatewayIds: Set<string>;
    }
  | {
      status: typeof CommandSigningEligibilityStatus.Ineligible;
      gatewayIds: Set<string>;
      reason: FeatureOwnerIneligibilityReason;
    }
  | {
      status: typeof CommandSigningEligibilityStatus.Unknown;
      gatewayIds: Set<string>;
      reason: typeof COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_REASON;
    };

type OwnerState = {
  active: boolean;
  organization: { active: boolean } | null;
} | null;

type FeatureOwnerIneligibilityReason =
  | "feature_disabled"
  | "inactive_user"
  | "inactive_organization"
  | "owner_not_found";

type FeatureOwnerIneligibilityResult = {
  status: typeof CommandSigningEligibilityStatus.Ineligible;
  reason: FeatureOwnerIneligibilityReason;
};

function unknownResult(): Extract<
  ComputeTargetSigningEligibilityResult,
  { status: typeof CommandSigningEligibilityStatus.Unknown }
> {
  return {
    status: CommandSigningEligibilityStatus.Unknown,
    reason: COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_REASON,
  };
}

function logUnknownEligibility(
  error: unknown,
  context: Record<string, string>
) {
  log.warn(COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_REASON, {
    ...context,
    error: parseError(error),
  });
}

function getOwnerState(input: {
  organizationId: string;
  userId: string;
}): Promise<OwnerState> {
  return withDb((db) =>
    db.user.findUnique({
      where: {
        id: input.userId,
        organizationId: input.organizationId,
      },
      select: {
        active: true,
        organization: { select: { active: true } },
      },
    })
  );
}

function evaluateOwnerState(
  owner: OwnerState
): FeatureOwnerIneligibilityResult | null {
  if (!owner) {
    return {
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: "owner_not_found",
    };
  }
  if (!owner.active) {
    return {
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: "inactive_user",
    };
  }
  if (owner.organization?.active !== true) {
    return {
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: "inactive_organization",
    };
  }
  return null;
}

async function loadFeatureAndOwnerEligibility(
  input: {
    organizationId: string;
    userId: string;
  } & ComputeTargetSigningIdentity
): Promise<
  | { status: typeof CommandSigningEligibilityStatus.Eligible }
  | FeatureOwnerIneligibilityResult
  | Extract<
      ComputeTargetSigningEligibilityResult,
      { status: typeof CommandSigningEligibilityStatus.Unknown }
    >
> {
  const featureSupport = await getComputeTargetSigningFeatureSupport({
    userId: input.userId,
    clerkUserId: input.clerkUserId,
  });
  if (featureSupport.status === "unknown") {
    return unknownResult();
  }
  if (featureSupport.status === "unsupported") {
    return {
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: "feature_disabled",
    };
  }

  try {
    const ownerState = await getOwnerState(input);
    const ownerIneligibility = evaluateOwnerState(ownerState);
    if (ownerIneligibility) {
      return ownerIneligibility;
    }
  } catch (error) {
    logUnknownEligibility(error, {
      organizationId: input.organizationId,
      userId: input.userId,
    });
    return unknownResult();
  }

  return { status: CommandSigningEligibilityStatus.Eligible };
}

/**
 * Loads gateway IDs that are backed by active desktop-managed write keys for
 * the target owner. `Eligible` is an owner/pre-check result and may include an
 * empty gateway set; target-level signing requires membership in `gatewayIds`.
 * This is the API-owned source of truth for the derived
 * `serverCapabilities.computeTargetSigning` projection.
 */
export async function loadActiveDesktopManagedGatewayIds(input: {
  organizationId: string;
  userId: string;
  clerkUserId?: string | null;
  gatewayIds: string[];
}): Promise<ActiveDesktopManagedGatewayIdsResult> {
  const gatewayIds = [...new Set(input.gatewayIds.filter(Boolean))];
  const emptyGatewayIds = new Set<string>();

  const ownerEligibility = await loadFeatureAndOwnerEligibility(input);
  if (ownerEligibility.status === CommandSigningEligibilityStatus.Unknown) {
    return { ...ownerEligibility, gatewayIds: emptyGatewayIds };
  }
  if (ownerEligibility.status === CommandSigningEligibilityStatus.Ineligible) {
    return { ...ownerEligibility, gatewayIds: emptyGatewayIds };
  }
  if (gatewayIds.length === 0) {
    return {
      status: CommandSigningEligibilityStatus.Eligible,
      gatewayIds: emptyGatewayIds,
    };
  }

  try {
    const keys = await withDb((db) =>
      db.apiKey.findMany({
        where: {
          organizationId: input.organizationId,
          userId: input.userId,
          source: ApiKeySource.DESKTOP_MANAGED,
          revokedAt: null,
          gatewayId: { in: gatewayIds },
          boundPublicKey: { not: null },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          scopes: { has: "write" },
        },
        select: { gatewayId: true },
      })
    );
    return {
      status: CommandSigningEligibilityStatus.Eligible,
      gatewayIds: new Set(
        keys.flatMap((key) => (key.gatewayId ? [key.gatewayId] : []))
      ),
    };
  } catch (error) {
    logUnknownEligibility(error, {
      organizationId: input.organizationId,
      userId: input.userId,
    });
    return {
      status: CommandSigningEligibilityStatus.Unknown,
      reason: COMMAND_SIGNING_ELIGIBILITY_UNKNOWN_REASON,
      gatewayIds: emptyGatewayIds,
    };
  }
}

/**
 * Returns tri-state signing eligibility for launch and generic command gates.
 * Mutation callers must fail closed on `unknown`; read projections may omit
 * `computeTargetSigning` while preserving unrelated server capabilities.
 */
export async function isComputeTargetSigningEligible(input: {
  organizationId: string;
  userId: string;
  clerkUserId?: string | null;
  gatewayId?: string | null;
}): Promise<ComputeTargetSigningEligibilityResult> {
  if (!input.gatewayId) {
    return {
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: "missing_gateway",
    };
  }
  const result = await loadActiveDesktopManagedGatewayIds({
    ...input,
    gatewayIds: [input.gatewayId],
  });
  if (result.status === CommandSigningEligibilityStatus.Unknown) {
    return unknownResult();
  }
  if (result.status === CommandSigningEligibilityStatus.Ineligible) {
    return {
      status: result.status,
      reason: result.reason,
    };
  }
  return result.gatewayIds.has(input.gatewayId)
    ? { status: CommandSigningEligibilityStatus.Eligible }
    : {
        status: CommandSigningEligibilityStatus.Ineligible,
        reason: "no_active_managed_key",
      };
}

/**
 * Direct Socket.IO auth has already proven revocation/expiry, write scope, and
 * active user through API-key verification and socket auth. This helper adds
 * feature-flag, organization-active, managed provenance, bound-key, and gateway
 * parity checks without changing the Desktop hello wire shape.
 */
export async function isDirectDesktopAuthSigningEligible(input: {
  organizationId: string;
  userId: string;
  clerkUserId?: string | null;
  apiKeySource: ApiKeySource;
  apiKeyGatewayId: string | null;
  apiKeyBoundPublicKey: string | null;
  targetGatewayId?: string | null;
}): Promise<ComputeTargetSigningEligibilityResult> {
  const ownerEligibility = await loadFeatureAndOwnerEligibility(input);
  if (ownerEligibility.status !== CommandSigningEligibilityStatus.Eligible) {
    return ownerEligibility;
  }
  if (!input.targetGatewayId) {
    return {
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: "missing_gateway",
    };
  }
  if (
    input.apiKeySource !== ApiKeySource.DESKTOP_MANAGED ||
    !input.apiKeyBoundPublicKey ||
    input.apiKeyGatewayId !== input.targetGatewayId
  ) {
    return {
      status: CommandSigningEligibilityStatus.Ineligible,
      reason: "no_active_managed_key",
    };
  }
  return { status: CommandSigningEligibilityStatus.Eligible };
}
