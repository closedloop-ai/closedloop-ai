/**
 * ISS-8619 (PRD-699 §7.6): the ingest slice's DETAIL-UPSERT phase — the one
 * statement that decides this session's identity row, plus the two corrections
 * that can only be made once the database has told us which arm it took.
 *
 * The phase boundary is the `sessionDetail.upsert`, not the file: everything
 * here either feeds that statement's two arms or repairs them. It ends with the
 * `artifactId` every later phase writes against, so nothing downstream needs the
 * column-shaping vocabulary this module owns.
 *
 * `repairCreateArmRace`, {@link seedNameOverrideIfUnset} and (ISS-10332)
 * {@link seedPriorityIfUnset} are inside the phase rather than after it because
 * they are corrections to the upsert itself and must not be reordered against
 * the lanes that follow: the first hands the PR lane its arm-corrected freshness
 * decision, and the name seed must run before `maybeReopenTerminalSession`
 * touches the row.
 */

import type {
  SyncedAgentSession,
  SyncedAgentSessionTokenUsage,
} from "@repo/api/src/types/agent-session";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { SessionMetadataActivityField } from "@repo/api/src/types/artifact-activity";
import type { Priority } from "@repo/api/src/types/common";
import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { TERMINAL_SESSION_STATUSES } from "@repo/api/src/types/session-status";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { Prisma } from "@repo/database";
import { captureSystemSessionMetadataChange } from "@/lib/artifact-activity-recording";
import {
  countProjected,
  projectIndexKey,
  projectNullableIndexKey,
} from "@/lib/index-key-projection";
import { generateSlug } from "@/lib/slug-generator";
import { resolveActivityTilingStripPatch } from "./activity-tiling-strip";
import { normalizeNullableString, roundCost, toDate } from "./coercion";
import { repairCreateArmRace } from "./create-arm-race-repair";
import {
  resolveDegradedMetadataPersist,
  resolveWithheldMetadataKeys,
} from "./degraded-metadata-merge";
import {
  gateTokenRollupColumns,
  resolveGuardedTimestampPatch,
  resolveNameOverridePatch,
  resolvePriorityPatch,
  resolveStorableSessionEnd,
  resolveTokenRollupColumns,
} from "./field-regression-guards";
import { sanitizeMetadataForPersist } from "./metadata-sanitizer";
import {
  toNonNullAttributionPatch,
  toTraceDetailPatch,
} from "./persist-session-children";
import type {
  AgentSessionUpsertTx,
  SessionProjectResolution,
  UpsertSessionsContext,
} from "./records";
import {
  lowerSessionCreatedAt,
  resolveIncomingSessionCreatedAt,
} from "./session-created-at";
import {
  didRefusePayloadSessionEnd,
  resolveSessionEndWrites,
} from "./session-end-write-resolution";
import {
  type SessionMetadataWriteSnapshot,
  writeSessionArtifactMetadata,
} from "./session-ingest-metadata-activity";
import {
  toAuthoritativeCostPatch,
  toDataSyncLevelPatch,
  toIndexBoundAttributionColumns,
} from "./session-slice-detail-columns";
import type { SessionSliceGate } from "./session-slice-gating";
import type { SessionSliceIdentity } from "./session-slice-identity";
import { sumTokenUsage } from "./synced-payload";
import {
  resolveCreateArmDetail,
  resolvePersistableAgents,
} from "./upsert-arm-detail";

/** What the phases after the upsert need, and nothing more. */
export type PersistedSessionDetail = {
  metadataSnapshot: SessionMetadataWriteSnapshot | null;
  artifactId: string;
  /** ISS-8552 / ISS-8681: THIS delivery carried an end the apply refused to persist. */
  droppedContradictorySessionEnd: boolean;
  /** ISS-12251: THIS delivery carried a `createdAt` the apply refused to persist. */
  droppedImplausibleCreatedAt: boolean;
  /** The end as this write resolved it, for the reopen predicate downstream. */
  guardedSessionEndedAt: Date | null;
  /** ISS-8069: index-key columns this slice had to bind before it could write them. */
  indexKeyProjections: number;
  /** ISS-8604: the PR-link freshness decision, reconciled with the arm the database took. */
  shouldUpdatePullRequestLinks: boolean;
  /** ISS-8881: trace-detail counters this payload could not store. */
  unstorableCounterFields: string[];
};

