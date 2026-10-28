/**
 * ISS-8604: the ingest upsert's PER-ARM `SessionDetail` resolvers, split out of
 * the apply's detail-upsert phase (`session-slice-detail-write.ts` since
 * ISS-8619). Both arms live here — the shared ones the UPDATE
 * arm calls ({@link resolveIngestAwaitingInputSince},
 * {@link resolvePersistableAgents}) and the CREATE arm's overrides derived from
 * them — so the pair cannot drift apart in two files (review, marisolashgrove).
 *
 * Which arm runs is decided by the DATABASE, not by the pre-upsert `existing`
 * read. `acquireSessionAdvisoryLocks` serializes every concurrent INGEST writer
 * for one `externalSessionId`, so no second sync can interleave — but a deleter
 * that does not take that lock (retention, phantom retention) can, and under
 * READ COMMITTED it can commit between the read and the upsert. The apply then
 * lands on the CREATE arm holding a snapshot of a row that no longer exists.
 *
 * Until this module, `detailData` was one object shared by both arms, so a
 * brand-new artifact was born carrying the deleted row's content, in FOUR places:
 *   • `awaitingInputSince`, keyed off `guardedStatus` (the deleted row's status
 *     when terminal-wins fired) and falling back to the deleted row's own
 *     anchor — so a created row could read `active` with a null awaiting
 *     timestamp, or inherit an anchor from a run that was swept away;
 *   • `agents` / `agentCount`, merged with the deleted row's roster — a new row
 *     claiming agents whose events went with the deleted row; and
 *   • the chunk-sequence columns, the worst of the set because it is an ACK. `resolveChunkGating` reads the swept row's staged sequence, so the
 *     final chunk of a 3-chunk revision could satisfy `sequenceComplete` off a
 *     `pendingChunkReceived` the new row never received, commit that
 *     `dataRevision`, and acknowledge a row holding ONE chunk as a complete
 *     snapshot — the half-session-masquerading-as-complete that gate exists to
 *     prevent (review, whitlockk). See {@link resolveCreateArmChunkColumns}.
 *   • `metadata`, whose withheld-key merge reinstates top-level keys from the
 *     swept row (review, davetho). See {@link resolveCreateArmDetail}.
 *
 * THE SWEEP, so the next reader does not have to redo it. Every field the create
 * arm writes was walked for this same class, and after the four above NONE of
 * them carries CONTENT off the stale read. What remains that touches `existing`
 * at all touches it only to DECLINE — a guard, never a value:
 *   • `resolveTokenRollupColumns` reads `existingTokenRollup` /
 *     `hasStoredEstimatedCost` solely to suppress a cost it would otherwise
 *     emit, and the create arm already names `estimatedCost: null` under the
 *     patch, so a suppressed one lands the honest unknown rather than a
 *     fabricated $0;
 *   • `toAuthoritativeCostPatch` reads the stored cost only to return `{}`;
 *   • the tiling strip, frustration, `endsWithError` and the trace-duration
 *     triple are gated by a freshness FLAG, not by a stored value.
 * `resolveSessionEndWrites` is already arm-split (ISS-8552): its `create` is
 * resolved from `incomingSessionEndedAt` + `incomingStatus`, never
 * `guardedStatus`. `artifacts.status` likewise (ISS-5648).
 *
 * The BOUND, deliberately: that whole decline-only set stays SHARED. They write
 * nothing FROM the snapshot, and ISS-8515 chose that suppression for this exact
 * race because `persistSessionChildren` runs AFTER the upsert on the same
 * `shouldUpdateTokenEventCosts` / `shouldReplace` flags. ISS-8619 has since
 * moved those two into `session-slice-detail-write.ts` and
 * `session-slice-children.ts`, which relocated the phase without changing that
 * coupling — the two still share one freshness flag, so splitting the
 * decline-only set per arm would still mean splitting the children write with
 * it, and it remains unsplit. A suppression costs a value the next fresher batch
 * simply writes; a leak publishes a deleted row's content and nothing ever takes
 * it back. That asymmetry is why the line is drawn here.
 *
 * The PR lanes are NOT in that bound, and the asymmetry is the point: a
 * suppressed column is a value the row does not carry yet, while a skipped PR
 * link is an association nothing recreates. So the `pullRequests` blob is
 * overridden here, and its LINK half — plus the `slug`, which cannot be resolved
 * here because minting one costs a counter increment that must not be paid on
 * every apply — is corrected after the upsert by `create-arm-race-repair.ts`,
 * which by then knows which arm the database took.
 *
 * No resolver here re-derives from scratch, so the two arms cannot drift apart:
 * the anchor is the SAME function the update arm calls with the stored row
 * forced absent, the roster is SELECTED FROM the update arm's own result, and
 * the chunk columns are the SAME gate re-run with the stored sequence forced
 * absent. On a genuine create (`existing === null`) each returns exactly what
 * the shared `detailData` already returned, and only the race path changes.
 */

