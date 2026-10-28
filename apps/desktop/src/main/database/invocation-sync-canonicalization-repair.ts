/**
 * @file invocation-sync-canonicalization-repair.ts
 * @description ISS-6889 (codex P1 review): the ONE-SHOT upgrade repair for
 * invocation-sync parts a PREVIOUS build already persisted with a pre-trim hash.
 *
 * ## Why a repair pass is required at all
 *
 * Canonicalizing in `agent-component-invocation-sync-payload.ts` fixes parts the
 * producer builds FROM NOW ON. It does nothing for the population the defect
 * actually created. A user upgrading with a padded part already in
 * `agent_component_invocation_sync_outbox` keeps a `part_hash` signed over
 * untrimmed bytes; `loadReadyInvocationSyncOutboxParts` returns that stored
 * payload unchanged, the cloud re-hashes the TRIMMED object
 * (`hasValidPartHash`), the two can never reconcile, and the row earns
 * `validation_failed` — classed PERMANENT, dead-lettered on the fifth attempt.
 *
 * The general recovery pass can eventually re-pend that attempt-budgeted dead
 * letter, but it cannot repair the bytes that will be sent again. Nor does
 * anything re-derive an already-imported session — the only caller of
 * `enqueueInvocationGeneration` is materialization, and the rollup's
 * `ensureStoredAgentComponentInvocations` bootstraps only sessions with ZERO
 * invocation rows. So without this pass the affected session keeps cycling on
 * the same bad hash unless an unrelated later invocation happens to mint a new
 * generation. Shipping the producer fix alone would have left the installed base
 * broken and closed the ticket behind it.
 *
 * ## Why it repairs from the PERSISTED PAYLOAD, not from the transcript
 *
 * The stored parts already carry every item, so the repair is a pure rebuild
 * over rows this store owns. Routing it through a `DATA_REVISION` bump instead
 * would re-walk every transcript in the corpus — hours of work
 * (`sqlite-maintenance-facade.ts`) — to fix a hash. Invariant 7 asks for a
 * revision stamp scoped to what the semantics change must re-derive, and that is
 * these rows and nothing else.
 *
 * ## Why only TEMPLATE rows are rebuilt
 *
 * A template generation is always COMPLETE: nothing acks a template, and the
 * only `deleteMany` on this table is the ack path, which is scoped to a
 * target-scoped delivery key. Rebuilding a partially-acked DELIVERY generation
 * would hash a partial item set and mint a WRONG generation id. Delivery rows
 * for a repaired generation are therefore deleted rather than rewritten — they
 * name a superseded `external_generation_id` and are provably undeliverable —
 * and the ordinary promotion pass re-clones them from the repaired template,
 * which is the same delete-then-clone `prepareInvocationSyncTarget` already runs
 * when a template legitimately changes.
 *
 * ## Why an untouched generation is left ALONE
 *
 * The rebuild is compared against what is stored and a byte-identical result
 * writes nothing. An install with no padded part pays one read and no write, and
 * no correct row is churned into a fresh `created_at` that would reorder the
 * lane's FIFO drain.
 *
 * ## ISS-6910: the two populations revision 1 abandoned silently
 *
 * Revision 1 scanned `status = pending` only and folded every generation it
 * could not rebuild into "nothing to do". Measured on this branch against the
 * shipped pass, both cases end with the session's dead-lettered delivery rows
 * still on disk and the sentinel marked complete, so neither is ever revisited:
 *
 *  - a generation whose stored ids collide ONLY AFTER trimming reported
 *    `{ inspected: 1, repaired: 0 }` — byte-identical to what a healthy,
 *    already-canonical session reports. Trimming is what CREATES that collision,
 *    so canonicalization manufactures this population itself. This half is
 *    reachable from the ordinary producer and is the load-bearing one.
 *  - a session whose TEMPLATE rows were parked reported `{ inspected: 0 }` — the
 *    `status` filter made it invisible to the scan entirely. Stated honestly:
 *    no CURRENT writer produces that row. `enqueueInvocationGeneration` is the
 *    only template writer and parks only its own non-part error record, and the
 *    drain never reads the template key, so nothing quarantines one today. This
 *    half is therefore DEFENSIVE — it costs one extra read per parked-template
 *    session and no write — and it is kept because a template row's status was
 *    never a delivery verdict to filter on in the first place, and because rows
 *    written by older or newer builds are not this build's to assume about.
 *
 * Both are now scanned, and a generation that cannot be rehashed is COUNTED
 * ({@link InvocationSyncCanonicalizationRepairResult.unrepairable}) and surfaced
 * on the caller's diagnostic sink rather than being reported as healthy. It is
 * deliberately NOT left to block the sentinel: an unconvergeable row that keeps
 * the pass armed would re-walk every template on every tick forever, which is
 * the stateless-drain spin this lane has already been burned by.
 *
 * A parked template whose stored bytes ARE canonical is left parked. Re-driving
 * a dead-letter that this defect did not cause is a retry policy, and this pass
 * does not own one.
 */

