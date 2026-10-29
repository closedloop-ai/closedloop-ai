import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type {
  SyncedAgentSession,
  SyncedComponentUsage,
} from "@repo/api/src/types/agent-session";
import { admitSyncedCommandUsage } from "@/lib/command-key-admission";
import { normalizeStoredIndexKey } from "@/lib/index-key-lookup";
import {
  countProjected,
  projectIndexKey,
  projectNullableIndexKey,
} from "@/lib/index-key-projection";
import { isStorableInt4Count } from "@/lib/int4-column-bounds";
import { earliestTimestamp, latestTimestamp } from "@/lib/iso-timestamp-bounds";
import {
  isSkillShadowedPhantom,
  loadSkillShadowInventory,
  skillShadowBareName,
} from "@/lib/skill-shadow";
import {
  buildComponentLookupKey,
  type ComponentInventoryLookupPair,
  type ComponentUsageGroup,
  deleteShadowedCommandRows,
  insertComponentUsageRows,
  loadComponentInventoryRows,
  pruneStaleBranchBuckets,
  toComponentUsageInsertRow,
} from "./component-usage-writes";
import type { AgentSessionUpsertTx } from "./records";

/**
 * Batch-fetch existing AgentComponent rows for the given compute target and
 * the set of (componentKind, externalComponentId) pairs referenced by the
 * session's usage entries. Returns a map from lookup key → agentComponentId
 * so the caller can resolve the nullable FK without N+1 queries.
 *
 * Only entries with a non-null externalComponentId are fetched; built-in
 * tools (e.g. Read/Bash) have no inventory row and always resolve to null.
 */
async function resolveAgentComponentIdMap(
  tx: AgentSessionUpsertTx,
  computeTargetId: string,
  usages: readonly SyncedComponentUsage[]
): Promise<Map<string, string>> {
  // ISS-8062: DEDUPE BEFORE LOOKUP. `usages` is deduped on the natural
  // key, which includes gitBranch — so one component observed on N branches
  // still arrives as N rows carrying the SAME (kind, externalComponentId). The
  // lookup only cares about DISTINCT pairs, and folding them here is what keeps
  // a branch-heavy session to a single lookup pair instead of one per branch
  // bucket.
  const pairsByKey = new Map<string, ComponentInventoryLookupPair>();
  for (const usage of usages) {
    const externalComponentId = usage.externalComponentId?.trim();
    if (externalComponentId) {
      pairsByKey.set(
        buildComponentLookupKey(usage.componentKind, externalComponentId),
        {
          componentKind: usage.componentKind,
          externalComponentId,
        }
      );
    }
  }
  const pairs = [...pairsByKey.values()];
  if (pairs.length === 0) {
    return new Map();
  }

  const result = new Map<string, string>();
  const rows = await loadComponentInventoryRows(tx, computeTargetId, pairs);
  for (const row of rows) {
    // ISS-8200: keyed on the PROJECTED identity whichever key the row was found
    // under, so a legacy raw row resolves the same FK its projected sibling
    // would — `toComponentUsageInsertRow` looks up with the projected value.
    const componentKind = normalizeStoredIndexKey(row.componentKind);
    const externalComponentId = normalizeStoredIndexKey(
      row.externalComponentId
    );
    const key = buildComponentLookupKey(componentKind, externalComponentId);
    // ISS-8200 (review): a legacy RAW row and its projected sibling fold onto
    // this one key, and ISS-8285 records that the pre-fix syncs really did mint
    // that pair. The statement has no ORDER BY, so an unguarded `set` would let
    // whatever order Postgres returned decide the FK — the same identity
    // resolving to a different inventory row between syncs, which is exactly
    // what the ordered probe in `lib/index-key-lookup.ts` refuses to do. The
    // PROJECTED row wins here for the same reason it wins there, and the test
    // is order-independent: a row stored under the projected form is the one
    // whose stored key survives normalization unchanged.
    const isProjectedForm =
      row.componentKind === componentKind &&
      row.externalComponentId === externalComponentId;
    if (!result.has(key) || isProjectedForm) {
      result.set(key, row.id);
    }
  }
  return result;
}

