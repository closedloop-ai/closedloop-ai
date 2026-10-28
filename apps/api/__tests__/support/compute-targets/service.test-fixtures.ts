import type { Mock } from "vitest";
import { vi } from "vitest";
import { usableApiKeyWhere } from "@/lib/auth/usable-api-key-where";

/**
 * Fixed instant shared by the `service.branches.*.test.ts` siblings so
 * `lastSeenAt`/`createdAt`/`updatedAt` on `buildTarget()` and any
 * `usableApiKeyWhere()` expectation built alongside it describe the same
 * moment without each test file re-deriving its own clock.
 */
export const now = new Date("2026-04-28T17:00:00.000Z");

export function buildTarget(overrides: Record<string, unknown> = {}) {
  return {
    id: "target-1",
    organizationId: "org-1",
    userId: "user-1",
    machineName: "machine-1",
    platform: "darwin",
    capabilities: { desktopSecurityUpgradeProtocolVersion: 1 },
    supportedOperations: ["git_action"],
    lastSeenAt: now,
    isOnline: true,
    isSharedWithOrg: false,
    gatewayId: "gateway-1",
    createdAt: now,
    updatedAt: now,
    user: null,
    ...overrides,
  };
}

type WithDbDouble = Mock & { tx: Mock };

/**
 * Wires a fake Prisma client into a hoisted `withDb`/`withDb.tx` mock double.
 * Takes the double as a parameter (rather than closing over one) so it can be
 * shared by every `service.branches.*.test.ts` sibling, each of which must
 * declare its own `vi.hoisted`/`vi.mock` calls locally for hoisting to work.
 */
export function installDb(withDb: WithDbDouble, db: unknown) {
  const dbWithDefaults =
    typeof db === "object" && db !== null
      ? {
          computeTargetHealthCheck: { deleteMany: vi.fn() },
          ...db,
        }
      : db;
  withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
}

/**
 * The exact `apiKey.findMany` where-clause `loadProtectedGateways`
 * (`app/compute-targets/protected-gateways.ts`) issues, so a caller-side test
 * can pin the whole predicate a bound Desktop-managed key must satisfy
 * instead of `gatewayId` alone. `source` is passed in rather than imported
 * here so this builder stays a plain fixture with no dependency on a given
 * test file's `@repo/database` mock.
 */
export function protectedGatewayApiKeyWhere({
  organizationId,
  userId,
  source,
  gatewayIds,
  asOf,
}: {
  organizationId: string;
  userId: string;
  source: string;
  gatewayIds: string[];
  asOf: Date;
}) {
  return {
    organizationId,
    userId,
    source,
    gatewayId: { in: gatewayIds },
    boundPublicKey: { not: null },
    ...usableApiKeyWhere(asOf),
  };
}
