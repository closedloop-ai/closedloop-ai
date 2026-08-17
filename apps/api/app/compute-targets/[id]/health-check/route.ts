import type {
  ComputeTargetHealthCheckSnapshot,
  UpsertComputeTargetHealthCheckSnapshotInput,
} from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { getDroppedHealthCheckFields } from "../../health-check-dropped-fields";
import { computeTargetsService } from "../../service";
import {
  HEALTH_CHECK_SNAPSHOT_MAX_BYTES,
  healthCheckSnapshotValidator,
} from "../../validators";

/**
 * GET /compute-targets/:id/health-check
 * Returns the latest persisted health-check snapshot for an accessible target.
 */
export const GET = withAnyAuth<
  ComputeTargetHealthCheckSnapshot | null,
  "/compute-targets/[id]/health-check"
>(async ({ user }, _request, params) => {
  try {
    const { id } = await params;
    const snapshot = await computeTargetsService.getLatestHealthCheckForTarget(
      user.organizationId,
      user.id,
      id
    );
    return successResponse(snapshot);
  } catch (error) {
    return errorResponse("Failed to fetch compute target health check", error);
  }
});

/**
 * PUT /compute-targets/:id/health-check
 * Stores the latest health-check snapshot for an accessible target.
 */
export const PUT = withAnyAuth<
  ComputeTargetHealthCheckSnapshot,
  "/compute-targets/[id]/health-check"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;
    // ONE read of ONE capped body. The row guards in
    // `healthCheckSnapshotValidator` degrade an unusable field to "absent"
    // rather than failing the whole PUT, and a `z.preprocess` swallows the value
    // before `safeParse` can raise an issue — so the pre-validation object is
    // the only place a discarded field is still observable (ISS-5868).
    // `parseBody` hands that same object back rather than the route cloning the
    // request and parsing it a second time, which doubled the memory an
    // authenticated caller could spend on one oversized snapshot.
    const {
      body,
      rawBody,
      errorResponse: parseError,
    } = await parseBody(request, healthCheckSnapshotValidator, {
      maxBytes: HEALTH_CHECK_SNAPSHOT_MAX_BYTES,
    });
    if (parseError || !body) {
      return parseError;
    }
    const snapshot = await computeTargetsService.upsertHealthCheckSnapshot(
      user.organizationId,
      user.id,
      id,
      // `satisfies` (not `as`) checks at compile time that the validator output
      // matches the service contract, so any future drift between
      // healthCheckSnapshotValidator and this input type fails the build.
      body satisfies UpsertComputeTargetHealthCheckSnapshotInput
    );
    if (!snapshot) {
      return notFoundResponse("Compute target");
    }
    // AFTER the service proves the caller can reach this target. Emitting before
    // that let anyone authenticated put arbitrary content into the monitored
    // stream for a target id they have no access to.
    reportDroppedHealthCheckFields(rawBody, body, id, user.organizationId);

    return successResponse(snapshot);
  } catch (error) {
    return errorResponse("Failed to store compute target health check", error);
  }
});

/**
 * The monitored event a discarded snapshot field is reported on.
 *
 * A stable snake_case name, not prose: a raw `log.warn` string nobody queries is
 * not an alert, and would disappear into exactly the void ISS-5811 sat in for
 * days. This is the name the Datadog monitor keys on (monitors themselves are
 * Terraform in `cl-tofu-aws-live`, not this repo), so it must not be reworded
 * casually — the same contract `assigned_artifact_tree_truncated` carries.
 */
const HEALTH_CHECK_FIELDS_DROPPED_EVENT =
  "compute_target_health_check_fields_dropped";

/**
 * How many dropped field names ride along as a sample.
 *
 * Every part of a dropped name is caller-controlled — the check `id` is only
 * `min(1)` — so emitting the whole list would let one authenticated PUT decide
 * the cardinality of a monitored event. The COUNT is the signal a monitor
 * alerts on; the sample is just enough to name the producer's bug.
 */
const DROPPED_FIELD_SAMPLE_LIMIT = 5;

/** Per-name cap, so one absurd check id cannot dominate the emitted event. */
const DROPPED_FIELD_NAME_MAX_LENGTH = 120;

/**
 * Reports guarded fields the snapshot validator discarded.
 *
 * Degrading an unusable field to "absent" is the correct failure mode here —
 * rejection is not row-scoped, so one bad field would throw away the whole
 * refresh — but a value coerced away in silence is a corrupt producer nobody is
 * told about. That is how ISS-5811 stayed invisible: `severity` was stripped on
 * all 13 rows for days with nothing anywhere saying so.
 *
 * Server runtime, so this routes to the existing structured-log monitor rather
 * than being coerced away silently (root `AGENTS.md`). Warn-level, once per PUT,
 * only when something was actually dropped, and only once the service has proven
 * the caller can reach the target.
 */
function reportDroppedHealthCheckFields(
  rawBody: unknown,
  parsed: UpsertComputeTargetHealthCheckSnapshotInput,
  computeTargetId: string,
  organizationId: string
): void {
  const droppedFields = getDroppedHealthCheckFields(rawBody, parsed);
  if (droppedFields.length === 0) {
    return;
  }
  log.warn(HEALTH_CHECK_FIELDS_DROPPED_EVENT, {
    computeTargetId,
    organizationId,
    droppedFieldCount: droppedFields.length,
    checkCount: parsed.result.checks.length,
    droppedFieldSample: droppedFields
      .slice(0, DROPPED_FIELD_SAMPLE_LIMIT)
      .map((field) => field.slice(0, DROPPED_FIELD_NAME_MAX_LENGTH)),
  });
}