/**
 * T-7.6 / AC-011: upsert AgentComponentSessionUsage rows for all entries in
 * `session.components[]`. Idempotent — keyed by (agentSessionId, componentKind,
 * componentKey). Omission (older desktop builds that do not send the field)
 * is a no-op: previously persisted rows are left untouched.
 *
 * The nullable agentComponentId FK is resolved via a batched lookup on
 * (computeTargetId, componentKind, externalComponentId) — no server-side
 * re-parsing of events; the desktop sends the pre-materialized usage rows.
 */
export async function persistSessionComponentUsage(
  tx: AgentSessionUpsertTx,
  computeTargetId: string,
  agentSessionId: string,
  session: SyncedAgentSession
): Promise<SessionComponentUsageTally> {
  const reported = session.components;
  if (!reported || reported.length === 0) {
    return EMPTY_COMPONENT_USAGE_TALLY;
  }

  // ISS-4795/ISS-4796: normalize legacy Desktop command spellings before
  // folding skill-shadowed command rows and persisting the authoritative set.
  const rawUsages = admitSyncedCommandUsage(reported);
  if (rawUsages.length === 0) {
    return EMPTY_COMPONENT_USAGE_TALLY;
  }

  // ISS-4778: version-skew guard. An older Desktop still reports a phantom
  // `command` rollup for a slash-invoked SKILL; persisting it would recreate the
  // usage rows the one-time backfill migration just collapsed. Folded BEFORE the
  // branch-bucket prune below so the phantom's own group never participates in
  // the keep-set computation.
  const { shadowTargetBuckets, usages: foldedUsages } =
    await foldSkillShadowedCommandUsage(tx, computeTargetId, rawUsages);
  const dedupedUsages = dedupeComponentUsages(foldedUsages);

  // ISS-8125: projected ONCE, after the fold, and used for every statement
  // below. The fold and the dedupe read the RAW key on purpose —
  // `skillShadowBareName` parses the `/name` spelling, and the projection is
  // injective, so deduping raw and deduping projected produce the same groups.
  // Everything that touches a COLUMN from here on takes the projected value.
  const projection = projectComponentUsageIndexKeys(dedupedUsages);
  const usages = projection.usages;

  // ISS-8881: the int4 test runs on the counts that actually reach the column,
  // so it covers the un-merged single row as well as the merged sum — see
  // `isStorableInt4Count`, applied by `partitionStorableUsages` below.
  //
  // THE PRUNE STILL SEES THE DROPPED BUCKET, and that is load-bearing.
  // `pruneStaleBranchBuckets` below treats `usages` as the authoritative branch
  // set for every `(kind, key)` group it contains, deleting any stored branch
  // bucket the payload no longer lists. Hiding a dropped bucket from it would
  // DELETE that branch's previously-stored good row whenever a SIBLING branch of
  // the same component kept it in the group set — destroying a sound prior
  // measurement because this payload's value for a different branch was corrupt.
  // Today that payload throws at the INSERT and deletes nothing, so the prune
  // must keep reading the full set. Only the INSERT drops the bucket.
  const {
    droppedOverflowUsageBuckets,
    droppedRawBuckets,
    legacyGroups: insertableLegacyGroups,
    usages: insertableUsages,
  } = partitionStorableUsages(dedupedUsages, usages, projection.legacyGroups);

  await deleteShadowedCommandRows(
    tx,
    agentSessionId,
    // ISS-8125: the stored column holds the projected key, so every value
    // filtering it goes through the same projection as the writes below. A
    // NO-OP on every input reachable today, and said plainly rather than
    // dressed up as a fix: a key only lands in `shadowTargetBuckets` when
    // `loadSkillShadowInventory` matched a stored skill by its bare name, and
    // that stored key is itself already projected, so an over-long command key
    // can never be shadowed in the first place. Kept because the alternative is
    // one call site that reads a column differently from its siblings for a
    // reason no future reader would find.
    deletableShadowedCommandKeys(shadowTargetBuckets, droppedRawBuckets).map(
      (key) => projectIndexKey(key).value
    )
  );

  // ISS-8200: the lookup takes the RAW rows, not the projected ones. The
  // projection is LOSSY and non-invertible, so a projected external id cannot
  // yield back the raw value a pre-ISS-8069 inventory row is still stored
  // under — only the original can. The map it returns is keyed on the projected
  // identity either way, which is what `toComponentUsageInsertRow` looks up.
  const componentIdMap = await resolveAgentComponentIdMap(
    tx,
    computeTargetId,
    dedupedUsages
  );

  // FEA-2990 double-count guard: the natural key now includes gitBranch, so a
  // resync that moves a (session, component) off the old '' bucket to real
  // branch buckets — e.g. an older desktop build synced `''`, a newer one now
  // sends `feat/a`+`feat/b` for the same (kind, key) — would otherwise leave the
  // stale `''` row behind. Detail + token-trend sum ALL rows per (kind, key), so
  // that orphan double-counts invocations. The desktop rematerializes and sends
  // the COMPLETE set of branch buckets for every (kind, key) it reports, so the
  // payload is authoritative: for each present (kind, key) group, drop any
  // existing branch bucket the payload no longer includes before upserting.
  // True branchless rows still present in the payload survive (their `''` bucket
  // is in the keep-set). Groups absent from the payload are untouched — an
  // omitted section never clears previously synced cloud rows.
  // ISS-8253 (review, codex): a usage row written before ISS-8125 projected this
  // column is still stored under its RAW key, so the projected `ON CONFLICT`
  // target below misses it and mints a SECOND bucket for the same component —
  // and detail + token-trend, which sum ALL rows per (kind, key), then
  // double-count it forever. Nothing throws. The legacy group joins the prune's
  // group set (never its keep-set), so the resync deletes the raw row and the
  // insert replaces it under the projected key.
  await pruneStaleBranchBuckets(
    tx,
    agentSessionId,
    usages,
    insertableLegacyGroups
  );

  const rows = insertableUsages.map((usage) =>
    toComponentUsageInsertRow(agentSessionId, usage, componentIdMap)
  );

  await insertComponentUsageRows(tx, rows);
  return {
    indexKeyProjections: projection.projectedCount,
    droppedOverflowUsageBuckets,
  };
}

