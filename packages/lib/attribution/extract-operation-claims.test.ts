import {
  MAX_SYNCED_OPERATION_CLAIMS,
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import {
  MAX_UNSUPPORTED_TOOL_NAMES,
  OPERATION_EVIDENCE_MAX_CLAIM_BYTES,
  OperationClaimSource,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import { computeRequestFingerprint } from "@repo/api/src/utils/request-fingerprint";
import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "../harness/claude/parse-claude";
import { CODEX_CODE_MODE_TOOL_NAME } from "../harness/codex/codex-mcp-tool-call-item";
import {
  createNormalizedSession,
  Harness,
  type NormalizedSession,
  type NormalizedToolUse,
} from "../harness/types";
import { extractOperationClaims } from "./extract-operation-claims";

const TS = "2026-10-16T12:00:00.000Z";
const DOCUMENT_UUID = "01a14224-0000-7000-8000-000000000001";
const OPERATION_ID = "clop_01a14224-9b59-77ba-b518-16aaa9880991";
const RECEIPT = {
  operationId: OPERATION_ID,
  outcome: OperationReceiptOutcome.Committed,
};

function session(
  toolUses: NormalizedToolUse[],
  overrides: Partial<NormalizedSession> = {}
): NormalizedSession {
  return createNormalizedSession({
    sessionId: "claims",
    version: "2.1.296",
    toolUses,
    ...overrides,
  });
}

function closedloopTool(
  tool: string,
  id: string,
  extra: Partial<NormalizedToolUse> = {}
): NormalizedToolUse {
  return {
    name: `mcp__closedloop__${tool}`,
    id,
    timestamp: TS,
    resultTimestamp: TS,
    input: {},
    output: "{}",
    resultState: ToolResultState.Present,
    closedloopResultFacts: { isError: false, nestedSlugs: [] },
    ...extra,
  };
}

describe("extractOperationClaims, ClosedLoop MCP calls", () => {
  it("records one claim per call through the real parser, keeping the receipt past the cap", async () => {
    const input = { documentId: DOCUMENT_UUID, content: "next" };
    const body = JSON.stringify({
      id: DOCUMENT_UUID,
      slug: "PLN-2191",
      latestVersion: 5,
      content: "y".repeat(20_000),
      operationReceipt: RECEIPT,
    });
    const parsed = await parseClaudeTranscript(
      [
        {
          type: "assistant",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_write",
                name: "mcp__closedloop__create-document-version",
                input,
              },
            ],
          },
        },
        {
          type: "user",
          timestamp: TS,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_write",
                content: body,
              },
            ],
          },
        },
      ].map((record) => JSON.stringify(record)),
      { sessionId: "claims" }
    );
    if (!parsed) {
      throw new Error("transcript did not parse");
    }

    const { claims } = await extractOperationClaims(parsed, Harness.Claude);

    expect(claims).toEqual([
      {
        claimKey: "claude:toolu_write",
        providerCallId: "toolu_write",
        source: OperationClaimSource.ClosedloopMcp,
        toolName: "create-document-version",
        operationKind: OperationKind.CreateVersion,
        resultState: ToolResultState.Present,
        requestFingerprint: await computeRequestFingerprint(
          "create-document-version",
          input
        ),
        inputTargets: [{ key: "documentId", uuid: DOCUMENT_UUID }],
        operationIds: [OPERATION_ID],
        primaryResultEntity: {
          id: DOCUMENT_UUID,
          slug: "PLN-2191",
          version: 5,
        },
        invokedAt: TS,
        resultAt: TS,
      },
    ]);
  });

  it("takes a read's primary entity and nested slugs, never an operation id it quotes", async () => {
    const { claims } = await extractOperationClaims(
      session([
        closedloopTool("get-document", "toolu_read", {
          input: { documentId: "pln-2191" },
          closedloopResultFacts: {
            isError: false,
            operationReceipt: RECEIPT,
            primaryEntity: { id: DOCUMENT_UUID, slug: "PLN-2191" },
            nestedSlugs: ["PRD-800"],
          },
        }),
      ]),
      Harness.Claude
    );

    expect(claims[0]).toMatchObject({
      operationKind: OperationKind.Read,
      inputTargets: [{ key: "documentId", slug: "PLN-2191" }],
      primaryResultEntity: { id: DOCUMENT_UUID, slug: "PLN-2191" },
      nestedReferenceSlugs: ["PRD-800"],
    });
    expect(claims[0]?.operationIds).toBeUndefined();
  });

  it("flags errored and missing results, and keeps related artifacts apart from the target", async () => {
    const { claims } = await extractOperationClaims(
      session([
        closedloopTool("update-document", "toolu_err", {
          isError: true,
          resultState: ToolResultState.Error,
        }),
        {
          name: "mcp__closedloop__create-artifact-link",
          id: "toolu_missing",
          timestamp: TS,
          input: { sourceId: "PLN-2191", targetId: "ISS-12552" },
        },
      ]),
      Harness.Claude
    );

    expect(claims.map((claim) => claim.resultState)).toEqual([
      ToolResultState.Error,
      ToolResultState.Missing,
    ]);
    expect(claims[1]).toMatchObject({
      inputTargets: [{ key: "sourceId", slug: "PLN-2191" }],
      relatedTargets: [{ key: "targetId", slug: "ISS-12552" }],
    });
  });

  it("includes sidecar subagent calls and Codex code-mode evidence, once each", async () => {
    const { claims } = await extractOperationClaims(
      session(
        [
          {
            name: "get_document",
            mcpNamespace: "mcp__closedloop",
            providerToolUseId: "call_1",
            timestamp: TS,
            input: { documentId: "PLN-1" },
            output: "{}",
          },
        ],
        {
          subagents: [
            {
              id: "agent-lane",
              parentId: null,
              name: "lane",
              toolUses: [
                closedloopTool("get-document", "toolu_sidecar", {
                  subagentId: "agent-lane",
                }),
              ],
            },
          ],
          mcpCallEvidence: [
            {
              name: "closedloop__get-document",
              mcpServer: "closedloop",
              mcpMethod: "get-document",
              providerToolUseId: "call_1",
              timestamp: TS,
            },
            {
              name: "closedloop__create-document",
              mcpServer: "closedloop",
              mcpMethod: "create-document",
              providerToolUseId: "exec-2",
              subagentId: "child-1",
              timestamp: TS,
            },
          ],
        }
      ),
      Harness.Codex
    );

    expect(
      claims.map((claim) => [claim.claimKey, claim.toolName, claim.agentId])
    ).toEqual([
      ["codex:call_1", "get-document", undefined],
      ["codex:toolu_sidecar", "get-document", "agent-lane"],
      ["codex:exec-2", "create-document", "child-1"],
    ]);
  });

  it("counts a ClosedLoop tool the semantics table does not know", async () => {
    const { claims, coverage } = await extractOperationClaims(
      session([
        closedloopTool("add-loop-event", "toolu_a"),
        closedloopTool("add-loop-event", "toolu_b"),
      ]),
      Harness.Claude
    );

    expect(claims[0]).toMatchObject({
      toolName: "add-loop-event",
      operationKind: OperationKind.Unsupported,
    });
    expect({ ...coverage.unsupportedToolNames }).toEqual({
      "add-loop-event": 2,
    });
    expect(coverage.closedloopMcpCalls).toBe(2);
  });

  it("gives calls with a missing or repeated id an ordinal key and no call id", async () => {
    const { claims } = await extractOperationClaims(
      session([
        closedloopTool("get-document", "toolu_dup"),
        closedloopTool("get-document", "toolu_dup"),
        { ...closedloopTool("search", "x"), id: undefined },
      ]),
      Harness.Claude
    );

    expect(
      claims.map((claim) => [
        claim.claimKey,
        claim.ambiguous,
        claim.providerCallId,
      ])
    ).toEqual([
      ["claude:ordinal:0", true, undefined],
      ["claude:ordinal:1", true, undefined],
      ["claude:ordinal:2", true, undefined],
    ]);
  });
});

