/**
 * ISS-5260: re-point a slash invocation of a SKILL onto the skill itself, so one
 * entity keeps one record.
 *
 * ## What was already handled, and what was not
 *
 * ISS-4775 / ISS-4810 / ISS-4811 built PER-OCCURRENCE skill-shadow correlation
 * (`component-invocation-skill-shadow.ts`): when a session holds both a
 * `<command-name>` slash entry AND a `Skill` tool_use of the same bare name, the
 * Command candidate is dropped because the Skill candidate already represents
 * that invocation. That correlation deliberately keeps any slash invocation it
 * cannot pair, so a `/foo` the user escaped before the Skill tool fired is not
 * silently deleted (the undercount ISS-4810 exists to prevent).
 *
 * But the dominant real shape has NOTHING to pair with. When Claude Code expands
 * a slash-invoked skill it records the `<command-name>` entry and no `Skill`
 * tool_use at all — golden session `3b820c31` invokes `/code-review:deep` with
 * four unrelated `Skill` tool_uses and none for `code-review:deep`. Correlation
 * finds no partner, keeps the Command candidate, and `ensureInvocationComponents`
 * mints an `agent_components` row `(command, /code-review:deep)` beside the
 * resolved `(skill, code-review:deep)` row the definition collector wrote. Two
 * records, one entity: invocations and modal usage on the command, the
 * definition on the skill, and neither reconciles against "what is this skill
 * and how was it used".
 *
 * So this module is the correlation's INVENTORY-EVIDENCE half, not a replacement
 * for it. Correlation still runs first and still drops the paired occurrences;
 * whatever survives is then checked against the local component inventory, and a
 * survivor whose bare name resolves to a real skill is REWRITTEN onto that skill
 * rather than dropped. Rewriting is what makes the counts reconcile: the
 * invocation is real evidence of usage, it just belongs to the skill. Dropping
 * it would re-introduce ISS-4810's undercount from the other direction.
 *
 * This deliberately inverts one ISS-4810 property: the slash entry correlation
 * could not pair — including a `/foo` the user ESCAPED — is no longer kept as a
 * separate `command` row, it moves onto the skill's rollup. The escaped case
 * therefore becomes a modest per-skill OVERCOUNT rather than a stray command
 * row, and the transcript cannot distinguish it from the unlogged expansion that
 * dominates. The full reasoning for accepting that lives in the revision-68 note
 * in `collectors/engine/data-revision.ts`.
 *
 * ## Why it runs here rather than in the candidate derivation
 *
 * `deriveAgentComponentInvocationCandidates` is pure (session in, candidates
 * out) and the evidence needed is the stored inventory. Running at the writer —
 * the single point where the transcript-reparse path, the legacy bootstrap, and
 * the stored-row rebuild bridge all converge before `ensureInvocationComponents`
 * — gives all three paths ONE implementation, which is the convergence property
 * ISS-4811 had to add a second copy of the correlation helper to obtain.
 *
 * The decision itself is `@repo/lib/sessions/skill-shadow-identity`, shared with
 * the cloud's version-skew guards so collector and cloud can never disagree
 * about what a slash-invoked skill is. See that module for why name equality
 * here cannot merge two genuinely different components.
 */
import { ComponentResolvedState } from "@repo/api/src/types/agent-component";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import {
  carriesOwnDefinitionEvidence,
  isSkillInvokedSlashKey,
  type SkillShadowEvidence,
  slashKeyBareName,
} from "@repo/lib/sessions/skill-shadow-identity";
import type { AgentComponentInvocationCandidate } from "./component-invocation-row-writer.js";
import { EVENT_INSERT_PARAM_CAP } from "./db-constants.js";
import type { Prisma } from "./generated/client.js";

type InventoryRow = {
  component_kind: string;
  component_key: string;
  resolved_state: string | null;
  content: string | null;
};