function dedupeComponentUsages(
  usages: readonly SyncedComponentUsage[]
): SyncedComponentUsage[] {
  const byNaturalKey = new Map<string, SyncedComponentUsage>();
  for (const usage of usages) {
    byNaturalKey.set(usageBucketKey(usage), usage);
  }
  return [...byNaturalKey.values()];
}

/** The natural key a usage row upserts on, minus the session. */
function usageBucketKey(usage: SyncedComponentUsage): string {
  return `${usage.componentKind}\u0000${usage.componentKey}\u0000${usage.gitBranch?.trim() ?? ""}`;
}

/**
 * Sum a phantom rollup into the skill rollup that survives it.
 *
 * ISS-8881: this no longer screens the sum. A merged count past the `int4`
 * ceiling is caught by `partitionStorableUsages`, which tests the value that
 * actually reaches the column — so the sum case stays covered by one check
 * instead of two, and the un-merged single row it never covered is covered too.
 */
function mergeUsage(
  survivor: SyncedComponentUsage,
  phantom: SyncedComponentUsage
): SyncedComponentUsage {
  return {
    ...survivor,
    errorCount: survivor.errorCount + phantom.errorCount,
    firstInvokedAt: earliestTimestamp(
      survivor.firstInvokedAt,
      phantom.firstInvokedAt
    ),
    invocations: survivor.invocations + phantom.invocations,
    lastInvokedAt: latestTimestamp(
      survivor.lastInvokedAt,
      phantom.lastInvokedAt
    ),
  };
}

