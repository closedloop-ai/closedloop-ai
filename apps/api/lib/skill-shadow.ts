/**
 * ISS-4778 (Part 2 of ISS-4775) — the single source of truth for the
 * "skill-shadowed phantom command" predicate the cloud ingest lanes share.
 *
 * Running `/review` on a `review` SKILL records BOTH a `<command-name>` slash
 * entry and a `Skill` tool_use, so a pre-ISS-4775 desktop emits a `command`
 * candidate keyed `/review` alongside the resolved `skill` keyed `review`. That
 * command can never resolve — a skill's entrypoint is `SKILL.md`, not
 * `.claude/commands/review.md` — so it lands in the cloud as a phantom.
 *
 * Desktop auto-update is not guaranteed, so a skewed build keeps posting those
 * rows on every ingest lane and would re-pollute the cloud right after the
 * one-time backfill migration. Each lane drops or folds them at ingest using the
 * helpers below, so a skewed client self-heals instead.
 */
import {
  AgentComponentKind,
  ComponentResolvedState,
} from "@repo/api/src/types/agent-component";
import type { TransactionClient } from "@repo/database";
import {
  isSkillInvokedSlashKey,
  type SkillShadowEvidence,
  slashKeyBareName,
} from "@repo/lib/sessions/skill-shadow-identity";
import { indexKeyLookupCandidates } from "@/lib/index-key-lookup";
import { POSTGRES_MAX_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";

/**
 * The resolved inventory rows that decide whether a slash-keyed command is a
 * phantom: the skills it would shadow, and the genuine commands that must never
 * be touched.
 */
export type SkillShadowInventory = {
  /** bare skill name (`review`) → the resolved skill inventory row. */
  resolvedSkills: ReadonlyMap<
    string,
    { id: string; externalComponentId: string }
  >;
  /** slash keys (`/review`) that have a RESOLVED command row on this target. */
  resolvedCommandKeys: ReadonlySet<string>;
  /**
   * ISS-4923 (whitlockk review): slash keys whose stored command row carries its own
   * DEFINITION TEXT (`content`), whatever its `resolvedState`. This is the second
   * half of the evidence the inventory-sync guard already layers in
   * `inventoryShadowBareName` (which requires `content == null` AND a
   * non-resolved state before it will call a row a phantom). `resolvedState`
   * alone is not the whole story: a genuine `/deploy` whose
   * `.claude/commands/deploy.md` synced with content but has not yet been
   * promoted to `resolved` would otherwise be invisible to a lane that only
   * reads {@link resolvedCommandKeys}, and would be rewritten to `skill:deploy`.
   */
  definedCommandKeys: ReadonlySet<string>;
  /**
   * ISS-5260: the same facts in the shape the SHARED decision consumes, built
   * once at load rather than per row. `resolvedCommandKeys` and
   * `definedCommandKeys` are both "a command row vouches for this slash key", so
   * they collapse into one set; they are still exposed separately above because
   * they are independently meaningful evidence and the guards' own tests read
   * them. Collapsing inside {@link isSkillShadowedPhantom} instead would
   * allocate two sets on every row of an ingest loop.
   */
  evidence: SkillShadowEvidence;
};

/**
 * The bare skill name a slash-keyed command would shadow (`/review` → `review`),
 * or null when the component is not shadow-shaped at all. Purely structural —
 * callers add the lane-specific evidence (an inventory row's `resolvedState` and
 * `content`, or the stored inventory for lanes whose payload carries neither).
 */
export function skillShadowBareName(
  componentKind: string,
  componentKey: string | null | undefined
): string | null {
  if (componentKind !== AgentComponentKind.Command) {
    return null;
  }
  // ISS-5260: the slash-key parse is the shared one, so the collector's re-point
  // and this guard can never disagree about which key names which skill.
  return slashKeyBareName(componentKey);
}

/**
 * Load the resolved skills that `bareNames` would shadow plus the commands that
 * prove a slash key is genuine. A `/deploy` that resolved against a real
 * `.claude/commands/deploy.md` is reported in `resolvedCommandKeys`, so callers
 * keep it even when a `deploy` skill also exists on the same target.
 *
 * ISS-4923 (whitlockk review): command rows are read at EVERY `resolvedState`, not
 * only `resolved`, so a command carrying its own definition text lands in
 * {@link SkillShadowInventory.definedCommandKeys} even before resolution
 * promotes it. Skill rows stay restricted to `resolved` — an unresolved skill is
 * not evidence that a slash key shadows anything.
 *
 * ISS-8193: read in bind-safe SLICES rather than one statement, because the
 * `where` above costs {@link BIND_PARAMETERS_PER_BARE_NAME} parameters for every
 * distinct name and the payload it is derived from carries no cap of its own
 * once ISS-8051 lands. Both `in` lists are UNIONs over the same names, so a
 * slice returns exactly the rows it would have returned inside the whole
 * statement and the sets merge without re-aggregation — unlike an intersective
 * `notIn`, which cannot be split at all.
 *
 * ONE NAME IS DECIDED BY ONE STATEMENT, which is what keeps slicing safe under
 * `READ COMMITTED` (davetho review). Snapshots are per statement, so a
 * component sync committing mid-loop IS visible to a later slice — but a name
 * lands in exactly one slice, and that slice's `where` carries BOTH its skill
 * disjunct and its `/${name}` command disjunct. Every input
 * `isSkillInvokedSlashKey` reads for a name therefore comes from one snapshot,
 * so no interleaving can pair a freshly-synced skill with the pre-sync (absent)
 * command row and fold a genuine command. Splitting the two disjuncts into
 * separate statements would reintroduce exactly that tear.
 *
 * The loop is SEQUENTIAL because a fan-out buys nothing: every caller runs
 * inside the session-upsert's interactive transaction, which pins ONE connection
 * and queues every `tx.*` call on it (`apps/api/AGENTS.md`), so concurrent
 * slices would still execute one at a time — while holding every slice's rows in
 * memory at once and leaving an unbounded number of statements queued against
 * that single connection.
 */
export async function loadSkillShadowInventory(
  db: TransactionClient,
  computeTargetId: string,
  bareNames: readonly string[]
): Promise<SkillShadowInventory> {
  const resolvedSkills = new Map<
    string,
    { id: string; externalComponentId: string }
  >();
  const resolvedCommandKeys = new Set<string>();
  const definedCommandKeys = new Set<string>();
  // Deduped here rather than trusted from the callers, so the bound below is
  // over DISTINCT names no matter what a future caller hands in. A name lands in
  // exactly one slice, so the lowest-`id` tie-break stays a within-slice
  // decision even when the same key is installed at several scopes.
  const distinctNames = [...new Set(bareNames)];

  for (
    let offset = 0;
    offset < distinctNames.length;
    offset += SKILL_SHADOW_BARE_NAME_CHUNK_SIZE
  ) {
    const slice = distinctNames.slice(
      offset,
      offset + SKILL_SHADOW_BARE_NAME_CHUNK_SIZE
    );
    // ISS-8200: `componentKey` is stored PROJECTED (ISS-8069), so an equality
    // `in` over the bare names and their slash keys misses a name over the byte
    // budget entirely — for such a name the inventory reports no skill AND no
    // vouching command, which is not "no evidence" but unread evidence. Both
    // disjuncts widen to the candidate set, and `collectInventoryRows` maps each
    // stored key back to the key the callers index on, so the two sets stay
    // comparable.
    const skillKeysByStored = storedKeyIndex(slice);
    const commandKeysByStored = storedKeyIndex(slice.map((name) => `/${name}`));
    const rows = await db.agentComponent.findMany({
      where: {
        computeTargetId,
        OR: [
          {
            componentKind: AgentComponentKind.Skill,
            componentKey: { in: [...skillKeysByStored.keys()] },
            resolvedState: ComponentResolvedState.Resolved,
          },
          {
            componentKind: AgentComponentKind.Command,
            componentKey: { in: [...commandKeysByStored.keys()] },
          },
        ],
      },
      select: {
        componentKey: true,
        componentKind: true,
        content: true,
        externalComponentId: true,
        id: true,
        resolvedState: true,
      },
    });
    collectInventoryRows(
      rows,
      resolvedSkills,
      resolvedCommandKeys,
      definedCommandKeys,
      (storedKey) =>
        skillKeysByStored.get(storedKey) ?? commandKeysByStored.get(storedKey)
    );
  }

  return {
    definedCommandKeys,
    evidence: collapseEvidence(
      resolvedSkills,
      resolvedCommandKeys,
      definedCommandKeys
    ),
    resolvedCommandKeys,
    resolvedSkills,
  };
}

/**
 * THE phantom predicate the invocation lane and the usage fold both consult —
 * one copy so the two can never drift apart again (ISS-4923 / whitlockk review; the
 * two lanes previously carried the same expression inline and only one of them
 * would have been widened).
 *
 * A slash-keyed command is a phantom only when a RESOLVED skill with the bare
 * name exists on this compute target AND no command row vouches for the slash
 * key. Both command-side signals count as vouching, mirroring the evidence the
 * inventory-sync guard layers before it will drop a row:
 *   - `resolvedCommandKeys` — the command already resolved against a real
 *     `.claude/commands/<name>.md`;
 *   - `definedCommandKeys` — the command carries its own definition text, so it
 *     is genuine even though resolution has not promoted it yet.
 */
export function isSkillShadowedPhantom(
  inventory: SkillShadowInventory,
  bareName: string | null,
  componentKey: string
): boolean {
  // ISS-5260: the DECISION is `@repo/lib/sessions/skill-shadow-identity`, shared
  // with the desktop collector's re-point so collector and cloud can never
  // disagree about what a slash-invoked skill is. Only the evidence-gathering
  // is cloud-specific, and it is already collapsed into the shared shape at load
  // time (see `collapseEvidence`) so this stays allocation-free per row.
  return isSkillInvokedSlashKey(inventory.evidence, bareName, componentKey);
}

/**
 * Project a loaded inventory into the shared {@link SkillShadowEvidence} shape,
 * once per load. Both command-side signals are "a command row vouches for this
 * slash key" — a command that already resolved against a real
 * `.claude/commands/<name>.md`, or one carrying its own definition text before
 * resolution promoted it — so they become one set.
 */
function collapseEvidence(
  resolvedSkills: ReadonlyMap<
    string,
    { id: string; externalComponentId: string }
  >,
  resolvedCommandKeys: ReadonlySet<string>,
  definedCommandKeys: ReadonlySet<string>
): SkillShadowEvidence {
  return {
    resolvedSkillNames: new Set(resolvedSkills.keys()),
    vouchedCommandKeys: new Set([
      ...resolvedCommandKeys,
      ...definedCommandKeys,
    ]),
  };
}

/**
 * Bind parameters {@link loadSkillShadowInventory} spends per DISTINCT bare
 * name: a slot in the skill disjunct's `componentKey: { in: … }` list and a slot
 * in the command disjunct's `/${name}` list, each of which ISS-8200 widened from
 * one key to the CANDIDATE SET for that key — the projected form plus, when the
 * byte budget actually bound, the raw form a pre-ISS-8069 row still holds.
 *
 * Two candidates is the ceiling `indexKeyCandidates` can return, so four is the
 * worst case rather than the typical one: every name inside the budget still
 * yields one candidate per list, which is all of them in practice. Sized against
 * the worst case deliberately — this constant exists to keep the statement
 * inside {@link POSTGRES_MAX_BIND_PARAMETERS} on the payload that actually
 * reaches it, not on the common one.
 */
const BIND_PARAMETERS_PER_BARE_NAME = 4;

/**
 * The statement's own binds, which the per-name budget must reserve before it
 * divides: `computeTargetId`, one `componentKind` per `OR` disjunct, the skill
 * disjunct's `resolvedState`, and the `OFFSET` Prisma appends to every
 * `findMany`. Sizing against the bare ceiling instead is what puts a slice one
 * parameter over the moment the enclosing `where` binds anything.
 */
const FIXED_BIND_PARAMETERS = 5;

/**
 * Distinct bare names one statement may carry.
 *
 * {@link POSTGRES_MAX_BIND_PARAMETERS} is EXCLUSIVE — it is the count that is
 * refused, and the repo's sibling chunking suites pin their sizes with
 * `toBeLessThan` against it — so the reservation subtracts one more before
 * dividing. Floors at 1 rather than 0 so a future ceiling change cannot turn
 * this loop into one that emits empty statements forever.
 */
export const SKILL_SHADOW_BARE_NAME_CHUNK_SIZE = Math.max(
  1,
  Math.floor(
    (POSTGRES_MAX_BIND_PARAMETERS - 1 - FIXED_BIND_PARAMETERS) /
      BIND_PARAMETERS_PER_BARE_NAME
  )
);

/**
 * Fold one slice's rows into the inventory sets being accumulated across
 * slices. Merging is a plain union because both `in` lists are UNIONs over the
 * slice's names: a row matches the whole-statement predicate exactly when it
 * matches the predicate of the one slice its name belongs to.
 */
function collectInventoryRows(
  rows: readonly {
    componentKey: string | null;
    componentKind: string;
    content: string | null;
    externalComponentId: string;
    id: string;
    resolvedState: string;
  }[],
  resolvedSkills: Map<string, { id: string; externalComponentId: string }>,
  resolvedCommandKeys: Set<string>,
  definedCommandKeys: Set<string>,
  // ISS-8200: the key the query ASKED for, given the key the row is STORED
  // under. Every set this fills is read back by bare name or slash key, so a
  // projected stored key has to be mapped home or the widened lookup returns
  // rows nothing can match.
  lookupKeyOf: (storedKey: string) => string | undefined
): void {
  for (const row of rows) {
    const key = row.componentKey ? lookupKeyOf(row.componentKey) : undefined;
    if (!key) {
      continue;
    }
    if (row.componentKind === AgentComponentKind.Command) {
      if (row.resolvedState === ComponentResolvedState.Resolved) {
        resolvedCommandKeys.add(key);
      }
      if (row.content?.trim()) {
        definedCommandKeys.add(key);
      }
      continue;
    }
    // `DISTINCT ON (…, id)` in the migration picks the lowest id when the same
    // skill key is installed at more than one scope; keep the same tie-break so
    // ingest and backfill agree on which inventory row a phantom folds into.
    const existing = resolvedSkills.get(key);
    if (!existing || row.id < existing.id) {
      resolvedSkills.set(key, {
        externalComponentId: row.externalComponentId,
        id: row.id,
      });
    }
  }
}

/**
 * ISS-8200: every key each requested name could be STORED under, mapped back to
 * the name itself. One entry per key for every value inside the byte budget,
 * which is all of them in practice, so the `in` list is unchanged for ordinary
 * traffic.
 */
function storedKeyIndex(keys: readonly string[]): Map<string, string> {
  const byStoredKey = new Map<string, string>();
  for (const key of keys) {
    for (const candidate of indexKeyLookupCandidates(key)) {
      byStoredKey.set(candidate, key);
    }
  }
  return byStoredKey;
}
