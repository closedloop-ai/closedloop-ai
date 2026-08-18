/**
 * ISS-4778 (Part 2 of ISS-4775) — server-side version-skew guard for the desktop
 * component-inventory sync lane.
 *
 * ISS-4775 Part 1 stopped the desktop collector from EMITTING a phantom
 * `command` component for a slash-invoked SKILL (running `/review` on a `review`
 * skill records both a `<command-name>` slash entry and a `Skill` tool_use, and
 * the command half can never resolve because a skill's entrypoint is `SKILL.md`,
 * not `.claude/commands/review.md`). Desktop auto-update is not guaranteed, so an
 * older build keeps posting those rows — which would re-pollute the cloud right
 * after the one-time backfill migration. Dropping them at ingest makes a skewed
 * client self-heal instead.
 *
 * Deliberately conservative, mirroring the migration's predicate: a row is only
 * dropped when it is `command`-kind, slash-keyed, carries no definition text, is
 * not marked `resolved`, AND a RESOLVED `skill` with the bare name exists for the
 * same compute target (in this payload or already stored). A genuine `/deploy`
 * with no `deploy` skill — and a `/foo` command that resolved against a real
 * `.claude/commands/foo.md` — are always kept.
 */
import {
  AgentComponentKind,
  ComponentResolvedState,
} from "@repo/api/src/types/agent-component";
import type { TransactionClient } from "@repo/database";
import type { DesktopAgentComponentsPayload } from "@/lib/desktop-agent-sessions-schema";
import { skillShadowBareName } from "@/lib/skill-shadow";

type SyncedComponent = DesktopAgentComponentsPayload["components"][number];

/**
 * Drop the phantom `command` rows a version-skewed desktop still emits for
 * slash-invoked skills. Returns the components that should be ingested.
 *
 * Costs at most ONE extra indexed read, and only when the payload actually
 * carries a slash-keyed unresolved command — the common payload short-circuits
 * before touching the database.
 */
export async function dropSkillShadowedCommands(
  db: TransactionClient,
  components: SyncedComponent[],
  computeTargetId: string
): Promise<SyncedComponent[]> {
  const shadowCandidates = new Map<SyncedComponent, string>();
  for (const component of components) {
    const bareName = inventoryShadowBareName(component);
    if (bareName) {
      shadowCandidates.set(component, bareName);
    }
  }
  if (shadowCandidates.size === 0) {
    return components;
  }

  const resolvedSkillKeys = await resolvedSkillKeysForTarget(
    db,
    components,
    computeTargetId,
    [...new Set(shadowCandidates.values())]
  );
  return components.filter((component) => {
    const bareName = shadowCandidates.get(component);
    return !(bareName && resolvedSkillKeys.has(bareName));
  });
}

/**
 * The bare skill name an INVENTORY component would shadow (`/review` → `review`),
 * or null when the component is not phantom-shaped. Layers the two pieces of
 * evidence only an inventory payload carries — `resolvedState` and `content` —
 * on top of the shared structural predicate. An OMITTED `resolvedState` folds to
 * `unresolved` — the same default the cloud writer applies to a stale client's
 * row — so a skewed build that predates the field is still covered.
 */
function inventoryShadowBareName(component: SyncedComponent): string | null {
  if (
    (component.resolvedState ?? ComponentResolvedState.Unresolved) ===
    ComponentResolvedState.Resolved
  ) {
    return null;
  }
  if (component.content != null) {
    return null;
  }
  return skillShadowBareName(component.componentKind, component.componentKey);
}

/**
 * The subset of `bareNames` that has a RESOLVED skill on this compute target —
 * counting both the skills carried in this same payload and the ones already
 * stored, so the guard holds whether or not the skill row happens to be batched
 * alongside its shadow.
 */
async function resolvedSkillKeysForTarget(
  db: TransactionClient,
  components: SyncedComponent[],
  computeTargetId: string,
  bareNames: string[]
): Promise<Set<string>> {
  const resolved = new Set<string>();
  for (const component of components) {
    if (
      component.componentKind === AgentComponentKind.Skill &&
      component.resolvedState === ComponentResolvedState.Resolved &&
      component.componentKey
    ) {
      resolved.add(component.componentKey);
    }
  }
  const stored = await db.agentComponent.findMany({
    where: {
      computeTargetId,
      componentKind: AgentComponentKind.Skill,
      resolvedState: ComponentResolvedState.Resolved,
      componentKey: { in: bareNames },
    },
    select: { componentKey: true },
  });
  for (const row of stored) {
    if (row.componentKey) {
      resolved.add(row.componentKey);
    }
  }
  return resolved;
}