/**
 * ISS-4778 (Part 2 of ISS-4775) — fold the phantom `command` rollups a
 * version-skewed Desktop still reports for slash-invoked skills into the real
 * skill rollup, matching the one-time backfill migration exactly: sum the counts
 * into a colliding skill bucket (step 2a), or re-point the bucket onto the skill
 * identity when nothing collides (step 2c).
 *
 * Deliberately conservative. A usage row carries no `resolvedState`/`content`, so
 * the stored inventory is the evidence: a slash-keyed command folds only when a
 * RESOLVED skill with the bare name exists on this compute target AND no
 * RESOLVED command with that slash key does. A genuine `/deploy` — with or
 * without a `deploy` skill beside it — is always kept.
 *
 * Costs at most ONE extra indexed read, and only when the payload actually
 * carries a slash-keyed command rollup.
 *
 * ISS-8193: that read is owned by `loadSkillShadowInventory`
 * (`@/lib/skill-shadow`), which keeps its own bind safety because the same
 * predicate is shared by the usage and invocation lanes.
 */
async function foldSkillShadowedCommandUsage(
  tx: AgentSessionUpsertTx,
  computeTargetId: string,
  usages: readonly SyncedComponentUsage[]
): Promise<{
  usages: SyncedComponentUsage[];
  shadowTargetBuckets: ShadowTargetBuckets;
}> {
  const bareNameByUsage = new Map<SyncedComponentUsage, string>();
  for (const usage of usages) {
    const bareName = skillShadowBareName(
      usage.componentKind,
      usage.componentKey
    );
    if (bareName) {
      bareNameByUsage.set(usage, bareName);
    }
  }
  if (bareNameByUsage.size === 0) {
    return { shadowTargetBuckets: new Map(), usages: [...usages] };
  }

  const inventory = await loadSkillShadowInventory(tx, computeTargetId, [
    ...new Set(bareNameByUsage.values()),
  ]);
  const { resolvedSkills } = inventory;

  const kept: SyncedComponentUsage[] = [];
  const phantoms: Array<{ bareName: string; usage: SyncedComponentUsage }> = [];
  const shadowTargetBuckets: ShadowTargetBuckets = new Map();
  for (const usage of usages) {
    const bareName = bareNameByUsage.get(usage);
    // ISS-4923 (whitlockk review): the shared predicate, so this lane and the
    // invocation normalization can never disagree about what a phantom is.
    const isPhantom = isSkillShadowedPhantom(
      inventory,
      bareName ?? null,
      usage.componentKey
    );
    if (bareName && isPhantom) {
      phantoms.push({ bareName, usage });
      recordShadowTarget(shadowTargetBuckets, usage, bareName);
    } else {
      kept.push(usage);
    }
  }
  if (phantoms.length === 0) {
    return { shadowTargetBuckets: new Map(), usages: kept };
  }

  return {
    shadowTargetBuckets,
    usages: foldPhantomsIntoBuckets(kept, phantoms, resolvedSkills),
  };
}

/**
 * ISS-8881: the destination buckets each shadowed `command` key folds ONTO —
 * one per branch the payload reports that key on.
 *
 * `deleteShadowedCommandRows` filters by `componentKey` alone, with no branch
 * predicate, so ONE unstorable destination poisons the delete for EVERY branch
 * under that key. The set is therefore per key, and the delete is withheld
 * unless all of it survives.
 */
type ShadowTargetBuckets = Map<string, Set<string>>;

/**
 * Record that `usage`'s `command` key folds onto the skill bucket the phantom is
 * rewritten to — same branch, skill identity, exactly what
 * `foldPhantomsIntoBuckets` computes.
 */
