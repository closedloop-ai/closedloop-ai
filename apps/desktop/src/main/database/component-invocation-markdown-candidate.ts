/**
 * The shared candidate-shaping factory for `agent_component_invocations`.
 *
 * `markdownCandidate` is already injected into the sibling candidate producers
 * (`component-invocation-command-candidates.ts`,
 * `component-invocation-subagent-candidates.ts`) rather than called through
 * `component-invocations.ts`, so the shaping concern had outgrown that module's
 * ownership. Extracted here (ISS-7795) so the one place a candidate's shape is
 * decided — including which evidence it carries and which telemetry rides with
 * it — has its own home and its own test surface.
 */

import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import {
  AGENT_COMPONENT_FOOTPRINT_SOURCE,
  type AgentComponentFootprint,
  AgentComponentFootprintSource,
  resolveAgentComponentFootprint,
} from "@repo/api/src/types/agent-component-footprint";
import {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import type {
  NormalizedComponentUsage,
  NormalizedDefinitionSnapshot,
  NormalizedInvocationDefinitionEvidence,
  NormalizedSession,
  NormalizedTokenRecord,
  NormalizedToolUse,
} from "@repo/lib/harness/types";
import {
  type AgentComponentInvocationCandidate,
  type EvidencePointer,
  invocationFootprintColumns,
  invocationLineColumns,
  invocationTelemetryColumns,
  NO_INVOCATION_FINDINGS,
} from "./component-invocation-row-writer.js";

type InvocationKind =
  (typeof AgentComponentInvocationKind)[keyof typeof AgentComponentInvocationKind];
type EvidenceClass =
  (typeof AgentComponentInvocationEvidenceClass)[keyof typeof AgentComponentInvocationEvidenceClass];

export type MarkdownCandidateInput = {
  session: NormalizedSession;
  mainAgentId: string;
  externalInvocationId: string;
  externalSourceId: string | null;
  providerToolUseId: string | null;
  childSessionId?: string | null;
  componentKind: InvocationKind;
  componentKey: string;
  rawName: string;
  normalizedName: string;
  invokedAt: string | null;
  sourceOrder: number;
  agentId: string | null;
  parentAgentId: string | null;
  relationship: string;
  anchorKind: string;
  anchorValue: string;
  snapshot: NormalizedDefinitionSnapshot | undefined;
  focusedEvidence: NormalizedInvocationDefinitionEvidence | undefined;
  externalAgentId: string | null;
  transcriptFileId?: string | null;
  parentExternalInvocationId: string | null;
  succeeded?: boolean | null;
  /**
   * ISS-10736: the resolved context footprint, for the kinds whose source text
   * this factory cannot see. Omitted for `skill` and `command`, whose footprint
   * IS the definition body resolved here.
   */
  footprint?: AgentComponentFootprint;
  /**
   * ISS-7795: usage the parser measured for THIS invocation from the harness's
   * per-turn attribution stamp. Absent for every kind the stamp does not name.
   */
  usage?: NormalizedComponentUsage;
  /**
   * ISS-7361: the round-trips `usage` was folded from, when the producer still
   * has them, so the money column prices each at its own tier.
   */
  usageRecords?: readonly NormalizedTokenRecord[];
  now: string;
};

/**
 * The `markdownCandidate` factory signature, exported so sibling candidate
 * builders (e.g. `component-invocation-command-candidates.ts`) can receive it by
 * injection rather than duplicating the shared candidate-shaping logic.
 */
export type MarkdownCandidateFn = (
  input: MarkdownCandidateInput
) => AgentComponentInvocationCandidate;

export function markdownCandidate(
  input: MarkdownCandidateInput
): AgentComponentInvocationCandidate {
  const evidence = exactEvidence(
    input.snapshot,
    input.focusedEvidence,
    input.componentKind,
    input.componentKey
  );
  return baseCandidate({
    session: input.session,
    externalInvocationId: input.externalInvocationId,
    externalSourceId: input.externalSourceId,
    childSessionId: input.childSessionId,
    componentKind: input.componentKind,
    componentKey: input.componentKey,
    rawName: input.rawName,
    normalizedName: input.normalizedName,
    invokedAt: input.invokedAt,
    sourceOrder: input.sourceOrder,
    agentId: input.agentId,
    parentAgentId: input.parentAgentId,
    relationship: input.relationship,
    anchorKind: input.anchorKind,
    anchorValue: input.anchorValue,
    providerToolUseId: input.providerToolUseId,
    attributionStatus: evidence
      ? AgentComponentInvocationAttributionStatus.Matched
      : AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass:
      evidence?.evidenceClass ?? AgentComponentInvocationEvidenceClass.None,
    evidencePointer:
      evidence ||
      input.externalAgentId ||
      input.transcriptFileId ||
      input.parentExternalInvocationId
        ? {
            ...(evidence?.pointer ?? {}),
            ...(input.externalAgentId
              ? { externalAgentId: input.externalAgentId }
              : {}),
            ...(input.transcriptFileId
              ? { transcriptFileId: input.transcriptFileId }
              : {}),
            ...(input.parentExternalInvocationId
              ? {
                  parentExternalInvocationId: input.parentExternalInvocationId,
                }
              : {}),
          }
        : null,
    definitionHash: evidence?.definitionHash ?? null,
    normalizerContractVersion: evidence?.normalizerContractVersion ?? null,
    definitionContent: evidence?.content ?? null,
    succeeded: input.succeeded ?? null,
    // ISS-10736: the two kinds whose footprint IS their definition body resolve
    // it here, from the very content this factory just decided the row carries,
    // so the declaration and the value cannot drift. Every other kind's source
    // lives outside this factory and arrives already resolved.
    ...footprintFor(input, evidence?.content ?? null),
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.usageRecords ? { usageRecords: input.usageRecords } : {}),
    now: input.now,
  });
}

