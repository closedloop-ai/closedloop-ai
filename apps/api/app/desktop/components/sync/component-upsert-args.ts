import {
  type StoredComponentIdentity,
  type SyncedComponent,
  toComponentIndexKeys,
} from "./component-identity-lookup";

/** Parse an ISO string field to Date, or null if absent. */
export function parseDateField(value: string | null | undefined): Date | null {
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
  computeTargetId: string,
  stored: StoredComponentIdentity
) {
  const indexKeys = toComponentIndexKeys(component);
  return {
    organizationId,
    computeTargetId,
    // ISS-8285: the identity resolved against what is ALREADY stored, not the
    // projection. On the create arm the two are the same value (nothing matched,
    // so the resolver fell back to the projection); naming `stored` anyway keeps
    // one identity source for both arms, so the create can never write a row the
    // sibling `where` could not find again.
    componentKind: stored.componentKind,
    externalComponentId: stored.externalComponentId,
    harness: component.harness ?? null,
    name: component.name ?? null,
    componentKey: stored.componentKey,
    version: component.version ?? null,
    description: component.description ?? null,
    sourceUrl: component.sourceUrl ?? null,
    installPath: component.installPath ?? null,
    packId: component.packId ?? null,
    scope: component.scope ?? null,
    projectPath: component.projectPath ?? null,
    metadata: component.metadata ?? undefined,
    // `content` is unindexed and stays WHOLE — only the hash beside it is
    // projected, so an over-long hash never costs the definition text it
    // describes.
    content: component.content ?? null,
    contentHash: indexKeys.contentHash.value,
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
function buildUpsertUpdate(
  component: SyncedComponent,
  stored: StoredComponentIdentity
) {
  const lastSeenAt = parseDateField(component.lastSeenAt);
  const indexKeys = toComponentIndexKeys(component);
  return {
    harness: component.harness ?? null,
    name: component.name ?? null,
    // ISS-8285: the key the matched row is ALREADY stored under. Writing the
    // projected key here would RE-KEY a legacy row on every sync, orphaning the
    // usage rows and version history that reference the old value.
    componentKey: stored.componentKey,
    version: component.version ?? null,
    description: component.description ?? null,
    sourceUrl: component.sourceUrl ?? null,
    installPath: component.installPath ?? null,
    packId: component.packId ?? null,
    scope: component.scope ?? null,
    projectPath: component.projectPath ?? null,
    metadata: component.metadata ?? undefined,
    content: component.content ?? null,
    contentHash: indexKeys.contentHash.value,
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
export function mapSyncedComponentToUpsert(
  component: SyncedComponent,
  organizationId: string,
  computeTargetId: string,
  stored: StoredComponentIdentity
) {
  return {
    where: {
      computeTargetId_componentKind_externalComponentId: {
        computeTargetId,
        componentKind: stored.componentKind,
        externalComponentId: stored.externalComponentId,
      },
    },
    create: buildUpsertCreate(
      component,
      organizationId,
      computeTargetId,
      stored
    ),
    update: buildUpsertUpdate(component, stored),
  };
}

/**
 * ISS-5029 (whitlockk, #4391): the truncation-marker columns for one upsert, shared
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