export async function writeSessionDetail(
  tx: AgentSessionUpsertTx,
  input: Readonly<{
    context: UpsertSessionsContext;
    dataSyncLevel: DataSyncLevel | undefined;
    gate: SessionSliceGate;
    identity: SessionSliceIdentity;
    includeFrustration: boolean;
    normalizedTokenUsage: readonly SyncedAgentSessionTokenUsage[];
    projectId: string | null;
    projectResolution: SessionProjectResolution;
    session: SyncedAgentSession;
    syncTimestamp: Date;
  }>
): Promise<PersistedSessionDetail> {
  const {
    context,
    gate,
    normalizedTokenUsage,
    projectId,
    session,
    syncTimestamp,
  } = input;
  const { existing, externalSessionIdKey } = input.identity;
  const shouldUpdateTokenEventCosts = gate.shouldUpdateTokenEventCosts;
  const tokenTotals = sumTokenUsage(normalizedTokenUsage);
  const incomingCreatedAt = resolveIncomingSessionCreatedAt(
    session.createdAt,
    syncTimestamp
  );
  // ISS-8515: derived from the RAW wire rows, and it has to be. The wire field is
  // `.optional()` (not nullable) and the desktop omits the key outright, but
  // `normalizeTokenUsage` folds `?? 0` and `sumTokenUsage` folds it again — so
  // after either, "never priced" and "priced at exactly $0" are the same value.
  // `!== undefined` is the same predicate `token-event-persistence.ts` uses; a
  // `> 0` reading here would persist null for a genuinely free session.
  const anyRowPriced = session.tokenUsageByModel.some(
    (row) => row.estimatedCostUsd !== undefined
  );
  const attributionColumns = toIndexBoundAttributionColumns(session);
  const sessionName =
    normalizeNullableString(session.name) ??
    `Session ${session.externalSessionId}`;

  const sanitizedAgents = resolvePersistableAgents(
    session,
    gate.shouldReplace,
    existing?.agents
  );

  // ISS-8069: `harness` and `model` each ride a btree index
  // (`@@index([harness, sessionStartedAt])`,
  // `@@index([model, sessionStartedAt])`), so they are bounded at the column for
  // the same reason `externalSessionId` is. `cwd` is NOT indexed and stays whole.
  const harnessKey = projectIndexKey(
    normalizeNullableString(session.harness) ?? "unknown"
  );
  const modelKey = projectNullableIndexKey(
    normalizeNullableString(session.model)
  );

  // ISS-8515 BOUND on the invariant below: `metadata` is written UNGATED on both
  // arms (`resolveDegradedMetadataPersist` deliberately carries no freshness
  // gate), while the cost derived FROM it is now freshness-gated. So on a STALE
  // batch the stored blob can advance — a different `web_search_requests` count —
  // while the stored dollar figure deliberately does not follow it. The
  // reproducibility below therefore holds for the batch that last WROTE the cost,
  // not for every later metadata write. Gating the metadata too would restore the
  // stronger property and is a larger change than this ticket.
  //
  // ISS-7821 (review: davetho): compacted ONCE, then both persisted and
  // priced. `estimatedCost` is a derived figure whose only stored source is this
  // blob, so reading a different value than the one written makes the dollar
  // figure unreproducible from the row it belongs to — and
  // `compactMetadataForPreview` genuinely can drop the count (own-keys past
  // `MAX_METADATA_KEYS`, or a branch below `MAX_METADATA_DEPTH`), which would
  // have written a non-zero cost beside metadata containing no count at all.
  const incomingMetadata = sanitizeMetadataForPersist(session.metadata);
  // ISS-8641 / ISS-8714: a payload that NAMES the keys ISS-7997's degrade
  // withheld gets those keys reinstated from the stored row instead of deleting
  // them; every other payload — including every already-installed desktop build,
  // which cannot declare — keeps the wholesale replace. Why the list rather than
  // a flag, and why no freshness gate, live on the resolver.
  const persistedMetadata = await resolveDegradedMetadataPersist(tx, {
    // The same tenant-scoped unique the `sessionDetail.upsert` below writes
    // under, so the blob the merge preserves is the blob in the row about to be
    // overwritten. `null` when this session has no stored row — a first delivery
    // has nothing to preserve, so it must not pay the read.
    storedRowKey: existing
      ? {
          computeTargetId: context.computeTargetId,
          externalSessionId: externalSessionIdKey.value,
        }
      : null,
    withheldKeys: resolveWithheldMetadataKeys(session.metadataWithheldKeys),
    incoming: incomingMetadata,
  });

  // ISS-8881: the trace-detail counters this payload could not store. Merged by
  // the caller with the rollup counters `persistSessionChildren` collects, into
  // ONE field the batch emits once per request.
  const unstorableCounterFields: string[] = [];
  const detailData = {
    harness: harnessKey.value,
    cwd: normalizeNullableString(session.cwd),
    model: modelKey.value,
    ...(session.deviceTimeZone === undefined
      ? {}
      : { deviceTimeZone: normalizeNullableString(session.deviceTimeZone) }),
    ...toDataSyncLevelPatch(input.dataSyncLevel),
    ...(gate.shouldCommitRevision
      ? { dataRevision: gate.effectiveDataRevision }
      : {}),
    ...gate.pendingChunkPatch,
    // ISS-7265: the durable half of the tiling-strip signal — see
    // `resolveActivityTilingStripPatch` for why only a DECLARED strip is written
    // here, and why the watermark gates it.
    ...resolveActivityTilingStripPatch(session, shouldUpdateTokenEventCosts),
    // ISS-4654: a terminal status still clears awaitingInputSince. No re-fold —
    // `guardedStatus` is already a lifecycle value (ISS-5981).
    awaitingInputSince: TERMINAL_SESSION_STATUSES.has(gate.guardedStatus)
      ? null
      : gate.incomingAwaitingInputSince,
    agentCount: sanitizedAgents.length,
    ...toAuthoritativeCostPatch(session, {
      costUsd: existing?.authoritativeCostUsd,
      isFreshDelivery: shouldUpdateTokenEventCosts,
    }),
    metadata: persistedMetadata ?? Prisma.DbNull,
    agents: sanitizedAgents,
    lastSyncedAt: syncTimestamp,
    ...toTraceDetailPatch(session, {
      includeFrustration:
        input.includeFrustration && shouldUpdateTokenEventCosts,
      // ISS-4586 / ISS-4688 / ISS-4946: ends_with_error and the trace-duration
      // triple share the watermark; the pullRequests blob takes the stricter PR
      // gate, resolved from the `prs` blob's OWN evidence so it cannot be let
      // through on the link lane's behalf (or vice versa).
      includeEndsWithError: shouldUpdateTokenEventCosts,
      includeTraceDurations: shouldUpdateTokenEventCosts,
      includePullRequests: gate.freshness.shouldUpdatePullRequestsBlob,
      // ISS-9859: a continuation part appends its page to this.
      storedPullRequests: existing?.pullRequests ?? null,
      unstorableCounterFields,
    }),
  };

  // ISS-8604: the columns above whose value comes off the STORED row, resolved a
  // second time with that row forced absent — the create arm's last word. See
  // `upsert-arm-detail.ts` for the race this closes and for the bound on it.
  const createArmDetail = resolveCreateArmDetail({
    incomingRevision: gate.effectiveDataRevision,
    incomingStatus: gate.incomingStatus,
    incomingMetadata,
    persistedAgents: sanitizedAgents,
    rowLevelAck: gate.rowLevelAck,
    session,
    shouldReplace: gate.shouldReplace,
  });

  // ISS-8681: kept beside the gated value because the refusal diagnostics below
  // name a PRODUCER, so they have to see what the producer actually sent.
  const payloadSessionEndedAt = toDate(session.endedAt);
  // ISS-8681: gated HERE, ahead of max-wins and of both arms, so an end no clock
  // could produce never reaches the column every clock-free direct reader of
  // `sessionEndedAt` (Duration span, `endedAt` wire field, completion filters)
  // measures against.
  const storableSessionEndedAt = resolveStorableSessionEnd(
    payloadSessionEndedAt,
    syncTimestamp
  );
  const incomingTimestamps = {
    sessionStartedAt: new Date(session.startedAt),
    sessionUpdatedAt: gate.incomingSessionUpdatedAt,
    sessionEndedAt: storableSessionEndedAt,
  };
  const tokenRollupColumns = resolveTokenRollupColumns({
    hasTokenUsage: normalizedTokenUsage.length > 0,
    totals: tokenTotals,
    roundCost,
    // ISS-7821: the blob this row PERSISTS, so `estimatedCost` is always
    // reproducible from the metadata stored beside it.
    metadata: persistedMetadata,
    // ISS-7821: lets the web-search line item reach a session that has no token
    // rows without clobbering a stored token cost — see `hasStoredTokenCost`.
    existingTokenRollup: existing,
    anyRowPriced,
    // ISS-8515 erase guard: never overwrite a stored NUMERIC cost with a
    // token-derived one this payload cannot actually compute.
    hasStoredEstimatedCost: existing?.estimatedCost != null,
  });
  const resolvedTimestamps = existing
    ? resolveGuardedTimestampPatch(existing, incomingTimestamps, {
        repairImplausibleUpdatedAt: gate.freshness.didRepairPoisonedWatermark,
      })
    : incomingTimestamps;
  const sessionEndWrites = resolveSessionEndWrites({
    resolvedSessionEndedAt: resolvedTimestamps.sessionEndedAt,
    incomingSessionEndedAt: incomingTimestamps.sessionEndedAt,
    guardedStatus: gate.guardedStatus,
    incomingStatus: gate.incomingStatus,
  });
  const guardedTimestamps = {
    ...resolvedTimestamps,
    sessionEndedAt: sessionEndWrites.update,
  };
  const slug = existing
    ? undefined
    : await generateSlug(context.organizationId, SlugPrefix.Session);

  const metadataSnapshot = await writeSessionArtifactMetadata(tx, {
    organizationId: context.organizationId,
    artifactId: existing?.artifactId ?? null,
    status: gate.guardedStatus,
    projectId,
    name: sessionName,
  });

  const persisted = await tx.sessionDetail.upsert({
    where: {
      computeTargetId_externalSessionId: {
        computeTargetId: context.computeTargetId,
        externalSessionId: externalSessionIdKey.value,
      },
    },
    create: {
      artifact: {
        create: {
          organization: { connect: { id: context.organizationId } },
          ...(projectId ? { project: { connect: { id: projectId } } } : {}),
          type: ArtifactType.Session,
          name: sessionName,
          // ISS-5648: the folded INCOMING status, deliberately not
          // `guardedStatus`. Which arm runs is decided by the DATABASE, not by
          // the `existing` read above — under READ COMMITTED a sweep that
          // deletes the row between that read and this upsert lands here with
          // `guardedStatus` carrying the deleted row's terminal status, which
          // would stamp a brand-new artifact with a status no payload claimed.
          // The incoming value is what a create arm has always written.
          //
          // ISS-8604 made the rest of the arm agree with it: the `detailData`
          // fields whose value came off that same deleted row are re-resolved
          // in `createArmDetail` below and spread after the shared object, so a
          // created row can no longer read `active` while carrying the swept
          // row's awaiting anchor or agent roster.
          status: gate.incomingStatus,
          slug,
          createdBy: { connect: { id: context.userId } },
          // ISS-12251 D-1/D-7: the session's Owner starts as its uploader, set
          // here and only here. The update arm never names it, so an API
          // reassignment survives every later sync.
          assignee: { connect: { id: context.userId } },
          // ISS-12251: absent, the column keeps its `now()` default.
          ...(incomingCreatedAt.createdAt
            ? { createdAt: incomingCreatedAt.createdAt }
            : {}),
        },
      },
      computeTarget: { connect: { id: context.computeTargetId } },
      externalSessionId: externalSessionIdKey.value,
      metadataActivityCoverageStartedAt: syncTimestamp,
      toolUseCount: 0,
      errorCount: 0,
      ...detailData,
      // ISS-8604: spread AFTER `detailData` so these columns are resolved from
      // the payload alone. On a genuine create every value here is byte-identical
      // to the one it overrides — `existing` is already null, so each resolver
      // re-runs on the same inputs — and only the concurrent-delete race changes.
      ...createArmDetail,
      ...incomingTimestamps,
      // ISS-8552, spread AFTER `incomingTimestamps` so it is the last word on
      // the column: a create must not be born asserting an end its own status
      // denies, the same invariant the update arm's `guardedTimestamps` carries.
      sessionEndedAt: sessionEndWrites.create,
      // ISS-8515: `estimatedCost` is ALWAYS named on create — a number or null,
      // never omitted. `resolveTokenRollupColumns` returns `{}` for a payload
      // with no token rows and no web search, and until this ticket that omission
      // let the schema `@default(0)` write a confident $0 for a session nothing
      // ever priced. Folded UNDER the patch so a resolved value always wins and
      // the key can never be absent.
      //
      // The patch itself is gated on the SAME freshness flag as the update arm.
      // On a genuine create `existing === null` makes that flag true, so this is
      // a no-op on the normal path. It exists for the READ COMMITTED race below
      // (ISS-5648): the finder can return a row, freshness can resolve STALE, and
      // Postgres can still take THIS arm because the row was concurrently
      // deleted. Ungated, that wrote counts and a cost while
      // `persistSessionChildren` — on the same flag — suppressed the per-model
      // rows, leaving rollupTokenTotal > 0 against zero token events — a
      // half-written state. No counts, no cost, no per-model rows is
      // consistent; half-written is not.
      estimatedCost: null,
      ...gateTokenRollupColumns(
        tokenRollupColumns,
        shouldUpdateTokenEventCosts
      ),
      ...attributionColumns.columns,
      // ISS-6463: seed the activity anchor at the session start. The column is
      // NOT NULL, so the create arm has to name a value — it used to leave the
      // column null and let `persistSessionChildren`'s GREATEST floor it a few
      // statements later in this same transaction, which no reader could observe
      // but the constraint now forbids outright. The value must keep tracking
      // that GREATEST's own `$4` floor, which is this same session start.
      //
      // Spread LAST so no `...extras` above can clobber it. That is the general
      // reserved-key rule, and it binds harder here than usual: losing this key
      // is not a null, it is a constraint violation on every new-session ingest.
      //
      // CREATE ARM ONLY, deliberately. That GREATEST is still the sole advancer:
      // putting this in `incomingTimestamps` would also feed the update arm's
      // `guardedTimestamps`, and a re-sync carrying an older start would then
      // move a live session's anchor BACKWARD — the exact monotonicity
      // `persistSessionChildren` exists to guarantee.
      lastActivityAt: incomingTimestamps.sessionStartedAt,
    },
    update: {
      // ISS-10995 (operator ruling 2026-10-12): deliberately NO `project` here.
      // Filing a session is the create arm's, and filling an unfiled one is
      // `writeSessionArtifactMetadata`'s fill-only COALESCE — which is exactly
      // the writer this branch stands in for, since it only runs when that one
      // found no artifact id. Re-connecting here re-filed an already-filed
      // session over whatever a user had set.
      ...(metadataSnapshot === null
        ? {
            artifact: {
              update: {
                name: sessionName,
                status: gate.guardedStatus,
              },
            },
          }
        : {}),
      ...detailData,
      ...guardedTimestamps,
      // ISS-8515: the token rollup is now freshness-gated, so a stale batch
      // changes NONE of the five columns it carries. Before this, it wrote them
      // gated only on "this payload has token rows", so a late-arriving older
      // batch clobbered a newer authoritative cost that the gated writer in
      // `persistSessionChildren` had already declined to touch.
      ...gateTokenRollupColumns(
        tokenRollupColumns,
        shouldUpdateTokenEventCosts
      ),
      ...toNonNullAttributionPatch(attributionColumns.columns),
    },
    select: {
      artifactId: true,
      // ISS-8552 (whitlockk, PR #6284): the end as COMMITTED, which is the only
      // authority on which arm the database took — see
      // `didDropContradictorySessionEnd`.
      sessionEndedAt: true,
      // ISS-8732: the value as COMMITTED, which is what decides whether the seed
      // below has anything to do — see the note there.
      nameOverride: true,
      // ISS-12251: likewise for `lowerSessionCreatedAt`.
      artifact: { select: { createdAt: true } },
    },
  });

  // ISS-8604: reconcile the lanes below with the arm the DATABASE took — the
  // slug a swept-row create could not mint, and the PR-link freshness decision
  // made against a watermark that no longer exists. See the module.
  const { shouldUpdatePullRequestLinks } = await repairCreateArmRace(tx, {
    organizationId: context.organizationId,
    existingArtifactId: existing?.artifactId ?? null,
    persistedArtifactId: persisted.artifactId,
    freshPullRequestLinks: gate.freshness.shouldUpdatePullRequestLinks,
  });

  await seedNameOverrideIfUnset(tx, {
    organizationId: context.organizationId,
    artifactId: persisted.artifactId,
    incoming: session.nameOverride,
    committed: persisted.nameOverride,
  });
  await seedPriorityIfUnset(
    tx,
    context.organizationId,
    persisted.artifactId,
    session.priority
  );
  await lowerSessionCreatedAt(tx, {
    organizationId: context.organizationId,
    artifactId: persisted.artifactId,
    incoming: incomingCreatedAt.createdAt,
    committed: persisted.artifact.createdAt,
  });

  return {
    metadataSnapshot,
    artifactId: persisted.artifactId,
    // Read here, immediately after the upsert and BEFORE
    // `maybeReopenTerminalSession` in the children phase, which clears the
    // column as its own legitimate job rather than as a refusal this counter
    // should name.
    droppedContradictorySessionEnd: didRefusePayloadSessionEnd({
      payloadSessionEndedAt,
      storableSessionEndedAt,
      committedSessionEndedAt: persisted.sessionEndedAt,
    }),
    droppedImplausibleCreatedAt: incomingCreatedAt.dropped,
    guardedSessionEndedAt: guardedTimestamps.sessionEndedAt,
    indexKeyProjections: countProjected(
      externalSessionIdKey,
      harnessKey,
      modelKey,
      attributionColumns.repositoryFullNameKey
    ),
    shouldUpdatePullRequestLinks,
    unstorableCounterFields,
  };
}