export function baseCandidate(input: {
  session: NormalizedSession;
  externalInvocationId: string;
  externalSourceId: string | null;
  childSessionId?: string | null;
  componentKind: InvocationKind;
  componentKey: string;
  rawName: string | null;
  normalizedName: string | null;
  invokedAt: string | null;
  sourceOrder: number;
  agentId: string | null;
  parentAgentId: string | null;
  relationship: string;
  anchorKind: string;
  anchorValue: string;
  providerToolUseId: string | null;
  attributionStatus?: string;
  evidenceClass?: EvidenceClass;
  evidencePointer?: EvidencePointer | null;
  definitionHash?: string | null;
  normalizerContractVersion?: number | null;
  definitionContent?: string | null;
  gitBranch?: string | null;
  succeeded?: boolean | null;
  durationMs?: number;
  durationRefusedInvalidEvidence?: true;
  footprint?: AgentComponentFootprint;
  usage?: NormalizedComponentUsage;
  usageRecords?: readonly NormalizedTokenRecord[];
  /**
   * ISS-10730: the tool call's own per-edit line delta, when this candidate was
   * built from one. Projected through `invocationLineColumns`, which is the one
   * place the kind gate and the validity predicate are applied — every other
   * candidate producer leaves it undefined and gets NULL columns.
   */
  diffDelta?: { add: number; del: number };
  now: string;
}): AgentComponentInvocationCandidate {
  return {
    // ISS-10720: which source attributed this row. Always NULL at derivation
    // — `stampOtelInvocationAttribution` re-derives it from the live cost rows
    // on every pass, so a stale attribution can never survive a re-import.
    attributionSource: null,
    externalInvocationId: input.externalInvocationId,
    externalSourceId: input.externalSourceId,
    childSessionId: input.childSessionId ?? null,
    agentId: input.agentId,
    parentAgentId: input.parentAgentId,
    componentKind: input.componentKind,
    componentKey: input.componentKey,
    rawName: input.rawName,
    normalizedName: input.normalizedName,
    relationship: input.relationship,
    invokedAt: input.invokedAt,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.durationRefusedInvalidEvidence
      ? { durationRefusedInvalidEvidence: true }
      : {}),
    sourceOrder: input.sourceOrder,
    sequence: 0,
    anchorKind: input.anchorKind,
    anchorValue: input.anchorValue,
    providerToolUseId: input.providerToolUseId,
    attributionStatus:
      input.attributionStatus ??
      AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass:
      input.evidenceClass ?? AgentComponentInvocationEvidenceClass.None,
    evidencePointer: input.evidencePointer ?? null,
    definitionHash: input.definitionHash ?? null,
    normalizerContractVersion: input.normalizerContractVersion ?? null,
    definitionContent: input.definitionContent ?? null,
    localComponentId: null,
    localComponentVersionId: null,
    gitBranch: input.gitBranch ?? null,
    repositoryFullName: null,
    succeeded: input.succeeded ?? null,
    ...withFootprint(
      invocationTelemetryColumns({
        usage: input.usage,
        usageRecords: input.usageRecords,
        invokedAt: input.invokedAt,
        sessionId: input.session.sessionId,
      }),
      input.footprint
    ),
    ...invocationLineColumns({
      componentKind: input.componentKind,
      diffDelta: input.diffDelta,
    }),
    // ISS-10725: the findings funnel is attributed after the whole candidate set
    // exists, since the join is per component across a session's code-review
    // runs; every candidate is born unmeasured.
    ...NO_INVOCATION_FINDINGS,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function exactEvidence(
  snapshot: NormalizedDefinitionSnapshot | undefined,
  focused: NormalizedInvocationDefinitionEvidence | undefined,
  expectedKind: InvocationKind,
  expectedComponentKey: string
): {
  evidenceClass: EvidenceClass;
  pointer: EvidencePointer;
  content: string;
  definitionHash: string;
  normalizerContractVersion: number;
} | null {
  if (
    snapshot?.kind === expectedKind &&
    snapshot.normalizedName === expectedComponentKey
  ) {
    const fingerprint = computeDefinitionHash({
      frontmatter: "",
      body: snapshot.content,
      kind: snapshot.kind,
    });
    return {
      evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
      pointer: {
        definitionFormat: "md",
        ...(snapshot.capturedAt ? { capturedAt: snapshot.capturedAt } : {}),
      },
      content: snapshot.content,
      ...fingerprint,
    };
  }
  if (
    !focused ||
    focused.kind !== expectedKind ||
    focused.normalizedName !== expectedComponentKey
  ) {
    return null;
  }
  return {
    evidenceClass: AgentComponentInvocationEvidenceClass.CollectorSnapshot,
    pointer: {
      definitionFormat: focused.definitionFormat,
      sourcePath: focused.sourcePath,
      sourceModifiedAt: focused.sourceModifiedAt,
      capturedAt: focused.capturedAt,
    },
    content: focused.content,
    definitionHash: focused.definitionHash,
    normalizerContractVersion: focused.normalizerContractVersion,
  };
}

/**
 * The `skill`/`command` footprint: counted from the definition body this factory
 * resolved, unless the caller already supplied one. A kind declaring a source
 * OTHER than the definition body must never have one invented from that body
 * instead, which is why this reads the declaration rather than testing for a
 * non-null `definitionContent`.
 */
function footprintFor(
  input: MarkdownCandidateInput,
  definitionContent: string | null
): { footprint?: AgentComponentFootprint } {
  if (input.footprint) {
    return { footprint: input.footprint };
  }
  if (
    AGENT_COMPONENT_FOOTPRINT_SOURCE[input.componentKind] !==
    AgentComponentFootprintSource.DefinitionBody
  ) {
    return {};
  }
  const footprint = resolveAgentComponentFootprint({
    text: definitionContent ?? injectedDefinitionBody(input),
  });
  return footprint ? { footprint } : {};
}

/**
 * The definition body a `skill`/`command` occurrence carried, when
 * `exactEvidence` declined to promote it to `definitionContent`.
 *
 * Those are two different questions and ISS-10736 needs the second. Evidence
 * matching also compares the snapshot's un-normalized `normalizedName` against
 * the NORMALIZED component key, so a `/design` entry whose snapshot says
 * `design` resolves to no evidence at all — the ISS-5260 population that already
 * needed `commandDefinitionWitness` to stay visible. That command still injected
 * its body into the turn, so refusing to count it would leave `command` at zero
 * for exactly the rows the key normalization touches.
 *
 * KIND is still checked, because it is the half that guards against attribution
 * error: counting a `skill` snapshot as a `command`'s footprint would put one
 * component's text on another's row. A name that differs only by normalization
 * does not; the snapshot came off this very occurrence.
 */
function injectedDefinitionBody(input: MarkdownCandidateInput): string | null {
  return input.snapshot?.kind === input.componentKind
    ? (input.snapshot.content ?? null)
    : null;
}

function withFootprint(
  telemetry: ReturnType<typeof invocationTelemetryColumns>,
  footprint: AgentComponentFootprint | undefined
) {
  return {
    ...telemetry,
    ...invocationFootprintColumns({ footprint, telemetry }),
  };
}

export function classifyToolInvocationKind(
  toolUse: NormalizedToolUse,
  isMcp: boolean
): InvocationKind {
  if (isMcp) {
    return AgentComponentInvocationKind.Mcp;
  }
  if (toolUse.kind === "harness") {
    return AgentComponentInvocationKind.Orchestration;
  }
  return AgentComponentInvocationKind.Tool;
}
