/**
 * @file component-invocation-hook-candidates.ts
 * @description Invocation candidates for HOOK firings — the sibling of
 * `component-invocation-command-candidates.ts` and
 * `component-invocation-subagent-candidates.ts`.
 *
 * Extracted from `component-invocations.ts` (grandfathered shrink-only under the
 * root AGENTS.md line-count contract) so the hook lane owns its own anchoring
 * contract and its own footprint source rather than growing that file further.
 */
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { hookComponentKey } from "@repo/lib/harness/hook-identity";
import type { ToolCandidateContext } from "./component-invocation-candidate-context.js";
import { withCandidateFootprint } from "./component-invocation-footprint-sources.js";
import type { markdownCandidate as MarkdownCandidateImpl } from "./component-invocation-markdown-candidate.js";
import type { AgentComponentInvocationCandidate } from "./component-invocation-row-writer.js";

type MarkdownCandidateFn = typeof MarkdownCandidateImpl;

/**
 * FEA-4093: one invocation candidate per captured Hook firing
 * (`session.hooks`, from transcript `attachment` hook_success/hook_error
 * records). Before this, hooks produced no candidates, so `Hook` inventory
 * rows aggregated to zero usage even though hooks fire regularly — the bug this
 * fixes.
 *
 * `componentKey` is the normalized per-handler identity from
 * `hookComponentKey(hook.name, hook.command)` — the harness `hookName` (e.g.
 * `"PreToolUse:Bash"`) plus the machine-independent normalized `command` as a
 * discriminator. `hookName` alone collapses distinct handlers that share a
 * matcher (in the corpus `PreToolUse:Bash` maps to three different commands),
 * while the raw command leaks host-specific home paths; the normalizer keeps
 * handlers distinct without leaking paths (see `hook-identity.ts`).
 *
 * A hook attachment is not a transcript turn item, so it has no tool/message
 * ordinal to resolve a Timestamp anchor against (a timestamp collision would
 * mis-link to an unrelated row). It therefore anchors to the Session — its
 * per-firing distinctness lives in `externalInvocationId` and the normalized
 * `componentKey`, and the failed-firing rollup reads `succeeded` directly, not
 * the anchor. Hooks run on the orchestrator (there is no per-firing subagent
 * axis in the transcript), so they attribute to `mainAgentId` with a Direct
 * relationship.
 */
export function hookCandidates(
  context: ToolCandidateContext,
  markdownCandidate: MarkdownCandidateFn
): AgentComponentInvocationCandidate[] {
  const { session, mainAgentId, now } = context;
  return (session.hooks ?? []).map((hook, index) => {
    const componentKey = hookComponentKey(hook.name, hook.command);
    const externalInvocationId = `hook:${index}:${hook.timestamp ?? "unknown"}:${componentKey}`;
    return markdownCandidate({
      session,
      mainAgentId,
      externalInvocationId,
      externalSourceId: null,
      providerToolUseId: null,
      componentKind: AgentComponentInvocationKind.Hook,
      componentKey,
      rawName: hook.name,
      normalizedName: componentKey,
      invokedAt: hook.timestamp,
      sourceOrder: 250_000 + index,
      agentId: mainAgentId,
      parentAgentId: null,
      relationship: AgentComponentInvocationRelationship.Direct,
      anchorKind: AgentComponentInvocationAnchorKind.Session,
      anchorValue: session.sessionId,
      snapshot: undefined,
      focusedEvidence: context.evidenceByInvocationId.get(externalInvocationId),
      externalAgentId: null,
      parentExternalInvocationId: null,
      succeeded: hook.succeeded,
      // ISS-10736: a hook's footprint is its stdout — what the firing injected
      // into the turn that followed it — counted at parse time over the whole
      // block rather than a capped prefix of it.
      ...withCandidateFootprint(hook.stdoutFootprintTokens),
      now,
    });
  });
}