describe("extractOperationClaims, shell calls and references", () => {
  it("claims a shell call's printed ids and counts a direct API call without one", async () => {
    const { claims, coverage } = await extractOperationClaims(
      session([
        {
          name: "Bash",
          id: "toolu_script",
          timestamp: TS,
          input: { command: "node file-bug.mjs finding.json" },
          output: "{}",
          shellOperationIds: [OPERATION_ID],
        },
        {
          name: "Bash",
          id: "toolu_curl",
          timestamp: TS,
          input: { command: "curl https://api.closedloop.ai/documents" },
          output: "{}",
        },
      ]),
      Harness.Claude
    );

    expect(claims[0]).toMatchObject({
      claimKey: "claude:toolu_script",
      source: OperationClaimSource.Shell,
      operationIds: [OPERATION_ID],
    });
    expect(coverage).toMatchObject({
      shellCallsWithOperationIds: 1,
      directApiShellCommands: 1,
      harness: Harness.Claude,
      harnessVersion: "2.1.296",
      evidencePathSupported: true,
    });
  });

  it("claims each slug in prose or another tool's text once, and none from a ClosedLoop call's own text", async () => {
    const { claims } = await extractOperationClaims(
      session(
        [
          closedloopTool("get-document", "toolu_cl", {
            input: { documentId: "PLN-7" },
            output: "PLN-7 links PRD-9",
          }),
          {
            name: "Read",
            id: "toolu_read",
            timestamp: TS,
            input: { file_path: "notes.md" },
            output: "see ISS-3 and PRD-1",
          },
        ],
        {
          messages: [
            { role: "human", timestamp: TS, text: "Work on PRD-1 please" },
            { role: "system", timestamp: TS, text: "ISS-99" },
          ],
        }
      ),
      Harness.Claude
    );

    expect(
      claims
        .filter((claim) => claim.source === OperationClaimSource.Reference)
        .map((claim) => claim.referenceSlug)
    ).toEqual(["PRD-1", "ISS-3"]);
  });

  it("claims the slugs a ClosedLoop result nests beside its target, as the call's agent saw them", async () => {
    const { claims } = await extractOperationClaims(
      session([
        closedloopTool("list-documents", "toolu_list", {
          input: { projectId: "PRO-1" },
          subagentId: "agent-1",
          resultTimestamp: TS,
          closedloopResultFacts: {
            isError: false,
            nestedSlugs: ["PRD-2", "PRD-1"],
          },
        }),
      ]),
      Harness.Claude
    );

    expect(
      claims.filter((claim) => claim.source === OperationClaimSource.Reference)
    ).toEqual([
      expect.objectContaining({ referenceSlug: "PRD-2", agentId: "agent-1" }),
      expect.objectContaining({ referenceSlug: "PRD-1", agentId: "agent-1" }),
    ]);
  });

  it("reads no references from Codex code-mode script text, which carries the tool catalog", async () => {
    const { claims } = await extractOperationClaims(
      session(
        [
          {
            name: CODEX_CODE_MODE_TOOL_NAME,
            id: "call_catalog",
            timestamp: TS,
            input: "text(ALL_TOOLS)",
            output:
              "Issue URL pattern (e.g. /acme/issues/ISS-1035), PRD-42, PLN-7",
          },
          {
            name: "shell",
            id: "call_shell",
            timestamp: TS,
            input: { command: ["git", "log", "--oneline"] },
            output: "abc1234 ISS-3: fix the login page",
          },
        ],
        { mcpCallEvidence: [closedloopTool("get-document", "exec-1")] }
      ),
      Harness.Codex
    );

    expect(
      claims
        .filter((claim) => claim.source === OperationClaimSource.Reference)
        .map((claim) => claim.referenceSlug)
    ).toEqual(["ISS-3"]);
    expect(claims.map((claim) => claim.providerCallId)).toContain("exec-1");
  });

  it("drops references first past the claim cap, and counts what it dropped", async () => {
    const prose = Array.from(
      { length: MAX_SYNCED_OPERATION_CLAIMS },
      (_, i) => `ISS-${i + 1}`
    ).join(" ");
    const { claims, coverage } = await extractOperationClaims(
      session([closedloopTool("get-document", "toolu_keep")], {
        messages: [{ role: "human", timestamp: TS, text: prose }],
      }),
      Harness.Cursor
    );

    expect(claims.length).toBeLessThanOrEqual(MAX_SYNCED_OPERATION_CLAIMS);
    expect(claims[0]?.claimKey).toBe("cursor:toolu_keep");
    expect(claims.length + coverage.claimsDroppedByCap).toBe(
      MAX_SYNCED_OPERATION_CLAIMS + 1
    );
    expect(coverage.claimsDroppedByCap).toBeGreaterThan(0);
    expect(coverage.evidencePathSupported).toBe(false);
  });
});

