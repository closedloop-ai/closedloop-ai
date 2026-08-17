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
   * ISS-4923 (wongk review): slash keys whose stored command row carries its own
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
 * Load, in ONE indexed read, the resolved skills that `bareNames` would shadow
 * plus the commands that prove a slash key is genuine. A `/deploy` that resolved
 * against a real `.claude/commands/deploy.md` is reported in
 * `resolvedCommandKeys`, so callers keep it even when a `deploy` skill also
 * exists on the same target.
 *
 * ISS-4923 (wongk review): command rows are read at EVERY `resolvedState`, not
 * only `resolved`, so a command carrying its own definition text lands in
 * {@link SkillShadowInventory.definedCommandKeys} even before resolution
 * promotes it. Skill rows stay restricted to `resolved` — an unresolved skill is
 * not evidence that a slash key shadows anything.
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
  if (bareNames.length === 0) {
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

  const rows = await db.agentComponent.findMany({
    where: {
      computeTargetId,
      OR: [
        {
          componentKind: AgentComponentKind.Skill,
          componentKey: { in: [...bareNames] },
          resolvedState: ComponentResolvedState.Resolved,
        },
        {
          componentKind: AgentComponentKind.Command,
          componentKey: { in: bareNames.map((name) => `/${name}`) },
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

  for (const row of rows) {
    if (!row.componentKey) {
      continue;
    }
    if (row.componentKind === AgentComponentKind.Command) {
      if (row.resolvedState === ComponentResolvedState.Resolved) {
        resolvedCommandKeys.add(row.componentKey);
      }
      if (row.content?.trim()) {
        definedCommandKeys.add(row.componentKey);
      }
      continue;
    }
    // `DISTINCT ON (…, id)` in the migration picks the lowest id when the same
    // skill key is installed at more than one scope; keep the same tie-break so
    // ingest and backfill agree on which inventory row a phantom folds into.
    const existing = resolvedSkills.get(row.componentKey);
    if (!existing || row.id < existing.id) {
      resolvedSkills.set(row.componentKey, {
        externalComponentId: row.externalComponentId,
        id: row.id,
      });
    }
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
 * one copy so the two can never drift apart again (ISS-4923 / wongk review; the
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
