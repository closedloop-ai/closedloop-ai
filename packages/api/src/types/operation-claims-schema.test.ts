import { describe, expect, it } from "vitest";
import {
  MAX_SYNCED_OPERATION_CLAIMS,
  OperationKind,
} from "./attribution-evidence.ts";
import { OperationClaimSource, ToolResultState } from "./operation-claims.ts";
import { sessionOperationEvidenceSchema } from "./operation-claims-schema.ts";

const DIGEST = "a".repeat(64);
const COVERAGE = {
  harness: "claude",
  harnessVersion: "2.1.296",
  evidencePathSupported: true,
  closedloopMcpCalls: 1,
  shellCallsWithOperationIds: 0,
  directApiShellCommands: 0,
  unsupportedToolNames: {},
  claimsDroppedByCap: 0,
};
const CLAIM = {
  claimKey: "claude:toolu_1",
  source: OperationClaimSource.ClosedloopMcp,
  toolName: "get-document",
  operationKind: OperationKind.Read,
  resultState: ToolResultState.Present,
  inputTargets: [{ key: "documentId", slug: "PLN-1" }],
};

describe("sessionOperationEvidenceSchema", () => {
  it("parses a snapshot and its claims", () => {
    const parsed = sessionOperationEvidenceSchema.parse({
      extractorVersion: 1,
      digest: DIGEST,
      coverage: COVERAGE,
      claims: [CLAIM],
    });

    expect(parsed).toEqual({
      extractorVersion: 1,
      digest: DIGEST,
      coverage: COVERAGE,
      claims: [CLAIM],
      unparsedClaims: 0,
    });
  });

  it("drops a claim it cannot parse on its own and counts it", () => {
    const parsed = sessionOperationEvidenceSchema.parse({
      extractorVersion: 2,
      digest: DIGEST,
      coverage: COVERAGE,
      claims: [
        CLAIM,
        { ...CLAIM, claimKey: "claude:toolu_2", source: "futureSource" },
        { claimKey: 7 },
      ],
    });

    expect(parsed.claims).toEqual([CLAIM]);
    expect(parsed.unparsedClaims).toBe(2);
  });

  it("drops a claim repeating an earlier claim's key and counts it", () => {
    const parsed = sessionOperationEvidenceSchema.parse({
      extractorVersion: 1,
      digest: DIGEST,
      coverage: COVERAGE,
      claims: [CLAIM, { ...CLAIM, toolName: "list-documents" }],
    });

    expect(parsed.claims).toEqual([CLAIM]);
    expect(parsed.unparsedClaims).toBe(1);
  });

  it("rejects a snapshot whose own fields are malformed", () => {
    for (const snapshot of [
      { extractorVersion: 1, digest: "short", coverage: COVERAGE, claims: [] },
      { extractorVersion: 1, digest: DIGEST, coverage: {}, claims: [] },
    ]) {
      expect(sessionOperationEvidenceSchema.safeParse(snapshot).success).toBe(
        false
      );
    }
  });

  it("keeps the first claims up to the cap and counts the rest", () => {
    const parsed = sessionOperationEvidenceSchema.parse({
      extractorVersion: 1,
      digest: DIGEST,
      coverage: COVERAGE,
      claims: Array.from(
        { length: MAX_SYNCED_OPERATION_CLAIMS + 2 },
        (_, i) => ({
          ...CLAIM,
          claimKey: `claude:toolu_${i}`,
        })
      ),
    });

    expect(parsed.claims).toHaveLength(MAX_SYNCED_OPERATION_CLAIMS);
    expect(parsed.claims.at(-1)?.claimKey).toBe(
      `claude:toolu_${MAX_SYNCED_OPERATION_CLAIMS - 1}`
    );
    expect(parsed.unparsedClaims).toBe(2);
  });

  it("round-trips a claim with candidate requests, and one from an older Desktop without them (ISS-12552)", () => {
    const withCandidates = {
      ...CLAIM,
      claimKey: "codex:exec-1",
      candidateRequestKeys: [
        "codex.response.id:resp_1",
        "codex.response.id:resp_2",
      ],
    };
    const parsed = sessionOperationEvidenceSchema.parse(
      JSON.parse(
        JSON.stringify({
          extractorVersion: 4,
          digest: DIGEST,
          coverage: COVERAGE,
          claims: [withCandidates, CLAIM],
        })
      )
    );

    expect(parsed.claims).toEqual([withCandidates, CLAIM]);
    expect(parsed.claims[1]).not.toHaveProperty("candidateRequestKeys");
    expect(parsed.unparsedClaims).toBe(0);
  });
});
