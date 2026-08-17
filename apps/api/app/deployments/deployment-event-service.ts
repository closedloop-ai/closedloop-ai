import type {
  DeploymentEventSource,
  DeploymentEventState,
} from "@repo/api/src/types/deployment-event";
import { Result, type StatusCode } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";

/**
 * ISS-4975: writer for the append-only deployment-event history.
 *
 * Separate from `deployment-service.ts` on purpose — that service owns the
 * MUTABLE current-state DEPLOYMENT artifact (upsert-in-place on
 * `(organizationId, externalUrl)`), which is exactly the behavior that makes it
 * unusable as a DORA source. This service only ever appends.
 */

export type RecordDeploymentEventInput = {
  organizationId: string;
  projectId?: string | null;
  repositoryId?: string | null;
  branchArtifactId?: string | null;
  source: DeploymentEventSource;
  externalDeploymentId: string;
  externalEventId: string;
  state: DeploymentEventState;
  providerState: string;
  environment?: string | null;
  ref?: string | null;
  sha?: string | null;
  environmentUrl?: string | null;
  githubStatusUrl?: string | null;
  githubDeploymentUrl?: string | null;
  production?: boolean | null;
  transient?: boolean | null;
  occurredAt: Date;
  deploymentCreatedAt?: Date | null;
};

export type RecordDeploymentEventOutcome = {
  /**
   * False when the identical provider event was already recorded, i.e. the
   * insert hit the dedupe identity and did nothing.
   */
  recorded: boolean;
};

/**
 * Append one deployment status transition to the history.
 *
 * Concurrency: a single `createMany({ skipDuplicates: true })` compiles to
 * `INSERT ... ON CONFLICT DO NOTHING` against the
 * `(organization_id, source, external_event_id)` unique index, so overlapping
 * webhook deliveries of the same event — GitHub redelivery, or the same
 * deployment observed on more than one event stream — resolve in the database
 * rather than in a read-then-write race. There is no read to lose.
 *
 * This intentionally does NOT update on conflict: history rows are immutable, so
 * a redelivery must be a no-op, not a rewrite of an already-recorded fact.
 */
async function recordEvent(
  input: RecordDeploymentEventInput
): Promise<Result<RecordDeploymentEventOutcome, StatusCode>> {
  const { count } = await withDb((db) =>
    db.deploymentEvent.createMany({
      data: [
        {
          organizationId: input.organizationId,
          projectId: input.projectId ?? null,
          repositoryId: input.repositoryId ?? null,
          branchArtifactId: input.branchArtifactId ?? null,
          source: input.source,
          externalDeploymentId: input.externalDeploymentId,
          externalEventId: input.externalEventId,
          state: input.state,
          providerState: input.providerState,
          environment: input.environment ?? null,
          ref: input.ref ?? null,
          sha: input.sha ?? null,
          environmentUrl: input.environmentUrl ?? null,
          githubStatusUrl: input.githubStatusUrl ?? null,
          githubDeploymentUrl: input.githubDeploymentUrl ?? null,
          production: input.production ?? null,
          transient: input.transient ?? null,
          occurredAt: input.occurredAt,
          deploymentCreatedAt: input.deploymentCreatedAt ?? null,
        },
      ],
      skipDuplicates: true,
    })
  );
  return Result.ok({ recorded: count > 0 });
}

export const deploymentEventService = {
  recordEvent,
};
