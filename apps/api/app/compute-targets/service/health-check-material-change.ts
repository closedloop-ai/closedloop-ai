/**
 * Whether an incoming health-check payload changes anything MATERIAL about a
 * compute target — the identity/capability columns, as opposed to the liveness
 * columns (`lastSeenAt`, `isOnline`) every heartbeat touches by definition.
 *
 * Split out of `service.ts` (ISS-6322) as its own responsibility: this is a pure
 * comparison with no database, no transaction, and no Prisma types, and it is
 * the only reason `service.ts` carried a stable-JSON serializer.
 *
 * `capabilities` and `supportedOperations` are JSON columns, so they are
 * compared through a key-sorted serialization rather than by reference or by
 * raw `JSON.stringify`: two payloads carrying identical data in a different key
 * order must NOT read as a change, or every heartbeat would look material.
 */

/** The compute-target columns a health check can materially change. */
export type MaterialHealthCheckFields = {
  machineName: string;
  platform: string;
  capabilities: unknown;
  supportedOperations: unknown;
  gatewayId?: string | null;
};

export function hasMaterialHealthCheckFieldChanged(
  existing: MaterialHealthCheckFields,
  next: Partial<MaterialHealthCheckFields>
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

/**
 * The `select` for a compute-target read whose ONLY job is to answer
 * {@link hasMaterialHealthCheckFieldChanged} — the register/update paths read
 * the row purely to decide whether the stored health check must be invalidated,
 * and then discard it. `id` is the row the invalidating `deleteMany` addresses.
 *
 * `gatewayId` is optional on {@link MaterialHealthCheckFields}, so dropping its
 * key would still typecheck at the comparison and only surface as a gateway
 * change that silently stopped invalidating; `satisfies` is what forbids that.
 */
export const COMPUTE_TARGET_MATERIAL_CHANGE_SELECT = {
  id: true,
  machineName: true,
  platform: true,
  capabilities: true,
  supportedOperations: true,
  gatewayId: true,
} satisfies Record<keyof MaterialHealthCheckFields | "id", true>;
