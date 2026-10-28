/**
 * @file otel-seeded-invocation-candidate.ts
 * @description ISS-10720: the invocation row the harness's OTel counter seats
 * when this device's transcript reconstruction missed the component entirely.
 *
 * WHY A ROW AND NOT A COUNTER (tamsinb on #7731). The first cut of the join
 * only CORROBORATED: a tuple naming a component the transcript had already
 * derived took the stamp, and a tuple naming a component the transcript never
 * saw went to `unmatchedAttributions` and wrote nothing. That is an agreement
 * join, and ISS-10720 AC#3 asks for the other thing — "precedence is explicit
 * and tested when OTel and the transcript disagree, one wins, the row records
 * which". With nothing written there was no row to record anything on, so the
 * harness could never actually overrule the transcript; it could only agree
 * with it louder.
 *
 * WHAT IT MAY AND MAY NOT CLAIM. A cost counter point carries NO occurrence
 * identifier, so this row asserts exactly what the counter supports and not one
 * field more: this component ran in this session. It therefore anchors to
 * {@link AgentComponentInvocationAnchorKind.Session} — the payload-free anchor
 * that already exists for precisely this "we know it happened here, not when" —
 * and leaves `invokedAt` NULL rather than borrowing a timestamp off the counter
 * point, which would be a fabricated occurrence dressed as a measurement. No
 * telemetry, no lines, no findings: this row measures nothing, it attributes.
 *
 * ONLY `agent_name` SEATS. `skill.name` is one key space for two components —
 * a skill and a same-named `/command` — so an unmatched skill tuple cannot say
 * which of the two ran, and a row that guessed would be worse than the counter
 * the caller keeps instead. `agent_name` names a Subagent and nothing else.
 */

import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionSource,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import {
  type OtelInvocationAttributionTally,
  stampOtelInvocationAttribution,
} from "../otel/claude-code-otel-invocation-attribution.js";
import {
  type AgentComponentInvocationCandidate,
  deterministicId,
} from "./component-invocation-row-writer.js";
import type { Prisma } from "./generated/client.js";

/**
 * Where a seeded row sorts among the transcript's own candidates.
 *
 * Above every producer's band (`command` candidates start at 200_000) so a
 * seeded row never displaces a transcript-derived one in `sequence`, and the
 * ordering a reader sees stays "what the transcript saw, then what only the
 * harness saw".
 */
const OTEL_SEEDED_SOURCE_ORDER_BASE = 900_000;

/**
 * Mint the candidate for one OTel tuple the transcript has no invocation for.
 *
 * `externalInvocationId` is derived from (session, kind, folded name) and
 * nothing else, so it is STABLE across every re-derivation: the same tuple
 * seats the same row id on the next import, the `ON CONFLICT` upsert lands on
 * it, and a re-run neither duplicates the row nor churns the generation hash.
 * It deliberately does NOT include the counter's value or timestamp — those
 * change while the fact this row records does not.
 */
export function seededOtelInvocationCandidate(input: {
  sessionId: string;
  componentKind: AgentComponentInvocationKind;
  componentKey: string;
  ordinal: number;
  now: string;
}): AgentComponentInvocationCandidate {
  const externalInvocationId = deterministicId(
    `otel-attribution|${input.sessionId}|${input.componentKind}|${input.componentKey}`
  );
  return {
    externalInvocationId,
    externalSourceId: null,
    childSessionId: null,
    agentId: null,
    parentAgentId: null,
    componentKind: input.componentKind,
    componentKey: input.componentKey,
    rawName: input.componentKey,
    normalizedName: input.componentKey,
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: null,
    sourceOrder: OTEL_SEEDED_SOURCE_ORDER_BASE + input.ordinal,
    sequence: OTEL_SEEDED_SOURCE_ORDER_BASE + input.ordinal,
    anchorKind: AgentComponentInvocationAnchorKind.Session,
    anchorValue: input.sessionId,
    providerToolUseId: null,
    // The harness named the component outright, so the attribution is settled —
    // `unresolved` is what this device says when IT could not settle one.
    attributionStatus: AgentComponentInvocationAttributionStatus.Matched,
    evidenceClass: AgentComponentInvocationEvidenceClass.OtelCounter,
    evidencePointer: null,
    definitionHash: null,
    normalizerContractVersion: null,
    definitionContent: null,
    localComponentId: null,
    localComponentVersionId: null,
    gitBranch: null,
    repositoryFullName: null,
    succeeded: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    estimatedCost: null,
    usageMeasurement: null,
    /* ISS-10736: no operand exists. The footprint is counted from a result
       payload, a definition body or stdout, and a row minted from an OTel
       counter has none of them — nothing was measured, as with
       `findingsDisposition` below. */
    footprintTokens: null,
    linesAdded: null,
    linesRemoved: null,
    findingsEmitted: null,
    findingsInvalidated: null,
    /* ISS-11325: absent, not a withholding. This row is minted from an OTel
       counter, so no code-review ingest ever looked at it and there is nothing
       to disclose — a `withheld-*` label here would be the disclosure becoming
       decoration. The findings pass may still stamp it later if a matched
       reviewer resolves to this component. */
    findingsDisposition: null,
    attributionSource: AgentComponentInvocationAttributionSource.HarnessOtel,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * Which invocation kinds an unmatched OTel tuple may seat a row for.
 *
 * An EXHAUSTIVE `Record`, not a set of the members that happen to qualify
 * today: a set built from the current kinds still compiles when a kind is
 * added, so the new one would silently fall to "not seatable" with nothing to
 * say so. Written this way, adding a kind fails `tsc` until someone rules on
 * it. `Skill` and `Command` are `false` because `skill.name` is one harness key
 * space for both, so an unmatched tuple there cannot say which one ran.
 */
const OTEL_SEATABLE_KIND: Record<AgentComponentInvocationKind, boolean> = {
  [AgentComponentInvocationKind.Subagent]: true,
  [AgentComponentInvocationKind.Skill]: false,
  [AgentComponentInvocationKind.Command]: false,
  [AgentComponentInvocationKind.Hook]: false,
  [AgentComponentInvocationKind.Tool]: false,
  [AgentComponentInvocationKind.Mcp]: false,
  [AgentComponentInvocationKind.Orchestration]: false,
};

/** Whether this join may seat a row for `kind`. */
function isSeatableInvocationKind(
  kind: string
): kind is AgentComponentInvocationKind {
  return OTEL_SEATABLE_KIND[kind as AgentComponentInvocationKind] === true;
}

/**
 * Run the OTel attribution join over desktop candidates, ALWAYS with the seat.
 *
 * The single entry point every write path uses, so the precedence half cannot
 * be wired into three of the four and forgotten on the fourth — an omission
 * that would be invisible, because a path without the seat still stamps the
 * corroborated rows and still reports a tally.
 */
export async function stampOtelAttributionOnCandidates(
  tx: Pick<Prisma.TransactionClient, "$queryRawUnsafe">,
  sessionId: string,
  candidates: AgentComponentInvocationCandidate[],
  now: string,
  log: (message: string) => void
): Promise<OtelInvocationAttributionTally> {
  let ordinal = 0;
  return await stampOtelInvocationAttribution(
    tx,
    sessionId,
    candidates,
    log,
    ({ componentKind, name }) => {
      if (!isSeatableInvocationKind(componentKind)) {
        return;
      }
      const seated = seededOtelInvocationCandidate({
        sessionId,
        componentKind,
        componentKey: name,
        ordinal,
        now,
      });
      ordinal += 1;
      return seated;
    }
  );
}