import type {
  AgentComponentInvocationCompleteGeneration,
  AgentComponentInvocationSyncItem,
  AgentComponentInvocationSyncPart,
} from "@repo/api/src/types/agent-component-invocation";
import { OutboxStatus } from "../../shared/sync-lane-contract.js";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_DELIVERY_KEY_PREFIX,
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  AgentComponentInvocationSyncLocalError,
} from "../agent-sync/agent-component-invocation-sync-constants.js";
import { computeAgentComponentInvocationGenerationId } from "../agent-sync/agent-component-invocation-sync-payload.js";
import { parseInvocationSyncPart } from "./invocation-sync-outbox-parts.js";
import { buildInvocationSyncParts } from "./invocation-sync-parts-builder.js";
import { bumpInvocationSyncTemplateRevision } from "./invocation-sync-template-revision.js";
import type { DesktopPrisma } from "./prisma-client.js";

/**
 * The cursor sentinel that records this repair has run, alongside the lane's
 * existing `__invocation_sync_state__` / `__invocation_sync_backfill__` rows.
 *
 * A sentinel row rather than a schema migration because the marker is lane
 * bookkeeping, and `agent_component_invocation_sync_cursors` is already the
 * table that holds exactly that — two sentinels live in it today. A migration
 * would add a column no query filters on.
 */
export const INVOCATION_SYNC_CANONICALIZATION_SESSION_ID =
  "__invocation_sync_canonicalization__" as const;

/**
 * Which canonicalization semantics the persisted payloads were built under.
 *
 * Stored in the sentinel's `source_sequence`. A store at or above this value has
 * already been repaired; anything lower (including the 0 an absent row reads as)
 * has not. Bump it if the producer's canonicalization changes again — that is
 * the whole point of stamping it rather than writing a boolean.
 *
 * ISS-6910 raised it to 2. The semantics did not change; the COVERAGE did, and a
 * store that already ran revision 1 is exactly the store holding the sessions
 * that pass abandoned. Without the bump those installs keep their stranded rows
 * forever, which is the whole population this ticket exists for. It re-runs one
 * keyset-paged scan per store, writes nothing for a session whose rebuild is
 * byte-identical, and does NOT re-walk a single transcript — this is the lane's
 * own sentinel, deliberately not `DATA_REVISION`.
 *
 * ISS-9174 did NOT bump it. It widened what the shared wire schema REJECTS (NUL,
 * lone surrogates, below-floor timestamps) without changing how an accepted item
 * is canonicalized, so every generation this pass would accept rebuilds
 * byte-identical. A generation the widened schema now rejects is one this pass
 * can only count as `unrepairable`: it never dead-letters or deletes a template,
 * so a bump would re-walk every store to add such a session to one log line and
 * change no delivery state. A store already at revision 2 therefore keeps such a
 * template uncounted here; the delivery rows that matter dead-letter through the
 * server's 400 on their own.
 *
 * ISS-4965 raised it to 3. Canonicalization now redacts secrets in
 * `definitionContent` (and re-fingerprints what it rewrote), so a template
 * persisted by an earlier build still holds the raw text and would send it.
 * Rebuilding it redacts it; a template with nothing to redact rebuilds
 * byte-identical and is left alone.
 */
export const INVOCATION_SYNC_CANONICALIZATION_REVISION = 3;

/** How many template generations one repair transaction rebuilds. */
const REPAIR_PAGE_SIZE = 50;

/** What one repair pass did, for the caller's log line. */
export type InvocationSyncCanonicalizationRepairResult = {
  /**
   * Template generations this pass read and could interpret — the denominator
   * `repaired` is drawn from. An interpretable generation whose stored bytes
   * were already canonical is counted here and nowhere else.
   */
  inspected: number;
  /** Template generations rebuilt because their stored bytes were not. */
  repaired: number;
  /**
   * Template generations this pass looked at and could NOT rehash — a stored
   * form it must not guess at (ids that collide once trimmed, a payload that no
   * longer parses, a part set that is not the complete 0..partCount-1 run).
   *
   * Counted separately because folding these into `repaired: 0` is what made the
   * ISS-6910 population invisible: a session nothing can fix reported exactly
   * what a healthy session reports.
   */
  unrepairable: number;
};

