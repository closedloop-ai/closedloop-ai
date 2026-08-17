import { ApiKeySource, withDb } from "@repo/database";
import { usableApiKeyWhere } from "@/lib/auth/usable-api-key-where";

export type ProtectedGatewayLookup = {
  protectedGateways: Set<string>;
  /** True when the lookup itself failed, so "unprotected" is not a fact. */
  lookupFailed: boolean;
};

/**
 * Which of the given gateways are protected by a Desktop-managed PoP key that
 * could actually authenticate today.
 *
 * ISS-4905: the scope/expiry half of that predicate is shared with the verifier
 * through `usableApiKeyWhere`. Without it this reported "Protected" for a key
 * `verifyKeyWithMetadata` now refuses, which suppressed the upgrade prompt that
 * would have fixed it.
 *
 * Extracted from `service.ts` so the security projection is readable on its own
 * and the composition root stops growing (AGENTS.md → File Size and
 * Organization).
 */
export async function loadProtectedGateways(
  organizationId: string,
  userId: string,
  gatewayIds: string[]
): Promise<ProtectedGatewayLookup> {
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
          gatewayId: { in: gatewayIds },
          boundPublicKey: { not: null },
          ...usableApiKeyWhere(),
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