function recordShadowTarget(
  targets: ShadowTargetBuckets,
  usage: SyncedComponentUsage,
  bareName: string
): void {
  const bucket = usageBucketKey({
    ...usage,
    componentKind: AgentComponentKind.Skill,
    componentKey: bareName,
  });
  const existing = targets.get(usage.componentKey);
  if (existing) {
    existing.add(bucket);
    return;
  }
  targets.set(usage.componentKey, new Set([bucket]));
}

/**
 * The shadowed `command` keys whose skill replacement is actually being written.
 *
 * ISS-8881 (davetho review): step 2b deletes the phantom's stored `command`
 * rows on the promise that the fold re-inserts their counts under the skill
 * identity. A destination bucket dropped by `partitionStorableUsages` breaks
 * that promise, and the delete then ERASES a previously-stored good measurement
 * with nothing to replace it — permanently, because the desktop re-sends the
 * same corrupt payload and the empty insert commits every time. On base the
 * overflowing insert raised `22003` and rolled the whole transaction back, so
 * nothing was deleted; this diff makes the write succeed, which is exactly what
 * turns a wedged sync into silent data loss.
 *
 * So the migration is deferred, per key, until every branch that key folds onto
 * is storable. The cost is the stale `command` row surviving beside its skill
 * replacement — the ISS-4778 double-count, visible and repaired by the next
 * sound payload — against a measurement that cannot be recovered. Same trade,
 * and the same side of it, as the legacy-group deferral in
 * `partitionStorableUsages`.
 */
function deletableShadowedCommandKeys(
  shadowTargetBuckets: ShadowTargetBuckets,
  droppedRawBuckets: ReadonlySet<string>
): string[] {
  const deletable: string[] = [];
  for (const [commandKey, targets] of shadowTargetBuckets) {
    let allStorable = true;
    for (const bucket of targets) {
      if (droppedRawBuckets.has(bucket)) {
        allStorable = false;
        break;
      }
    }
    if (allStorable) {
      deletable.push(commandKey);
    }
  }
  return deletable;
}

/**
 * Rewrite each phantom onto its skill bucket, merging it into the survivor when
 * one already exists.
 *
 * ISS-8881: this no longer drops. A merged count past the `int4` ceiling is
 * removed downstream by `partitionStorableUsages`, which screens the value that
 * reaches the column rather than the addends.
 *
 * Extracted from `foldSkillShadowedCommandUsage` so that function stays under
 * the cognitive-complexity ceiling.
 */
function foldPhantomsIntoBuckets(
  kept: SyncedComponentUsage[],
  phantoms: ReadonlyArray<{ bareName: string; usage: SyncedComponentUsage }>,
  resolvedSkills: ReadonlyMap<string, { externalComponentId: string | null }>
): SyncedComponentUsage[] {
  const byBucket = new Map<string, number>();
  for (const [index, usage] of kept.entries()) {
    byBucket.set(usageBucketKey(usage), index);
  }
  for (const { bareName, usage } of phantoms) {
    const skill = resolvedSkills.get(bareName);
    const rewritten: SyncedComponentUsage = {
      ...usage,
      componentKind: AgentComponentKind.Skill,
      componentKey: bareName,
      externalComponentId: skill?.externalComponentId ?? null,
    };
    const bucketKey = usageBucketKey(rewritten);
    const survivorIndex = byBucket.get(bucketKey);
    if (survivorIndex === undefined) {
      byBucket.set(bucketKey, kept.length);
      kept.push(rewritten);
      continue;
    }
    kept[survivorIndex] = mergeUsage(kept[survivorIndex], rewritten);
  }
  return kept;
}

