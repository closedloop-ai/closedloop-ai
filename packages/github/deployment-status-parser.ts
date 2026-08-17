import {
  DeploymentEventSource,
  type DeploymentEventState,
  normalizeDeploymentEventState,
} from "@repo/api/src/types/deployment-event";
import { log } from "@repo/observability/log";
import { z } from "zod";

const LOG_PREFIX = "[deployment-status-parser]";

/**
 * Provider ids arrive as JSON numbers today, but GitHub has shipped string ids
 * on other resources, so accept either and normalize to string.
 */
const ProviderIdSchema = z.union([z.string().min(1), z.number()]);

/**
 * Deliberately loose: GitHub adds fields to `deployment_status` payloads without
 * warning, and an older delivery may omit fields a newer one carries. Every
 * field below is optional and unknown keys pass through, so neither direction of
 * version skew rejects a payload.
 */
const DeploymentStatusPayloadSchema = z.looseObject({
  deployment: z.looseObject({
    id: ProviderIdSchema.nullish(),
    ref: z.string().nullish(),
    sha: z.string().nullish(),
    environment: z.string().nullish(),
    created_at: z.string().nullish(),
    transient_environment: z.boolean().nullish(),
    production_environment: z.boolean().nullish(),
  }),
  deployment_status: z.looseObject({
    id: ProviderIdSchema.nullish(),
    state: z.string().nullish(),
    environment_url: z.string().nullish(),
    url: z.string().nullish(),
    deployment_url: z.string().nullish(),
    created_at: z.string().nullish(),
  }),
  repository: z
    .looseObject({
      id: ProviderIdSchema.nullish(),
    })
    .nullish(),
});

/**
 * A `deployment_status` webhook normalized for the append-only deployment-event
 * history. `externalDeploymentId` and `externalEventId` are the non-nullable
 * dedupe identity: the event id is unique per status transition, and the
 * deployment id groups every transition of one deployment so counts collapse per
 * deployment rather than per event.
 */
export type ParsedDeploymentStatusEvent = {
  source: DeploymentEventSource;
  externalDeploymentId: string;
  externalEventId: string;
  state: DeploymentEventState;
  providerState: string;
  environment: string | null;
  ref: string | null;
  sha: string | null;
  environmentUrl: string | null;
  githubStatusUrl: string | null;
  githubDeploymentUrl: string | null;
  production: boolean | null;
  transient: boolean | null;
  /**
   * When the PROVIDER says the transition happened — never the ingest clock.
   * Every DORA metric is a window or an interval over this value, so a
   * substituted ingest time would place a delayed redelivery in the wrong window
   * and permanently skew ordering. A payload with no parseable
   * `deployment_status.created_at` is skipped instead (see the parser below).
   */
  occurredAt: Date;
  deploymentCreatedAt: Date | null;
  repositoryExternalId: string | null;
};

function toProviderId(
  value: string | number | null | undefined
): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toNullableString(value: string | null | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

function toNullableBoolean(value: boolean | null | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Normalize a GitHub `deployment_status` webhook payload for history ingestion.
 *
 * Returns `null` — and logs a warning — when the payload is missing either half
 * of what a history row cannot be repaired without:
 *
 * 1. The non-nullable dedupe identity (`deployment.id` + `deployment_status.id`).
 *    Without both, a redelivered or cross-stream duplicate could not be
 *    recognized, and appending anyway would double-count deployment frequency.
 * 2. A parseable provider occurrence time (`deployment_status.created_at`).
 *    Substituting the ingest clock would make a delayed redelivery look like it
 *    happened now, landing it in the wrong DORA window and skewing MTTR ordering
 *    permanently — and the row is immutable, so it could never be corrected.
 *    A row with no honest occurrence time cannot serve any of the four metrics
 *    anyway, since all four are windowed or ordered on it, so skipping loses
 *    nothing a fabricated timestamp would have provided.
 *
 * Callers treat a `null` as "skip history", never as "skip the whole webhook".
 *
 * An unrecognized `state` is NOT a parse failure: it normalizes to
 * `DeploymentEventState.Unknown` and the event is still recorded.
 */
export function parseDeploymentStatusEvent(
  payload: unknown
): ParsedDeploymentStatusEvent | null {
  const result = DeploymentStatusPayloadSchema.safeParse(payload);
  if (!result.success) {
    log.warn(`${LOG_PREFIX} Unrecognized deployment_status payload shape`, {
      issues: result.error.issues.length,
    });
    return null;
  }

  const { deployment, deployment_status: status, repository } = result.data;
  const externalDeploymentId = toProviderId(deployment.id);
  const externalEventId = toProviderId(status.id);
  if (!(externalDeploymentId && externalEventId)) {
    log.warn(
      `${LOG_PREFIX} Skipping history: payload has no provider dedupe identity`,
      {
        hasDeploymentId: externalDeploymentId !== null,
        hasStatusId: externalEventId !== null,
      }
    );
    return null;
  }

  const occurredAt = toDate(status.created_at);
  if (!occurredAt) {
    log.warn(
      `${LOG_PREFIX} Skipping history: payload has no parseable occurrence time`,
      {
        externalDeploymentId,
        externalEventId,
        rawCreatedAt: status.created_at ?? null,
      }
    );
    return null;
  }

  const providerState = status.state?.trim() ?? "";
  return {
    source: DeploymentEventSource.GitHub,
    externalDeploymentId,
    externalEventId,
    state: normalizeDeploymentEventState(providerState),
    providerState,
    environment: toNullableString(deployment.environment),
    ref: toNullableString(deployment.ref),
    sha: toNullableString(deployment.sha),
    environmentUrl: toNullableString(status.environment_url),
    githubStatusUrl: toNullableString(status.url),
    githubDeploymentUrl: toNullableString(status.deployment_url),
    production: toNullableBoolean(deployment.production_environment),
    transient: toNullableBoolean(deployment.transient_environment),
    occurredAt,
    deploymentCreatedAt: toDate(deployment.created_at),
    repositoryExternalId: toProviderId(repository?.id),
  };
}
