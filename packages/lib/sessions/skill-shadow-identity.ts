/**
 * ISS-5260 — the ONE pure decision behind "this slash key names a SKILL, not a
 * command", shared by the desktop collector and the cloud ingest lanes.
 *
 * A skill is a single entity. Slash-invoking it (`/prune-tests`) is one way it
 * was invoked, not a second entity — yet a slash invocation and a skill
 * definition arrive on different code paths, so without a shared rule the
 * product ends up holding TWO records for one thing: a `command` carrying the
 * invocations and modal usage, and a `skill` carrying the definition. Every
 * per-component rollup (invocation counts, cost, LOC-per-dollar, catalog
 * population) is then wrong for exactly the skills people actually invoke.
 *
 * The rule was first written for the cloud's version-skew guards (ISS-4778 /
 * ISS-4923) and lived only in `apps/api/lib/skill-shadow.ts`, which the desktop
 * cannot import. It is hoisted here rather than copied because the two sides
 * MUST agree: if the collector re-points a slash invocation onto the skill and
 * the cloud does not — or vice versa — the same session yields a different
 * skill/command split depending on which surface you read it from, which is the
 * split-truth bug this rule exists to prevent.
 *
 * The evidence each side gathers differs (a Prisma `findMany` vs raw SQL over
 * the desktop's SQLite mirror), so only the DECISION is shared; each caller
 * builds {@link SkillShadowEvidence} from its own store.
 *
 * ## Why this cannot merge two genuinely different entities
 *
 * The join is name equality (`/foo` → `foo`), which on its own would happily
 * fold a real `/deploy` command into an unrelated `deploy` skill. Three
 * conditions make that impossible:
 *
 *  1. The SKILL must be RESOLVED — its `SKILL.md` text was actually captured.
 *     A bare name observed in passing is not evidence that a skill exists.
 *  2. The COMMAND must have no definition of its own — neither a resolved
 *     `.claude/commands/<name>.md`, nor captured definition text, nor (on the
 *     collector side) a definition snapshot on the invocation itself. A command
 *     that carries its own content IS a second entity, and is never folded.
 *  3. Both rows must belong to the SAME compute target, so one machine's skill
 *     can never absorb another machine's command.
 *
 * So the identity being merged is not "two things with the same name" but "a
 * name that resolves to exactly one definition, reached two ways". When a real
 * command and a real skill share a bare name, condition 2 keeps both records —
 * which is the behavior `command` as a kind is reserved for.
 */

/** The stored evidence a caller must gather before {@link isSkillInvokedSlashKey} can decide. */
export type SkillShadowEvidence = {
  /** Bare names (`review`) that have a RESOLVED `skill` component on this target. */
  resolvedSkillNames: ReadonlySet<string>;
  /**
   * Slash keys (`/review`) that a `command` row vouches for — because it
   * resolved against a real `.claude/commands/<name>.md`, or because it carries
   * its own non-empty definition text even though resolution has not promoted
   * it yet. Either signal proves a genuine command.
   */
  vouchedCommandKeys: ReadonlySet<string>;
};

/**
 * The bare skill name a slash-keyed component would name (`/review` → `review`),
 * or null when the key is not slash-shaped at all. Purely structural: the caller
 * has already established that the component is `command`-kind.
 */
export function slashKeyBareName(
  componentKey: string | null | undefined
): string | null {
  if (!componentKey?.startsWith("/")) {
    return null;
  }
  const bareName = componentKey.slice(1);
  return bareName.length > 0 ? bareName : null;
}

/**
 * Does this slash key name a SKILL rather than a command?
 *
 * True only when a resolved skill answers to the bare name AND nothing vouches
 * for the slash key as a command. Callers that hold per-invocation definition
 * evidence (a `definitionSnapshot`, a `definition_hash`) must exclude it BEFORE
 * calling — that evidence is the same "this command is genuine" fact as
 * {@link SkillShadowEvidence.vouchedCommandKeys}, just carried on the invocation
 * instead of the inventory row. {@link carriesOwnDefinitionEvidence} is that
 * exclusion; every caller holding a row with these fields must apply it.
 */
export function isSkillInvokedSlashKey(
  evidence: SkillShadowEvidence,
  bareName: string | null,
  componentKey: string
): boolean {
  if (!(bareName && evidence.resolvedSkillNames.has(bareName))) {
    return false;
  }
  return !evidence.vouchedCommandKeys.has(componentKey);
}

/**
 * ISS-5260 (wongk review): does this invocation carry its OWN definition, making
 * it a genuine command whatever the inventory says?
 *
 * The per-row exclusion condition 2 above describes, hoisted so the collector
 * and the cloud apply the SAME test rather than one side remembering it. It
 * matters most where the inventory is not yet populated: a genuine `/deploy`
 * generation can reach the cloud BEFORE its command inventory row syncs, and
 * without this the slash key would be rewritten onto a same-named skill — after
 * which `resolveDefinitionVersion` hashes the carried content under the skill
 * kind and the generation is rejected with a `GenerationConflict` that every
 * retry reproduces.
 *
 * Absence of both fields is NOT proof a command is a phantom — a real command
 * whose snapshot the collector could not attribute has neither (the
 * leading-slash-run population). That is why the collector layers its own
 * authoritative `commandDefinitionWitness` on top; this is the floor both sides
 * share, not the whole test.
 */
export function carriesOwnDefinitionEvidence(row: {
  definitionHash?: string | null;
  definitionContent?: string | null;
}): boolean {
  return Boolean(row.definitionHash) || Boolean(row.definitionContent?.trim());
}
