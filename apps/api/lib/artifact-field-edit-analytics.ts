import { nodeAnalytics } from "@repo/analytics/node";
import {
  type ArtifactFieldEditField,
  type ArtifactFieldEditOutcome,
  classifyArtifactFieldEditValue,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import type {
  ArtifactStatusEditSurface,
  ArtifactStatusProvenance,
} from "@repo/api/src/types/artifact-status-contract";
import type { JsonValue } from "@repo/api/src/types/common";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import {
  EmissionRollupCause,
  type EmissionRollupCause as EmissionRollupCauseValue,
  FixedWindowEmissionThrottle,
} from "./observability/fixed-window-emission-throttle";

/** Stable aggregate event for server-authoritative field-edit outcomes. */
export const ARTIFACT_FIELD_EDIT_RESULT_EVENT = "artifact_field_edit_result";

/** Whether the server can join an outcome to a grouped or reversing commit. */
export const ArtifactFieldEditLineage = {
  Single: "single",
  Grouped: "grouped",
  Undo: "undo",
} as const;
export type ArtifactFieldEditLineage =
  (typeof ArtifactFieldEditLineage)[keyof typeof ArtifactFieldEditLineage];

/** Value-safe facts needed to emit one edit result. */
export type ArtifactFieldEditAnalyticsInput = {
  organizationId: string;
  userId?: string;
  field: ArtifactFieldEditField;
  result: ArtifactFieldEditOutcome;
  artifactCount?: number;
  provenance?: ArtifactStatusProvenance;
  surface?: ArtifactStatusEditSurface;
  before?: JsonValue;
  after?: JsonValue;
  commitGroupId?: string;
  undoOfCommitGroupId?: string;
};

/** Schedule one value-safe result; analytics can never change the mutation. */
export function captureArtifactFieldEditAnalytics(
  input: ArtifactFieldEditAnalyticsInput
): void {
  try {
    const now = Date.now();
    resultEmissionThrottle.drainExpired(now);
    const emission = analyticsEmission(input);
    const decision = resultEmissionThrottle.record(
      analyticsKey(emission),
      emission,
      now
    );
    if (decision.flushedSuppressedCount > 0) {
      scheduleAnalyticsDelivery(
        emission,
        decision.flushedSuppressedCount,
        EmissionRollupCause.Window
      );
    }
    if (decision.emit) {
      scheduleAnalyticsDelivery(emission, 1);
    }
  } catch (error) {
    reportAnalyticsDeliveryFailure(analyticsEmission(input), error);
  }
}

/** Send one result through the same delivery and diagnostic boundary. */
export async function emitArtifactFieldEditAnalytics(
  input: ArtifactFieldEditAnalyticsInput
): Promise<void> {
  await sendAnalytics(analyticsEmission(input), 1);
}

type ArtifactFieldEditAnalyticsProperties = ReturnType<
  typeof analyticsProperties
>;

type ArtifactFieldEditAnalyticsEmission = {
  distinctId: string;
  properties: ArtifactFieldEditAnalyticsProperties;
};

const resultEmissionThrottle =
  new FixedWindowEmissionThrottle<ArtifactFieldEditAnalyticsEmission>({
    onFlush: (emission, occurrences, cause) => {
      scheduleAnalyticsDelivery(emission, occurrences, cause);
    },
  });

const deliveryFailureThrottle =
  new FixedWindowEmissionThrottle<ArtifactFieldEditAnalyticsEmission>({
    onFlush: emitAnalyticsDeliveryFailureRollup,
  });

function analyticsEmission(
  input: ArtifactFieldEditAnalyticsInput
): ArtifactFieldEditAnalyticsEmission {
  return {
    distinctId: input.userId ?? `system:${input.organizationId}`,
    properties: analyticsProperties(input),
  };
}

function analyticsKey(emission: ArtifactFieldEditAnalyticsEmission): string {
  return JSON.stringify([emission.distinctId, emission.properties]);
}

function scheduleAnalyticsDelivery(
  emission: ArtifactFieldEditAnalyticsEmission,
  occurrences: number,
  rollupCause?: EmissionRollupCauseValue
): void {
  try {
    waitUntil(sendAnalytics(emission, occurrences, rollupCause));
  } catch (error) {
    reportAnalyticsDeliveryFailure(emission, error);
  }
}

async function sendAnalytics(
  emission: ArtifactFieldEditAnalyticsEmission,
  occurrences: number,
  rollupCause?: EmissionRollupCauseValue
): Promise<void> {
  const artifactCount = emission.properties.artifactCount;
  try {
    await nodeAnalytics.captureImmediate({
      distinctId: emission.distinctId,
      event: ARTIFACT_FIELD_EDIT_RESULT_EVENT,
      properties: {
        ...emission.properties,
        occurrences,
        ...(artifactCount === undefined
          ? {}
          : { artifactCount: artifactCount * occurrences }),
        ...(rollupCause === undefined ? {} : { rollupCause }),
      },
    });
  } catch (error) {
    reportAnalyticsDeliveryFailure(emission, error);
  }
}

function analyticsProperties(input: ArtifactFieldEditAnalyticsInput) {
  const provenance = input.provenance;
  const surface = provenance?.surface ?? input.surface;
  const commitGroupId = provenance?.commitGroupId ?? input.commitGroupId;
  const artifactCount = representedArtifactCount(input.artifactCount);
  return {
    organizationId: input.organizationId,
    field: input.field,
    result: input.result,
    ...(artifactCount === undefined ? {} : { artifactCount }),
    lineage: resolveLineage({
      commitGroupId,
      undoOfCommitGroupId: input.undoOfCommitGroupId,
    }),
    ...(surface === undefined ? {} : { surface }),
    ...(input.before === undefined
      ? {}
      : {
          fromValueClassification: classifyArtifactFieldEditValue(
            input.field,
            input.before
          ),
        }),
    ...(input.after === undefined
      ? {}
      : {
          toValueClassification: classifyArtifactFieldEditValue(
            input.field,
            input.after
          ),
        }),
  };
}

function representedArtifactCount(value: number | undefined) {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function reportAnalyticsDeliveryFailure(
  emission: ArtifactFieldEditAnalyticsEmission,
  error: unknown
): void {
  try {
    const now = Date.now();
    deliveryFailureThrottle.drainExpired(now);
    const decision = deliveryFailureThrottle.record(
      analyticsKey(emission),
      emission,
      now
    );
    if (decision.flushedSuppressedCount > 0) {
      emitAnalyticsDeliveryFailureRollup(
        emission,
        decision.flushedSuppressedCount,
        EmissionRollupCause.Window
      );
    }
    if (!decision.emit) {
      return;
    }
    log.error("Failed to capture artifact field edit analytics", {
      organizationId: emission.properties.organizationId,
      field: emission.properties.field,
      result: emission.properties.result,
      occurrences: 1,
      error: parseError(error),
    });
  } catch {
    // Analytics diagnostics are best-effort and cannot affect the mutation.
  }
}

function emitAnalyticsDeliveryFailureRollup(
  emission: ArtifactFieldEditAnalyticsEmission,
  occurrences: number,
  rollupCause: EmissionRollupCauseValue
): void {
  try {
    log.error("Failed to capture artifact field edit analytics", {
      organizationId: emission.properties.organizationId,
      field: emission.properties.field,
      result: emission.properties.result,
      occurrences,
      rollupCause,
    });
  } catch {
    // Analytics diagnostics are best-effort and cannot affect the mutation.
  }
}

function resolveLineage(input: {
  commitGroupId?: string;
  undoOfCommitGroupId?: string;
}): ArtifactFieldEditLineage {
  if (input.undoOfCommitGroupId !== undefined) {
    return ArtifactFieldEditLineage.Undo;
  }
  return input.commitGroupId === undefined
    ? ArtifactFieldEditLineage.Single
    : ArtifactFieldEditLineage.Grouped;
}
