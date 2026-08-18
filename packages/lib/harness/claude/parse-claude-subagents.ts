/**
 * @file parse-claude-subagents.ts
 * @description Claude subagent IDENTITY — the pure functions that decide what a
 * subagent record is called and which subagent a raw line belongs to. Split out
 * of `parse-claude.ts` under ISS-4592 to pay that grandfathered file back down
 * (repo AGENTS.md: an over-size file must never grow).
 *
 * Everything here is pure and accumulator-free, which is exactly why it can
 * live outside the parser: `ensureSidechainSubagent` stays in `parse-claude.ts`
 * because it mutates the session accumulator, and it calls into these.
 */

import { stringValue } from "../parser-utils";
import type { NormalizedSubagent } from "../types";

const CLAUDE_SUBAGENT_FILE_PREFIX_RE = /^agent-/;

/**
 * Build a subagent shell for a Claude sidecar `agent-*.jsonl` file. Exported for
 * the desktop shell, whose sidecar-file merge synthesizes one when no in-line
 * sidechain subagent already represents the file.
 */
export function createSidecarSubagent(
  nativeSubagentId: string,
  timestamp: string | null
): NormalizedSubagent {
  return {
    id: nativeSubagentId,
    parentId: null,
    name: `Claude subagent ${nativeSubagentId
      .replace(CLAUDE_SUBAGENT_FILE_PREFIX_RE, "")
      .slice(0, 8)}`,
    startedAt: timestamp,
    endedAt: timestamp,
    status: "completed",
    nativeSubagentId,
    toolUses: [],
  };
}

/**
 * FEA-3597: provenance id for a record that is provably NOT the parent's but
 * whose owning subagent cannot be identified — a sidechain entry carrying no
 * `agentId`, `uuid`, `parentUuid` or `sessionId`.
 *
 * `ensureSidechainSubagent` returns `null` for those, yet the usage line is
 * still accepted into the dedup map. Leaving such a record unmarked would make
 * it read as PARENT and inflate the parent's agent-turn count — precisely the
 * over-count FEA-3597 removes. Marking it with this sentinel excludes it from
 * the parent without fabricating a specific subagent identity.
 *
 * It deliberately need NOT match any `NormalizedSubagent.id`; consumers joining
 * `tokenSeries.subagentId` to `subagents[].id` must tolerate a miss. Appearing
 * in volume is a data-quality signal worth investigating, not a normal state.
 */
export const UNATTRIBUTED_SUBAGENT_ID = "unattributed-subagent";

/**
 * FEA-3597: the single formula turning a Claude sidechain record's raw ids into
 * a stable subagent id. Shared by `ensureSidechainSubagent` (which builds the
 * `NormalizedSubagent` row) and `extractDedupedUsage` (which stamps provenance
 * onto the token records), so the two can never disagree about who owns a turn.
 *
 * Matches the sidecar basename shape (`agent-<uuid>`) so an in-line sidechain
 * record reconciles with the `agent-*.jsonl` file the desktop shell folds.
 */
export function normalizeSidechainSubagentId(
  nativeId: string,
  providerAgentId: string | null
): string {
  if (!providerAgentId) {
    return nativeId;
  }
  return providerAgentId.startsWith("agent-")
    ? providerAgentId
    : `agent-${providerAgentId}`;
}

/**
 * FEA-3597: provenance for one raw transcript entry, or `undefined` when the
 * entry is a parent round-trip.
 *
 * A non-sidechain entry is the parent's. A sidechain entry is a subagent's —
 * and if no id can be recovered it still is not the parent's, so it gets
 * `UNATTRIBUTED_SUBAGENT_ID` rather than being silently counted as parent.
 *
 * The parser DOES emit a `NormalizedSubagent` under this id, so a consumer
 * joining `tokenSeries.subagentId` to `subagents[].id` resolves rather than
 * missing. It is a provenance anchor only: the desktop invocation lane skips it
 * (`parserSubagentCandidates`) so it is never counted as a delegated agent.
 */
export function deriveSidechainSubagentId(
  entry: Record<string, unknown>
): string | undefined {
  if (entry.isSidechain !== true) {
    return undefined;
  }
  const providerAgentId = stringValue(entry.agentId);
  const nativeId =
    providerAgentId ??
    stringValue(entry.uuid) ??
    stringValue(entry.parentUuid) ??
    stringValue(entry.sessionId);
  if (!nativeId) {
    return UNATTRIBUTED_SUBAGENT_ID;
  }
  return normalizeSidechainSubagentId(nativeId, providerAgentId);
}