describe("extractOperationClaims, sync byte budget", () => {
  it("keeps the serialized claims within the budget and counts what it dropped", async () => {
    const tools = Array.from({ length: 400 }, (_, i) =>
      closedloopTool("get-document", `toolu_${i}`, {
        input: { documentId: `PLN-${i + 1}` },
      })
    );
    const { claims, coverage } = await extractOperationClaims(
      session(tools),
      Harness.Claude
    );

    expect(
      new TextEncoder().encode(JSON.stringify(claims)).length
    ).toBeLessThanOrEqual(OPERATION_EVIDENCE_MAX_CLAIM_BYTES);
    expect(claims.length).toBeLessThan(400);
    expect(claims.length + coverage.claimsDroppedByCap).toBe(400);
    expect(claims[0]?.claimKey).toBe("claude:toolu_0");
  });

  it("keeps a write that comes after the reads that exhausted the budget", async () => {
    const reads = Array.from({ length: 400 }, (_, i) =>
      closedloopTool("get-document", `toolu_${i}`, {
        input: { documentId: `PLN-${i + 1}` },
      })
    );
    const write = closedloopTool("create-document", "toolu_write", {
      input: { title: "Plan" },
    });
    const { claims } = await extractOperationClaims(
      session([...reads, write]),
      Harness.Claude
    );

    expect(claims.map((claim) => claim.claimKey)).toContain(
      "claude:toolu_write"
    );
    expect(claims.at(-1)?.claimKey).toBe("claude:toolu_write");
    expect(
      new TextEncoder().encode(JSON.stringify(claims)).length
    ).toBeLessThanOrEqual(OPERATION_EVIDENCE_MAX_CLAIM_BYTES);
  });

  it("still keeps a smaller claim after a larger one misses the remaining budget", async () => {
    const nestedSlugs = Array.from({ length: 200 }, (_, i) => `PRD-${i + 1}`);
    // More large reads than the budget holds, so one misses before any reference.
    const largeReads = Array.from({ length: 30 }, (_, i) =>
      closedloopTool("get-document", `toolu_${i}`, {
        closedloopResultFacts: { isError: false, nestedSlugs },
      })
    );
    const { claims, coverage } = await extractOperationClaims(
      session(largeReads, {
        messages: [{ role: "human", timestamp: TS, text: "see ISS-9001" }],
      }),
      Harness.Claude
    );

    expect(
      claims.filter((claim) => claim.source !== OperationClaimSource.Reference)
        .length
    ).toBeLessThan(largeReads.length);
    expect(
      claims.some((claim) => claim.source === OperationClaimSource.Reference)
    ).toBe(true);
    expect(coverage.claimsDroppedByCap).toBeGreaterThan(0);
    expect(
      new TextEncoder().encode(JSON.stringify(claims)).length
    ).toBeLessThanOrEqual(OPERATION_EVIDENCE_MAX_CLAIM_BYTES);
  });

  it("lists at most the capped number of distinct unsupported tool names", async () => {
    const tools = Array.from(
      { length: MAX_UNSUPPORTED_TOOL_NAMES + 5 },
      (_, i) => closedloopTool(`unknown-${i}`, `toolu_${i}`)
    );
    const { coverage } = await extractOperationClaims(
      session(tools),
      Harness.Claude
    );

    expect(Object.keys(coverage.unsupportedToolNames)).toHaveLength(
      MAX_UNSUPPORTED_TOOL_NAMES
    );
    expect(coverage.closedloopMcpCalls).toBe(MAX_UNSUPPORTED_TOOL_NAMES + 5);
  });
});
