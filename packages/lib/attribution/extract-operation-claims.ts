/**
 * ISS-12552: one operation claim per ClosedLoop MCP call, one
 * per shell call that printed `clop_` operation ids, and one reference claim
 * per slug the session named elsewhere. Claims record observations; the
 * server binds them to receipts and classifies them.
 */
import {
  MAX_SYNCED_OPERATION_CLAIMS,
  OperationKind,
} from "@repo/api/src/types/attribution-evidence";
import {
  operationSemanticsFor,
  RECEIPTED_OPERATION_KINDS,
} from "@repo/api/src/types/closedloop-operation-semantics";
import {
  MAX_UNSUPPORTED_TOOL_NAMES,
  OPERATION_EVIDENCE_MAX_CLAIM_BYTES,
  type OperationClaim,
  OperationClaimSource,
  type OperationEvidenceCoverage,
} from "@repo/api/src/types/operation-claims";
import { computeRequestFingerprint } from "@repo/api/src/utils/request-fingerprint";
import { CODEX_CODE_MODE_TOOL_NAME } from "../harness/codex/codex-mcp-tool-call-item";
import { isShellCommandToolUse, shellCommand } from "../harness/parser-utils";
import {
  collectSessionToolUses,
  type IndexedToolUse,
} from "../harness/session-tool-uses";
import {
  readClosedloopServerMethod,
  resolveClosedloopToolName,
} from "../harness/tool-result-facts";
import {
  Harness,
  type NormalizedSession,
  type NormalizedToolUse,
} from "../harness/types";
import { resultStateOf } from "./claim-result-state";
import { implementationJoinClaims } from "./implementation-requests";
import { readClaimTargets } from "./operation-claim-targets";
import {
  extractReferenceClaims,
  type ResultSlugSighting,
} from "./operation-reference-claims";
import {
  type GitWriteInput,
  repositoryActivity,
} from "./repository-write-claims";

export type ExtractedOperationEvidence = {
  claims: OperationClaim[];
  coverage: OperationEvidenceCoverage;
};

/** Harnesses whose MCP calls carry a call id the server stores. */
const EVIDENCE_PATH_HARNESSES: ReadonlySet<Harness> = new Set([
  Harness.Claude,
  Harness.Codex,
]);
const CLOSEDLOOP_API_COMMAND_RE = /closedloop\.ai|CLOSEDLOOP_API/i;

type SessionCall = IndexedToolUse & { callId?: string };

type ClaimDraft = Omit<OperationClaim, "claimKey"> & { callId?: string };

/**
 * The claims and coverage for one parsed session. Claims beyond
 * {@link MAX_SYNCED_OPERATION_CLAIMS} or
 * {@link OPERATION_EVIDENCE_MAX_CLAIM_BYTES} are dropped references first and
 * counted, never silently lost.
 */
export async function extractOperationClaims(
  session: NormalizedSession,
  harness: Harness,
  /** Commits, pushes and PR creates the caller found, by tool-use index. */
  gitWrites: readonly GitWriteInput[] = []
): Promise<ExtractedOperationEvidence> {
  const calls = collectSessionCalls(session);
  const unsupportedToolNames: Record<string, number> = Object.create(null);
  const mcpDrafts: ClaimDraft[] = [];
  const shellDrafts: ClaimDraft[] = [];
  const otherCalls: IndexedToolUse[] = [];
  let directApiShellCommands = 0;
  for (const call of calls) {
    const method = readClosedloopServerMethod(call.tu);
    if (method !== null) {
      mcpDrafts.push(await closedloopDraft(call, method, unsupportedToolNames));
      continue;
    }
    if (
      harness === Harness.Codex &&
      call.tu.name === CODEX_CODE_MODE_TOOL_NAME
    ) {
      continue;
    }
    otherCalls.push(call);
    if (!isShellCommandToolUse(call.tu)) {
      continue;
    }
    if (call.tu.shellOperationIds?.length) {
      shellDrafts.push(shellDraft(call));
    } else if (CLOSEDLOOP_API_COMMAND_RE.test(shellCommand(call.tu))) {
      directApiShellCommands += 1;
    }
  }
  const observed = keyCallClaims(harness, [...mcpDrafts, ...shellDrafts]);
  const all = [
    ...observed,
    ...implementationJoinClaims(
      harness,
      repositoryActivity(harness, calls, gitWrites)
    ),
    ...extractReferenceClaims(
      session,
      otherCalls,
      resultSlugSightings(mcpDrafts)
    ),
  ];
  const claims = withinClaimCaps(all);
  return {
    claims,
    coverage: {
      harness,
      ...(session.version ? { harnessVersion: session.version } : {}),
      evidencePathSupported: EVIDENCE_PATH_HARNESSES.has(harness),
      closedloopMcpCalls: mcpDrafts.length,
      shellCallsWithOperationIds: shellDrafts.length,
      directApiShellCommands,
      unsupportedToolNames,
      claimsDroppedByCap: all.length - claims.length,
    },
  };
}