/** The projected usage set plus how many of its index keys actually bound. */
type ComponentUsageIndexKeyProjection = {
  usages: SyncedComponentUsage[];
  projectedCount: number;
  /**
   * ISS-8253: the PRE-PROJECTION `(kind, key)` of every group the projection
   * re-keyed — the representation a row written before ISS-8125 is still stored
   * under. Empty whenever nothing bound.
   */
  legacyGroups: ComponentUsageGroup[];
};

/**
 * ISS-8125: project every index-key column of every usage row down to a size a
 * btree tuple can physically hold, and report how many of them bound.
 *
 * All FOUR are resolved together because they do not each ride their own index —
 * they SHARE tuples. `componentKind` + `componentKey` + `gitBranch` sit in
 * `idx_acsu_session_kind_key_branch`, the UNIQUE this table upserts on, beside a
 * uuid; `componentKind` also sits in
 * `agent_component_session_usage_kind_key_norm_idx`. `externalComponentId` is
 * not a column HERE at all — it is the `AgentComponent` key this row's FK is
 * resolved through, and that table stores it projected (ISS-8069). The
 * 2704-byte limit applies to the whole tuple, so bounding one string while its
 * neighbours can still be 4 KB leaves the write throwing exactly as before.
 *
 * `component_key_normalized` deliberately does NOT appear here. It is derived by
 * the database (migration 20260820120000 installs a BEFORE INSERT/UPDATE trigger
 * that overwrites whatever a writer supplies with the folded `component_key`),
 * so it inherits this bound from the projected value the trigger reads and stays
 * on ONE definition. Computing it here instead would fork that definition —
 * exactly what the migration exists to prevent.
 *
 * The trims happen BEFORE the projection so the projected value is a pure
 * function of the value the columns actually receive: `toComponentUsageInsertRow`
 * and `pruneStaleBranchBuckets` both re-trim, and trimming an already-trimmed
 * string is a no-op, so the two agree on every row.
 *
 * Deterministic, so every re-sync of the same usage resolves to the same row and
 * the `ON CONFLICT` stays idempotent.
 */
function projectComponentUsageIndexKeys(
  usages: readonly SyncedComponentUsage[]
): ComponentUsageIndexKeyProjection {
  let projectedCount = 0;
  const legacyGroupsByKey = new Map<string, ComponentUsageGroup>();
  const projected = usages.map((usage) => {
    const componentKind = projectIndexKey(usage.componentKind);
    const componentKey = projectIndexKey(usage.componentKey);
    const gitBranch = projectIndexKey(usage.gitBranch?.trim() ?? "");
    const externalComponentId = projectNullableIndexKey(
      usage.externalComponentId?.trim() || null
    );
    projectedCount += countProjected(
      componentKind,
      componentKey,
      gitBranch,
      externalComponentId
    );
    // ISS-8253: only the group KEY matters to the prune, so a row re-keyed only
    // by its branch or its external id contributes nothing here — its group is
    // already in the set the payload built.
    if (componentKind.projected || componentKey.projected) {
      legacyGroupsByKey.set(
        `${usage.componentKind}\u0000${usage.componentKey}`,
        {
          componentKind: usage.componentKind,
          componentKey: usage.componentKey,
        }
      );
    }
    return {
      ...usage,
      componentKind: componentKind.value,
      componentKey: componentKey.value,
      externalComponentId: externalComponentId.value,
      gitBranch: gitBranch.value,
    };
  });
  return {
    projectedCount,
    usages: projected,
    legacyGroups: [...legacyGroupsByKey.values()],
  };
}