/**
 * ISS-5260 (wongk review): bare names per inventory read.
 *
 * {@link loadSkillShadowEvidence} binds each name TWICE — once bare for the
 * skill arm, once slash-prefixed for the command arm — plus three fixed
 * parameters, so the statement costs `3 + 2n` binds. libSQL's
 * `SQLITE_MAX_VARIABLE_NUMBER` floor is 999 (see
 * {@link EVENT_INSERT_PARAM_CAP}), so an unchunked read blows the limit at 499
 * distinct names and rolls back the WHOLE import or rebuild transaction it runs
 * inside. A session with that many distinct slash commands is unusual but not
 * synthetic — `/clear`, `/model`, and `/compact` are ubiquitous, and a
 * long-lived admitted session accumulates them.
 *
 * Derived from the same cap the import path's chunked INSERTs use, so both
 * budgets move together if the floor is ever revised.
 */
const SKILL_SHADOW_NAMES_PER_READ = Math.floor(
  (EVENT_INSERT_PARAM_CAP - 3) / 2
);

/**
 * Rewrite, in place, every slash-keyed `command` candidate that actually names a
 * resolved local SKILL so it is attributed to that skill. Returns the slash keys
 * it re-pointed, so the caller can REPORT a silently-rewritten identity — an
 * operator debugging a mis-attributed component otherwise has no signal that a
 * `command` became a `skill`. Same precedent as `insertInvocationRows`' required
 * reporter for a dropped agent reference (ISS-5098).
 *
 * Costs at most ONE indexed read, taken whenever the candidate set carries any
 * slash-keyed command without definition evidence of its own. That is most real
 * sessions — `/clear`, `/model`, and `/compact` are ubiquitous — so this is one
 * indexed read per session import or rebuild, not a rare path.
 */
export async function repointSkillInvokedCommandCandidates(
  tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe">,
  candidates: AgentComponentInvocationCandidate[]
): Promise<string[]> {
  const bareNameByCandidate = new Map<
    AgentComponentInvocationCandidate,
    string
  >();
  for (const candidate of candidates) {
    const bareName = repointableBareName(candidate);
    if (bareName) {
      bareNameByCandidate.set(candidate, bareName);
    }
  }
  if (bareNameByCandidate.size === 0) {
    return [];
  }

  const evidence = await loadSkillShadowEvidence(tx, [
    ...new Set(bareNameByCandidate.values()),
  ]);
  const repointed = new Set<string>();
  for (const [candidate, bareName] of bareNameByCandidate) {
    if (!isSkillInvokedSlashKey(evidence, bareName, candidate.componentKey)) {
      continue;
    }
    const slashKey = candidate.componentKey;
    repointed.add(slashKey);
    candidate.componentKind = AgentComponentInvocationKind.Skill;
    candidate.componentKey = bareName;
    // The slash spelling is how the user actually invoked it, so `rawName` is
    // deliberately left alone — it is the observed text, not the identity. Only
    // `normalizedName` moves, and only when it WAS the slash key; a normalizer
    // that already produced something else is left as it intended. This mirrors
    // the cloud's `SkillShadowIdentityRewrite` guard exactly.
    if (candidate.normalizedName === slashKey) {
      candidate.normalizedName = bareName;
    }
    // The candidate carried no definition of its own (that is a precondition of
    // being re-pointable), so there is no component/version linkage to move.
    candidate.localComponentId = null;
    candidate.localComponentVersionId = null;
  }
  return [...repointed];
}

/**
 * The bare skill name this candidate could name, or null when it is not even a
 * re-point candidate.
 *
 * The per-invocation definition evidence is excluded HERE rather than inside the
 * shared predicate, because it is the collector's own witness that a slash entry
 * resolved against a real `.claude/commands/<name>.md`. A command proved genuine
 * that way is never a skill, whatever the inventory says.
 *
 * `commandDefinitionWitness` is the AUTHORITATIVE signal — the exact expression
 * the per-occurrence correlation gates on, stamped by both `command` candidate
 * producers so the two guards cannot disagree about which commands are genuine.
 * It is checked instead of inferring from `definitionHash`/`definitionContent`,
 * which `exactEvidence` leaves null whenever the snapshot's un-normalized
 * `normalizedName` differs from the NORMALIZED component key: a `//deploy` entry
 * carrying a real `.claude/commands/deploy.md` snapshot (the leading-slash-run
 * population ISS-4795 documented as real, `/clear` 133 vs `//clear` 111) has
 * neither field set, so a guard reading only those would fold the very command
 * correlation protects. The hash/content check is KEPT as a second gate for the
 * stored-row rebuild, whose candidates carry no snapshot of their own but have
 * exact evidence restored onto them by `preserveStrongerEvidence`. That second
 * gate is `carriesOwnDefinitionEvidence`, the SHARED floor the cloud's staged-row
 * lane applies too (ISS-5260 / wongk review), so neither side can hold a row's
 * own definition and still fold it.
 */