/**
 * The tool stream, then code-mode MCP evidence the stream does not already
 * hold (the parser merges most, but a replayed item can arrive first).
 */
function collectSessionCalls(session: NormalizedSession): SessionCall[] {
  const stream: SessionCall[] = collectSessionToolUses(session).map((call) => ({
    ...call,
    ...callIdOf(call.tu),
  }));
  const streamIds = new Set(stream.flatMap((call) => call.callId ?? []));
  let nextIndex = stream.length;
  for (const tu of session.mcpCallEvidence ?? []) {
    const { callId } = callIdOf(tu);
    if (callId && streamIds.has(callId)) {
      continue;
    }
    stream.push({
      tu,
      toolIndex: nextIndex,
      agentId: tu.subagentId ?? null,
      ...(callId ? { callId } : {}),
    });
    nextIndex += 1;
  }
  return stream;
}

function callIdOf(tu: NormalizedToolUse): { callId?: string } {
  const callId = tu.providerToolUseId ?? tu.id;
  return callId ? { callId } : {};
}

async function closedloopDraft(
  call: SessionCall,
  method: string,
  unsupportedToolNames: Record<string, number>
): Promise<ClaimDraft> {
  const { tu } = call;
  const toolName = resolveClosedloopToolName(tu);
  if (
    toolName === null &&
    (method in unsupportedToolNames ||
      Object.keys(unsupportedToolNames).length < MAX_UNSUPPORTED_TOOL_NAMES)
  ) {
    unsupportedToolNames[method] = (unsupportedToolNames[method] ?? 0) + 1;
  }
  const semantics = operationSemanticsFor(toolName ?? method);
  const facts = tu.closedloopResultFacts;
  const receipt =
    RECEIPTED_OPERATION_KINDS.has(semantics.kind) && facts?.operationReceipt;
  const inputTargets = readClaimTargets(tu.input, semantics.targetKeys);
  const relatedTargets = readClaimTargets(
    tu.input,
    semantics.relatedKeys ?? []
  );
  return {
    ...commonFields(call),
    source: OperationClaimSource.ClosedloopMcp,
    toolName: toolName ?? method,
    operationKind:
      toolName === null ? OperationKind.Unsupported : semantics.kind,
    resultState: resultStateOf(tu),
    requestFingerprint: await computeRequestFingerprint(
      toolName ?? method,
      tu.input ?? {}
    ),
    ...(inputTargets.length > 0 ? { inputTargets } : {}),
    ...(relatedTargets.length > 0 ? { relatedTargets } : {}),
    ...(receipt ? { operationIds: [receipt.operationId] } : {}),
    ...(facts?.primaryEntity
      ? { primaryResultEntity: facts.primaryEntity }
      : {}),
    ...(facts?.nestedSlugs.length
      ? { nestedReferenceSlugs: facts.nestedSlugs }
      : {}),
  };
}