/**
 * Whether a usage count can be stored in the `int4` column it is bound into.
 *
 * ISS-8330 covered ONE way this goes wrong: `mergeUsage` folds a phantom rollup
 * into the survivor, and two individually in-range addends can overflow
 * together. That fix screened the ADDENDS, so it only ever ran on the
 * phantom-fold arm — and the overwhelming majority of usage rows are never
 * folded. ISS-8881 moves the test onto the value that actually reaches the
 * column, which covers both: an un-merged single row straight off the wire, and
 * a merged sum. The wire cannot close either case, but for different reasons —
 * a rejecting bound there would 400 a whole 200-session batch (ISS-8051), and
 * for the sum each addend is legal on its own.
 *
 * The predicate covers the whole impossible set, not just "too big", but only
 * the past-the-ceiling case is REACHABLE through the route today: `invocations`
 * and `errorCount` are `z.number().int().nonnegative()` on the wire
 * (`lib/desktop-agent-sessions-schema.ts:304-305`), so the wire already refuses
 * a fractional, negative, or non-finite count — what it lacks is a `.max()`.
 * The rest of the predicate is defence in depth at the write, for a value that
 * arrived some other way; it is not a live hole. Same wording as
 * `lib/int4-column-bounds.ts`, deliberately.
 *
 * The caller DROPS the bucket rather than clamping it (whitlockk + codex review,
 * #6370). A clamped `PR_INT_MAX` is indistinguishable from a real count once
 * stored, and these columns are `_sum`-ed into org rollups
 * (`agent-components/org-population-reads.ts:479`,
 * `agent-components/identity.ts:577`), so the floor would be read as a
 * measurement — the "confident real measurement, worse than a refusal" the root
 * `AGENTS.md` names. `invocation_count` is `Int @default(0)`, so there is no
 * null to mean "unknown"; valid-or-absent is the only honest shape available.
 *
 * Dropping costs nothing real. 2^31 invocations of one component in one session
 * is not physically reachable, so a count past the ceiling is already corrupt
 * and the bucket has no trustworthy content. Only that bucket is dropped: the
 * session's other components, and every other session in the batch, still
 * commit — refusing the write instead would fail the slice on every retry,
 * which is the poison-retry shape this lane exists to remove.
 *
 * The dropped bucket is reported, never silent — see
 * `SessionComponentUsageTally`, which carries it to the one emission the batch
 * makes per request.
 */

/**
 * Split the deduped buckets into the ones that can be stored and the component
 * keys of the ones that cannot.
 *
 * The RAW `componentKey` is what is REPORTED — the projection can rewrite that
 * string, and the reported name has to stay the one the phantom-fold arm
 * reported before ISS-8881 moved this check — while the PROJECTED row is what is
 * returned for insertion. Hence both arrays.
 *
 * Only the INSERT set is narrowed. `pruneStaleBranchBuckets` keeps reading the
 * full projected set, because a bucket whose count cannot be stored is still a
 * bucket the payload CLAIMS, and dropping it from the prune's keep-set would
 * delete that branch's previously-stored good row.
 *
 * `droppedRawBuckets` carries the same drop to the OTHER delete on this lane:
 * `deletableShadowedCommandKeys` withholds a shadowed `command` key whose skill
 * replacement is not being written.
 *
 * The legacy set is the ONE exception, and it is narrowed the other way — by
 * group, not by row. A legacy group is only ever added to the prune's DELETE
 * set, never to its keep-set, so every branch stored under the raw key dies
 * together on the promise that the caller re-inserts each one under the
 * projected key. One dropped bucket breaks that promise for the WHOLE group:
 * keeping the group because a sibling branch is sound deletes the dropped
 * branch's raw row with nothing to replace it. So the migration is deferred
 * until a payload arrives in which every branch the group claims is storable.
 *
 * WHAT THE DEFERRAL COSTS, priced honestly (marisolashgrove review): NOT "one
 * re-sync". The payload is deterministic and re-sent on every sync, so nothing
 * here makes a corrupt producer heal — a producer that keeps emitting the bad
 * count keeps this group deferred INDEFINITELY. And while it is deferred the
 * sound sibling branch IS inserted under the projected key while the raw-keyed
 * rows survive, which is precisely the state `pruneStaleBranchBuckets`' own
 * docstring names: the projected insert conflicts with nothing, the raw row
 * survives, and detail + token-trend — which sum ALL rows per `(kind, key)` —
 * double-count that component for as long as the producer stays corrupt. So the
 * real trade is a possibly-unbounded ISS-8253 duplicate against a permanently
 * lost measurement. The duplicate is visible in the data and repaired by the
 * first sound payload; the deleted row is not recoverable at all. Hence this
 * side of it.
 */
