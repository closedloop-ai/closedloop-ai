import type { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { inferComponentFormat } from "@repo/api/src/types/agent-component-properties";
import { Result, Status } from "@repo/api/src/types/result";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import {
  SourceAccessState,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";
import { agentComponentInvocationsService } from "@/app/agent-sessions/service/component-invocations";
import { computeTargetsService } from "@/app/compute-targets/service";
import { registerDefinitionVersion } from "@/app/definition-registry/service";
import {
  agentComponentProjection,
  type SearchProjectionInput,
  searchIndexService,
} from "@/app/search/search-index-service";
import { admitSyncedCommandComponents } from "@/lib/command-key-admission";
import { mapWithDbConcurrency } from "@/lib/db-fanout";
import type { DesktopAgentComponentsPayload } from "@/lib/desktop-agent-sessions-schema";
import { countProjected, projectIndexKey } from "@/lib/index-key-projection";
import {
  type RecordWriteInTransaction,
  writeInShape,
} from "@/lib/record-write-in-transaction";
import {
  resolveStoredComponentIdentity,
  type StoredComponentIdentity,
  type SyncedComponent,
  toComponentIndexKeys,
} from "./component-identity-lookup";
import { reportComponentIndexKeyProjections } from "./component-index-key-telemetry";
import {
  mapSyncedComponentToUpsert,
  parseDateField,
} from "./component-upsert-args";
import type { DesktopComponentsSyncResponse } from "./contract";
import { dropSkillShadowedCommands } from "./skill-shadow-guard";
import { degradeUnstorableComponentTimestamps } from "./timestamp-floor";
import { reportDegradedComponentTimestamps } from "./timestamp-floor-telemetry";
import { persistVariantUsageScopeHashes } from "./variant-usage-scope-hash";

type DesktopComponentsSyncInput = {
  clerkUserId: string | null;
  computeTargetId: string;
  organizationId: string;
  payload: DesktopAgentComponentsPayload;
  userId: string;
};

/**
 * Upsert a content-hash version-history row for a synced component that carries
 * definition text (FEA-2923). Piggybacks on the existing component sync lane:
 * the cloud accumulates one row per distinct `(org, component, source, hash)` as
 * updated content syncs over time — no separate versions transport. `source` is
 * "" to match the desktop collector's version identity. Returns null (no-op) for
 * components without content.
 *
 * `format` is inferred from the already-synced `installPath` via the shared
 * `inferComponentFormat` SSOT — the same call the desktop collector
 * (`definition-content-collector.ts`) makes when it writes its own version row.
 * The payload carries no `format` of its own, so without this the column stayed
 * null and the read path's `format ?? "md"` fallback labelled every non-markdown
 * definition (mcp→json, workflow→yml, hook→bash) as Markdown on the web Prompt
 * panel while desktop showed the truth (see AGENTS.md "Cross-surface
 * consistency"). Set on `create` only, mirroring the collector's
 * `ON CONFLICT DO UPDATE SET last_seen_at`: a revision's identity includes its
 * content hash, so its format is fixed at first observation.
 */
function buildVersionUpsert(
  component: SyncedComponent,
  organizationId: string,
  stored: StoredComponentIdentity
) {
  if (component.content == null || component.contentHash == null) {
    return null;
  }
  // ISS-8069: this row's identity IS the `(organizationId, componentKind,
  // componentKey, source, contentHash)` UNIQUE btree — four strings in one
  // tuple — so every one of them is taken from the projected keys, not from the
  // raw payload. Taking some from each would build a `where` that cannot match
  // the row the sibling `AgentComponent` upsert just wrote.
  // ISS-8285: taken from the STORED component identity, so a legacy raw row's
  // version history stays on the tuple it is already keyed by instead of a
  // second, projected one appearing beside it.
  const componentKey = stored.componentKey ?? stored.externalComponentId;
  // Projected from the same non-null value the guard above already proved, so
  // this stays a `string` — reusing `indexKeys.contentHash` would drag its
  // nullable type (and a second, unreachable null branch) in behind it.
  const contentHash = projectIndexKey(component.contentHash).value;
  return {
    where: {
      organizationId_componentKind_componentKey_source_contentHash: {
        organizationId,
        componentKind: stored.componentKind,
        componentKey,
        source: "",
        contentHash,
      },
    },
    create: {
      organizationId,
      componentKind: stored.componentKind,
      componentKey,
      source: "",
      contentHash,
      content: component.content,
      usageScopeHash: component.usageScopeHash ?? null,
      format: inferComponentFormat(
        component.componentKind,
        component.installPath
      ),
      // A version row's `firstSeenAt` is when THIS revision (hash) was first
      // observed, not when the component was first installed — so seeding from
      // `component.firstSeenAt` (the install time) would be wrong for every
      // revision after the first.
      //
      // ISS-4662: prefer the desktop's own per-revision observation
      // (`contentFirstSeenAt`, read from its `agent_component_versions` row) so
      // this lane and the variant lane below mean the SAME thing. Falling back to
      // `component.lastSeenAt` — the sync at which the hash surfaced — preserves
      // the previous behavior exactly for a desktop that does not send it
      // (closedloop-ai-stage, #4295).
      firstSeenAt:
        parseDateField(component.contentFirstSeenAt) ??
        parseDateField(component.lastSeenAt),
      lastSeenAt: parseDateField(component.lastSeenAt),
    },
    // The observation window is widened MONOTONICALLY after the upsert (see
    // `widenVersionObservationWindows`), never clobbered here: version identity
    // is org-global, so an older retained observation arriving from one desktop
    // must not overwrite a newer one already recorded from another (whitlockk,
    // #4295).
    //
    // ISS-4965 (Perrin, 2026-10-05): the usage digest is written on update too.
    // Every sync re-links this row to the DefinitionVersion of the redacted body
    // (`registerDefinitionVersionForComponent`), so a row stored before the
    // column existed needs the digest its usage rows carry in the same sync.
    // The redacted body is written too, so a row stored raw before redaction is
    // scrubbed on its next sync (Perrin, 2026-10-05, #8391).
    update: component.usageScopeHash
      ? { usageScopeHash: component.usageScopeHash, content: component.content }
      : {},
    // ISS-6318: the caller discards this upsert's row, so `RETURNING *` would
    // ship every column of a wide `AgentComponentVersion` — `content` included —
    // for a value nobody reads. `no-discarded-wide-prisma-write` cannot police
    // this site whichever way it is written: the call passes an identifier
    // rather than an object literal, so the rule falls out before it tests for
    // `select`. The assertion in service-variants.test.ts is the only guard.
    select: { id: true },
  };
}

/**
 * ISS-4662 — one cloud version row for a component's RETAINED variant
 * (ISS-4564): a lower-precedence same-name revision the desktop keeps in its
 * local `agent_component_versions` table.
 */
/**
 * The identity + observation window of one version row — the only fields the
 * monotonic widening needs, so the primary and variant lanes share it.
 */
type VersionObservation = {
  organizationId: string;
  componentKind: string;
  componentKey: string;
  source: string;
  contentHash: string;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
};

type VariantVersionRow = {
  organizationId: string;
  componentKind: string;
  componentKey: string;
  source: string;
  contentHash: string;
  content: string;
  usageScopeHash: string | null;
  format: string;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
};

/**
 * ISS-4662 — build the content-hash version rows for a component's RETAINED
 * variants.
 *
 * Each variant becomes one more row on the SAME `(org, kind, key, source, hash)`
 * identity `buildVersionUpsert` uses for the primary, differing only in
 * `contentHash` — so the cloud accumulates the revision set the desktop shipped,
 * and the web detail panel stops showing one revision where Desktop shows
 * several. Content identity is the desktop's hash, forwarded verbatim for every
 * hash an index tuple can physically hold — the cloud never re-derives or widens
 * the preimage. ISS-8069 is the ONE exception and it is not a re-keying of
 * anything that exists: a hash over `INDEX_KEY_MAX_BYTES` could not be written
 * at all before, so the row it now lands is one this lane previously threw on.
 *
 * NOT a full mirror of desktop retention, and the docstring used to overclaim
 * that (closedloop-ai-stage, #4295): this lane only ever ADDS rows. A revision
 * that later drops out of the desktop's retention — or out of the packer's
 * per-component entry/byte budget — stops shipping, and the cloud row it already
 * wrote stays. So the cloud set is the union of every subset ever shipped, which
 * can exceed what the desktop currently retains. Pruning cloud version history is
 * deliberately NOT done here (it would delete rows other surfaces link to) and is
 * tracked as its own follow-up.
 *
 * A variant whose hash equals the primary's is skipped: the primary upsert
 * already wrote that row. Deliberately does NOT feed the F1
 * `registerDefinitionVersion` registry — that records exact-definition provenance
 * (`installPath`, `accessState`) which belongs to the PRIMARY revision's file,
 * not to a variant discovered under a different root. Stamping a variant with the
 * primary's path would be a fabricated source; the coarse row's
 * `definitionVersionId` stays null for the Slice-5 backfill instead.
 *
 * `format` prefers the desktop's own inference for THAT revision, falling back
 * to the existing component-level `inferComponentFormat` when a client omits it.
 */
function buildVariantVersionRows(
  component: SyncedComponent,
  organizationId: string,
  stored: StoredComponentIdentity
): { rows: VariantVersionRow[]; projectedCount: number } {
  const variants = component.variants;
  if (!variants || variants.length === 0) {
    return { rows: [], projectedCount: 0 };
  }
  // ISS-8069: variant rows land in the same five-column UNIQUE btree as the
  // primary, so they take the same projected identity. The variant's own hash is
  // projected alongside them — the base ISS-8051 bound on it is 512 CHARACTERS,
  // which does not bound the tuple's BYTES.
  // ISS-8285: the same STORED identity the primary row resolved to — a variant
  // shares its component's five-column tuple, so it must not be keyed by the
  // projection while the primary is keyed by the legacy raw value.
  const componentKey = stored.componentKey ?? stored.externalComponentId;
  const fallbackFormat = inferComponentFormat(
    component.componentKind,
    component.installPath
  );
  const rows: VariantVersionRow[] = [];
  // ISS-8069 (review, whitlockk): a variant hash is an index key like any other, so
  // a variant-only projection has to reach the batch tally too. Counted from the
  // rows actually BUILT, not from `component.variants`, so a variant skipped for
  // matching the primary is not reported as a bound value that landed.
  let projectedCount = 0;
  for (const variant of variants) {
    if (variant.contentHash === component.contentHash) {
      continue;
    }
    const observedAt =
      parseDateField(variant.lastSeenAt) ??
      parseDateField(component.lastSeenAt);
    const variantContentHash = projectIndexKey(variant.contentHash);
    projectedCount += countProjected(variantContentHash);
    rows.push({
      organizationId,
      componentKind: stored.componentKind,
      componentKey,
      source: "",
      contentHash: variantContentHash.value,
      content: variant.content,
      usageScopeHash: variant.usageScopeHash ?? null,
      format: variant.format || fallbackFormat,
      firstSeenAt: parseDateField(variant.firstSeenAt) ?? observedAt,
      lastSeenAt: observedAt,
    });
  }
  return { rows, projectedCount };
}

/**
 * ISS-4662 — persist a whole batch's variant version rows SET-BASED.
 *
 * The first cut issued one `upsert` per variant inside the per-component loop, so
 * a valid 200-component request could expand to as many as 1 600 sequential
 * round trips. The per-request limiter bounds concurrent connections, not total
 * database work, so that was a self-inflicted load multiplier on a single request
 * (whitlockk, #4295). This instead does:
 *
 *   1. ONE `createMany({ skipDuplicates: true })` for the entire batch — an
 *      `INSERT ... ON CONFLICT DO NOTHING` against the version identity, so a
 *      revision the cloud already has is a no-op rather than a rewrite;
 *   2. a monotonic window widening for the rows that already existed, grouped by
 *      timestamp so it is a handful of `updateMany`s (in practice one — a batch
 *      shares its observation instant), not one per row;
 *   3. ONE update setting a sent usage digest on rows that already existed
 *      (`persistVariantUsageScopeHashes`, ISS-4965).
 *
 * Step 2 never moves a window inward. Version identity is org-global, so an
 * older retained observation arriving from one desktop must not overwrite a newer
 * observation already recorded from another; `firstSeenAt` only moves EARLIER and
 * `lastSeenAt` only LATER, mirroring `updateDefinitionObservationWindow` in the
 * definition registry. Content and format are left alone on an existing row: the
 * hash IS the identity, so those are fixed at first observation.
 */
async function persistVariantVersionRows(
  db: TransactionClient,
  rows: readonly VariantVersionRow[]
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await db.agentComponentVersion.createMany({
    data: rows.map((row) => ({ ...row })),
    skipDuplicates: true,
  });
  await widenVersionObservationWindows(db, rows);
  await persistVariantUsageScopeHashes(db, rows);
}

/**
 * Lift the identity fields back out of a primary `buildVersionUpsert` result so
 * the primary row can reuse the same monotonic window widening as the variants.
 */
function versionIdentityWhereSource(versionUpsert: {
  create: {
    organizationId: string;
    componentKind: string;
    componentKey: string;
    source: string;
    contentHash: string;
  };
}) {
  return {
    organizationId: versionUpsert.create.organizationId,
    componentKind: versionUpsert.create.componentKind,
    componentKey: versionUpsert.create.componentKey,
    source: versionUpsert.create.source,
    contentHash: versionUpsert.create.contentHash,
  };
}

/** The unique-identity predicate for one version row. */
function versionIdentityWhere(row: VersionObservation) {
  return {
    organizationId: row.organizationId,
    componentKind: row.componentKind,
    componentKey: row.componentKey,
    source: row.source,
    contentHash: row.contentHash,
  };
}

/**
 * Widen the observation window of already-existing version rows monotonically,
 * grouped by timestamp so the whole batch costs a couple of set-based updates.
 */
async function widenVersionObservationWindows(
  db: TransactionClient,
  rows: readonly VersionObservation[]
): Promise<void> {
  const byFirstSeen = new Map<number, VersionObservation[]>();
  const byLastSeen = new Map<number, VersionObservation[]>();
  for (const row of rows) {
    if (row.firstSeenAt) {
      appendGrouped(byFirstSeen, row.firstSeenAt.getTime(), row);
    }
    if (row.lastSeenAt) {
      appendGrouped(byLastSeen, row.lastSeenAt.getTime(), row);
    }
  }
  for (const [time, group] of byFirstSeen) {
    const observedAt = new Date(time);
    await db.agentComponentVersion.updateMany({
      where: {
        OR: group.map(versionIdentityWhere),
        firstSeenAt: { gt: observedAt },
      },
      data: { firstSeenAt: observedAt },
    });
  }
  for (const [time, group] of byLastSeen) {
    const observedAt = new Date(time);
    await db.agentComponentVersion.updateMany({
      where: {
        OR: group.map(versionIdentityWhere),
        lastSeenAt: { lt: observedAt },
      },
      data: { lastSeenAt: observedAt },
    });
  }
}

function appendGrouped(
  groups: Map<number, VersionObservation[]>,
  key: number,
  row: VersionObservation
): void {
  const existing = groups.get(key);
  if (existing) {
    existing.push(row);
    return;
  }
  groups.set(key, [row]);
}

/**
 * FEA-3290 (F1, Slice 3) — register the exact `DefinitionVersion` + typed
 * `SourceOccurrence` for a synced component that carries definition text, and
 * stamp the resulting `definitionVersionId` onto the coarse
 * `AgentComponentVersion` row the sync just upserted. Runs on the same `db`
 * handle as the sync writes (the shared `withDb` client), immediately after the
 * version upsert, so the F1 rows land in the same request.
 *
 * Every step is an idempotent upsert (or an `IS`-guarded update), so a partial
 * failure and retry re-runs cleanly — mirroring the existing component/version
 * upserts, which are likewise not wrapped in an interactive transaction.
 *
 * Every *new* sync thus self-fills the F1 link, so the historical backfill
 * (Slice 5) only ever needs to sweep pre-F1 rows once, never chase an ongoing
 * gap. No-op for components without content/contentHash (the version row
 * `buildVersionUpsert` gates on the same condition, so there is nothing to link).
 * Additive only — a mere refresh never overwrites a surface (AC-018): the
 * registry upserts on `(organizationId, definitionHash)` and the occurrence on
 * its natural key, so re-syncing identical content bumps `lastSeenAt` and links
 * the same version, never rewrites another org's or another version's row.
 *
 * `organizationId` and `computeTargetId` are the authenticated caller's, never
 * the payload's.
 */
async function registerDefinitionVersionForComponent(
  db: TransactionClient,
  component: SyncedComponent,
  stored: StoredComponentIdentity,
  organizationId: string,
  computeTargetId: string,
  editorUserId: string
): Promise<void> {
  if (component.content == null || component.contentHash == null) {
    return;
  }
  const definitionVersionId = await registerDefinitionVersion(db, {
    organizationId,
    // ISS-8201: the RAW kind is the FINGERPRINT input, the PROJECTED one is what
    // lands in the index-bearing column — and they are deliberately two
    // arguments, not one.
    //
    // `DefinitionVersion` carries its own `@@index([organizationId,
    // componentKind])`, so this is a second btree the same string lands in, and
    // it is the one the wire cap used to be standing in front of. With that cap
    // gone, writing the raw kind into that column made an over-long component
    // throw `index row size ... exceeds btree version 4 maximum` inside the
    // fan-out, after siblings had committed: strictly worse than the 400 the cap
    // produced. So the column takes the projection — the same value the sibling
    // `AgentComponent` row is stored under (`toComponentIndexKeys`), keeping ONE
    // spelling of the kind across the two tables.
    //
    // The HASH must not move with it (codex P2 + whitlockk review, PR #7220).
    // `definitionHash` IS the version identity, so folding the projection into it
    // would rekey every version already registered under a raw multibyte kind —
    // a resync would miss the existing row, insert a duplicate, and move the
    // `AgentComponentVersion` link — and would split provenance against any
    // producer that registers the same bytes without a projection.
    //
    // NOT counted again: the projection is the same key the batch tally already
    // reported once via `toComponentIndexKeys`, and `projectIndexKey` is a pure
    // function of its input, so re-deriving it here cannot disagree.
    componentKind: component.componentKind as AgentComponentKind,
    storedComponentKind: projectIndexKey(component.componentKind)
      .value as AgentComponentKind,
    content: component.content,
    format: inferComponentFormat(
      component.componentKind,
      component.installPath
    ),
    computeTargetId,
    // FEA-3982 edit-lineage: the authenticated syncing user is an editor of this
    // exact version hash. Sourced from the verified caller, never the payload.
    editorUserId,
    installPath: component.installPath ?? null,
    accessState:
      component.accessState === "inaccessible"
        ? SourceAccessState.inaccessible
        : SourceAccessState.accessible,
    observedAt:
      parseDateField(component.scannedAt) ??
      parseDateField(component.lastSeenAt) ??
      undefined,
  });

  // Stamp the coarse version row's F1 link. `buildVersionUpsert` upserted this
  // exact row above; the where-key mirrors it (same "" source sentinel + the
  // componentKey fallback), and `organizationId` scopes it so no cross-org row
  // is ever touched.
  //
  // ISS-8285 (review — codex, whitlockk): mirrors it through the SAME STORED
  // identity `buildVersionUpsert` wrote with, never a fresh projection of the
  // payload. Re-deriving the keys here was correct only while both sides
  // projected; once the version upsert adopted a legacy raw component's stored
  // identity, this rebuilt a DIFFERENT tuple, so the update raised P2025 AFTER
  // the component and version writes had already landed — a partial sync whose
  // retry replays the same failure forever.
  const componentKey = stored.componentKey ?? stored.externalComponentId;
  await db.agentComponentVersion.update({
    where: {
      organizationId_componentKind_componentKey_source_contentHash: {
        organizationId,
        componentKind: stored.componentKind,
        componentKey,
        source: "",
        // Projected from the same non-null value the guard at the top of this
        // function already proved, exactly as `buildVersionUpsert` does. No
        // `?? ""` fallback: an empty-string key would silently target a
        // different row rather than fail.
        contentHash: projectIndexKey(component.contentHash).value,
      },
    },
    data: { definitionVersionId },
    select: { id: true },
  });
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
    input: DesktopComponentsSyncInput,
    recordInventoryWrite?: RecordWriteInTransaction<undefined>
  ): Promise<Result<DesktopComponentsSyncResponse, typeof Status.Forbidden>> {
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

    // ISS-11449 retired the org session-sync policy, so ownership of the compute
    // target above is the only gate at every ingest boundary now, this one
    // included. Component INVENTORY carries no session-derived content anyway —
    // it is the set of agents, skills and commands installed on a machine — so
    // it never had an egress gate to lose.

    const { components, schemaVersion: _schemaVersion } = input.payload;

    // Upsert each component existence row. idempotent by the unique index on
    // (computeTargetId, componentKind, externalComponentId). Each unit also
    // accumulates the content-hash version history (FEA-2923) from the same
    // payload — one row per distinct (component, source, hash).
    //
    // This is the fan-out that took production down on 2026-07-15. Each in-flight
    // upsert borrows one pooled pg connection, so the unbounded `Promise.all`
    // this once used grabbed one per component: a device with a large inventory —
    // or a burst of devices re-syncing at once (the thundering-herd resync after
    // an api redeploy, or right after local sync is repaired) — drained the pool
    // in a single request and starved every other endpoint, surfacing as
    // `timeout exceeded when trying to connect` across the API. `mapWithDbConcurrency`
    // caps peak connection use regardless of inventory size; the upserts stay
    // idempotent, only their concurrency changes. See PR #2892 and FEA-3299.
    // FEA-4011 Slice A: capture the durable projection inputs from each upserted
    // component row so the `search_document` projection is indexed AFTER the
    // primary write commits. An uninstalled component (`uninstalledAt` set) is
    // removed from the projection instead of indexed. Collected here and flushed
    // below so a projection failure can never roll back or fail this sync.
    const indexed: ReturnType<typeof agentComponentProjection>[] = [];
    const removed: string[] = [];
    // ISS-8069: how many index-key columns this inventory had to be projected
    // down on. One emission for the whole request, never one per component, and
    // incremented only where the write that stored the projected key has
    // already resolved — an attempted projection is not a persisted one.
    let indexKeyProjections = 0;

    // `withDb` is NOT a transaction — each component upsert commits on its own.
    // Collect the projection input as each upsert succeeds, and flush in a
    // `finally` so that if a LATER element's version/registry write throws
    // (fail-fast fan-out), the already-committed rows still get indexed instead
    // of being left out of search until the next sync/backfill (FEA-4011
    // review). The flush hooks are themselves fail-open, so flushing on the
    // error path never masks the original failure.
    try {
      await withDb(async (db) => {
        // ISS-4778: version-skew guard. An older Desktop still emits a phantom
        // `command` row for a slash-invoked SKILL; ingesting it would re-pollute
        // the inventory right after the one-time backfill migration cleaned it
        // out. Dropped BEFORE the upsert fan-out so the row is never written,
        // never indexed into search, and never relinked to an invocation.
        // ISS-4795/ISS-4796: the same version-skew reasoning, one lane over. An
        // older Desktop still posts `//clear` (a second identity for `/clear`)
        // and `/...` (a truncated palette string, not a command). Normalized and
        // admitted BEFORE the shadow guard so that guard's slash-key predicate
        // sees the collapsed key, and before the upsert fan-out so neither can
        // mint an inventory row.
        const admitted = admitSyncedCommandComponents(components);
        if (admitted.length !== components.length) {
          log.info("Dropped inadmissible command components at sync ingest", {
            computeTargetId: input.computeTargetId,
            droppedCount: components.length - admitted.length,
            organizationId: input.organizationId,
          });
        }
        const unshadowed = await dropSkillShadowedCommands(
          db,
          admitted,
          input.computeTargetId
        );
        if (unshadowed.length !== admitted.length) {
          log.info("Dropped skill-shadowed phantom command components", {
            computeTargetId: input.computeTargetId,
            droppedCount: admitted.length - unshadowed.length,
            organizationId: input.organizationId,
          });
        }
        // ISS-8735: strip every timestamp below the Postgres floor BEFORE any
        // write. `withDb` is not a transaction, so the INSERT that used to
        // throw on one left the earlier components durable and the request
        // 500'd forever. Runs AFTER the shadow drop so the tally reports only
        // components that are actually written. Reporting is throttled per
        // (org, compute target) rather than emitted per request, because the
        // desktop replays a poisoned batch forever and nothing repairs it —
        // see `timestamp-floor-telemetry.ts`.
        const { components: ingestible, degraded } =
          degradeUnstorableComponentTimestamps(unshadowed);
        reportDegradedComponentTimestamps(
          {
            computeTargetId: input.computeTargetId,
            organizationId: input.organizationId,
          },
          degraded
        );
        // ISS-4662: variant version rows are collected across the whole batch
        // and written SET-BASED once, instead of one upsert per variant inside
        // this loop (which could reach ~1 600 sequential round trips for a valid
        // 200-component request). See `persistVariantVersionRows`.
        const variantRows: VariantVersionRow[] = [];
        // ISS-8069 (review, davetho): variant projections are tallied only
        // once their SET-BASED write below has committed, so they are held
        // apart from the per-component count until then. Counting them as the
        // rows are BUILT would report attempted projections as persisted ones
        // whenever `persistVariantVersionRows` throws.
        let variantIndexKeyProjections = 0;
        await mapWithDbConcurrency(ingestible, async (component) => {
          const variants = await writeInShape(recordInventoryWrite, {
            unrecorded: async () => {
              // ISS-8285: resolved ONCE per component and threaded through every
              // statement below, so the component upsert, its version row and its
              // variant rows cannot disagree about which identity this sync is
              // about.
              const { stored, upserted } = await upsertSyncedComponent(
                db,
                component,
                input
              );
              // Tallied HERE, after the upsert that stored them resolved, and not
              // from a pre-pass over `ingestible`: the fan-out is not a
              // transaction, so a component whose write throws stored no projected
              // key and must not be counted (review, davetho).
              indexKeyProjections +=
                toComponentIndexKeys(component).projectedCount;
              collectComponentProjection({ indexed, removed }, upserted);
              return await writeComponentHistory(db, component, input, stored);
            },
            // ISS-12552: recorded, each component writes in its
            // own transaction with the caller's receipt for it, so a component
            // and its receipt commit or roll back together. Its projection is
            // collected once that transaction committed.
            recorded: async (record) => {
              const written = await withDb.tx(async (tx) => {
                const { stored, upserted } = await upsertSyncedComponent(
                  tx,
                  component,
                  input
                );
                const history = await writeComponentHistory(
                  tx,
                  component,
                  input,
                  stored
                );
                await record(tx, undefined);
                return { upserted, history };
              });
              indexKeyProjections +=
                toComponentIndexKeys(component).projectedCount;
              collectComponentProjection(
                { indexed, removed },
                written.upserted
              );
              return written.history;
            },
          });
          variantIndexKeyProjections += variants.projectedCount;
          variantRows.push(...variants.rows);
        });
        await writeInShape(recordInventoryWrite, {
          unrecorded: () => persistVariantVersionRows(db, variantRows),
          recorded: (record) => persistRecordedVariantRows(variantRows, record),
        });
        indexKeyProjections += variantIndexKeyProjections;
      });
    } finally {
      flushComponentSearchIndex(input.organizationId, indexed, removed);
      // In the `finally` for the same reason the index flush is: the fan-out is
      // not a transaction, so a request that threw part-way still WROTE the
      // projected keys of everything that committed before it, and that is
      // exactly the case worth hearing about.
      reportComponentIndexKeyProjections(input, indexKeyProjections);
    }

    // Invocation sync may arrive before inventory. Once inventory is durable,
    // repair active rows with a single org/target-scoped set-based update. This
    // is derived materialization: a repair failure must not roll back or report
    // failure for the authoritative component inventory that already synced.
    try {
      await agentComponentInvocationsService.relinkActiveForComputeTarget({
        organizationId: input.organizationId,
        computeTargetId: input.computeTargetId,
      });
    } catch (error) {
      log.warn("Late agent component invocation relink failed", {
        organizationId: input.organizationId,
        computeTargetId: input.computeTargetId,
        error,
      });
    }

    return Result.ok({ synced: true });
  },
};

/**
 * Flush the collected component search projections through the fail-open,
 * post-commit, BATCH index hooks (FEA-4011). One multi-row upsert + one grouped
 * delete regardless of inventory size — never a per-row fan-out (FEA-3299).
 *
 * De-dupes the upsert batch by org-identity slug so a single sync payload that
 * carries the same component identity twice (or a keyless component whose slug
 * folds together) projects one canonical row — the latest-updated one — instead
 * of several rows that would consume the search page limit. (Cross-compute-target
 * duplicates — the same component installed on multiple devices, each a distinct
 * `AgentComponent` UUID — cannot be seen by one target's write path and are
 * de-duped query-side.)
 */
function flushComponentSearchIndex(
  organizationId: string,
  indexed: SearchProjectionInput[],
  removed: string[]
): void {
  searchIndexService.indexManyAfterCommit(dedupeProjectionsBySlug(indexed));
  searchIndexService.removeManyAfterCommit(
    removed.map((componentId) => ({
      organizationId,
      entityType: SearchEntityType.AgentComponent,
      entityId: componentId,
    }))
  );
}

/**
 * Collapse projections that share the same non-null org-identity `slug` to a
 * single canonical row (the most recently updated). A null slug is an
 * identity-less component that routes to no detail page, so those rows are kept
 * as-is (keyed by their own `entityId`) rather than merged together.
 */
function dedupeProjectionsBySlug(
  projections: SearchProjectionInput[]
): SearchProjectionInput[] {
  const bySlug = new Map<string, SearchProjectionInput>();
  const keyless: SearchProjectionInput[] = [];
  for (const projection of projections) {
    if (projection.slug === null) {
      keyless.push(projection);
      continue;
    }
    const existing = bySlug.get(projection.slug);
    if (!existing || projection.updatedAt > existing.updatedAt) {
      bySlug.set(projection.slug, projection);
    }
  }
  return [...bySlug.values(), ...keyless];
}

/**
 * One component's existence row: its stored identity, resolved ONCE so the
 * upsert, its version row and its variant rows agree on it (ISS-8285), and the
 * upsert itself.
 */
async function upsertSyncedComponent(
  db: TransactionClient,
  component: SyncedComponent,
  input: DesktopComponentsSyncInput
) {
  const stored = await resolveStoredComponentIdentity(
    db,
    input.computeTargetId,
    component
  );
  const upserted = await db.agentComponent.upsert(
    mapSyncedComponentToUpsert(
      component,
      input.organizationId,
      input.computeTargetId,
      stored
    )
  );
  return { stored, upserted };
}

/**
 * One component's history after its upsert: the content-hash version row and
 * its definition registration, and the retained variant rows it carries for
 * the batch-level write.
 */
async function writeComponentHistory(
  db: TransactionClient,
  component: SyncedComponent,
  input: DesktopComponentsSyncInput,
  stored: StoredComponentIdentity
) {
  const versionUpsert = buildVersionUpsert(
    component,
    input.organizationId,
    stored
  );
  if (versionUpsert) {
    await db.agentComponentVersion.upsert(versionUpsert);
    // ISS-4662: the upsert no longer clobbers `lastSeenAt` on conflict
    // (version identity is org-global, so a stale observation from one
    // desktop must not overwrite a newer one from another). Widen the
    // window monotonically instead — same treatment the variant rows get.
    await widenVersionObservationWindows(db, [
      {
        ...versionIdentityWhereSource(versionUpsert),
        firstSeenAt: versionUpsert.create.firstSeenAt ?? null,
        lastSeenAt: versionUpsert.create.lastSeenAt ?? null,
      },
    ]);
    // FEA-3290 (F1): register the exact DefinitionVersion +
    // SourceOccurrence and stamp definitionVersionId onto the version
    // row just upserted, in the same tx. Gated on the same
    // content/contentHash condition as the version upsert, so it only
    // runs when there is a coarse row to link.
    await registerDefinitionVersionForComponent(
      db,
      component,
      stored,
      input.organizationId,
      input.computeTargetId,
      input.userId
    );
  }
  // ISS-4662: the retained variant revisions go to the batch-level set-based
  // write. Built whether or not the PRIMARY carried content: a component whose
  // display row lost its body can still have retained revisions.
  return buildVariantVersionRows(component, input.organizationId, stored);
}

/**
 * FEA-4011: an upserted component goes to the search projection, or is removed
 * from it once uninstalled.
 */
function collectComponentProjection(
  projections: {
    indexed: ReturnType<typeof agentComponentProjection>[];
    removed: string[];
  },
  upserted: Awaited<ReturnType<typeof upsertSyncedComponent>>["upserted"]
): void {
  if (upserted.uninstalledAt === null) {
    projections.indexed.push(
      agentComponentProjection({
        id: upserted.id,
        organizationId: upserted.organizationId,
        componentKind: upserted.componentKind,
        name: upserted.name,
        componentKey: upserted.componentKey,
        externalComponentId: upserted.externalComponentId,
        description: upserted.description,
        updatedAt: upserted.updatedAt,
        // FEA-4335: route the search hit to the content-hash detail URI
        // so two same-named different-content synced components resolve
        // to distinct detail pages instead of colliding.
        contentHash: upserted.contentHash,
      })
    );
  } else {
    projections.removed.push(upserted.id);
  }
}

/**
 * ISS-12552: the request's retained variant rows with the caller's receipt
 * for them, in one transaction; nothing when the request carried none.
 */
async function persistRecordedVariantRows(
  rows: readonly VariantVersionRow[],
  record: RecordWriteInTransaction<undefined>
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await withDb.tx(async (tx) => {
    await persistVariantVersionRows(tx, rows);
    await record(tx, undefined);
  });
}
