import type { CreateDesktopCommandInput } from "@repo/api/src/types/compute-target";
import type {
  GitHubDirtyScope,
  GitHubDirtyTrigger,
  GitHubResyncNudgeBody,
} from "@repo/api/src/types/github-dirty-scope";
import {
  GITHUB_DIRTY_SCOPE_COMMAND_TIMEOUT_MS,
  GITHUB_RESYNC_NUDGE_METHOD,
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GITHUB_RESYNC_NUDGE_PATH,
  GitHubDirtyFallbackReason,
  GitHubDirtyScopeKind,
  omitAbsentNudgeOptionals,
} from "@repo/api/src/types/github-dirty-scope";
import type { RelayDispatchResult } from "@repo/api/src/types/relay-dispatch";
import { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { z } from "zod";
import {
  dispatchRelayCommandToRelay,
  toRelayOperation,
} from "@/app/compute-targets/relay-command-helpers";
import {
  isGenericScopeSet,
  mergeDirtyScopes,
  normalizeDirtyScopes,
} from "@/app/integrations/github/dirty-scope-scope-merge";
import { desktopCommandStore } from "@/lib/desktop-command-store";

export const GITHUB_DIRTY_SCOPE_DEBOUNCE_MS = 45_000;
export const GITHUB_DIRTY_SCOPE_DESKTOP_RATE_LIMIT_MS = 45_000;
export const GITHUB_DIRTY_SCOPE_DISPATCH_CLAIM_TTL_MS = 2 * 60_000;
export const GITHUB_DIRTY_SCOPE_PENDING_TTL_MS = 10 * 60_000;

/**
 * How long a nudge whose dispatch THREW waits before it is due again
 * (ISS-10050).
 *
 * A thrown dispatch is released, not settled: the claim clears, `dispatchedAt`
 * stays null and `createdAt` is untouched, so without this the row re-enters
 * the due set exactly where it was. `findDueDirtyScopeRows` pages
 * `createdAt asc`, and `writeDirtyScopeChunk` gives a whole chunk one
 * `created_at`, so once a tie block is wider than
 * `GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE` the same retrying rows can fill the page
 * on every drain and a tied peer is never read before `expiresAt` retires it. A
 * tiebreaker cannot fix that — a deterministic order over the same block
 * re-picks the same rows. Deferring the retry does: the block leaves the due
 * set for this long, its peers get a page, and the retry then competes on the
 * same terms again rather than being ranked behind its peers permanently.
 *
 * DERIVED, and the relationship is the contract, not the number: it must be
 * STRICTLY GREATER than `GITHUB_DIRTY_SCOPE_DEBOUNCE_MS`. A tie block spans
 * several desktops, and the presence-heartbeat drain is scoped to ONE
 * (`scheduleGitHubDirtyScopeRecoveryDrain` passes `computeTargetId`), so it
 * never reads a page those rows compete for — the debounced re-drain
 * `publish` schedules at `now + GITHUB_DIRTY_SCOPE_DEBOUNCE_MS` is the drain
 * that has to land while the block is deferred. `scheduledDispatchAt: { lte: now }`
 * is INCLUSIVE, so a backoff merely equal to that gap is due again on exactly
 * the drain meant to step over it, and the block refills the page. The margin
 * is for a re-drain that fires LATE, which `waitUntil(delay(...))` allows and
 * early firing does not. `github-dirty-scope-drain-cost.test.ts` pins both the
 * inequality and the boundary drain, so making the two equal again fails there
 * rather than in production.
 *
 * Short against `GITHUB_DIRTY_SCOPE_PENDING_TTL_MS` at the other end, so a
 * persistently failing row still gets roughly ten attempts inside its own TTL.
 *
 * Applies ONLY to a thrown dispatch. The rows a spent lease releases are not
 * holding a page against anyone — the page-mates ahead of them settled and
 * left — so deferring them would buy fairness they do not owe with latency a
 * healthy drain would pay. (One of those rows, the one the lease ran out
 * INSIDE, did get a command written; see `releaseUnreachedDirtyScopeRows`. It
 * is a single row, not a block, so it cannot hold a page either.)
 */
export const GITHUB_DIRTY_SCOPE_RETRY_BACKOFF_MS =
  GITHUB_DIRTY_SCOPE_DEBOUNCE_MS + 15_000;

/**
 * Targets written per transaction by the set-based pending upsert (ISS-7276).
 *
 * An org's eligible desktop targets are normally a handful, so this is a
 * statement-size guard rather than a routine split: it keeps one publish from
 * building an unbounded `IN (...)` list if an org ever runs hundreds of online
 * desktops.
 */
export const GITHUB_DIRTY_SCOPE_UPSERT_CHUNK_SIZE = 100;

/** Due rows read, claimed, and settled per drain page. */
export const GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE = 100;

/**
 * Pages one drain will take before leaving the rest to the next one (ISS-8973).
 *
 * The loop re-pages only while a FULL page made forward progress, so for a
 * fixed due set it terminates on its own. Publishes land concurrently though,
 * so a busy org can keep handing it full pages — and this runs under
 * `waitUntil` on the presence heartbeat, which fires roughly 27,000 times a
 * day. Capping it bounds what one request's background task can own; the
 * remainder is picked up by the next heartbeat or the debounced dispatch,
 * both of which are already frequent.
 */
export const GITHUB_DIRTY_SCOPE_DRAIN_MAX_PAGES = 10;

/**
 * Lease headroom a drain keeps in hand instead of spending it on deliveries.
 *
 * The deliveries are serial and `dispatchRelayCommandToRelay` aborts at five
 * seconds, so a degraded relay makes a full page cost up to 500s — four times
 * `GITHUB_DIRTY_SCOPE_DISPATCH_CLAIM_TTL_MS`. A drain that keeps delivering
 * past its own claim is racing whichever drain has since legitimately reclaimed
 * those rows, and BOTH push the same command id: the store's idempotency key
 * dedupes the row, not the relay hop after it. So the page stops this far short
 * of its lease and releases the rest, leaving room for the hop already in
 * flight plus the settle writes that do the releasing.
 *
 * It budgets those two and nothing else. `createCommand` sits between the
 * page's check and the hop and is bounded by neither, so `dispatchDirtyScopeRow`
 * rechecks the deadline after the command write rather than this widening to
 * cover it (@davetho, #6529).
 */
const GITHUB_DIRTY_SCOPE_DISPATCH_LEASE_MARGIN_MS = 15_000;

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

export type DirtyScopeTarget = {
  id: string;
  gatewayId: string | null;
  supportedOperations: unknown;
};

/**
 * Per-organization work `publish` would otherwise redo on every call: the
 * org-wide eligible-target read and the expired-nudge sweep (ISS-7276).
 *
 * Build one with `prepareBatch` and pass it to every `publish` in a fan-out —
 * the `installation_repositories` webhook publishes once per added repository,
 * and GitHub makes that list hundreds wide on an "all repositories" grant, so
 * paying both per repository multiplies round trips by the payload size.
 */
export type GitHubDirtyScopeBatch = {
  organizationId: string;
  /**
   * Mutable: a publish that finds one of these desktops deleted removes it
   * here, so the rest of the fan-out stops writing rows that cannot exist.
   */
  targets: DirtyScopeTarget[];
};

/** The filters one drain was invoked with, carried into its logs for triage. */
type DirtyScopeDrainScope = {
  computeTargetId?: string;
  organizationId?: string;
  repositoryId?: string;
};

/** One page's rows that settled identically, written by a single `updateMany`. */
type DirtyScopeSettleGroup = {
  ids: string[];
  /** False releases the claim instead, leaving the row in the due set. */
  settled: boolean;
  /**
   * Milliseconds to push `scheduledDispatchAt` out by when the claim is
   * released, so a row that was ATTEMPTED and failed falls behind the peers it
   * ties with on `createdAt` instead of holding the page (ISS-10050). Zero
   * leaves the row due immediately, which is what a release of a row that was
   * never attempted wants.
   */
  retryBackoffMs: number;
  result: DirtyScopeDispatchResult;
};

type DirtyScopeUpdateGroup = {
  dirtyScopes: GitHubDirtyScope[];
  genericRefresh: boolean;
  computeTargetIds: string[];
};

type DirtyScopeChunkWrites = {
  creates: Prisma.GitHubDirtyScopeNudgeCreateManyInput[];
  updates: DirtyScopeUpdateGroup[];
};

type DirtyScopeRowKey = {
  organizationId: string;
  githubInstallationRepositoryId: string;
  windowStartedAt: Date;
};

type DirtyScopeWritePlan = {
  rowKey: DirtyScopeRowKey;
  dirtyScopes: GitHubDirtyScope[];
  scheduledDispatchAt: Date;
  expiresAt: Date;
};

type ExistingDirtyScopeRow = {
  computeTargetId: string;
  dirtyScopes: Prisma.JsonValue;
  genericRefresh: boolean;
  dispatchedAt: Date | null;
};

type PendingDirtyScopeRow = Prisma.GitHubDirtyScopeNudgeGetPayload<{
  include: {
    computeTarget: {
      select: {
        organizationId: true;
        supportedOperations: true;
      };
    };
  };
}>;

/**
 * All the due read owes the drain: which rows to claim, in the order to claim
 * them. Every column the delivery needs comes back from the claim itself, so
 * reading them here would be a join whose result the drain would then discard.
 */
type DueDirtyScopeRowId = { id: string };

type DirtyScopeDispatchResult = RelayDispatchResult & {
  commandId?: string;
};

const supportedOperationsValidator = z.array(z.string());
const prismaJsonValueValidator = z.custom<Prisma.InputJsonValue>((value) => {
  if (value === null || value === undefined) {
    return false;
  }
  return JSON.stringify(value) !== undefined;
});

export const githubDirtyScopeService = {
  /**
   * Resolve the per-organization prerequisites of `publish` once, for a caller
   * about to publish for many repositories of the same org (ISS-7276).
   *
   * The returned target set is a snapshot in both directions: a desktop that
   * comes online while the fan-out is still running gets no pending row, where
   * per-call resolution would have caught it partway through, and one that goes
   * offline still gets rows, which dispatch settles as `no_subscriber`. That widens an existing race (a
   * desktop connecting after the last publish was always missed) from one
   * publish to one webhook — seconds — and the nudge is a best-effort pull hint
   * whose recovery path is the desktop's own visible reads and app focus, so a
   * reconnect drain having no row to replay costs a refresh, not correctness.
   * Do NOT reuse a batch across webhooks, where that window would stop being
   * bounded by one payload.
   */
  async prepareBatch(organizationId: string): Promise<GitHubDirtyScopeBatch> {
    const targets = await findEligibleTargets(organizationId);
    if (targets.length > 0) {
      await cleanupExpiredDirtyScopeNudges(new Date());
    }
    return { organizationId, targets };
  },

  async publish(
    input: PublishGitHubDirtyScopeInput,
    batch?: GitHubDirtyScopeBatch
  ): Promise<GitHubDirtyScopePublishResult> {
    const now = new Date();
    const targets = await resolveEligibleTargets(
      input.organizationId,
      now,
      batch
    );
    if (targets.length === 0) {
      return { pendingRows: 0, dispatchedRows: 0 };
    }
    const missingTargetIds = await upsertPendingDirtyScopes({
      input,
      targets,
      now,
      batch,
    });
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
    return {
      pendingRows: targets.length - missingTargetIds.length,
      dispatchedRows,
    };
  },

  dispatchDue: dispatchDueGitHubDirtyScopeNudges,
};

/**
 * A batch is only reusable within the organization it was prepared for —
 * honoring one from another org would write nudges for that org's desktops.
 * Mismatches fall back to resolving this org's targets rather than failing, so
 * a mis-threaded batch degrades to the pre-ISS-7276 cost instead of leaking.
 */
async function resolveEligibleTargets(
  organizationId: string,
  now: Date,
  batch: GitHubDirtyScopeBatch | undefined
): Promise<readonly DirtyScopeTarget[]> {
  if (batch) {
    if (batch.organizationId === organizationId) {
      return batch.targets;
    }
    log.warn(
      "[githubDirtyScopeService] Ignoring dirty-scope batch prepared for another organization",
      { batchOrganizationId: batch.organizationId, organizationId }
    );
  }
  const targets = await findEligibleTargets(organizationId);
  if (targets.length > 0) {
    await cleanupExpiredDirtyScopeNudges(now);
  }
  return targets;
}

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

/**
 * Write this publish's pending nudge for every eligible target with one
 * transaction per chunk instead of one per target (ISS-7276).
 *
 * Returns the ids of targets the write proved are deleted, having already
 * dropped them from `batch` so the rest of the fan-out stops offering them.
 * The prune happens the moment the deletion is proven rather than on the way
 * out, because the survivor retry below can throw: on the way out, a throw
 * there would leave the dead desktop in the shared snapshot and every remaining
 * repository would repeat the same failing chunk write plus its reload — the
 * per-repository multiplication ISS-7276 exists to remove.
 */
async function upsertPendingDirtyScopes({
  input,
  targets,
  now,
  batch,
}: {
  input: PublishGitHubDirtyScopeInput;
  targets: readonly DirtyScopeTarget[];
  now: Date;
  batch: GitHubDirtyScopeBatch | undefined;
}): Promise<string[]> {
  const plan: DirtyScopeWritePlan = {
    rowKey: {
      organizationId: input.organizationId,
      githubInstallationRepositoryId: input.repositoryId,
      windowStartedAt: floorToWindow(
        now,
        GITHUB_DIRTY_SCOPE_DESKTOP_RATE_LIMIT_MS
      ),
    },
    dirtyScopes: normalizeDirtyScopes(input.scopes),
    scheduledDispatchAt: new Date(
      now.getTime() + GITHUB_DIRTY_SCOPE_DEBOUNCE_MS
    ),
    expiresAt: new Date(now.getTime() + GITHUB_DIRTY_SCOPE_PENDING_TTL_MS),
  };

  const missingTargetIds: string[] = [];
  for (const chunk of chunkTargets(targets)) {
    try {
      await writeDirtyScopeChunk(chunk, plan);
    } catch (error) {
      if (!isForeignKeyViolation(error)) {
        throw error;
      }
      const liveIds = await findLiveTargetIds(chunk.map((target) => target.id));
      const missing = chunk
        .filter((target) => !liveIds.has(target.id))
        .map((target) => target.id);
      if (missing.length === 0) {
        // Some other reference went away — the org or the repository row. The
        // retry would replay the same transaction and fail the same way, so
        // leave it to the publisher's best-effort catch.
        throw error;
      }
      missingTargetIds.push(...missing);
      dropDeletedBatchTargets(batch, input.organizationId, missing);
      log.warn(
        "[githubDirtyScopeService] Retrying dirty-scope write without deleted desktops",
        {
          organizationId: input.organizationId,
          repositoryId: input.repositoryId,
          missingTargetIds: missing,
        }
      );
      const survivors = chunk.filter((target) => liveIds.has(target.id));
      if (survivors.length > 0) {
        await writeDirtyScopeChunk(survivors, plan);
      }
    }
  }
  return missingTargetIds;
}

/**
 * One chunk's read-merge-write, in a single transaction.
 *
 * The advisory locks stay keyed per (org, repo, target, window) — the key the
 * pre-ISS-7276 writer took — so a still-deploying instance and this one still
 * exclude each other. A single window-wide key would be one acquisition instead
 * of `chunk.length`, but across a rollout it would not overlap the old key: both
 * writers would read the same row as absent, and the loser's scopes would either
 * be dropped by `skipDuplicates` or overwritten by the old update. Acquiring in
 * sorted order gives every writer the same total order, so overlapping chunks
 * cannot deadlock.
 */
async function writeDirtyScopeChunk(
  chunk: readonly DirtyScopeTarget[],
  { rowKey, dirtyScopes, scheduledDispatchAt, expiresAt }: DirtyScopeWritePlan
): Promise<void> {
  const lockKeys = chunk
    .map((target) => dirtyScopeWindowLockKey(rowKey, target.id))
    .sort();
  await withDb.tx(async (tx) => {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(lock_key, 0::bigint))
      FROM unnest(${lockKeys}::text[]) AS lock_key
    `);
    const existingRows = await tx.gitHubDirtyScopeNudge.findMany({
      where: {
        ...rowKey,
        computeTargetId: { in: chunk.map((target) => target.id) },
      },
      select: {
        computeTargetId: true,
        dirtyScopes: true,
        genericRefresh: true,
        dispatchedAt: true,
      },
    });
    const { creates, updates } = planDirtyScopeChunkWrites({
      chunk,
      existingRows,
      dirtyScopes,
      rowKey,
      scheduledDispatchAt,
      expiresAt,
    });
    if (creates.length > 0) {
      await tx.gitHubDirtyScopeNudge.createMany({
        data: creates,
        skipDuplicates: true,
      });
    }
    for (const group of updates) {
      await tx.gitHubDirtyScopeNudge.updateMany({
        where: {
          ...rowKey,
          computeTargetId: { in: group.computeTargetIds },
        },
        data: {
          dirtyScopes: toPrismaJson(group.dirtyScopes),
          genericRefresh: group.genericRefresh,
          expiresAt,
        },
      });
    }
  });
}

/**
 * P2003 is Prisma's foreign-key violation, and it aborts the whole transaction
 * — the still-live targets in the chunk lose their nudges too. `computeTargetId`
 * is the reference a publish can stale out on its own, because the batch
 * snapshot outlives the desktops in it; the reload below is what tells the two
 * apart, since a chunk whose targets all still exist just fails again and
 * reaches the publisher's best-effort catch.
 */
function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "P2003";
}

async function findLiveTargetIds(
  targetIds: readonly string[]
): Promise<Set<string>> {
  const rows = await withDb((db) =>
    db.computeTarget.findMany({
      where: { id: { in: [...targetIds] } },
      select: { id: true },
    })
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * Drop targets a write proved are gone from the shared snapshot, so the rest of
 * a fan-out does not re-attempt — and re-fail — the same rows. Publishes run
 * concurrently, so two prunes racing can leave one dead id behind; the next
 * publish that trips it removes it.
 */
function dropDeletedBatchTargets(
  batch: GitHubDirtyScopeBatch | undefined,
  organizationId: string,
  missingTargetIds: readonly string[]
): void {
  if (
    !batch ||
    batch.organizationId !== organizationId ||
    missingTargetIds.length === 0
  ) {
    return;
  }
  const missing = new Set(missingTargetIds);
  batch.targets = batch.targets.filter((target) => !missing.has(target.id));
}

/**
 * Split a chunk's targets into the rows to insert and the rows to update,
 * grouping updates that land on the same merged payload so the common case —
 * every target of a repo sharing one pending scope set — costs one statement.
 */
function planDirtyScopeChunkWrites({
  chunk,
  existingRows,
  dirtyScopes,
  rowKey,
  scheduledDispatchAt,
  expiresAt,
}: {
  chunk: readonly DirtyScopeTarget[];
  existingRows: readonly ExistingDirtyScopeRow[];
  dirtyScopes: GitHubDirtyScope[];
  rowKey: DirtyScopeRowKey;
  scheduledDispatchAt: Date;
  expiresAt: Date;
}): DirtyScopeChunkWrites {
  const existingByTarget = new Map(
    existingRows.map((row) => [row.computeTargetId, row])
  );
  const creates: Prisma.GitHubDirtyScopeNudgeCreateManyInput[] = [];
  const updates = new Map<string, DirtyScopeUpdateGroup>();

  for (const target of chunk) {
    const existing = existingByTarget.get(target.id);
    if (existing?.dispatchedAt) {
      continue;
    }
    const mergedScopes = mergeDirtyScopes(existing?.dirtyScopes, dirtyScopes);
    const genericRefresh =
      existing?.genericRefresh === true || isGenericScopeSet(mergedScopes);
    if (!existing) {
      creates.push({
        ...rowKey,
        computeTargetId: target.id,
        dirtyScopes: toPrismaJson(mergedScopes),
        genericRefresh,
        scheduledDispatchAt,
        expiresAt,
      });
      continue;
    }
    const groupKey = JSON.stringify([mergedScopes, genericRefresh]);
    const group = updates.get(groupKey);
    if (group) {
      group.computeTargetIds.push(target.id);
      continue;
    }
    updates.set(groupKey, {
      dirtyScopes: mergedScopes,
      genericRefresh,
      computeTargetIds: [target.id],
    });
  }

  return { creates, updates: [...updates.values()] };
}

function chunkTargets(
  targets: readonly DirtyScopeTarget[]
): DirtyScopeTarget[][] {
  const chunks: DirtyScopeTarget[][] = [];
  for (
    let index = 0;
    index < targets.length;
    index += GITHUB_DIRTY_SCOPE_UPSERT_CHUNK_SIZE
  ) {
    chunks.push(
      targets.slice(index, index + GITHUB_DIRTY_SCOPE_UPSERT_CHUNK_SIZE)
    );
  }
  return chunks;
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
  // Anchored on `now`, NOT on this drain's own start: the claim stamps
  // `dispatchClaimedAt: now`, and the staleness clause makes a row stealable
  // once some drain runs with a `now` past
  // `dispatchClaimedAt + GITHUB_DIRTY_SCOPE_DISPATCH_CLAIM_TTL_MS` — a wall
  // clock instant, since no caller's stamp can lead its own clock. `now` is the
  // CALLER's though: `publish` takes it before resolving targets and before
  // every chunk write, each of which blocks on the per-window advisory lock, so
  // the lease can already be part spent when the drain starts. Anchoring on the
  // drain's start would hand that skew back as extra runway and deliver past
  // the lease; anchoring here degrades the safe way, releasing early
  // (@marisolashgrove, #6529). Every page claims against the same `now`, so one
  // deadline covers the whole drain.
  const leaseDeadline =
    now.getTime() +
    GITHUB_DIRTY_SCOPE_DISPATCH_CLAIM_TTL_MS -
    GITHUB_DIRTY_SCOPE_DISPATCH_LEASE_MARGIN_MS;
  for (let page = 0; page < GITHUB_DIRTY_SCOPE_DRAIN_MAX_PAGES; page += 1) {
    const rows = await findDueDirtyScopeRows({
      computeTargetId,
      organizationId,
      repositoryId,
      now,
    });
    if (rows.length === 0) {
      return dispatched;
    }
    const result = await drainDirtyScopePage(rows, now, leaseDeadline, {
      computeTargetId,
      organizationId,
      repositoryId,
    });
    dispatched += result.dispatched;
    if (
      result.leaseExpired ||
      rows.length < GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE ||
      result.progress === 0
    ) {
      // `leaseExpired` ends the whole drain, not just the page: every page
      // claims against the SAME `now`, so a later page would inherit a lease
      // that is already spent and release itself on its first row.
      return dispatched;
    }
  }
  // All the loop establishes is that the LAST page was full and made progress.
  // `findDueDirtyScopeRows` carries no continuation signal, so a due set that is
  // an exact multiple of the ceiling is indistinguishable from one with a
  // backlog behind it — hence "may still be due" rather than a claim that a
  // remainder exists. Logged because the return value cannot say even this much:
  // both callers discard it, so a persistently backlogged scope would otherwise
  // under-drain on every heartbeat with no signal at all.
  log.warn(
    "[githubDirtyScopeService] Dirty-scope drain stopped at its page ceiling; a remainder may still be due",
    {
      computeTargetId,
      maxPages: GITHUB_DIRTY_SCOPE_DRAIN_MAX_PAGES,
      organizationId,
      repositoryId,
    }
  );
  return dispatched;
}

/**
 * One page: a set-based claim, the per-target deliveries, then the settles
 * grouped by identical outcome (ISS-8973).
 *
 * Settling is deferred to the end of the page so rows that settled the same way
 * share one statement, which is why a page whose rows were all ineligible costs
 * two writes instead of two hundred. It does NOT make the happy path cheaper:
 * a delivered row's outcome carries its own `commandId`, so a fully-delivered
 * page still writes one statement per row — the same count as before, moved to
 * the end of the page. The saving is on the ineligible and released shapes,
 * which are the ones that repeat every drain until a TTL.
 *
 * The deliveries stay INSIDE the claim: `leaseDeadline` is the drain's whole
 * lease window, so once it is within
 * `GITHUB_DIRTY_SCOPE_DISPATCH_LEASE_MARGIN_MS` of expiring the page stops and
 * releases the rows it has not reached, and never delivers alongside the drain
 * that reclaimed them (@whitlockk, #6529). Checked before each row AND, inside
 * `dispatchDirtyScopeRow`, between the command write and the relay hop, since
 * the write itself can spend what the margin held back. What remains is a page
 * dying
 * between delivery and flush: those rows stay claimed rather than settled,
 * return to the due set after `GITHUB_DIRTY_SCOPE_DISPATCH_CLAIM_TTL_MS`, and
 * re-dispatch. That re-dispatch creates no duplicate COMMAND —
 * `dispatchDirtyScopeRow`'s idempotency key dedupes at the store — but the
 * relay hop after it fires again regardless, so the desktop can receive a
 * second push for the same command id. That is a repeated pull hint, not a
 * duplicated action.
 */
async function drainDirtyScopePage(
  rows: readonly DueDirtyScopeRowId[],
  now: Date,
  leaseDeadline: number,
  scope: DirtyScopeDrainScope
): Promise<{ dispatched: number; leaseExpired: boolean; progress: number }> {
  const claimed = await claimDirtyScopeRows(rows, now);
  const settles = new Map<string, DirtyScopeSettleGroup>();
  let dispatched = 0;
  let leaseExpired = false;
  let progress = 0;
  for (const [index, row] of claimed.entries()) {
    if (Date.now() >= leaseDeadline) {
      leaseExpired = true;
      releaseUnreachedDirtyScopeRows(
        settles,
        claimed.slice(index),
        scope,
        dispatched
      );
      break;
    }
    const ineligible = dirtyScopeIneligibilityReason(row);
    if (ineligible) {
      // Settled rather than skipped: the row is claimed, and leaving it
      // unsettled would re-read and re-claim it on every pass until its TTL.
      recordDirtyScopeSettle(
        settles,
        row.id,
        true,
        { delivered: false, reason: ineligible },
        0
      );
      log.warn(
        "[githubDirtyScopeService] Dropping dirty-scope nudge for an ineligible desktop",
        {
          computeTargetId: row.computeTargetId,
          organizationId: row.organizationId,
          repositoryId: row.githubInstallationRepositoryId,
          reason: ineligible,
        }
      );
      // Progress, but not a delivery: the row has left the due set, so a page
      // made only of these must not read as a stalled drain.
      progress += 1;
      continue;
    }
    try {
      const result = await dispatchDirtyScopeRow(row, leaseDeadline);
      if (result === null) {
        // The command write spent the rest of the lease, so this row's relay
        // hop never fired — release it and the ones behind it on exactly the
        // terms the top-of-loop check uses.
        leaseExpired = true;
        releaseUnreachedDirtyScopeRows(
          settles,
          claimed.slice(index),
          scope,
          dispatched
        );
        break;
      }
      recordDirtyScopeSettle(settles, row.id, true, result, 0);
      dispatched += 1;
      progress += 1;
    } catch (error) {
      // Released, not settled: the row stays due so a later drain retries it —
      // but `GITHUB_DIRTY_SCOPE_RETRY_BACKOFF_MS` later, not immediately. This
      // row was attempted and failed; leaving it due now is what lets a block
      // of them re-fill the page ahead of the peers they tie with on
      // `createdAt` (ISS-10050).
      recordDirtyScopeSettle(
        settles,
        row.id,
        false,
        {
          delivered: false,
          reason: error instanceof Error ? error.message : String(error),
        },
        GITHUB_DIRTY_SCOPE_RETRY_BACKOFF_MS
      );
    }
  }
  await flushDirtyScopeSettles([...settles.values()], now, scope);
  return { dispatched, leaseExpired, progress };
}

/**
 * Oldest first by `createdAt` alone. Order among rows that tie on it is
 * unspecified, and no consumer reads it: each tied row is a different
 * desktop's command (ISS-9006).
 *
 * Ties are routine: `writeDirtyScopeChunk` inserts a chunk with one
 * `createMany`, so every row in it shares a `createdAt`, and a tie block is
 * one org's, one repository's, one window's targets.
 *
 * The production callers all scope this read to one organization — `publish`
 * and its debounced re-drain through `scheduleDueDirtyScopeDispatch`, both by
 * org and repository, and `scheduleGitHubDirtyScopeRecoveryDrain` off the relay
 * heartbeat and hello, by org and desktop — so no page weighs one org against
 * another. That is what those callers pass, not something this signature
 * enforces: `dispatchDue` is exported with every filter optional, and an
 * unscoped caller would reopen the question.
 *
 * A tied row that SETTLES cannot starve its peers. Settling stamps
 * `dispatchedAt` — a relay hop reporting `delivered: false` included — which
 * takes the row out of this `where`, and newer rows sort behind it, so the
 * tied rows a page missed head the next page or the next drain.
 *
 * A tied row that does NOT settle is RELEASED instead: `settled: false` clears
 * the claim without stamping `dispatchedAt` and leaves `createdAt` untouched,
 * so the row re-enters the same tie block. Once the released rows and their
 * tied peers together exceed `GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE`, nothing in
 * THIS read promises a peer is picked before `expiresAt` retires it. The
 * ordering is not where that is fixed, and a tiebreaker would make it worse — a
 * deterministic order over the same block re-picks the same rows every drain.
 * What fixes it is the retry deprioritization on the settle
 * (`GITHUB_DIRTY_SCOPE_RETRY_BACKOFF_MS`, ISS-10050): a release that FOLLOWS AN
 * ATTEMPT moves `scheduledDispatchAt` out, so the block leaves this `where` and
 * its peers get a page.
 *
 * The other two ways a row comes back cannot hold a page open the same way. A
 * spent lease RELEASES the page's tail, but the rows ahead of it settled and
 * left, so the tail moves up on the next drain. A settle whose write is lost
 * does not release at all: those rows stay CLAIMED, so this `where` excludes
 * them until `GITHUB_DIRTY_SCOPE_DISPATCH_CLAIM_TTL_MS` makes them stealable.
 * Neither carries a backoff, and neither needs one.
 */
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
}): Promise<DueDirtyScopeRowId[]> {
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
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE,
    })
  );
}

/**
 * Claim a whole page in one statement, and return the rows this drain owns
 * (ISS-8973).
 *
 * Under READ COMMITTED Postgres re-evaluates the predicate per row after a
 * concurrent writer commits, so a drain racing this one is excluded here on
 * exactly the terms the per-row claim used: the returned ids are the rows THIS
 * statement updated, and a row another drain already claimed matches neither
 * `dispatchClaimedAt: null` nor the staleness clause.
 *
 * The rows come back from the CLAIM rather than from the due read, so the
 * `computeTarget` join `dirtyScopeIneligibilityReason` rechecks is the target
 * state as of the claim. Returning the due read's snapshot instead let a
 * desktop moved between the two reads be handed its former org's repository id
 * — the one leak in this path that is not merely a wasted pull hint (@whitlockk,
 * #6529). Order still comes from the due read, which is the only one of the two
 * statements that can express `orderBy`.
 */
async function claimDirtyScopeRows(
  rows: readonly DueDirtyScopeRowId[],
  now: Date
): Promise<PendingDirtyScopeRow[]> {
  const claimed = await withDb((db) =>
    db.gitHubDirtyScopeNudge.updateManyAndReturn({
      where: {
        id: { in: rows.map((row) => row.id) },
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
      include: {
        computeTarget: {
          select: {
            organizationId: true,
            supportedOperations: true,
          },
        },
      },
    })
  );
  const claimedById = new Map(claimed.map((row) => [row.id, row]));
  return rows.flatMap((row) => claimedById.get(row.id) ?? []);
}

/**
 * Add one row's outcome to the group that already shares it (ISS-8973).
 *
 * Keyed on the whole outcome because it is written verbatim to
 * `deliveryResult`: a delivered row carries its own `commandId`, so delivered
 * rows collapse only when they genuinely settled the same way, exactly as
 * `groupChunkWrites` collapses identical scope sets.
 *
 * Only the ineligible and lease-expired reasons are a closed set, so those
 * pages collapse to one statement per distinct reason. A released row's reason
 * is the caught error's message, which collapses only when the page failed the
 * same way — a relay abort gives every row one string, while an error carrying
 * statement text gives each row its own and costs one settle per row
 * (@marisolashgrove, #6529). That is the pre-batch per-row cost, not a regression,
 * and it is paid only on the failure path.
 */
function recordDirtyScopeSettle(
  groups: Map<string, DirtyScopeSettleGroup>,
  id: string,
  settled: boolean,
  result: DirtyScopeDispatchResult,
  retryBackoffMs: number
): void {
  const key = JSON.stringify([settled, retryBackoffMs, result]);
  const group = groups.get(key);
  if (group) {
    group.ids.push(id);
    return;
  }
  groups.set(key, { ids: [id], settled, retryBackoffMs, result });
}

/**
 * Write each outcome group, isolated from its siblings (ISS-8973).
 *
 * `dispatchClaimedAt: now` in the predicate is load-bearing, not belt-and-braces:
 * batching stretched the claim-to-settle window from one row's dispatch to a
 * whole page's. `drainDirtyScopePage` now stops short of
 * `GITHUB_DIRTY_SCOPE_DISPATCH_CLAIM_TTL_MS` rather than delivering through it,
 * but that bounds the page's OWN scheduling, not a stalled event loop or a hop
 * that overruns its own abort — so a claim can still go stale under this write.
 * Another drain then legitimately re-claims those rows, and an id-only write
 * would stamp over ITS claim — freeing a row it is still delivering, or
 * resurrecting one it settled. Writing only rows still holding THIS drain's
 * claim makes a lost claim a no-op.
 *
 * Each group is caught on its own for the same reason the per-row settle it
 * replaced was: one transient write failure must not strand the groups behind
 * it as `claimed`, which is indistinguishable from in-flight until the claim
 * TTL. The failed group's rows stay claimed and return to the due set then.
 *
 * A group carrying a `retryBackoffMs` also moves `scheduledDispatchAt`, which
 * is what takes a released row out of the due set for that long instead of
 * handing it straight back at its original `createdAt` (ISS-10050). It is
 * written on the release groups that ask for it and on no other: a settled row
 * has left the due set already, and the rows a spent lease releases are not
 * holding a page against anyone.
 *
 * Off `Date.now()`, NOT the drain's `now` — the one place in this file where
 * that is the right anchor. `now` is the CALLER's stamp, frozen for the whole
 * drain: `publish` takes it before the advisory-lock-blocked chunk writes, and
 * a page may then legitimately run until `leaseDeadline`, up to
 * `GITHUB_DIRTY_SCOPE_DISPATCH_CLAIM_TTL_MS` minus the margin. So `now` can lag
 * real time by more than the whole backoff, and `now + backoff` lands in the
 * PAST — the row is due again immediately and the starvation returns with no
 * signal, because the write itself succeeded. The claim and the lease anchor on
 * `now` deliberately (ISS-8973): a stale stamp makes those release EARLY, which
 * is the safe direction. This deadline degrades the other way, so it takes the
 * real clock. `Date.now()` can never precede `now`, so it is also never the
 * shorter deferral of the two.
 */
async function flushDirtyScopeSettles(
  groups: readonly DirtyScopeSettleGroup[],
  now: Date,
  scope: DirtyScopeDrainScope
): Promise<void> {
  for (const group of groups) {
    try {
      const settled = await withDb((db) =>
        db.gitHubDirtyScopeNudge.updateMany({
          where: { id: { in: group.ids }, dispatchClaimedAt: now },
          data: {
            dispatchClaimedAt: null,
            ...(group.settled ? { dispatchedAt: now } : {}),
            ...(group.retryBackoffMs > 0
              ? {
                  scheduledDispatchAt: new Date(
                    Date.now() + group.retryBackoffMs
                  ),
                }
              : {}),
            deliveryResult: toPrismaJson(group.result),
          },
        })
      );
      if (settled.count !== group.ids.length) {
        // Reports the DISAGREEMENT, not a cause: the write is silent about why
        // a row fell out of the predicate, and two things do it. Another drain
        // re-claimed the row after this one's claim went stale — the case worth
        // paging on — or `cleanupExpiredDirtyScopeNudges` (or a cascade) deleted
        // it, which is benign housekeeping any concurrent publish fires. Naming
        // one as fact would send triage after a concurrency bug that may not
        // have happened. Logged at all because this is the only place either is
        // observable: the ownership predicate skips such a row silently.
        log.warn(
          "[githubDirtyScopeService] Dirty-scope settle wrote fewer rows than it claimed",
          {
            ...scope,
            groupRows: group.ids.length,
            nudgeIds: group.ids,
            settledRows: settled.count,
          }
        );
      }
    } catch (error) {
      log.warn(
        "[githubDirtyScopeService] Failed to settle a dirty-scope nudge group",
        {
          ...scope,
          error,
          nudgeIds: group.ids,
          reason: group.result.reason,
          settled: group.settled,
        }
      );
    }
  }
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

/**
 * Why a claimed pending row must NOT be delivered, or null to deliver it.
 *
 * Eligibility is decided when the targets are read — `findEligibleTargets`, or
 * once per fan-out via `prepareBatch` — and a pending row then sits for up to
 * `GITHUB_DIRTY_SCOPE_DEBOUNCE_MS` before it is dispatched. Across an
 * "all repositories" installation webhook that snapshot is minutes old by the
 * last repository (@davetho, #6441), so the two facts that decide whether
 * this desktop may receive THIS org's command are rechecked here, against the
 * `computeTarget` join `claimDirtyScopeRows` takes on the claim itself:
 *
 * - REASSIGNMENT. `organizationId` is what scopes the nudge. A desktop moved to
 *   another org between preparation and dispatch would otherwise be handed the
 *   former org's repository id — the one leak in this path that is not merely a
 *   wasted pull hint.
 * - REVOCATION. `supportedOperations` is rewritten on every desktop
 *   re-registration (`internal/relay/socket-event/service/hello-handler.ts`), so
 *   a desktop that reconnects without the nudge operation must stop receiving
 *   it.
 *
 * `isOnline` is deliberately NOT rechecked: a desktop going offline mid-window
 * is the accepted staleness `prepareBatch` documents, and the relay already
 * settles that row as `no_subscriber` on its own.
 */
function dirtyScopeIneligibilityReason(
  row: PendingDirtyScopeRow
): string | null {
  if (row.computeTarget.organizationId !== row.organizationId) {
    return "target_reassigned";
  }
  if (
    !toStringArray(row.computeTarget.supportedOperations).includes(
      GITHUB_RESYNC_NUDGE_OPERATION_ID
    )
  ) {
    return "operation_unsupported";
  }
  return null;
}

/**
 * Write the row's command, then relay it — `null` if the lease went before the
 * hop (ISS-8973).
 *
 * `drainDirtyScopePage` checks the lease BEFORE this call, but
 * `createCommand` sits between that check and the relay hop and is not bounded
 * by anything the margin can account for: the margin budgets the hop's own 5s
 * abort plus the settle writes, so a command write that outlasts the rest of
 * the lease puts the hop past it, alongside whichever drain has since
 * legitimately reclaimed the row — and BOTH push the same command id, because
 * the idempotency key dedupes the command, not the hop after it (@davetho,
 * #6529). Rechecking here rather than widening the margin, since no margin
 * bounds an unbounded await.
 *
 * The written command is left in place: it is idempotency-keyed, so the next
 * drain's `createCommand` returns this same command and does the hop.
 */
async function dispatchDirtyScopeRow(
  row: PendingDirtyScopeRow,
  leaseDeadline: number
): Promise<DirtyScopeDispatchResult | null> {
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
  if (Date.now() >= leaseDeadline) {
    return null;
  }
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
      diagnosticReason: relayResult.diagnosticReason,
      peerStatusCode: relayResult.peerStatusCode,
      peerErrorCode: relayResult.peerErrorCode,
    });
  }
  return {
    delivered: relayResult.delivered,
    ...(relayResult.reason ? { reason: relayResult.reason } : {}),
    ...(relayResult.diagnosticReason
      ? { diagnosticReason: relayResult.diagnosticReason }
      : {}),
    ...(relayResult.peerStatusCode === undefined
      ? {}
      : { peerStatusCode: relayResult.peerStatusCode }),
    ...(relayResult.peerErrorCode
      ? { peerErrorCode: relayResult.peerErrorCode }
      : {}),
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
    // ISS-12032 (operator-approved 2026-10-05): no gatewayId. The stored one
    // can be stale, and installed Desktop builds reject a nudge whose gatewayId
    // disagrees with theirs; they still require this computeTargetId to match.
    computeTargetId: row.computeTargetId,
  });
}

function dirtyScopeWindowLockKey(
  rowKey: DirtyScopeRowKey,
  computeTargetId: string
): string {
  return [
    "github-dirty-scope",
    rowKey.organizationId,
    rowKey.githubInstallationRepositoryId,
    computeTargetId,
    rowKey.windowStartedAt.toISOString(),
  ].join(":");
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

/**
 * Release the tail of a page whose claim lease is spent, and say so once
 * (ISS-8973).
 *
 * Released, not left claimed: these rows were never delivered, so the next
 * drain should get them now rather than after the claim TTL. Shared by the
 * two points the lease can run out — before a row is reached, and between its
 * command write and its relay hop — so the two cannot drift on what a released
 * row settles as.
 *
 * No retry backoff, unlike the released rows in `drainDirtyScopePage`'s catch
 * (ISS-10050). Not because none of them was attempted — the FIRST row of
 * `unreached` is, on the second call site, the row `dispatchDirtyScopeRow`
 * returned `null` for, whose `createCommand` succeeded and whose relay hop
 * alone was skipped. It is that they cannot hold a page against a tied peer:
 * the page-mates ahead of them settled and left, so the tail moves up on the
 * next drain, and the one attempted row is a single row rather than a block.
 * Backing them off would slow a healthy drain that merely ran out of runway.
 */
function releaseUnreachedDirtyScopeRows(
  settles: Map<string, DirtyScopeSettleGroup>,
  unreached: readonly PendingDirtyScopeRow[],
  scope: DirtyScopeDrainScope,
  deliveredRows: number
): void {
  for (const row of unreached) {
    recordDirtyScopeSettle(
      settles,
      row.id,
      false,
      { delivered: false, reason: "lease_expired" },
      0
    );
  }
  log.warn(
    "[githubDirtyScopeService] Dirty-scope page stopped short of its claim lease",
    { ...scope, deliveredRows, releasedRows: unreached.length }
  );
}