import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import type { JsonObject } from "@repo/api/src/types/common";
import {
  LEGACY_WAITING_WIRE_STATUS,
  type SessionStatus,
  TERMINAL_SESSION_STATUSES,
} from "@repo/api/src/types/session-status";
import { Prisma } from "@repo/database";
import { resolveChunkGating } from "./chunk-revision-gating";
import { mergeJsonArrayByKey, toDate } from "./coercion";
import { sanitizeMetadataForPersist } from "./metadata-sanitizer";
import {
  type PendingChunkAckContract,
  resolvePendingChunkAckContractPatch,
} from "./pending-chunk-ack-contract";
import { toTraceDetailPatch } from "./persist-session-children";

type PersistableAgent = SyncedAgentSession["agents"][number];

/**
 * The five gate-derived columns, always NAMED rather than patched. An omitted
 * key would leave the shared `detailData`'s value in place — the very value
 * being overridden — so every one is spelled out, and an omission the gate
 * expresses as "leave the marker alone" becomes the `null` a create arm would
 * have landed anyway.
 *
 * ISS-8602 added the fifth. It is NOT optional here for the reason the other
 * four are not: this arm can stage a marker the shared gate refused (a stale
 * chunk 0 is foreign against the stored row and advancing against no row), and
 * omitting the band would then land a staged marker with a NULL band — a row the
 * sweep declines forever for a reason that has nothing to do with its producer,
 * and one indistinguishable from a pre-migration row in the declined count.
 */
type CreateArmChunkColumns = {
  dataRevision: number | null;
  pendingChunkRevision: number | null;
  pendingChunkTotal: number | null;
  pendingChunkReceived: number | null;
  pendingChunkAckContract: PendingChunkAckContract | null;
};

type CreateArmDetail = CreateArmChunkColumns & {
  agentCount: number;
  agents: PersistableAgent[];
  awaitingInputSince: Date | null;
  /**
   * Present only when the payload actually declares a `prs` blob, so an omitted
   * key preserves the shared `detailData`'s decision rather than clearing it.
   */
  pullRequests?: ReturnType<typeof toTraceDetailPatch>["pullRequests"];
  metadata: Prisma.InputJsonValue | typeof Prisma.DbNull;
};

/**
 * ISS-5981: the `awaitingInputSince` this write persists — the awaiting-input
 * signal in its only durable form, now that `waiting` is never a stored status.
 *
 * Folding the status without this is silent data loss. The wire schema declares
 * `awaitingInputSince` as `.nullable().optional()`, so a version-skewed desktop
 * can send `waiting` carrying NO timestamp; while the column held the word, that
 * payload still displayed correctly, because `resolveDisplayedSessionStatus`
 * returns WAITING from the raw value before it consults any timestamp. Rewriting
 * the status to `active` and leaving the anchor null would drop the run's only
 * claim to be blocked on a human — it would read Active, then Stale once it aged
 * past the display cutoff.
 *
 * So a `waiting` payload that declares no timestamp resolves DECLARED → STORED →
 * SYNTHESIZED, and all three tiers are load-bearing:
 *
 *   • STORED pins the moment the run FIRST asked, which is what the elapsed-time
 *     display means. `detailData.awaitingInputSince` is spread into the update
 *     arm on every sync, so every sync rewrites the column; without this tier a
 *     run blocked for three days would re-anchor to "now" on every batch.
 *   • SYNTHESIZED is what the STORED tier alone cannot cover, and both gaps are
 *     reachable (#5018 review): a FIRST sync has no row to read, and the
 *     pre-ISS-5981 stored-`waiting` population — which was written with a null
 *     anchor precisely because the word carried the signal — is REWRITTEN to
 *     `active` on its next sync. With no third tier both land `null` and drop
 *     out of the Waiting facet, which is the read-visible migration this fold
 *     must not perform. It mirrors `resolveReopenAwaitingInputSince`, whose
 *     equivalent tier is `maxEventCreatedAt`; that value is not available at the
 *     ingest write (it comes from `persistSessionChildren`, further down), so
 *     this uses the payload's own activity clock, which is stable across
 *     resyncs.
 *
 * Every other payload keeps its incoming value verbatim, including a null: a
 * non-`waiting` payload asserts no awaiting-input state, so clearing a stale
 * anchor is the honest write rather than a loss. The RAW comparison (not a fold)
 * mirrors `resolveReopenAwaitingInputSince`, so the value that MEANS waiting is
 * the value that anchors it.
 *
 * ISS-8604: `existing` is the STORED row as the pre-upsert read saw it, and the
 * CREATE arm passes `null` — see the module header for why a snapshot the
 * database has already discarded must not seed a brand-new row's anchor.
 */