/**
 * Rebuild every template generation whose persisted parts were hashed before
 * canonicalization, at most once per store.
 *
 * Idempotent and safe to call on every tick: the sentinel read is one indexed
 * primary-key lookup, and every later call returns without touching a row.
 *
 * The sentinel read and its write are deliberately NOT one transaction. A user
 * signed into two compute targets runs a service tick per target through this
 * same step, so two ticks racing before the first sentinel write lands would
 * both walk the templates. That costs a duplicate read pass and nothing else —
 * every write below is an upsert or an `ON CONFLICT DO NOTHING` insert on the
 * single SQLite writer — so the race is accepted rather than paid for with a
 * transaction held across the whole scan.
 */
export async function repairInvocationSyncCanonicalization(
  prisma: Pick<DesktopPrisma, "read" | "write">,
  log?: (message: string) => void
): Promise<InvocationSyncCanonicalizationRepairResult | null> {
  if (await hasRepairedCanonicalization(prisma)) {
    return null;
  }
  const result: InvocationSyncCanonicalizationRepairResult = {
    inspected: 0,
    repaired: 0,
    unrepairable: 0,
  };
  let cursor = "";
  while (true) {
    const sessionIds = await loadTemplateSessionIdsAfter(prisma, cursor);
    if (sessionIds.length === 0) {
      break;
    }
    for (const sessionId of sessionIds) {
      await repairTemplateGeneration(prisma, sessionId, result);
    }
    cursor = sessionIds.at(-1) ?? cursor;
  }
  // The sentinel advances even when generations were left unrepairable, so an
  // unconvergeable row cannot re-arm this scan on every tick forever. What such
  // a row must never be is SILENT, which is what revision 1 made it.
  await markCanonicalizationRepaired(prisma);
  if (result.unrepairable > 0) {
    log?.(
      `invocation sync canonicalization repair: ${result.unrepairable} generation(s) could not be rehashed and remain undeliverable (inspected ${result.inspected}, repaired ${result.repaired})`
    );
  }
  return result;
}

async function hasRepairedCanonicalization(
  prisma: Pick<DesktopPrisma, "read">
): Promise<boolean> {
  const rows = await prisma.read((reader) =>
    reader.agentComponentInvocationSyncCursor.findMany({
      where: {
        sourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        externalSessionId: INVOCATION_SYNC_CANONICALIZATION_SESSION_ID,
      },
      select: { sourceSequence: true },
    })
  );
  return (
    Number(rows[0]?.sourceSequence ?? 0) >=
    INVOCATION_SYNC_CANONICALIZATION_REVISION
  );
}

async function markCanonicalizationRepaired(
  prisma: Pick<DesktopPrisma, "write">
): Promise<void> {
  const now = new Date().toISOString();
  await prisma.write((client) =>
    client.agentComponentInvocationSyncCursor.upsert({
      where: {
        sourceKey_externalSessionId: {
          sourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
          externalSessionId: INVOCATION_SYNC_CANONICALIZATION_SESSION_ID,
        },
      },
      create: {
        sourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        externalSessionId: INVOCATION_SYNC_CANONICALIZATION_SESSION_ID,
        externalGenerationId: INVOCATION_SYNC_CANONICALIZATION_SESSION_ID,
        sourceSequence: INVOCATION_SYNC_CANONICALIZATION_REVISION,
        updatedAt: now,
      },
      update: {
        sourceSequence: INVOCATION_SYNC_CANONICALIZATION_REVISION,
        updatedAt: now,
      },
    })
  );
}

/**
 * The next page of template session ids, keyset-ordered.
 *
 * The two lane sentinels are excluded by construction — neither owns outbox
 * rows — so no extra predicate is needed beyond the template source key.
 *
 * ISS-6910: deliberately NOT filtered on `status`. Revision 1 scanned
 * `pending` only, which made a session whose template rows had been parked
 * invisible to the pass — it reported `inspected: 0` for that session and left
 * its dead-lettered delivery clones on disk permanently. Nothing about a parked
 * TEMPLATE row means "do not look at it": templates are never delivered, so the
 * status on one is not a delivery verdict. Whether the generation is actually
 * rewritten is still decided downstream by comparing the rebuild against the
 * stored bytes, so widening the scan cannot churn a correct row.
 */