function repointableBareName(
  candidate: AgentComponentInvocationCandidate
): string | null {
  if (candidate.componentKind !== AgentComponentInvocationKind.Command) {
    return null;
  }
  if (candidate.commandDefinitionWitness) {
    return null;
  }
  if (carriesOwnDefinitionEvidence(candidate)) {
    return null;
  }
  return slashKeyBareName(candidate.componentKey);
}

/**
 * The inventory evidence for `bareNames`, in one indexed read over
 * `agent_components` PER {@link SKILL_SHADOW_NAMES_PER_READ} names: the resolved
 * skills those names answer to, and the command rows that vouch for the matching
 * slash keys.
 *
 * Skills are restricted to `resolved` — an unresolved skill row is a name
 * observed in passing, not proof that a skill definition exists. Commands are
 * read at EVERY resolved state so a command carrying its own definition text
 * vouches for itself before resolution promotes it, which is the same widening
 * the cloud predicate took in ISS-4923.
 *
 * Chunked because the bind count grows with the name count (ISS-5260 / wongk
 * review) — see {@link SKILL_SHADOW_NAMES_PER_READ}. Evidence is a pure union of
 * per-chunk facts (a name's inventory row is found by exactly the chunk that
 * carries it), so splitting the read cannot change the decision.
 */
async function loadSkillShadowEvidence(
  tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe">,
  bareNames: string[]
): Promise<SkillShadowEvidence> {
  const resolvedSkillNames = new Set<string>();
  const vouchedCommandKeys = new Set<string>();
  for (
    let offset = 0;
    offset < bareNames.length;
    offset += SKILL_SHADOW_NAMES_PER_READ
  ) {
    const chunk = bareNames.slice(offset, offset + SKILL_SHADOW_NAMES_PER_READ);
    const rows = await readInventoryChunk(tx, chunk);
    for (const row of rows) {
      if (row.component_kind === AgentComponentInvocationKind.Skill) {
        resolvedSkillNames.add(row.component_key);
        continue;
      }
      if (
        row.resolved_state === ComponentResolvedState.Resolved ||
        row.content?.trim()
      ) {
        vouchedCommandKeys.add(row.component_key);
      }
    }
  }
  return { resolvedSkillNames, vouchedCommandKeys };
}

/**
 * One inventory read over a chunk of bare names, bounded by
 * {@link SKILL_SHADOW_NAMES_PER_READ} so the `3 + 2n` bind count stays under the
 * SQLite variable floor.
 */
function readInventoryChunk(
  tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe">,
  bareNames: string[]
): Promise<InventoryRow[]> {
  const skillPlaceholders = bareNames
    .map((_, index) => `$${index + 4}`)
    .join(", ");
  const commandPlaceholders = bareNames
    .map((_, index) => `$${index + 4 + bareNames.length}`)
    .join(", ");
  return tx.$queryRawUnsafe<InventoryRow[]>(
    `SELECT component_kind, component_key, resolved_state, content
       FROM agent_components
      WHERE (component_kind = $1
             AND resolved_state = $3
             AND component_key IN (${skillPlaceholders}))
         OR (component_kind = $2
             AND component_key IN (${commandPlaceholders}))`,
    AgentComponentInvocationKind.Skill,
    AgentComponentInvocationKind.Command,
    ComponentResolvedState.Resolved,
    ...bareNames,
    ...bareNames.map((name) => `/${name}`)
  );
}
