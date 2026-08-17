/**
 * ISS-4923 (ISS-4778 follow-up) — the THIRD cloud ingest lane for the
 * skill-shadowed phantom `command`: exact invocation-generation parts.
 *
 * ISS-4778 (#4247) guarded the other two lanes by DROPPING or FOLDING the
 * phantom at ingest (`desktop/components/sync/skill-shadow-guard.ts` and
 * `component-usage.ts`). Neither shape is safe here, and the reason is the
 * content hash: a generation's `externalGenerationId` is a hash the desktop
 * computed over the items it sent, and `completeGenerationIfReady` re-derives
 * that hash from the STORED invocation rows once the last part lands.
 * `componentKind`, `componentKey`, and `normalizedName` are all in
 * `INVOCATION_HASH_SELECT`, so rewriting or dropping a staged row before the
 * check makes the re-derivation diverge and the generation is rejected with
 * `GenerationConflict` — permanently, because the part ledger is already
 * recorded and `partLedgerMatches` short-circuits every retry back into the
 * same failing call. The session would lose that generation outright, which is
 * strictly worse than the phantom row. (Same reasoning as the ISS-4778
 * migration's `completed_at IS NOT NULL` exclusion of staged generations.)
 *
 * So this lane normalizes POST-HASH: the hash check runs against the unmodified
 * staged rows, and only then — inside `resolveGenerationInvocations`, alongside
 * the resolution-derived columns `applyResolutionUpdates` already rewrites — is
 * the phantom's identity re-pointed at the real skill. NOTHING HERE FEEDS A
 * CONTENT HASH: the desktop's `externalGenerationId` preimage is built from what
 * the desktop sent, and the server only ever re-derives it from the pre-rewrite
 * rows, so no existing record is re-identified by this normalization.
 *
 * The predicate and the inventory read are the SHARED ones in
 * `@/lib/skill-shadow`, so ingest, the usage fold, and the backfill migration
 * all agree on what a phantom is — including the "a RESOLVED `/deploy` command
 * proves the slash key is genuine" carve-out.
 */
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import type { TransactionClient } from "@repo/database";
import { carriesOwnDefinitionEvidence } from "@repo/lib/sessions/skill-shadow-identity";
import {
  isSkillShadowedPhantom,
  loadSkillShadowInventory,
  skillShadowBareName,
} from "@/lib/skill-shadow";
import type { StagedInvocationRow } from "./component-invocation-helpers";

/**
 * The identity columns a phantom row takes on once it is re-pointed at the skill
 * it shadowed. `normalizedName` is OMITTED (never `null`) when the row's own
 * normalized name is not the phantom slash key — mirroring the backfill
 * migration's `CASE WHEN aci.normalized_name = m.phantom_key` guard, and letting
 * the UPDATE's `COALESCE` leave a caller-supplied normalized name untouched.
 */
export type SkillShadowIdentityRewrite = {
  componentKind: string;
  componentKey: string;
  normalizedName?: string;
};

/**
 * The staged rows to RESOLVE against (phantoms carrying the skill identity so
 * component lookup lands on the skill inventory row), plus the identity rewrite
 * each phantom's `ResolutionUpdate` must carry so the stored row is re-pointed
 * too. Rows that are not phantoms are passed through by reference.
 */
export type SkillShadowNormalization = {
  rows: StagedInvocationRow[];
  rewritesByInvocationId: ReadonlyMap<string, SkillShadowIdentityRewrite>;
};

/**
 * Re-point every skill-shadowed phantom `command` invocation in `rows` at the
 * resolved skill it shadowed. Costs at most ONE extra indexed read, and only
 * when the generation actually carries a slash-keyed command invocation.
 *
 * Deliberately conservative, exactly like the usage fold: a staged invocation
 * carries no `resolvedState`/`content` of its own, so the stored inventory is
 * the evidence. A slash-keyed command is a phantom only when a RESOLVED skill
 * with the bare name exists on this compute target AND no command row vouches
 * for that slash key. A genuine `/deploy` — with or without a `deploy` skill
 * beside it — is always left alone.
 *
 * ISS-4923 (wongk review): "vouches" is BOTH command-side signals the sibling
 * inventory guard uses, not just resolution. `resolvedCommandKeys` covers a
 * command already promoted to `resolved`; `definedCommandKeys` covers a command
 * whose `.claude/commands/<name>.md` text synced but whose resolution has not
 * landed yet. Reading only the former made this predicate LOOSER than the two
 * lanes it mirrors — the inventory guard requires `content == null` and a
 * non-resolved state, and the backfill migration requires `content IS NULL` — so
 * a content-bearing unresolved `/deploy` arriving before its resolution would be
 * rewritten to `skill:deploy`, and the kind-scoped hash check would then return
 * `GenerationConflict` until the desktop dead-lettered it.
 */