function shellDraft(call: SessionCall): ClaimDraft {
  return {
    ...commonFields(call),
    source: OperationClaimSource.Shell,
    resultState: resultStateOf(call.tu),
    operationIds: call.tu.shellOperationIds ?? [],
  };
}

function commonFields(call: SessionCall): Partial<ClaimDraft> {
  const { tu, agentId, callId } = call;
  return {
    ...(callId ? { callId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(tu.requestKey ? { requestKey: tu.requestKey } : {}),
    ...(!tu.requestKey && tu.candidateRequestKeys?.length
      ? { candidateRequestKeys: tu.candidateRequestKeys }
      : {}),
    ...(!tu.requestKey && tu.requestUnresolved
      ? { requestUnresolved: true as const }
      : {}),
    ...(tu.timestamp ? { invokedAt: tu.timestamp } : {}),
    ...(tu.resultTimestamp ? { resultAt: tu.resultTimestamp } : {}),
  };
}

/**
 * Key each call claim by harness and call id. A call with no id, or an id
 * another call in the session also carries, gets an ordinal key and is
 * flagged ambiguous, so it can never bind a receipt by id.
 */
function keyCallClaims(
  harness: Harness,
  drafts: readonly ClaimDraft[]
): OperationClaim[] {
  const idCounts = new Map<string, number>();
  for (const draft of drafts) {
    if (draft.callId) {
      idCounts.set(draft.callId, (idCounts.get(draft.callId) ?? 0) + 1);
    }
  }
  return drafts.map(({ callId, providerCallId, ...draft }, ordinal) => {
    const unique = callId !== undefined && idCounts.get(callId) === 1;
    return unique
      ? { ...draft, providerCallId: callId, claimKey: `${harness}:${callId}` }
      : {
          ...draft,
          claimKey: `${harness}:ordinal:${ordinal}`,
          ambiguous: true,
        };
  });
}

const UTF8 = new TextEncoder();

/**
 * The claims that fit {@link MAX_SYNCED_OPERATION_CLAIMS} and the sync byte
 * budget, kept by priority and returned in their original order: writes a
 * receipt can prove, shell claims carrying operation ids, and implementation
 * joins first, then other ClosedLoop calls, then references. A long session's
 * reads cannot crowd out a later write.
 */
function withinClaimCaps(claims: readonly OperationClaim[]): OperationClaim[] {
  const byPriority = claims
    .map((claim, index) => ({ claim, index, rank: claimPriority(claim) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index);
  const kept = new Set<number>();
  let bytes = 2;
  for (const { claim, index } of byPriority) {
    const size =
      UTF8.encode(JSON.stringify(claim)).length + (kept.size > 0 ? 1 : 0);
    if (kept.size >= MAX_SYNCED_OPERATION_CLAIMS) {
      break;
    }
    // A smaller claim behind this one may still fit what remains.
    if (bytes + size > OPERATION_EVIDENCE_MAX_CLAIM_BYTES) {
      continue;
    }
    bytes += size;
    kept.add(index);
  }
  return claims.filter((_, index) => kept.has(index));
}

function claimPriority(claim: OperationClaim): number {
  if (claim.source === OperationClaimSource.Reference) {
    return 2;
  }
  return claim.source === OperationClaimSource.Shell ||
    claim.source === OperationClaimSource.ImplementationJoin ||
    (claim.operationKind !== undefined &&
      RECEIPTED_OPERATION_KINDS.has(claim.operationKind))
    ? 0
    : 1;
}

function resultSlugSightings(
  drafts: readonly ClaimDraft[]
): ResultSlugSighting[] {
  return drafts.flatMap((draft) =>
    (draft.nestedReferenceSlugs ?? []).map((slug) => ({
      slug,
      ...(draft.agentId ? { agentId: draft.agentId } : {}),
      ...((draft.resultAt ?? draft.invokedAt)
        ? { at: draft.resultAt ?? draft.invokedAt }
        : {}),
    }))
  );
}
