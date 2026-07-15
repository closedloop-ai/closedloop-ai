import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { computeTargetsService } from "@/app/compute-targets/service";
import type { DesktopAgentComponentsPayload } from "@/lib/desktop-agent-sessions-schema";
import type { DesktopComponentsSyncResponse } from "./route";

type DesktopComponentsSyncInput = {
  clerkUserId: string | null;
  computeTargetId: string;
  organizationId: string;
  payload: DesktopAgentComponentsPayload;
  userId: string;
};

type SyncedComponent = DesktopAgentComponentsPayload["components"][number];

/** Parse an ISO string field to Date, or null if absent. */
function parseDateField(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

/**
 * Build the `create` payload for an AgentComponent upsert.
 * Split from `update` so each function stays under the complexity budget.
 */
function buildUpsertCreate(
  component: SyncedComponent,
  organizationId: string,
  computeTargetId: string
) {
  return {
    organizationId,
    computeTargetId,
    componentKind: component.componentKind,
    externalComponentId: component.externalId,
    harness: component.harness ?? null,
    name: component.name ?? null,
    componentKey: component.componentKey ?? null,
    version: component.version ?? null,
    description: component.description ?? null,
    sourceUrl: component.sourceUrl ?? null,
    installPath: component.installPath ?? null,
    packId: component.packId ?? null,
    scope: component.scope ?? null,
    projectPath: component.projectPath ?? null,
    metadata: component.metadata ?? undefined,
    firstSeenAt: parseDateField(component.firstSeenAt),
    lastSeenAt: parseDateField(component.lastSeenAt),
    uninstalledAt: parseDateField(component.uninstalledAt),
  };
}

/**
 * Build the `update` payload for an AgentComponent upsert.
 * Split from `create` so each function stays under the complexity budget.
 */
function buildUpsertUpdate(component: SyncedComponent) {
  const lastSeenAt = parseDateField(component.lastSeenAt);
  return {
    harness: component.harness ?? null,
    name: component.name ?? null,
    componentKey: component.componentKey ?? null,
    version: component.version ?? null,
    description: component.description ?? null,
    sourceUrl: component.sourceUrl ?? null,
    installPath: component.installPath ?? null,
    packId: component.packId ?? null,
    scope: component.scope ?? null,
    projectPath: component.projectPath ?? null,
    metadata: component.metadata ?? undefined,
    lastSeenAt: lastSeenAt ?? undefined,
    uninstalledAt: parseDateField(component.uninstalledAt),
  };
}

/**
 * Map a synced component payload to Prisma upsert args.
 * Delegates create/update construction to dedicated helpers to keep each
 * function under the cognitive complexity budget.
 */
function mapSyncedComponentToUpsert(
  component: SyncedComponent,
  organizationId: string,
  computeTargetId: string
) {
  return {
    where: {
      computeTargetId_componentKind_externalComponentId: {
        computeTargetId,
        componentKind: component.componentKind,
        externalComponentId: component.externalId,
      },
    },
    create: buildUpsertCreate(component, organizationId, computeTargetId),
    update: buildUpsertUpdate(component),
  };
}

/**
 * Service for the desktop component-inventory sync lane.
 *
 * Verifies compute-target ownership (same guard as agent-sessions sync), then
 * upserts `AgentComponent` existence rows keyed by
 * `(computeTargetId, componentKind, externalComponentId)`. `organizationId` is
 * sourced from the authenticated user — never from the payload.
 *
 * Idempotent: re-syncing the same component updates `lastSeenAt` and mutable
 * fields; the cloud row count is bounded by the device's actual inventory.
 *
 * No server-side transcript re-parse — the desktop materializes existence rows
 * at import time and ships them fully pre-computed. (AC-011)
 */
export const desktopComponentsSyncService = {
  async sync(
    input: DesktopComponentsSyncInput
  ): Promise<Result<DesktopComponentsSyncResponse, StatusCode>> {
    // Gate: verify the compute target is owned by this user + org.
    const target = await computeTargetsService.findOwnedById(
      input.computeTargetId,
      input.organizationId,
      input.userId,
      input.clerkUserId
    );
    if (!target) {
      return Result.err(Status.Forbidden);
    }

    const { components, schemaVersion: _schemaVersion } = input.payload;

    // Upsert each component existence row. idempotent by the unique index on
    // (computeTargetId, componentKind, externalComponentId).
    await withDb((db) =>
      Promise.all(
        components.map((component) =>
          db.agentComponent.upsert(
            mapSyncedComponentToUpsert(
              component,
              input.organizationId,
              input.computeTargetId
            )
          )
        )
      )
    );

    return Result.ok({ synced: true });
  },
};