export function resolveIngestAwaitingInputSince(
  session: SyncedAgentSession,
  existing: { awaitingInputSince: Date | null } | null
): Date | null {
  const declared = toDate(session.awaitingInputSince);
  if (declared || session.status !== LEGACY_WAITING_WIRE_STATUS) {
    return declared;
  }
  return (
    existing?.awaitingInputSince ??
    toDate(session.lastActivityAt) ??
    toDate(session.startedAt)
  );
}

/**
 * The agent roster the UPDATE arm persists: the payload's own agents when the
 * apply is entitled to delete-replace, otherwise the payload merged over the
 * stored roster so a chunked or additive delivery cannot drop an agent it did
 * not carry. Metadata is sanitized per agent on both paths.
 *
 * Unchanged by ISS-8604 — the create arm SELECTS FROM this result rather than
 * recomputing it (see {@link resolveCreateArmAgents}).
 */
export function resolvePersistableAgents(
  session: SyncedAgentSession,
  shouldReplace: boolean,
  existingAgents: Prisma.JsonValue | null | undefined
): PersistableAgent[] {
  const merged = shouldReplace
    ? session.agents
    : mergeJsonArrayByKey(existingAgents, session.agents, "externalAgentId");
  return merged.map((agent) => ({
    ...agent,
    metadata: sanitizeMetadataForPersist(agent.metadata),
  }));
}

/**
 * The same roster with the stored row's own agents removed — the create arm's
 * value, DERIVED from {@link resolvePersistableAgents}' result rather than
 * resolved a second time.
 *
 * Deriving is not a shortcut, it is the cheaper half of a correctness argument
 * (review: api-architect + unified auditor). Re-running the resolver with the
 * stored roster forced absent would re-run `sanitizeMetadataForPersist` — a
 * recursive walk with per-string redaction — over every incoming agent on EVERY
 * apply, not just in the race, and it would do it inside the interactive
 * transaction that already holds this session's advisory locks and is budgeted
 * against Prisma's timeout. `apps/api/AGENTS.md` is explicit that the cost
 * calculus inverts in there.
 *
 * The derivation is exact because the merge is keyed on `externalAgentId` and
 * the payload WINS every collision: each incoming id therefore appears exactly
 * once in the merged array carrying the payload's own (already sanitized)
 * entry, so selecting those ids back out yields precisely the roster a merge
 * against no stored row would have produced. The delete-replace path never
 * merged at all, so its result is already that roster and passes through whole.
 * Order is the merged array's, which differs from payload order only for an
 * agent the stored row also had — reachable ONLY in the race, since a genuine
 * create has no stored agents to order against.
 */
export function resolveCreateArmAgents(
  persistedAgents: PersistableAgent[],
  session: SyncedAgentSession,
  shouldReplace: boolean
): PersistableAgent[] {
  if (shouldReplace) {
    return persistedAgents;
  }
  const incomingIds = new Set(
    session.agents.map((agent) => agent.externalAgentId)
  );
  return persistedAgents.filter((agent) =>
    incomingIds.has(agent.externalAgentId)
  );
}

/**
 * The chunk-sequence columns as a session with NO stored row would gate them:
 * the SAME `resolveChunkGating` the apply already ran, re-run with every stored
 * field forced absent (review, whitlockk).
 *
 * The residue this closes is an ACK, which is why it is not merely one more
 * stale column. With a marker staged at revision 42, total 3, received 2, the
 * final chunk read that marker off the swept row, satisfied `sequenceComplete`
 * against a count the new row never received, and committed `dataRevision: 42`
 * onto a row holding ONE chunk's events — a half session masquerading as a
 * complete revision, and nothing downstream can tell. A non-final chunk was
 * quieter and equally wrong: `pendingChunkReceived` landed at
 * `existingPendingReceived + 1` beside a NULL `pendingChunkRevision`/`Total`,
 * a contiguous count for a sequence the row has no identity for.
 *
 * Re-running the gate is exact rather than a second opinion, because on the
 * create arm the stored fields ARE absent — that is what the database decided.
 * The gate then judges a following chunk against a null `stagedRevision`, calls
 * it foreign, commits nothing and stages nothing, and the row is born saying
 * exactly what it holds: no committed revision, no sequence in flight. The
 * desktop's next chunk 0 re-stages and repairs it the ordinary way.
 *
 * `shouldReplace` and `isForeignChunk` are deliberately NOT re-decided here.
 * They steer work OUTSIDE the upsert object — the pre-upsert refusal and the
 * post-upsert delete-replace — which one apply must decide once. On the create
 * arm the delete-replace is a no-op anyway: the new row has no children.
 *
 * On a genuine create (`existing === null`) every input is already absent, so
 * this returns the same decision the shared gate did.
 */
