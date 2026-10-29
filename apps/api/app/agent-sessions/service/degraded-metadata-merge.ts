/**
 * @file degraded-metadata-merge.ts
 * @description ISS-8641 / ISS-8714 — the receiver's half of the degraded-metadata
 * signal: how a payload that DECLARES it withheld `metadata` keys is merged onto
 * the stored row instead of replacing it, and the monitored event that says a
 * batch carried one.
 *
 * The defect this closes. ISS-7997 made an oversized `metadata` blob DEGRADE
 * rather than dead-letter the whole session. `upsertSessionSlice` assigns the
 * blob WHOLESALE, with no freshness gate and no merge, so every top-level key the
 * degrade omitted was DELETED from a row that already held it — a session that
 * synced whole while it was small and grew past the cap lost those keys
 * permanently, since the degraded delivery is acked like any other and nothing
 * records a repair debt.
 *
 * WHY MERGING IS SAFE HERE AND WAS NOT BEFORE. Merge-instead-of-replace on a bare
 * degradation FLAG would resurrect data the user deleted, because an absent key
 * is ambiguous between "the producer dropped it to fit" and "it is genuinely
 * gone". The producer therefore ships the LIST of keys it withheld
 * (`metadataWithheldKeys`), which removes the ambiguity outright: a stored key
 * the payload names is reinstated, and a stored key the payload does NOT name is
 * dropped exactly as it is today. Nothing is inferred from silence.
 *
 * WHY NOT A DESKTOP REPAIR DEBT, the other candidate owner. The tiling strip's
 * `activity_tiling_repair_owed` re-queues once the merging capability arrives, so
 * its degradation is bounded in time. Metadata oversize has no such trigger — the
 * blob stays oversized forever — so a debt row modelled on that one would have
 * nothing to fire on and would report a repair that never comes.
 *
 * NO USER-VISIBLE CAPABILITY IS TRADED AWAY to get here, which is why this is an
 * implementation of the tickets rather than a decision inside them: the session
 * still delivers (no return to dead-lettering), the stored row keeps strictly
 * more of what the reader could reach, and a real deletion still deletes.
 */

import type { JsonObject } from "@repo/api/src/types/common";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "@/lib/observability/fixed-window-emission-throttle";
import { sanitizeMetadataForPersist } from "./metadata-sanitizer";

export const METADATA_DEGRADED_EVENT = "agent_session_metadata_degraded";

/**
 * The top-level `metadata` keys this payload DECLARES it withheld, or an empty
 * list when it declares nothing.
 *
 * Empty is the answer for an older desktop build (the field is absent), for an
 * explicit `null`, and for a payload whose list survived the ingest schema but
 * carries no usable key. All three mean the same thing downstream — no
 * declaration, so no merge — and collapsing them here keeps the caller from
 * having to distinguish absences that have no distinct behaviour.
 *
 * Deduped, because a repeated key would make {@link mergeDegradedMetadata}'s
 * bookkeeping depend on multiplicity for no gain.
 *
 * EVERY STRING IS KEPT, INCLUDING `""` (review: whitlockk). An earlier revision
 * dropped blank keys on the reasoning that one "cannot name a stored key" — that
 * is false, and measurably so: `""` is a valid JSON object key and the shared
 * compactor retains it (`compactMetadataForPreview({ "": 42 })` returns
 * `{ "": 42 }`), so the desktop can hold one back and legitimately declare
 * `[""]`. Stripping it turned that declaration into an empty one, which is read
 * as NO declaration — and the fallback for no declaration is the wholesale
 * replace this module exists to prevent, so the very key the producer named was
 * the one deleted. The admission rule here must be exactly "what the compactor
 * can retain", never a narrower guess about which names are worth preserving.
 */
export function resolveWithheldMetadataKeys(
  withheldKeys: readonly string[] | null | undefined
): readonly string[] {
  if (!Array.isArray(withheldKeys)) {
    return EMPTY_WITHHELD_KEYS;
  }
  const usable = new Set<string>();
  for (const key of withheldKeys) {
    if (typeof key === "string") {
      usable.add(key);
    }
  }
  return usable.size === 0 ? EMPTY_WITHHELD_KEYS : [...usable];
}

/** Shared empty result, so the common no-declaration path allocates nothing. */
const EMPTY_WITHHELD_KEYS: readonly string[] = Object.freeze([]);