function partitionStorableUsages(
  rawUsages: readonly SyncedComponentUsage[],
  projectedUsages: readonly SyncedComponentUsage[],
  legacyGroups: readonly ComponentUsageGroup[]
): {
  droppedOverflowUsageBuckets: string[];
  droppedRawBuckets: Set<string>;
  legacyGroups: ComponentUsageGroup[];
  usages: SyncedComponentUsage[];
} {
  const droppedOverflowUsageBuckets: string[] = [];
  const insertable: SyncedComponentUsage[] = [];
  const droppedRawGroups = new Set<string>();
  const droppedRawBuckets = new Set<string>();
  // `projectComponentUsageIndexKeys` maps 1:1 in order and rewrites only the
  // four STRING index keys, so the counts are identical in both arrays and the
  // two can be read in lockstep: the predicate takes either, and the reported
  // name comes from the RAW row.
  for (const [index, projected] of projectedUsages.entries()) {
    const raw = rawUsages[index];
    if (
      isStorableInt4Count(projected.invocations) &&
      isStorableInt4Count(projected.errorCount)
    ) {
      insertable.push(projected);
      continue;
    }
    droppedRawGroups.add(usageGroupIdentity(raw));
    droppedRawBuckets.add(usageBucketKey(raw));
    droppedOverflowUsageBuckets.push(raw.componentKey);
  }
  // Every legacy group is built from these same rows, so a group absent from
  // `droppedRawGroups` is one whose every claimed branch is being re-inserted —
  // exactly the promise the prune's delete set is given.
  return {
    droppedOverflowUsageBuckets,
    droppedRawBuckets,
    legacyGroups: legacyGroups.filter(
      (group) => !droppedRawGroups.has(usageGroupIdentity(group))
    ),
    usages: insertable,
  };
}

/** The `(kind, key)` a legacy group and a raw usage row are compared on. */
function usageGroupIdentity(group: {
  componentKind: string;
  componentKey: string;
}): string {
  return `${group.componentKind}\u0000${group.componentKey}`;
}

/**
 * What one session's usage lane hands back for the BATCH to report.
 *
 * Neither figure is emitted here. `apps/api/AGENTS.md` ("Emission and Abuse
 * Control") bounds a caller-driven emission at the choke point, and this lane
 * is per session on a `sessions` array the wire does not cap — so a payload of
 * many small overflowing sessions, re-sent on every retry because the overflow
 * is deterministic, would drive one warn and one metric per session. Both
 * figures ride to `upsertSessionsBatch`'s `finally`, which emits once per
 * request, the same bound `SliceFailed`, the status fold, and the held-revision
 * tally already keep.
 */
type SessionComponentUsageTally = {
  /**
   * ISS-8069: how many index-key columns this session had to project down
   * before they could be written.
   */
  indexKeyProjections: number;
  /**
   * ISS-8330 / ISS-8881: the component keys whose bucket was dropped because a
   * count could not be stored in its `int4` column — a merged sum since
   * ISS-8330, and since ISS-8881 an un-merged single row off the wire too. The
   * KEY rather than a bare count, because the bucket that went missing is the
   * actionable detail and the batch cannot re-derive it.
   */
  droppedOverflowUsageBuckets: readonly string[];
};

/** The tally for a session that wrote no usage rows at all. */
const EMPTY_COMPONENT_USAGE_TALLY: SessionComponentUsageTally = {
  indexKeyProjections: 0,
  droppedOverflowUsageBuckets: [],
};