async function loadTemplateSessionIdsAfter(
  prisma: Pick<DesktopPrisma, "read">,
  cursor: string
): Promise<string[]> {
  const rows = await prisma.read((reader) =>
    reader.agentComponentInvocationSyncOutbox.findMany({
      where: {
        sourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        ...(cursor ? { externalSessionId: { gt: cursor } } : {}),
      },
      select: { externalSessionId: true },
      distinct: ["externalSessionId"],
      orderBy: { externalSessionId: "asc" },
      take: REPAIR_PAGE_SIZE,
    })
  );
  return rows.map((row) => row.externalSessionId);
}

/**
 * Rebuild one session's template generation when — and only when — its stored
 * bytes differ from what the canonicalizing producer now emits.
 */
async function repairTemplateGeneration(
  prisma: Pick<DesktopPrisma, "read" | "write">,
  sessionId: string,
  result: InvocationSyncCanonicalizationRepairResult
): Promise<void> {
  const outcome = await loadTemplateParts(prisma, sessionId);
  if (outcome.kind === TemplateLoadKind.NotThisPass) {
    return;
  }
  if (outcome.kind === TemplateLoadKind.Unusable) {
    result.unrepairable += 1;
    return;
  }
  const stored = outcome.generation;
  result.inspected += 1;
  // Two builds, and the sequence is why. The COMPARISON has to hold
  // `sourceSequence` fixed, or every generation would differ (it is inside the
  // part hash) and a correct store would rewrite every row it owns. The WRITE
  // has to advance it: `loadPendingInvocationTemplates` owes a session only
  // while `target.source_sequence < template.source_sequence`, so a repaired
  // template left at the same sequence would never be re-promoted to a target
  // that already cloned the superseded generation — the delivery rows this pass
  // deletes would never come back.
  const atSameSequence = rebuildGenerationParts(stored, stored.sourceSequence);
  // ISS-6910: a generation that has no canonical form is the population this
  // pass exists to surface, not a quiet `return`. Trimming is what MAKES two
  // stored ids collide, so the canonicalization change manufactures this case
  // itself — and its delivery rows are already dead-lettered `validation_failed`,
  // a cause the store-integrity probe's allow-list deliberately excludes. Left
  // uncounted it is indistinguishable from a healthy session.
  if (!atSameSequence) {
    result.unrepairable += 1;
    return;
  }
  if (partsAreUnchanged(stored.parts, atSameSequence)) {
    return;
  }
  const rebuilt = rebuildGenerationParts(stored, stored.sourceSequence + 1);
  if (!rebuilt) {
    result.unrepairable += 1;
    return;
  }
  await writeRepairedGeneration(prisma, sessionId, stored, rebuilt);
  result.repaired += 1;
}

/** How a session's stored template rows classified for this pass. */
const TemplateLoadKind = {
  /** A complete, part-shaped generation this pass can compare and rebuild. */
  Loaded: "loaded",
  /**
   * Rows exist but no longer describe a generation this pass may rehash — a
   * payload that no longer parses alongside ones that do, or a part set that is
   * not the complete `0..partCount-1` run. Counted, never guessed at.
   */
  Unusable: "unusable",
  /**
   * This session owns no template generation to judge — it has no rows at all,
   * or every row is a DELIVERY DECISION already recorded under a declared local
   * reason (`enqueueInvocationGeneration`'s error record: payload is an error
   * object, not a part). Neither is a canonicalization casualty, so counting
   * either would inflate `unrepairable` with a case it does not describe.
   *
   * The predicate is the recorded REASON, never "the payload did not parse".
   * Those are different facts and conflating them is the exact defect this
   * ticket exists to close: `parseInvocationSyncPart` also returns null for a
   * payload written by a NEWER build under a protocol version this one does not
   * accept, and every part of one generation shares that version — so they fail
   * together and a single-part generation lands here with zero parsed rows.
   * That template is unreadable, not settled, and belongs in `unrepairable`.
   * Nothing else would catch it: the ready-parts quarantine never sees a
   * template row (the lane drains only delivery keys), which is why the
   * integrity probe records template corruption as out of its reach.
   */
  NotThisPass: "not_this_pass",
} as const;

/** The declared local reasons a template generation is recorded undeliverable. */
const RECORDED_UNDELIVERABLE_REASONS = new Set<string>(
  Object.values(AgentComponentInvocationSyncLocalError)
);