/**
 * The `metadata` blob this apply should persist.
 *
 * REPLACE IS STILL THE DEFAULT, and deliberately so. Merging happens only when
 * the payload NAMES withheld keys and the row already holds a blob to preserve;
 * every other combination — an unstamped payload from an already-installed
 * desktop build, a first delivery with no stored row, a stored blob that is not
 * an object — returns `incoming` untouched, which is byte-for-byte the behaviour
 * before this ticket. The cross-repo contract is that omission asserts nothing,
 * so a peer that cannot declare must not have a merge policy applied on its
 * behalf.
 *
 * WHAT WINS. Incoming keys always, including a key the payload both sent AND
 * listed as withheld — a producer that contradicts itself is not a reason to
 * prefer the older value, and the stored copy is by definition no fresher.
 * A withheld key absent from `incoming` takes the stored value. A stored key that
 * is NEITHER incoming NOR withheld is DROPPED: that is the user-deletion case,
 * and preserving it is the one thing merge-instead-of-replace can get wrong.
 *
 * RE-SANITIZED AT THE END, not assembled and trusted. The merged object can carry
 * more keys than `MAX_METADATA_KEYS` admits, and the persist contract is that
 * every stored blob has been through the shared compaction. Incoming keys are
 * emitted first so they win that slice.
 */
export function mergeDegradedMetadata(
  input: Readonly<{
    stored: unknown;
    incoming: JsonObject | null;
    withheldKeys: readonly string[];
  }>
): JsonObject | null {
  if (input.withheldKeys.length === 0) {
    return input.incoming;
  }
  const stored = asMetadataObject(input.stored);
  if (stored === null) {
    return input.incoming;
  }
  // NULL-PROTOTYPE ACCUMULATOR, which is the root `AGENTS.md` rule for a lookup
  // table keyed by untrusted names and not merely a style choice here (review:
  // tamsinb). On a plain `{}` the assignment below is a [[Set]] that walks the
  // prototype chain, so `merged["__proto__"] = value` finds `Object.prototype`'s
  // accessor and REPARENTS `merged` instead of creating an own property: the key
  // never appears in `Object.keys`, `preservedAny` flips true for a key that was
  // not in fact preserved, and an attacker-influenced parsed-JSON object becomes
  // this object's prototype. With no prototype there is no accessor to find, so
  // every name — `__proto__` included — lands as plain data.
  const merged: Record<string, unknown> = Object.assign(
    Object.create(null),
    input.incoming ?? {}
  );
  let preservedAny = false;
  for (const key of input.withheldKeys) {
    // OWN PROPERTIES, never `in`. Both operands are untrusted: `withheldKeys`
    // arrives off the wire and `stored` is a parsed JSON blob, so a key named
    // `constructor`, `toString`, or `__proto__` reaches this lookup — and `in`
    // answers for `Object.prototype` on the plain object `stored` is. It would
    // report the key as already incoming and skip the reinstatement, deleting
    // exactly the key this module exists to preserve, and the mirrored check
    // would hand a `Object.prototype` FUNCTION to `merged[key]` as if it were
    // session data.
    if (Object.hasOwn(merged, key) || !Object.hasOwn(stored, key)) {
      continue;
    }
    merged[key] = stored[key];
    preservedAny = true;
  }
  if (!preservedAny) {
    return input.incoming;
  }
  return sanitizeMetadataForPersist(merged);
}

/**
 * `value` as a plain metadata object, or `null` when it is anything else.
 *
 * Arrays are refused alongside primitives: a stored `metadata` that is an array
 * has no top-level string keys to preserve, and `key in []` would answer for
 * indices and inherited members rather than for data.
 */
function asMetadataObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * The `metadata` this slice should write, reading the stored blob ONLY when a
 * merge is actually on the table.
 *
 * The stored blob is fetched here rather than added to the slice's own `select`
 * on purpose: that select runs for every session of every batch and this column
 * is the largest on the row, so widening it would make every healthy sync pay for
 * a case that is rare by construction. The extra read is one `findUnique` on the
 * path that already decided it needs the value.
 *
 * SCOPED BY THE TENANT KEY, not by provenance (review: chatgpt-codex-connector).
 * `SessionDetail` carries no `organizationId` column — it is org-owned through
 * its `Artifact` — so `computeTargetId` IS this table's tenant predicate, and it
 * is what the sibling row read and the `upsert` beside this one are both keyed
 * on. Reading under the SAME `(computeTargetId, externalSessionId)` unique
 * therefore does two things a bare `artifactId` primary-key read did not: the
 * predicate is enforced here rather than inherited from an earlier query, and the
 * blob this merge preserves is by construction the blob sitting in the row the
 * upsert is about to overwrite.
 *
 * NO FRESHNESS GATE, and that is not an oversight. The merge only ever REINSTATES
 * a value the row already holds; it never lets an older payload win a key over a
 * newer one, because incoming keys always win. A stale replay therefore writes at
 * worst what the ungated wholesale assign beside it already writes today, plus
 * the keys it declared it could not carry.
 *
 * WHAT THIS MEANS FOR `estimatedCost`, because the merged blob is also what
 * `resolveTokenRollupColumns` prices from (review: review-soul). `usageExtras` is
 * a real top-level key a degrade can drop, and `sessionWebSearchCostUsd` reads
 * `usageExtras.web_search_requests` out of the persisted blob — so BEFORE this
 * change a degraded resync deleted the key and the web-search line item silently
 * vanished from the dollar figure, reintroducing exactly the systematically-low
 * cost ISS-7821 existed to fix. Reinstating it restores that line item.
 *
 * The residual is that the reinstated COUNT is the last one measured, not a fresh
 * one, for as long as the blob stays oversized. That is a property of the DEGRADE
 * (the producer cannot send the key at all), not of the merge, and the only other
 * option is the `$0` the repo's bad-data rule names outright as the thing never to
 * emit — "never emit a plausible-but-wrong number (e.g. a `$0` cost you couldn't
 * actually compute)". Do not "fix" this by excluding `usageExtras` from
 * reinstatement; that is the pre-change behaviour, and it is the worse half.
 */
export async function resolveDegradedMetadataPersist(
  tx: Readonly<{
    sessionDetail: {
      findUnique: (args: {
        where: {
          computeTargetId_externalSessionId: StoredSessionRowKey;
        };
        select: { metadata: true };
      }) => Promise<{ metadata: unknown } | null>;
    };
  }>,
  input: Readonly<{
    storedRowKey: StoredSessionRowKey | null;
    withheldKeys: readonly string[];
    incoming: JsonObject | null;
  }>
): Promise<JsonObject | null> {
  if (input.withheldKeys.length === 0 || input.storedRowKey === null) {
    return input.incoming;
  }
  const row = await tx.sessionDetail.findUnique({
    where: { computeTargetId_externalSessionId: input.storedRowKey },
    select: { metadata: true },
  });
  return mergeDegradedMetadata({
    stored: row?.metadata,
    incoming: input.incoming,
    withheldKeys: input.withheldKeys,
  });
}

/**
 * How many sessions of this batch DURABLY LANDED a degraded `metadata` blob.
 *
 * A session counts when it DECLARED withheld keys and its slice COMMITTED. There
 * is deliberately no finality gate of the kind `countStrippedTilings` applies:
 * `chunkOversizedSession` replicates the base into every chunk, but the degraded
 * `metadata` is APPLIED by every one of those chunk slices — each is a real write
 * against the row — whereas a stripped tiling is a single absence that only
 * resolves at the end of the sequence. Counting deliveries is what this event
 * reports, and it says `degradedSessionCount` rather than a row count for exactly
 * that reason.
 */
export function countDegradedMetadataSessions(
  sessions: readonly Readonly<{
    externalSessionId: string;
    metadataWithheldKeys?: string[] | null;
  }>[],
  committedSessionIds: readonly string[]
): number {
  if (committedSessionIds.length === 0) {
    return 0;
  }
  const committed = new Set(committedSessionIds);
  return sessions.filter(
    (session) =>
      resolveWithheldMetadataKeys(session.metadataWithheldKeys).length > 0 &&
      committed.has(session.externalSessionId)
  ).length;
}

/**
 * The STABLE emission key: what an operator would act on, with no per-session
 * component. A compute target must already exist under the organization for the
 * ingest to run at all, so nothing a caller varies within a request can grow this
 * keyspace — it is bounded by (orgs × their real targets).
 */
type DegradedMetadataScope = {
  organizationId: string;
  computeTargetId: string;
};

/** Composite-key delimiter. Both key parts are ids, so `|` cannot collide. */
const KEY_DELIMITER = "|";

