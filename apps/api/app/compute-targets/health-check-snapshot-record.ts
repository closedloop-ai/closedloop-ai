import type {
  ComputeTargetHealthCheckSnapshot,
  HealthCheckResponse,
} from "@repo/api/src/types/compute-target";

/**
 * The stored System Check snapshot row, and the mapping between it and the
 * `ComputeTargetHealthCheckSnapshot` the API returns.
 *
 * Split out of `service.ts` because it is persistence shape-mapping, not
 * compute-target behaviour: the row carries `result` and `requiredFailureIds`
 * as opaque JSON columns, and turning those into a typed snapshot is the one
 * job of this module.
 */
export type ComputeTargetHealthCheckRecord = {
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

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function toHealthCheckSnapshot(
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

/**
 * The `select` for the stored snapshot read. Every column of the row is mapped
 * onto the API snapshot, so this narrows nothing today — it PINS the projection
 * so a column added to the table is not silently handed to the response, and
 * `satisfies` makes a divergence from {@link ComputeTargetHealthCheckRecord}
 * fail typecheck rather than reach a caller as `undefined`.
 */
export const COMPUTE_TARGET_HEALTH_CHECK_SELECT = {
  id: true,
  organizationId: true,
  computeTargetId: true,
  checkedAt: true,
  expectedMcpUrl: true,
  latestVersion: true,
  pluginAutoUpdateEnabled: true,
  result: true,
  allRequiredPassed: true,
  requiredFailureIds: true,
  schemaVersion: true,
  createdAt: true,
  updatedAt: true,
} satisfies Record<keyof ComputeTargetHealthCheckRecord, true>;
