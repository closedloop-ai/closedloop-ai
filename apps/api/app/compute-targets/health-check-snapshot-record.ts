import { isFailingRequiredCheck } from "@closedloop-ai/loops-api/compute-target";
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
 * The two snapshot columns derived from the gateway's checks — and they are
 * derived DIFFERENTLY on purpose.
 *
 * `requiredFailureIds` is the RAW `required && !passed` set, not
 * `isFailingRequiredCheck`: it is a record of what the gateway reported on each
 * row, and the blocking decision (which since ISS-5811 also reads `severity`)
 * belongs to the consumer that renders or gates on it, not to what gets written
 * down.
 *
 * `allRequiredPassed` is the blocking DECISION, so it goes through the shared
 * predicate (ISS-5868). Deriving it from the raw id list instead would make the
 * stored row contradict itself: the gateway mints the same field into the
 * `result` JSON column via `isFailingRequiredCheck`, so on the machine state
 * ISS-5811 describes — required rows the gateway could not determine — the
 * boolean column would read `false` beside a `result.allRequiredPassed` of
 * `true`. That is a third hand-copy of `required && !passed`, which is the
 * drift the shared predicate exists to prevent.
 */
function deriveHealthCheckSnapshotStatus(result: HealthCheckResponse): {
  requiredFailureIds: string[];
  allRequiredPassed: boolean;
} {
  return {
    requiredFailureIds: result.checks
      .filter((check) => check.required && !check.passed)
      .map((check) => check.id)
      .sort(),
    allRequiredPassed: !result.checks.some(isFailingRequiredCheck),
  };
}

/**
 * The complete write for one snapshot: the JSON `result` column, the derived
 * boolean column, and the raw id list — all from ONE derivation, so the two
 * places `allRequiredPassed` is stored cannot disagree.
 *
 * The gateway mints `result.allRequiredPassed` itself, and a Desktop older than
 * ISS-5369 computes it as bare `required && !passed` because it has no
 * `severity` to consult. Persisting that value verbatim while the sibling column
 * takes `isFailingRequiredCheck` writes a row that contradicts itself on exactly
 * the machine state ISS-5811 describes — required rows the gateway could not
 * determine — and this build then stamps `HEALTH_CHECK_SNAPSHOT_SCHEMA_VERSION`
 * on top, telling every consumer the row was written by a build that understands
 * severity. Normalising the JSON to the same derived value is what makes that
 * stamp true.
 *
 * This is a normalisation of a value this build derives, not an invented one:
 * every input is a field the client sent, and a client that never sent
 * `severity` still gets the pre-ISS-5369 answer, because `isFailingRequiredCheck`
 * treats an absent severity as a proven failure.
 */
export function buildHealthCheckSnapshotWrite(result: HealthCheckResponse): {
  result: HealthCheckResponse;
  requiredFailureIds: string[];
  allRequiredPassed: boolean;
} {
  const { requiredFailureIds, allRequiredPassed } =
    deriveHealthCheckSnapshotStatus(result);
  return {
    result: { ...result, allRequiredPassed },
    requiredFailureIds,
    allRequiredPassed,
  };
}