/**
 * WHY THIS IS THROTTLED. The batch IS the request and an authenticated desktop
 * drives the request rate, and a session whose blob stays oversized re-declares
 * its degradation on every pass — so an un-throttled emission is one warning per
 * request, forever, from one session. That is the amplification vector
 * `apps/api/AGENTS.md` ("Emission and Abuse Control") forbids, and it is a
 * sharper risk here than for the tiling strip because metadata oversize has no
 * repair trigger and therefore never stops recurring.
 *
 * `FixedWindowEmissionThrottle` supplies both bounds: at most one event per
 * (org, compute target) per window plus one aggregate rollup, and a hard
 * max-entry LRU cap on the keyspace, since an unbounded map would only trade a
 * log leak for a memory leak (root `AGENTS.md`).
 *
 * THE FIRST OCCURRENCE ALWAYS EMITS — a key with no live window emits before it
 * can suppress anything, so a genuinely new (org, target) degrade is never the
 * one the bound eats. The throttle only ever collapses REPETITION.
 *
 * Process-local per serverless instance, matching the sibling throttles.
 * Exported so tests can reset it between cases; production code must not reach
 * into it.
 */
export const degradedMetadataThrottle =
  new FixedWindowEmissionThrottle<DegradedMetadataScope>({
    onFlush: (scope, occurrences, cause) =>
      emitDegradedMetadataRollup(scope, occurrences, cause),
  });

/**
 * Raise the monitored event for a batch that applied at least one degraded blob.
 * Silent when none did — this reports a degradation, so a `0` would be traffic
 * rather than signal.
 *
 * Ids and counts only, never metadata content or key NAMES: a withheld key name
 * is session content and this is a log line, not a debugging channel.
 *
 * NEVER THROWS. A failure to REPORT the degradation must not also change the
 * ingest's outcome.
 */
export function reportDegradedMetadata(
  context: Readonly<DegradedMetadataScope>,
  degradedSessionCount: number
): void {
  if (degradedSessionCount <= 0) {
    return;
  }
  const scope: DegradedMetadataScope = {
    computeTargetId: context.computeTargetId,
    organizationId: context.organizationId,
  };
  try {
    const decision = degradedMetadataThrottle.record(
      buildDegradedMetadataKey(scope),
      scope,
      Date.now()
    );
    if (decision.flushedSuppressedCount > 0) {
      emitDegradedMetadataRollup(
        scope,
        decision.flushedSuppressedCount,
        EmissionRollupCause.Window
      );
    }
    if (decision.emit) {
      log.warn(METADATA_DEGRADED_EVENT, {
        ...scope,
        degradedSessionCount,
        occurrences: 1,
      });
    }
  } catch (error) {
    log.warn("[agent-sessions] Failed to report degraded session metadata", {
      event: METADATA_DEGRADED_EVENT,
      computeTargetId: scope.computeTargetId,
      error: parseError(error),
    });
  }
}

function buildDegradedMetadataKey(scope: DegradedMetadataScope): string {
  return [scope.organizationId, scope.computeTargetId].join(KEY_DELIMITER);
}

/**
 * The rollup for reports a closed window suppressed, emitted as ONE event
 * carrying their total so `sum(occurrences)` still tracks how often a degraded
 * batch landed. It deliberately omits `degradedSessionCount` — the suppressed
 * batches did not necessarily carry the same sessions, and a summed count would
 * report one recurring session once per pass — and carries `aggregated` so a
 * monitor can tell a rollup from a first occurrence.
 *
 * `flushedBy` is the CAUSE the throttle reported, never a constant this module
 * picks (the ISS-7360 lesson): stamping one literal would tell an operator the
 * key cap was hit when a quiet key was merely drained.
 */
function emitDegradedMetadataRollup(
  scope: DegradedMetadataScope,
  occurrences: number,
  flushedBy: EmissionRollupCause
): void {
  log.warn(METADATA_DEGRADED_EVENT, {
    ...scope,
    occurrences,
    aggregated: true,
    flushedBy,
  });
}

/**
 * The `(computeTargetId, externalSessionId)` unique that identifies the stored
 * session row — the tenant-scoped key `upsertSessionSlice` both finds the row
 * under and writes it back under.
 *
 * `externalSessionId` is the STORED index key (ISS-8069's `resolveStoredIndexKey`
 * result), never the raw id off the wire: an over-long id is projected before it
 * reaches the column, so reading under the raw value would miss the row this
 * merge exists to preserve.
 */
type StoredSessionRowKey = {
  computeTargetId: string;
  externalSessionId: string;
};
