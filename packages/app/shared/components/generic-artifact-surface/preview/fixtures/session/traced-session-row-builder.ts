/**
 * @file traced-session-row-builder.ts
 * @description The emission machinery every lane of the traced session is
 * written against.
 *
 * Split out of `./traced-session-rows.ts` so that file can be the composition
 * root and nothing else: this module owns HOW a row is made, each
 * `./traced-session-lane-*.ts` owns WHAT one phase of the session did, and the
 * row file owns the order they ran in.
 *
 * The builder is created per call rather than held at module scope. A shared
 * mutable array would make the fixture depend on module evaluation order across
 * five files, which is exactly the drift the generator exists to remove.
 */

import {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  type AgentComponentInvocationKind,
  AgentComponentInvocationUsageMeasurement,
} from "@repo/api/src/types/agent-component-invocation";
import {
  at,
  billed,
  definitionHashFor,
  LINKAGE,
  PACK_ID,
  type TokenVector,
} from "./traced-session-identity";
import type { TracedSessionInvocation } from "./traced-session-model";

/** The main agent every lane hangs off. */
export const MAIN = "ag-0";

export type RowInput = {
  parent?: string;
  agent: string;
  parentAgent?: string;
  kind: AgentComponentInvocationKind;
  key: string;
  /** Milliseconds from the trace origin, or `null` for a row that cannot be placed. */
  at: number | null;
  /** A measured elapsed span. Absent means the extent has to be reasoned to. */
  ms?: number;
  ok?: boolean;
  fp?: number;
  tokens?: TokenVector;
  detail?: Readonly<Record<string, string>>;
  attribution?: AgentComponentInvocationAttributionStatus;
};

export type Step = Omit<RowInput, "parent" | "agent" | "parentAgent">;

export type TracedSessionRowBuilder = {
  /** Append one row and hand back the id children will name as their parent. */
  emit: (input: RowInput) => string;
  /** A run of siblings under one parent, in one agent. */
  burst: (
    parent: string,
    agent: string,
    parentAgent: string | undefined,
    steps: readonly Step[]
  ) => void;
  rows: TracedSessionInvocation[];
};

export function createRowBuilder(): TracedSessionRowBuilder {
  const rows: TracedSessionInvocation[] = [];

  function emit(input: RowInput): string {
    const sequence = rows.length + 1;
    const externalInvocationId = `n${String(sequence).padStart(3, "0")}`;
    const billing =
      input.tokens === undefined ? undefined : billed(input.tokens);
    rows.push({
      externalInvocationId,
      parentExternalInvocationId: input.parent,
      externalAgentId: input.agent,
      parentAgentId: input.parentAgent,
      kind: input.kind,
      componentKey: input.key,
      sequence,
      invokedAt: input.at === null ? null : at(input.at),
      durationMs: input.ms,
      succeeded: input.ok,
      footprintTokens: input.fp,
      usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
      ...billing,
      // A billed activation is attributed by the usage counter; everything else
      // is read off the transcript. That split is the fixture's own, and it is
      // the reason the inspector can show two different answers to "which source
      // won" inside one session.
      evidenceClass:
        billing === undefined
          ? AgentComponentInvocationEvidenceClass.TranscriptSnapshot
          : AgentComponentInvocationEvidenceClass.OtelCounter,
      ...LINKAGE,
      definitionHash: definitionHashFor(input.key),
      ...(billing === undefined
        ? {}
        : {
            definitionVersionId: `dv-${externalInvocationId}`,
            packId: PACK_ID,
          }),
      attributionStatus:
        input.attribution ?? AgentComponentInvocationAttributionStatus.Matched,
      detail: input.detail,
    });
    return externalInvocationId;
  }

  function burst(
    parent: string,
    agent: string,
    parentAgent: string | undefined,
    steps: readonly Step[]
  ): void {
    for (const step of steps) {
      emit({ parent, agent, parentAgent, ...step, ok: step.ok ?? true });
    }
  }

  return { emit, burst, rows };
}
