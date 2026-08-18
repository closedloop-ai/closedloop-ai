/**
 * The inventory writes every invocation-derivation path performs before its rows
 * are inserted: mint the `agent_components` row each candidate is attributed to,
 * and record the definition version any candidate carried.
 *
 * Extracted from `component-invocations.ts` (grandfathered, shrink-only — see
 * root AGENTS.md on touched grandfathered files) when ISS-5260 added the
 * skill re-point that has to run immediately before the component upsert. These
 * three helpers are one cohesive unit — "decide the identity, then write the
 * inventory rows for it" — so they belong together rather than as more weight on
 * the materializer.
 *
 * `ensureInvocationComponents` owns the ISS-5260 re-point rather than leaving it
 * to each caller: the import path, the legacy bootstrap, and the stored-row
 * rebuild bridge all need it, and all three need it in exactly the same place.
 * Folding it in makes that unskippable, where three separate call sites could
 * drift — which is the failure mode ISS-4811 had to add a second copy of the
 * skill-shadow correlation helper to work around.
 */
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import {
  type AgentComponentInvocationCandidate,
  deterministicId,
} from "./component-invocation-row-writer.js";
import { repointSkillInvokedCommandCandidates } from "./component-invocation-skill-repoint.js";
import type { Prisma } from "./generated/client.js";

/**
 * Mint the `agent_components` row each candidate is attributed to.
 *
 * ISS-5260: the attribution is settled FIRST. A slash invocation that per-
 * occurrence correlation could not pair may still BE a skill invocation — Claude
 * Code expands a slash-invoked skill without emitting a `Skill` tool_use at all —
 * so it is re-pointed onto the skill before any row is written, and no phantom
 * `command` component is minted for it.
 */
export async function ensureInvocationComponents(
  tx: Prisma.TransactionClient,
  candidates: AgentComponentInvocationCandidate[],
  now: string,
  /**
   * ISS-5260: optional so the legacy-bootstrap path can stay quiet, but every
   * caller that has a reporter should pass it — a re-point silently rewrites a
   * `command` identity to a `skill`, and that is the one fact an operator
   * debugging a mis-attributed component needs to see.
   */
  log?: (message: string) => void
): Promise<void> {
  const repointed = await repointSkillInvokedCommandCandidates(tx, candidates);
  if (repointed.length > 0 && log) {
    log(
      `ISS-5260: re-pointed ${repointed.length} slash invocation(s) onto their skill: ${repointed.join(", ")}`
    );
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!shouldEnsureInvocationComponent(candidate)) {
      continue;
    }
    const identity = `${candidate.componentKind}\u0000${candidate.componentKey}`;
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    const componentId = deterministicId(
      `${candidate.componentKind}|${candidate.componentKey}`
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO agent_components
         (id, component_kind, external_id, component_key, resolved_state,
          first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $3, 'unresolved', $4, $4)
       ON CONFLICT (component_kind, external_id) DO UPDATE SET
         component_key = COALESCE(agent_components.component_key, excluded.component_key),
         resolved_state = COALESCE(agent_components.resolved_state, 'unresolved'),
         last_seen_at = excluded.last_seen_at`,
      componentId,
      candidate.componentKind,
      candidate.componentKey,
      now
    );
  }
}

/** Record the definition revision any candidate captured alongside its invocation. */
export async function ensureInvocationVersions(
  tx: Prisma.TransactionClient,
  candidates: AgentComponentInvocationCandidate[],
  now: string
): Promise<void> {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!(candidate.definitionHash && candidate.definitionContent)) {
      continue;
    }
    const identity = `${candidate.componentKind}\u0000${candidate.componentKey}\u0000${candidate.definitionHash}`;
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    const versionId = deterministicId(
      `${candidate.componentKind}|${candidate.componentKey}||${candidate.definitionHash}`
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO agent_component_versions
         (id, component_kind, component_key, source, content_hash, content,
          format, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, '', $4, $5, 'md', $6, $6)
       ON CONFLICT (component_kind, component_key, source, content_hash)
       DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      versionId,
      candidate.componentKind,
      candidate.componentKey,
      candidate.definitionHash,
      candidate.definitionContent,
      now
    );
    candidate.localComponentVersionId = versionId;
  }
}

/**
 * A subagent candidate only earns an inventory row once it carries exact
 * definition evidence; every other kind is minted on sight.
 */
function shouldEnsureInvocationComponent(
  candidate: AgentComponentInvocationCandidate
): boolean {
  if (candidate.componentKind !== AgentComponentInvocationKind.Subagent) {
    return true;
  }
  return (
    candidate.definitionHash !== null &&
    candidate.normalizerContractVersion !== null
  );
}
