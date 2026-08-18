import type { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { inferComponentFormat } from "@repo/api/src/types/agent-component-properties";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
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
import { isOrgSessionSyncPolicyEnabled } from "@/lib/org-session-sync-policy";
import type { DesktopComponentsSyncResponse } from "./route";
import { dropSkillShadowedCommands } from "./skill-shadow-guard";

type DesktopComponentsSyncInput = {
  clerkUserId: string | null;
  computeTargetId: string;
  organizationId: string;
  payload: DesktopAgentComponentsPayload;
  userId: string;
  /**
   * FEA-4169: server-side ORG POLICY gate. Defaults to the DB-backed
   * {@link isOrgSessionSyncPolicyEnabled}. Overridable in tests.
   */
  isOrgPolicyEnabled?: (organizationId: string) => Promise<boolean>;
};

type SyncedComponent = DesktopAgentComponentsPayload["components"][number];

/** Parse an ISO string field to Date, or null if absent. */
function parseDateField(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

/**
 * Map an optional/nullable ISO date field on the UPDATE path so an OMITTED
 * value is a no-op, not a clear (FEA-4011 review). `uninstalledAt` is optional
 * on the wire; an older Desktop that omits it must not clear an existing
 * tombstone (which would re-index a removed component into search). Three
 * states: `undefined` (omitted → leave stored value untouched), `null`
 * (explicit clear → set null), a string (set the parsed date).
 */
function parseUpdateDateField(
  value: string | null | undefined
): Date | null | undefined {
  if (value === undefined) {
    return undefined;
  }
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
    content: component.content ?? null,
    contentHash: component.contentHash ?? null,
    // F1 (FEA-3290 / PRD-527 Slice 4 / AC-007): honest resolution state. A
    // brand-new cloud row minted from a label with no captured definition
    // defaults to `unresolved` (mirrors the desktop mint gate) so it never
    // surfaces as a configured component; a stale desktop that omits the field
    // folds to the same default.
    resolvedState: component.resolvedState ?? "unresolved",
    ...buildVariantsTruncationWrite(component),
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
    content: component.content ?? null,
    contentHash: component.contentHash ?? null,
    // F1 (FEA-3290 Slice 4 / AC-007): update the resolution state ONLY when the
    // desktop sends one. `undefined` (a stale client that omits the field) is a
    // no-op — it must never demote a cloud row the collector already resolved.
    resolvedState: component.resolvedState ?? undefined,
    ...buildVariantsTruncationWrite(component),
    lastSeenAt: lastSeenAt ?? undefined,
    // Preserve an OMITTED `uninstalledAt` (undefined → no-op) so a stale Desktop
    // that drops the field does not clear an existing tombstone and resurrect a
    // removed component in search. Only an explicit null clears it.
    uninstalledAt: parseUpdateDateField(component.uninstalledAt),
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
  organizationId: string
) {
  if (component.content == null || component.contentHash == null) {
    return null;
  }
  const componentKey = component.componentKey ?? component.externalId;
  return {
    where: {
      organizationId_componentKind_componentKey_source_contentHash: {
        organizationId,
        componentKind: component.componentKind,
        componentKey,
        source: "",
        contentHash: component.contentHash,
      },
    },
    create: {
      organizationId,
      componentKind: component.componentKind,
      componentKey,
      source: "",
      contentHash: component.contentHash,
      content: component.content,
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
    // must not overwrite a newer one already recorded from another (wongk,
    // #4295).
    update: {},
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
 * several. Content identity is the desktop's hash forwarded VERBATIM; the cloud
 * never re-derives or widens the preimage, so no existing version row is re-keyed
 * or orphaned by this lane.
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
  organizationId: string
): VariantVersionRow[] {
  const variants = component.variants;
  if (!variants || variants.length === 0) {
    return [];
  }
  const componentKey = component.componentKey ?? component.externalId;
  const fallbackFormat = inferComponentFormat(
    component.componentKind,
    component.installPath
  );
  const rows: VariantVersionRow[] = [];
  for (const variant of variants) {
    if (variant.contentHash === component.contentHash) {
      continue;
    }
    const observedAt =
      parseDateField(variant.lastSeenAt) ??
      parseDateField(component.lastSeenAt);
    rows.push({
      organizationId,
      componentKind: component.componentKind,
      componentKey,
      source: "",
      contentHash: variant.contentHash,
      content: variant.content,
      format: variant.format || fallbackFormat,
      firstSeenAt: parseDateField(variant.firstSeenAt) ?? observedAt,
      lastSeenAt: observedAt,
    });
  }
  return rows;
}

/**
 * ISS-4662 — persist a whole batch's variant version rows SET-BASED.
 *
 * The first cut issued one `upsert` per variant inside the per-component loop, so
 * a valid 200-component request could expand to as many as 1 600 sequential
 * round trips. The per-request limiter bounds concurrent connections, not total
 * database work, so that was a self-inflicted load multiplier on a single request
 * (wongk, #4295). This instead does:
 *
 *   1. ONE `createMany({ skipDuplicates: true })` for the entire batch — an
 *      `INSERT ... ON CONFLICT DO NOTHING` against the version identity, so a
 *      revision the cloud already has is a no-op rather than a rewrite;
 *   2. a monotonic window widening for the rows that already existed, grouped by
 *      timestamp so it is a handful of `updateMany`s (in practice one — a batch
 *      shares its observation instant), not one per row.
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
  organizationId: string,
  computeTargetId: string,
  editorUserId: string
): Promise<void> {
  if (component.content == null || component.contentHash == null) {
    return;
  }
  const definitionVersionId = await registerDefinitionVersion(db, {
    organizationId,
    // `componentKind` is a free-form string on the wire; the fingerprint folds
    // it in verbatim, so passing it through is faithful.
    componentKind: component.componentKind as AgentComponentKind,
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
  const componentKey = component.componentKey ?? component.externalId;
  await db.agentComponentVersion.update({
    where: {
      organizationId_componentKind_componentKey_source_contentHash: {
        organizationId,
        componentKind: component.componentKind,
        componentKey,
        source: "",
        contentHash: component.contentHash,
      },
    },
    data: { definitionVersionId },
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

    // FEA-4169: server-owned ORG POLICY gate. Component inventory rows are
    // session-derived data materialized at transcript-import time, so a
    // policy-off org must not ingest them either — enforced server-side so an
    // older/compromised Desktop that ignores the policy cannot persist them.
    // Fail-closed (unresolved org → deny) and independent of any client field.
    const isOrgPolicyEnabled =
      input.isOrgPolicyEnabled ?? isOrgSessionSyncPolicyEnabled;
    if (!(await isOrgPolicyEnabled(input.organizationId))) {
      return Result.err(Status.Forbidden);
    }

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
        const ingestible = await dropSkillShadowedCommands(
          db,
          admitted,
          input.computeTargetId
        );
        if (ingestible.length !== admitted.length) {
          log.info("Dropped skill-shadowed phantom command components", {
            computeTargetId: input.computeTargetId,
            droppedCount: admitted.length - ingestible.length,
            organizationId: input.organizationId,
          });
        }
        // ISS-4662: variant version rows are collected across the whole batch
        // and written SET-BASED once, instead of one upsert per variant inside
        // this loop (which could reach ~1 600 sequential round trips for a valid
        // 200-component request). See `persistVariantVersionRows`.
        const variantRows: VariantVersionRow[] = [];
        await mapWithDbConcurrency(ingestible, async (component) => {
          const upserted = await db.agentComponent.upsert(
            mapSyncedComponentToUpsert(
              component,
              input.organizationId,
              input.computeTargetId
            )
          );
          if (upserted.uninstalledAt === null) {
            indexed.push(
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
            removed.push(upserted.id);
          }
          const versionUpsert = buildVersionUpsert(
            component,
            input.organizationId
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
              input.organizationId,
              input.computeTargetId,
              input.userId
            );
          }
          // ISS-4662: collect the retained variant revisions for the batch-level
          // set-based write below. Runs whether or not the PRIMARY carried
          // content — a component whose display row lost its body can still have
          // retained revisions.
          variantRows.push(
            ...buildVariantVersionRows(component, input.organizationId)
          );
        });
        await persistVariantVersionRows(db, variantRows);
      });
    } finally {
      flushComponentSearchIndex(input.organizationId, indexed, removed);
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
 * ISS-5029 (wongk, #4391): the truncation-marker columns for one upsert, shared
 * by `create` and `update` so the two can never drift.
 *
 * The wire field has THREE states and they mean three different things:
 *
 *  - **absent** — a desktop that predates the marker. It has NO OPINION, so both
 *    keys are omitted and Prisma no-ops: `update` leaves whatever is stored
 *    alone, `create` takes the column's `false` default. This is the case the
 *    first cut got wrong — folding absent to `false` let a stale desktop CLEAR a
 *    `true` that an upgraded peer device on the same identity had just recorded,
 *    which is a plain version-skew regression.
 *  - **`false`** — a marker-aware packer stating it dropped nothing. That is a
 *    real claim and it must be able to clear a stale `true`, so it writes
 *    `false` and nulls the reason.
 *  - **`true`** — truncation, with the reason that bound alongside it.
 *
 * The reason is stored VERBATIM rather than validated against the known set: a
 * newer desktop's reason is then preserved for whoever learns it, and the only
 * consumer (`emitVersionsTruncated`) already treats anything it does not
 * recognize as "no proof", which is the same safe default as absent.
 */
function buildVariantsTruncationWrite(component: SyncedComponent): {
  variantsTruncated?: boolean;
  variantsTruncatedReason?: string | null;
} {
  if (component.variantsTruncated === undefined) {
    return {};
  }
  if (component.variantsTruncated) {
    return {
      variantsTruncated: true,
      variantsTruncatedReason: component.variantsTruncatedReason ?? null,
    };
  }
  return { variantsTruncated: false, variantsTruncatedReason: null };
}