/**
 * Whether this row is a DELIVERY DECISION already recorded, rather than a
 * template payload this build simply cannot read.
 *
 * Keyed on the reason the row itself carries, not on whether its payload
 * parsed — see {@link TemplateLoadKind.NotThisPass}. An unknown or absent
 * `last_error` fails the test on purpose: a row that cannot say why it was
 * abandoned is not evidence that abandoning it was intended.
 */
function isRecordedUndeliverable(row: {
  status: string;
  lastError: string | null;
}): boolean {
  return (
    row.status === OutboxStatus.DeadLettered &&
    row.lastError !== null &&
    RECORDED_UNDELIVERABLE_REASONS.has(row.lastError)
  );
}

/** One session's persisted template generation. */
type StoredTemplateGeneration = {
  externalGenerationId: string;
  parts: AgentComponentInvocationSyncPart[];
  createdAt: string;
  sourceSequence: number;
};

type TemplateLoadOutcome =
  | {
      kind: typeof TemplateLoadKind.Loaded;
      generation: StoredTemplateGeneration;
    }
  | { kind: typeof TemplateLoadKind.Unusable }
  | { kind: typeof TemplateLoadKind.NotThisPass };

async function loadTemplateParts(
  prisma: Pick<DesktopPrisma, "read">,
  sessionId: string
): Promise<TemplateLoadOutcome> {
  const rows = await prisma.read((reader) =>
    reader.agentComponentInvocationSyncOutbox.findMany({
      where: {
        sourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        externalSessionId: sessionId,
      },
      select: {
        externalGenerationId: true,
        partIndex: true,
        payload: true,
        createdAt: true,
        status: true,
        lastError: true,
      },
      orderBy: { partIndex: "asc" },
    })
  );
  const parts: AgentComponentInvocationSyncPart[] = [];
  for (const row of rows) {
    const part = parseInvocationSyncPart(row.payload);
    if (part) {
      parts.push(part);
    }
  }
  const first = parts[0];
  const firstRow = rows[0];
  if (!firstRow) {
    return { kind: TemplateLoadKind.NotThisPass };
  }
  if (!first) {
    // Zero part-shaped rows. Settled ONLY when every row carries a declared
    // local reason; otherwise this is a template this build cannot read, and
    // silently returning would abandon it exactly the way revision 1 did.
    return rows.every(isRecordedUndeliverable)
      ? { kind: TemplateLoadKind.NotThisPass }
      : { kind: TemplateLoadKind.Unusable };
  }
  // A payload that no longer parses SITTING BESIDE ones that do is a genuinely
  // broken generation: rebuilding from the survivors would silently drop the
  // dropped part's items and mint an id covering fewer items than the stored
  // generation claimed.
  if (parts.length !== rows.length) {
    return { kind: TemplateLoadKind.Unusable };
  }
  // A template whose parts do not form a complete 0..partCount-1 set cannot be
  // rehashed: the generation hash covers the UNION of its items, so a missing
  // part would mint a wrong id that no later delivery could ever reconcile.
  if (parts.length !== first.partCount) {
    return { kind: TemplateLoadKind.Unusable };
  }
  return {
    kind: TemplateLoadKind.Loaded,
    generation: {
      externalGenerationId: first.externalGenerationId,
      parts,
      createdAt: firstRow.createdAt,
      sourceSequence: first.sourceSequence,
    },
  };
}

/**
 * Re-emit the generation through the SAME producer the live path uses, so the
 * repaired bytes cannot drift from newly built ones. Null when the generation is
 * undeliverable for a reason this pass must not paper over — it already carries
 * whatever local error `buildInvocationSyncParts` resolved, and re-recording it
 * here is not this pass's job.
 */
function rebuildGenerationParts(
  stored: StoredTemplateGeneration,
  sourceSequence: number
): AgentComponentInvocationSyncPart[] | null {
  const first = stored.parts[0];
  if (!first) {
    return null;
  }
  const items: AgentComponentInvocationSyncItem[] = stored.parts.flatMap(
    (part) => part.items
  );
  // The id computation shares `canonicalInvocationItems` with the producer, so
  // it raises the same declared limit/collision errors. A generation that has no
  // canonical id is not repairable BY REHASHING and is left exactly as stored —
  // one undeliverable generation must never abort the sweep for every other
  // session's repairable ones.
  let generation: AgentComponentInvocationCompleteGeneration;
  try {
    generation = {
      externalSessionId: first.externalSessionId,
      externalGenerationId: computeAgentComponentInvocationGenerationId(
        first.externalSessionId,
        items
      ),
      sourceUpdatedAt: first.sourceUpdatedAt,
      dataRevision: first.dataRevision,
      sourceSequence,
      items,
    };
  } catch {
    return null;
  }
  const built = buildInvocationSyncParts(generation);
  return built.localError ? null : built.parts;
}