export async function normalizeSkillShadowedInvocations(
  tx: TransactionClient,
  computeTargetId: string,
  rows: readonly StagedInvocationRow[]
): Promise<SkillShadowNormalization> {
  const bareNameByInvocationId = new Map<string, string>();
  for (const row of rows) {
    const bareName = repointableBareName(row);
    if (bareName) {
      bareNameByInvocationId.set(row.id, bareName);
    }
  }
  if (bareNameByInvocationId.size === 0) {
    return { rewritesByInvocationId: new Map(), rows: [...rows] };
  }

  const inventory = await loadSkillShadowInventory(tx, computeTargetId, [
    ...new Set(bareNameByInvocationId.values()),
  ]);

  const rewritesByInvocationId = new Map<string, SkillShadowIdentityRewrite>();
  const normalizedRows: StagedInvocationRow[] = [];
  for (const row of rows) {
    const bareName = bareNameByInvocationId.get(row.id);
    // Exact command evidence excludes the row BEFORE the skill-inventory
    // fallback — see `isSkillShadowedPhantom`, the one predicate this lane and
    // the usage fold share (ISS-4923 / wongk review).
    const isPhantom = isSkillShadowedPhantom(
      inventory,
      bareName ?? null,
      row.componentKey
    );
    if (!(bareName && isPhantom)) {
      normalizedRows.push(row);
      continue;
    }
    const rewrite: SkillShadowIdentityRewrite = {
      componentKey: bareName,
      componentKind: AgentComponentInvocationKind.Skill,
      // The migration only rewrites `normalized_name` when it IS the phantom
      // slash key; a normalizer that already produced something else (a bare or
      // namespaced name) is left as the producer intended.
      ...(row.normalizedName === row.componentKey
        ? { normalizedName: bareName }
        : {}),
    };
    rewritesByInvocationId.set(row.id, rewrite);
    normalizedRows.push({
      ...row,
      componentKey: rewrite.componentKey,
      componentKind: rewrite.componentKind,
      normalizedName: rewrite.normalizedName ?? row.normalizedName,
    });
  }
  return { rewritesByInvocationId, rows: normalizedRows };
}

/**
 * The bare skill name this staged row could name, or null when it is not a
 * re-point candidate at all.
 *
 * ISS-5260 (wongk review): the ROW-LEVEL definition evidence is excluded here,
 * not left to the inventory. The shared contract states that a caller holding
 * per-invocation definition evidence must exclude it before the predicate runs,
 * and this lane holds exactly that — a staged row carries `definitionHash` and
 * `definitionContent` from the desktop.
 *
 * Without it the ordering breaks in the one direction the inventory cannot
 * cover: a genuine `/deploy` generation that arrives BEFORE its command
 * inventory row syncs has nothing in `vouchedCommandKeys` to protect it, so it
 * would be rewritten onto a `deploy` skill. `resolveDefinitionVersion` then
 * hashes the carried definition content under the SKILL kind, the kind-scoped
 * hash check disagrees with the command hash the desktop computed, and the
 * generation is rejected with `GenerationConflict` — permanently, because
 * `partLedgerMatches` short-circuits every retry back into the same call. That
 * is the precise failure this lane's post-hash design exists to avoid.
 *
 * The collector applies the same floor plus its own authoritative
 * `commandDefinitionWitness`; the shared helper keeps the two floors identical.
 */
function repointableBareName(row: StagedInvocationRow): string | null {
  if (carriesOwnDefinitionEvidence(row)) {
    return null;
  }
  return skillShadowBareName(row.componentKind, row.componentKey);
}