/**
 * CLOUD-AUTHORITATIVE NAMING (ISS-8732, decision: Marisol 2026-09-01). A rename is
 * made through `PATCH /agent-sessions/[id]`, authorized to the session's OWNER
 * or an ORG ADMIN (ISS-8733). The desktop has no rename of its own — it only
 * projects its stored `sessions.name_override` into the sync payload — so sync
 * may SEED this column but must never overwrite a stored value, and an offline
 * rename is intentionally unsupported rather than merged. `resolveNameOverridePatch`
 * owns why the watermark cannot adjudicate this one.
 *
 * A SEPARATE, PREDICATED WRITE rather than a spread into the upsert's two arms
 * (ISS-8732 review: davetho, PR #6618). The pre-upsert `existing` read happens
 * many statements earlier and `sessionRenameService` takes none of this
 * transaction's advisory locks, so a rename can commit inside that window; a
 * patch computed from that stale read would undo the rename it raced. The
 * `nameOverride: null` qualifier is what closes it — under READ COMMITTED
 * Postgres re-evaluates the qualifier against the updated row version after
 * taking the row lock, so a rename landing before OR during this statement
 * wins, and one landing after blocks on this transaction's row lock and then
 * wins by arrival order. `committed` is not a second enforcement of that rule:
 * it is the post-upsert read-back, and it exists only so the common re-sync of
 * an already-renamed session issues no statement at all.
 */