/**
 * Whether the rebuild reproduced the stored bytes exactly. `part_hash` covers
 * every field the wire carries, so comparing the hashes (plus the part count and
 * the generation id they are computed under) is a complete equality test without
 * re-serializing the payloads.
 */
function partsAreUnchanged(
  stored: AgentComponentInvocationSyncPart[],
  rebuilt: AgentComponentInvocationSyncPart[]
): boolean {
  if (stored.length !== rebuilt.length) {
    return false;
  }
  return stored.every((part, index) => {
    const next = rebuilt[index];
    return (
      next !== undefined &&
      next.partHash === part.partHash &&
      next.externalGenerationId === part.externalGenerationId
    );
  });
}

/**
 * Replace one session's template parts and retire the delivery rows that cloned
 * the superseded generation, in ONE transaction.
 *
 * The writes mirror `enqueueInvocationGeneration` exactly — same delete, same
 * insert columns, same per-session cursor update, same template state bump — so
 * a repaired generation is indistinguishable from a freshly materialized one and
 * the promotion pass needs no special case for it.
 */
async function writeRepairedGeneration(
  prisma: Pick<DesktopPrisma, "write">,
  sessionId: string,
  stored: StoredTemplateGeneration,
  rebuilt: AgentComponentInvocationSyncPart[]
): Promise<void> {
  const now = new Date().toISOString();
  const nextGenerationId = rebuilt[0]?.externalGenerationId;
  await prisma.write((client) =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM agent_component_invocation_sync_outbox
          WHERE source_key = $1 AND external_session_id = $2`,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        sessionId
      );
      // Every target-scoped clone of the SUPERSEDED generation. Scoped to the
      // old generation id so a target that has already moved on is untouched,
      // and it unblocks the session for re-promotion in the same stroke: a
      // pending delivery row is exactly what `prepareInvocationSyncTarget`
      // treats as in-flight and refuses to re-materialize over.
      // `startsWith`, never a raw `LIKE`: the template key contains `_`, which
      // LIKE reads as a single-character wildcard, so a hand-written pattern
      // would silently widen the delete. Same predicate shape the outbox
      // integrity scan uses to separate delivery keys from the template key.
      await tx.agentComponentInvocationSyncOutbox.deleteMany({
        where: {
          sourceKey: {
            startsWith: AGENT_COMPONENT_INVOCATION_SYNC_DELIVERY_KEY_PREFIX,
          },
          externalSessionId: sessionId,
          externalGenerationId: stored.externalGenerationId,
        },
      });
      for (const part of rebuilt) {
        await tx.$executeRawUnsafe(
          `INSERT INTO agent_component_invocation_sync_outbox
             (source_key, external_session_id, external_generation_id, part_index,
              part_count, part_hash, source_updated_at, data_revision,
              source_sequence, payload, status, attempt_count, pending_since,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $13, $12, $13)
           ON CONFLICT (source_key, external_session_id, external_generation_id, part_index)
           DO NOTHING`,
          AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
          sessionId,
          part.externalGenerationId,
          part.partIndex,
          part.partCount,
          part.partHash,
          part.sourceUpdatedAt,
          part.dataRevision,
          part.sourceSequence,
          JSON.stringify(part),
          OutboxStatus.Pending,
          // The ORIGINAL queue position is preserved. This lane drains FIFO on
          // `created_at`, and stamping `now` would send every repaired backlog
          // row to the back of the queue behind rows enqueued after it.
          stored.createdAt,
          now
        );
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO agent_component_invocation_sync_cursors
           (source_key, external_session_id, external_generation_id,
            source_sequence, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (source_key, external_session_id) DO UPDATE SET
           external_generation_id = excluded.external_generation_id,
           source_sequence = excluded.source_sequence,
           updated_at = excluded.updated_at`,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        sessionId,
        nextGenerationId,
        // Already advanced by the caller, and taken from the PART so the cursor
        // and the payload cannot disagree about which sequence was written.
        rebuilt[0]?.sourceSequence ?? 0,
        now
      );
      await bumpInvocationSyncTemplateRevision(tx, now);
    })
  );
}
