import type { CreateDesktopCommandInput } from "@repo/api/src/types/compute-target";
import type {
  GitHubDirtyScope,
  GitHubDirtyTrigger,
  GitHubResyncNudgeBody,
} from "@repo/api/src/types/github-dirty-scope";
import {
  GITHUB_DIRTY_SCOPE_COMMAND_TIMEOUT_MS,
  GITHUB_DIRTY_SCOPE_MAX_SCOPES_PER_REPO,
  GITHUB_RESYNC_NUDGE_METHOD,
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GITHUB_RESYNC_NUDGE_PATH,
  GitHubDirtyFallbackReason,
  GitHubDirtyScopeKind,
  gitHubDirtyScopesValidator,
  omitAbsentNudgeOptionals,
} from "@repo/api/src/types/github-dirty-scope";
import { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { z } from "zod";
import {
  dispatchRelayCommandToRelay,
  toRelayOperation,
} from "@/app/compute-targets/relay-command-helpers";
import { desktopCommandStore } from "@/lib/desktop-command-store";

export const GITHUB_DIRTY_SCOPE_DEBOUNCE_MS = 45_000;
export const GITHUB_DIRTY_SCOPE_DESKTOP_RATE_LIMIT_MS = 45_000;
export const GITHUB_DIRTY_SCOPE_DISPATCH_CLAIM_TTL_MS = 2 * 60_000;
export const GITHUB_DIRTY_SCOPE_PENDING_TTL_MS = 10 * 60_000;

export type PublishGitHubDirtyScopeInput = {
  organizationId: string;
  repositoryId: string;
  repositoryFullName?: string;
  scopes: GitHubDirtyScope[];
  triggers?: GitHubDirtyTrigger[];
};

export type GitHubDirtyScopePublishResult = {
  pendingRows: number;
  dispatchedRows: number;
};

type DirtyScopeTarget = {
  id: string;
  gatewayId: string | null;
  supportedOperations: unknown;
};

type PendingDirtyScopeRow = Prisma.GitHubDirtyScopeNudgeGetPayload<{
  include: { computeTarget: { select: { gatewayId: true } } };
}>;

const supportedOperationsValidator = z.array(z.string());
const prismaJsonValueValidator = z.custom<Prisma.InputJsonValue>((value) => {
  if (value === null || value === undefined) {
    return false;
  }
  return JSON.stringify(value) !== undefined;
});

export const githubDirtyScopeService = {
  async publish(
    input: PublishGitHubDirtyScopeInput
  ): Promise<GitHubDirtyScopePublishResult> {
    const now = new Date();
    const targets = await findEligibleTargets(input.organizationId);
    if (targets.length === 0) {
      return { pendingRows: 0, dispatchedRows: 0 };
    }
    await cleanupExpiredDirtyScopeNudges(now);
    let pendingRows = 0;
    for (const target of targets) {
      await upsertPendingDirtyScope({
        input,
        target,
        now,
      });
      pendingRows += 1;
    }
    const dispatchedRows = await dispatchDueGitHubDirtyScopeNudges({
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      now,
    });
    scheduleDueDirtyScopeDispatch({
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      scheduledAt: new Date(now.getTime() + GITHUB_DIRTY_SCOPE_DEBOUNCE_MS),
    });
    return { pendingRows, dispatchedRows };
  },

  dispatchDue: dispatchDueGitHubDirtyScopeNudges,
};

async function findEligibleTargets(
  organizationId: string
): Promise<DirtyScopeTarget[]> {
  const targets = await withDb((db) =>
    db.computeTarget.findMany({
      where: {
        organizationId,
        isOnline: true,
      },
      select: {
        id: true,
        gatewayId: true,
        supportedOperations: true,
      },
    })
  );
  return targets.filter((target) =>
    toStringArray(target.supportedOperations).includes(
      GITHUB_RESYNC_NUDGE_OPERATION_ID
    )
  );
}

async function upsertPendingDirtyScope({
  input,
  target,
  now,
}: {
  input: PublishGitHubDirtyScopeInput;
  target: DirtyScopeTarget;
  now: Date;
}): Promise<void> {
  const windowStartedAt = floorToWindow(
    now,
    GITHUB_DIRTY_SCOPE_DESKTOP_RATE_LIMIT_MS
  );
  const scheduledDispatchAt = new Date(
    now.getTime() + GITHUB_DIRTY_SCOPE_DEBOUNCE_MS
  );
  const expiresAt = new Date(now.getTime() + GITHUB_DIRTY_SCOPE_PENDING_TTL_MS);
  const dirtyScopes = normalizeDirtyScopes(input.scopes);

  await withDb.tx(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${dirtyScopeWindowLockKey(
        input,
        target.id,
        windowStartedAt
      )}, 0::bigint))
    `);
    const existing = await tx.gitHubDirtyScopeNudge.findUnique({
      where: {
        organizationId_githubInstallationRepositoryId_computeTargetId_windowStartedAt:
          {
            organizationId: input.organizationId,
            githubInstallationRepositoryId: input.repositoryId,
            computeTargetId: target.id,
            windowStartedAt,
          },
      },
      select: {
        dirtyScopes: true,
        genericRefresh: true,
        dispatchedAt: true,
      },
    });
    if (existing?.dispatchedAt) {
      return;
    }
    const mergedScopes = mergeDirtyScopes(existing?.dirtyScopes, dirtyScopes);
    await tx.gitHubDirtyScopeNudge.upsert({
      where: {
        organizationId_githubInstallationRepositoryId_computeTargetId_windowStartedAt:
          {
            organizationId: input.organizationId,
            githubInstallationRepositoryId: input.repositoryId,
            computeTargetId: target.id,
            windowStartedAt,
          },
      },
      create: {
        organizationId: input.organizationId,
        githubInstallationRepositoryId: input.repositoryId,
        computeTargetId: target.id,
        windowStartedAt,
        dirtyScopes: toPrismaJson(mergedScopes),
        genericRefresh: isGenericScopeSet(mergedScopes),
        scheduledDispatchAt,
        expiresAt,
      },
      update: {
        dirtyScopes: toPrismaJson(mergedScopes),
        genericRefresh:
          existing?.genericRefresh === true || isGenericScopeSet(mergedScopes),
        expiresAt,
      },
    });
  });
}

async function dispatchDueGitHubDirtyScopeNudges({
  computeTargetId,
  organizationId,
  repositoryId,
  now = new Date(),
}: {
  computeTargetId?: string;
  organizationId?: string;
  repositoryId?: string;
  now?: Date;
} = {}): Promise<number> {
  let dispatched = 0;
  for (;;) {
    const rows = await findDueDirtyScopeRows({
      computeTargetId,
      organizationId,
      repositoryId,
      now,
    });
    if (rows.length === 0) {
      return dispatched;
    }

    let pageProgress = 0;
    for (const row of rows) {
      const claimed = await claimDirtyScopeRow(row, now);
      if (!claimed) {
        continue;
      }
      try {
        const result = await dispatchDirtyScopeRow(row);
        await settleDirtyScopeRow(row, now, result);
        dispatched += 1;
        pageProgress += 1;
      } catch (error) {
        await releaseDirtyScopeClaim(row, error);
      }
    }

    if (rows.length < 100 || pageProgress === 0) {
      return dispatched;
    }
  }
}

function findDueDirtyScopeRows({
  computeTargetId,
  organizationId,
  repositoryId,
  now,
}: {
  computeTargetId?: string;
  organizationId?: string;
  repositoryId?: string;
  now: Date;
}): Promise<PendingDirtyScopeRow[]> {
  return withDb((db) =>
    db.gitHubDirtyScopeNudge.findMany({
      where: {
        dispatchedAt: null,
        scheduledDispatchAt: { lte: now },
        expiresAt: { gt: now },
        OR: [
          { dispatchClaimedAt: null },
          {
            dispatchClaimedAt: {
              lt: new Date(
                now.getTime() - GITHUB_DIRTY_SCOPE_DISPATCH_CLAIM_TTL_MS
              ),
            },
          },
        ],
        ...(computeTargetId ? { computeTargetId } : {}),
        ...(organizationId ? { organizationId } : {}),
        ...(repositoryId
          ? { githubInstallationRepositoryId: repositoryId }
          : {}),
      },
      include: { computeTarget: { select: { gatewayId: true } } },
      orderBy: { createdAt: "asc" },
      take: 100,
    })
  );
}

async function claimDirtyScopeRow(
  row: PendingDirtyScopeRow,
  now: Date
): Promise<boolean> {
  const claim = await withDb((db) =>
    db.gitHubDirtyScopeNudge.updateMany({
      where: {
        id: row.id,
        dispatchedAt: null,
        OR: [
          { dispatchClaimedAt: null },
          {
            dispatchClaimedAt: {
              lt: new Date(
                now.getTime() - GITHUB_DIRTY_SCOPE_DISPATCH_CLAIM_TTL_MS
              ),
            },
          },
        ],
        scheduledDispatchAt: { lte: now },
        expiresAt: { gt: now },
      },
      data: {
        dispatchClaimedAt: now,
        deliveryResult: toPrismaJson({ delivered: false, reason: "claimed" }),
      },
    })
  );
  return claim.count === 1;
}

async function settleDirtyScopeRow(
  row: PendingDirtyScopeRow,
  now: Date,
  result: { delivered: boolean; reason?: string; commandId?: string }
): Promise<void> {
  await withDb((db) =>
    db.gitHubDirtyScopeNudge.updateMany({
      where: { id: row.id },
      data: {
        dispatchClaimedAt: null,
        dispatchedAt: now,
        deliveryResult: toPrismaJson(result),
      },
    })
  );
}

async function releaseDirtyScopeClaim(
  row: PendingDirtyScopeRow,
  error: unknown
): Promise<void> {
  await withDb((db) =>
    db.gitHubDirtyScopeNudge.updateMany({
      where: { id: row.id },
      data: {
        dispatchClaimedAt: null,
        deliveryResult: toPrismaJson({
          delivered: false,
          reason: error instanceof Error ? error.message : String(error),
        }),
      },
    })
  );
}

function scheduleDueDirtyScopeDispatch({
  organizationId,
  repositoryId,
  scheduledAt,
}: {
  organizationId: string;
  repositoryId: string;
  scheduledAt: Date;
}): void {
  const delayMs = Math.max(0, scheduledAt.getTime() - Date.now());
  waitUntil(
    delay(delayMs).then(() =>
      dispatchDueGitHubDirtyScopeNudges({
        organizationId,
        repositoryId,
      }).catch((error) => {
        log.warn("[githubDirtyScopeService] Delayed dispatch failed", {
          error,
          organizationId,
          repositoryId,
        });
      })
    )
  );
}

async function dispatchDirtyScopeRow(row: PendingDirtyScopeRow): Promise<{
  delivered: boolean;
  reason?: string;
  commandId?: string;
}> {
  const body = buildCommandBody(row);
  const idempotencyKey = [
    "github-resync",
    row.organizationId,
    row.githubInstallationRepositoryId,
    row.windowStartedAt.toISOString(),
    row.computeTargetId,
  ].join(":");
  const commandInput: CreateDesktopCommandInput = {
    operationId: GITHUB_RESYNC_NUDGE_OPERATION_ID,
    method: GITHUB_RESYNC_NUDGE_METHOD,
    path: GITHUB_RESYNC_NUDGE_PATH,
    body,
    timeoutMs: GITHUB_DIRTY_SCOPE_COMMAND_TIMEOUT_MS,
    idempotencyKey,
    streaming: false,
  };
  const createResult = await desktopCommandStore.createCommand(
    row.computeTargetId,
    commandInput
  );
  const relayResult = await dispatchRelayCommandToRelay({
    targetId: row.computeTargetId,
    commandId: createResult.command.commandId,
    relayOperation: toRelayOperation(
      createResult.command.commandId,
      commandInput
    ),
  });
  if (!relayResult.delivered) {
    log.info("[githubDirtyScopeService] GitHub resync nudge not delivered", {
      computeTargetId: row.computeTargetId,
      repositoryId: row.githubInstallationRepositoryId,
      commandId: createResult.command.commandId,
      reason: relayResult.reason,
    });
  }
  return {
    delivered: relayResult.delivered,
    ...(relayResult.reason ? { reason: relayResult.reason } : {}),
    commandId: createResult.command.commandId,
  };
}

async function cleanupExpiredDirtyScopeNudges(now: Date): Promise<void> {
  await withDb((db) =>
    db.gitHubDirtyScopeNudge.deleteMany({
      where: {
        expiresAt: { lt: now },
      },
    })
  );
}

function buildCommandBody(row: PendingDirtyScopeRow): GitHubResyncNudgeBody {
  const scopes = normalizeDirtyScopes(row.dirtyScopes);
  const fallbackReason = row.genericRefresh
    ? GitHubDirtyFallbackReason.ScopeOverflow
    : undefined;
  return omitAbsentNudgeOptionals({
    scopes: scopes.length ? scopes : [{ kind: GitHubDirtyScopeKind.Generic }],
    ...(fallbackReason ? { fallbackReason } : {}),
    computeTargetId: row.computeTargetId,
    gatewayId: row.computeTarget.gatewayId ?? undefined,
  });
}

function dirtyScopeWindowLockKey(
  input: PublishGitHubDirtyScopeInput,
  computeTargetId: string,
  windowStartedAt: Date
): string {
  return [
    "github-dirty-scope",
    input.organizationId,
    input.repositoryId,
    computeTargetId,
    windowStartedAt.toISOString(),
  ].join(":");
}

function normalizeDirtyScopes(value: unknown): GitHubDirtyScope[] {
  const parsed = gitHubDirtyScopesValidator.safeParse(value);
  if (!parsed.success) {
    return [{ kind: GitHubDirtyScopeKind.Generic }];
  }
  return parsed.data;
}

function mergeDirtyScopes(
  existingValue: unknown,
  nextScopes: GitHubDirtyScope[]
): GitHubDirtyScope[] {
  const existingScopes =
    existingValue === undefined || existingValue === null
      ? []
      : normalizeDirtyScopes(existingValue);
  if (existingScopes.some(isGenericScope) || nextScopes.some(isGenericScope)) {
    return [{ kind: GitHubDirtyScopeKind.Generic }];
  }
  const byKey = new Map<string, GitHubDirtyScope>();
  for (const scope of [...existingScopes, ...nextScopes]) {
    byKey.set(stableScopeKey(scope), scope);
    if (byKey.size > GITHUB_DIRTY_SCOPE_MAX_SCOPES_PER_REPO) {
      return [{ kind: GitHubDirtyScopeKind.Generic }];
    }
  }
  return [...byKey.values()];
}

function isGenericScopeSet(scopes: readonly GitHubDirtyScope[]): boolean {
  return scopes.some(isGenericScope);
}

function isGenericScope(scope: GitHubDirtyScope): boolean {
  return scope.kind === GitHubDirtyScopeKind.Generic;
}

function stableScopeKey(scope: GitHubDirtyScope): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(scope).sort(([left], [right]) => left.localeCompare(right))
    )
  );
}

function floorToWindow(date: Date, windowMs: number): Date {
  return new Date(Math.floor(date.getTime() / windowMs) * windowMs);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toStringArray(value: unknown): string[] {
  const parsed = supportedOperationsValidator.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return prismaJsonValueValidator.parse(value);
}
