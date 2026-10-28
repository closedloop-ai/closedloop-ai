/**
 * @file component-invocation-footprint-sources.ts
 * @description ISS-10736: how a desktop invocation candidate receives its
 * CONTEXT FOOTPRINT — the plumbing between the parse-time counts and the
 * candidate factories.
 *
 * Which text each kind's footprint is counted from is declared once, in
 * `@repo/api/src/types/agent-component-footprint`; this module only carries the
 * value across. A sibling rather than another block in
 * `component-invocations.ts`, which is grandfathered shrink-only.
 */
import {
  AGENT_COMPONENT_FOOTPRINT_SOURCE,
  type AgentComponentFootprint,
  AgentComponentFootprintSource,
  agentComponentFootprintFromTokenCount,
} from "@repo/api/src/types/agent-component-footprint";
import type { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";

/**
 * ISS-10736: spread a pre-counted footprint onto a candidate factory's input, or
 * nothing at all when there was none to count.
 *
 * Every kind reaching this helper counted at PARSE time, above a size cap its
 * carrier imposes further down — a tool result at 4 KiB, a hook's stdout at the
 * worker payload bound — so the value arrives as a number rather than as text to
 * count here. `skill` and `command` do not come through here at all: their source
 * is the definition body, which is carried whole, and the markdown factory
 * resolves it from the very content it decided the row carries.
 *
 * Omission rather than an explicit `undefined`, so an absent footprint has one
 * shape everywhere and a number is never invented for a source that was missing.
 */
export function withCandidateFootprint(value: number | null | undefined): {
  footprint?: AgentComponentFootprint;
} {
  const footprint = agentComponentFootprintFromTokenCount(value);
  return footprint ? { footprint } : {};
}

/**
 * ISS-10736: the footprint count persisted on a stored tool event, or `null`
 * when the cell is absent or is not a number this contract can accept. The
 * validity check itself lives in `agentComponentFootprintFromTokenCount`, which
 * owns the whole impossible set for a token count; this only narrows the
 * untyped JSON cell to a number first.
 */
function storedFootprintTokens(
  data: Record<string, unknown> | null
): number | null {
  const value = data?.toolFootprintTokens;
  return typeof value === "number" ? value : null;
}

/**
 * ISS-10736: the stored-rebuild lane's footprint, GATED ON THE DECLARED SOURCE
 * rather than attached to whatever the row turns out to be.
 *
 * `toolFootprintTokens` is a count of the tool RESULT, written by
 * `importToolEventData` for every tool_use uniformly — but `classifyStoredTool`
 * can resolve one of those same rows to `skill`, whose footprint is declared to
 * be its DEFINITION BODY. Attaching it there would publish one source's number
 * under another's name: the mirror image of the rule `footprintFor` states on
 * the transcript path. The rebuild lane stores no definition body, so `skill`
 * correctly gets nothing here, exactly as the `command` and `subagent` rebuild
 * sources already do.
 */
export function storedResultPayloadFootprint(
  kind: AgentComponentInvocationKind,
  data: Record<string, unknown> | null
): { footprint?: AgentComponentFootprint } {
  return AGENT_COMPONENT_FOOTPRINT_SOURCE[kind] ===
    AgentComponentFootprintSource.ResultPayload
    ? withCandidateFootprint(storedFootprintTokens(data))
    : {};
}