async function seedNameOverrideIfUnset(
  tx: AgentSessionUpsertTx,
  row: Readonly<{
    organizationId: string;
    artifactId: string;
    incoming: string | null | undefined;
    committed: string | null;
  }>
): Promise<void> {
  const seed = resolveNameOverridePatch(row.incoming, row.committed);
  if (seed.nameOverride === undefined) {
    return;
  }
  const written = await tx.sessionDetail.updateMany({
    where: { artifactId: row.artifactId, nameOverride: null },
    data: seed,
  });
  if (written.count === 1) {
    await captureSystemSessionMetadataChange({
      tx,
      organizationId: row.organizationId,
      artifactId: row.artifactId,
      field: SessionMetadataActivityField.Name,
      before: null,
      after: seed.nameOverride,
    });
  }
}

/**
 * ISS-10332 / PLN-2086 Milestone 3: seed the session artifact's priority from a
 * desktop-set one, only while it holds none. The same separate, predicated
 * write as {@link seedNameOverrideIfUnset} and for the same race: a
 * `PATCH /agent-sessions/[id]` priority write committing inside this
 * transaction's window wins through the `priority: null` qualifier. The stored
 * value is checked ONLY there — no read-back — so a re-sync of a session
 * that already holds one costs one no-op statement, and only when the payload
 * carries a priority at all.
 */
async function seedPriorityIfUnset(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  artifactId: string,
  incoming: Priority | null | undefined
): Promise<void> {
  const seed = resolvePriorityPatch(incoming);
  if (seed.priority === undefined) {
    return;
  }
  const written = await tx.artifact.updateMany({
    where: { id: artifactId, type: ArtifactType.Session, priority: null },
    data: seed,
  });
  if (written.count === 1) {
    await captureSystemSessionMetadataChange({
      tx,
      organizationId,
      artifactId,
      field: SessionMetadataActivityField.Priority,
      before: null,
      after: seed.priority,
    });
  }
}