export function resolveCreateArmChunkColumns(input: {
  incomingRevision: number | null | undefined;
  rowLevelAck: boolean;
  session: SyncedAgentSession;
}): CreateArmChunkColumns {
  const gate = resolveChunkGating({
    incomingRevision: input.incomingRevision,
    chunk: input.session.chunk,
    existingRevision: null,
    existingPendingRevision: null,
    existingPendingTotal: null,
    existingPendingReceived: null,
  });
  return {
    // `shouldCommitRevision` already implies a non-null revision; the coalesce
    // is what states that to the compiler rather than a second decision.
    dataRevision: gate.shouldCommitRevision
      ? (input.incomingRevision ?? null)
      : null,
    pendingChunkRevision: gate.pendingChunkPatch.pendingChunkRevision ?? null,
    pendingChunkTotal: gate.pendingChunkPatch.pendingChunkTotal ?? null,
    pendingChunkReceived: gate.pendingChunkPatch.pendingChunkReceived ?? null,
    // Through the SAME resolver the shared gate uses, against THIS arm's patch,
    // so the band always describes the marker actually being written and the two
    // derivations cannot disagree.
    pendingChunkAckContract:
      resolvePendingChunkAckContractPatch(
        gate.pendingChunkPatch,
        input.rowLevelAck
      ).pendingChunkAckContract ?? null,
  };
}

/**
 * The create arm's overrides for the shared `detailData`, spread AFTER it so
 * they are the last word on these columns.
 *
 * `incomingStatus` — never `guardedStatus`. It is the same value the create arm
 * already writes to `artifacts.status` (ISS-5648), so the created row's awaiting
 * anchor and its status now agree in the race that made them disagree.
 *
 * `metadata` is the payload's OWN sanitized blob, never
 * `resolveDegradedMetadataPersist`'s result (review, davetho). That resolver
 * reinstates the top-level keys a payload DECLARES it withheld from the blob
 * "sitting in the row the upsert is about to overwrite" — and on the create arm
 * there is no such row: the upsert overwrites nothing. Its read is issued because
 * the pre-upsert `existing` was non-null and lands inside the same window, so a
 * sweep committing after it hands back the doomed row's blob, and a payload
 * declaring `metadataWithheldKeys: ["oldKey"]` then republishes `oldKey` onto a
 * brand-new artifact — resurrecting on the new row exactly what retention just
 * deleted. Byte-identical on a genuine create, where `storedRowKey` is null and
 * the resolver returns `incoming` untouched; the UPDATE arm keeps the merge,
 * which is the only arm that has a row to preserve it for.
 *
 * The `pullRequests` blob is picked off a second `toTraceDetailPatch` rather
 * than re-derived, so the blob's own shape rules stay in one place. Only that
 * one key is taken: its siblings are the freshness-suppressed columns this
 * module's bound deliberately leaves shared, and no `unstorableCounterFields`
 * sink is passed, so the ISS-8881 tally cannot be double-counted by this call.
 * The blob is opened on the create arm for the reason the gate itself opens it
 * on a genuine create — a row that does not exist has no newer PR state to
 * protect — and it is the blob half of the correction whose LINK half lives in
 * `create-arm-race-repair.ts`. The stored blob is passed as `null` for the same
 * reason: a continuation part of a paginated PR sequence (ISS-9859) appends its
 * page to nothing here, so the swept row's list is not carried onto the new one.
 */
export function resolveCreateArmDetail(input: {
  incomingRevision: number | null | undefined;
  incomingStatus: SessionStatus;
  /** ISS-8602: the batch's ack contract, for the band this arm must name. */
  rowLevelAck: boolean;
  /** The payload's OWN sanitized blob, before any stored-row merge. */
  incomingMetadata: JsonObject | null;
  persistedAgents: PersistableAgent[];
  session: SyncedAgentSession;
  shouldReplace: boolean;
}): CreateArmDetail {
  const agents = resolveCreateArmAgents(
    input.persistedAgents,
    input.session,
    input.shouldReplace
  );
  const { pullRequests } = toTraceDetailPatch(input.session, {
    includePullRequests: true,
    includeTraceDurations: false,
    storedPullRequests: null,
  });
  return {
    ...resolveCreateArmChunkColumns({
      incomingRevision: input.incomingRevision,
      rowLevelAck: input.rowLevelAck,
      session: input.session,
    }),
    agentCount: agents.length,
    agents,
    awaitingInputSince: TERMINAL_SESSION_STATUSES.has(input.incomingStatus)
      ? null
      : resolveIngestAwaitingInputSince(input.session, null),
    ...(pullRequests === undefined ? {} : { pullRequests }),
    metadata: input.incomingMetadata ?? Prisma.DbNull,
  };
}
