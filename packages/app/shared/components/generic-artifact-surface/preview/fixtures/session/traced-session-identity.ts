/**
 * @file traced-session-identity.ts
 * @description Who the traced session is, what a token costs, and the two
 * helpers every row in `./traced-session-rows.ts` is built from.
 *
 * Split out of `./traced-session.ts` so the row generator can import the
 * pricing without the totals importing the rows back — the reduction reads the
 * rows, the rows read this, and nothing reads the reduction.
 *
 * COST IS COMPUTED, NEVER TYPED. Every `estimatedCost` in the fixture is priced
 * from that row's own token vector at the rates below, the way `computeTokenCost`
 * (`packages/cost/src/genai-cost.ts`) prices a real one. A hand-typed cost
 * beside a hand-typed token count is two numbers that can drift; this is one.
 */

import { AgentComponentInvocationUsageMeasurement } from "@repo/api/src/types/agent-component-invocation";
import type { TracedSessionInvocation } from "./traced-session-model";

/** Identity shared by the Sessions row, the `SES-7B91` artifact and the trace. */
export const TRACED_SESSION = {
  rowId: "ses_7b91",
  artifactSlug: "SES-7B91",
  name: "Prototype generic artifact shells",
  externalSessionId: "019f7b91-2c48-71ad-9e05-4c2a6f0d5b13",
  ownerName: "Ottilie Eastwick",
  ownerInitials: "AE",
  model: "claude-opus-4-5",
  repositoryFullName: "closedloop-ai/closedloop-ai",
  repositoryCommit: "b47e1d9",
  branchName: "prototype/generic-artifacts-web-master",
  pullRequestNumber: 2048,
  pullRequestTitle: "Generic artifact list and detail shells",
  pullRequestUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/2048",
  editedFile:
    "packages/app/shared/components/generic-artifact-surface/preview/components/generic-artifact-detail-shell.tsx",
} as const;

/**
 * Published Claude Opus 4.5 list prices. Named here rather than folded into the
 * numbers so a reader can check the arithmetic instead of trusting it.
 */
const CLAUDE_OPUS_RATE_USD_PER_MTOK = {
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite: 6.25,
} as const;

const TOKENS_PER_MTOK = 1_000_000;

const TRACE_ORIGIN = "2026-08-20T14:02:01.000Z";

/** An ISO instant `offsetMs` after the trace origin. */
export function at(offsetMs: number): string {
  return new Date(Date.parse(TRACE_ORIGIN) + offsetMs).toISOString();
}

export type TokenVector = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens?: number;
};

/** The `estimatedCost` a token vector earns at the rates above. */
export function priceTokens(vector: TokenVector): number {
  const { input, output, cacheRead, cacheWrite } =
    CLAUDE_OPUS_RATE_USD_PER_MTOK;
  return (
    (vector.inputTokens * input +
      vector.outputTokens * output +
      vector.cacheReadTokens * cacheRead +
      (vector.cacheWriteTokens ?? 0) * cacheWrite) /
    TOKENS_PER_MTOK
  );
}

/** A billed row: the vector, plus the cost it prices to and its footprint. */
export function billed(
  vector: TokenVector
): Pick<
  TracedSessionInvocation,
  | "model"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "estimatedCost"
  | "footprintTokens"
  | "usageMeasurement"
> {
  return {
    model: TRACED_SESSION.model,
    inputTokens: vector.inputTokens,
    outputTokens: vector.outputTokens,
    cacheReadTokens: vector.cacheReadTokens,
    cacheWriteTokens: vector.cacheWriteTokens,
    estimatedCost: priceTokens(vector),
    // The component's own injected text, already inside `inputTokens` above and
    // therefore never summed with it.
    footprintTokens: vector.inputTokens + vector.outputTokens,
    usageMeasurement: AgentComponentInvocationUsageMeasurement.Measured,
  };
}

/** Span-grain artifact linkage, identical on every row of one session. */
export const LINKAGE = {
  repositoryFullName: TRACED_SESSION.repositoryFullName,
  repositoryCommit: TRACED_SESSION.repositoryCommit,
  branchName: TRACED_SESSION.branchName,
} as const;

export const PACK_ID = "closedloop-ai/design";

const FNV_OFFSET_BASIS = 0x81_1c_9d_c5;
const FNV_PRIME = 0x01_00_01_93;
const HASH_DIGITS = 6;

/**
 * A stable digest per component key.
 *
 * Derived rather than typed for the same reason the costs are: `definitionHash`
 * answers "was this the same code", so two invocations of one component must
 * carry the same value and two different components must not. A literal per row
 * can violate both by a typo; a function of the key cannot.
 */
export function definitionHashFor(componentKey: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < componentKey.length; index += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a IS the XOR-then-multiply step; substituting arithmetic gives a different function and stops being the named algorithm. This hash exists so two invocations of one component cannot drift apart via a typo in a literal, which requires it to be a pure function of the key — so the operators are the contract, not an optimisation.
    hash ^= componentKey.charCodeAt(index);
    // biome-ignore lint/suspicious/noBitwiseOperators: the unsigned shift is what keeps `Math.imul`'s signed 32-bit result inside the range `toString(16)` can render without a minus sign. Dropping it makes roughly half the keys hash to a string that is not a hex digest.
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return `sha256:${hash.toString(16).padStart(HASH_DIGITS, "0").slice(0, HASH_DIGITS)}`;
}
