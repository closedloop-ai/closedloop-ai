import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  MCP_CLIENT_HEADER_VALUE,
  OperationEvidenceHeader,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence.js";
import {
  CLOSEDLOOP_MCP_TOOL_SEMANTICS,
  isClosedloopMcpToolName,
  RECEIPTED_OPERATION_KINDS,
  UNSUPPORTED_RECEIPT_TOOLS,
} from "@repo/api/src/types/closedloop-operation-semantics.js";
import { computeRequestFingerprint } from "@repo/api/src/utils/request-fingerprint.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELETE_SCOPE,
  toolRequiredScopes,
  WRITE_SCOPE,
} from "../oauth-scopes.js";
import { readClientCallId } from "../tool-call-context.js";
import { attachOperationReceipt } from "../tool-call-receipts.js";
import { TOOL_REGISTRATIONS } from "../tool-registrations.js";
import {
  createDocumentTestServer,
  stubCreateDocumentApi,
} from "./support/create-document-test-server.js";

const ORIGINAL_ENV = { ...process.env };
const TOOL_ARGS = { title: "Plan" };
const RECEIPT = {
  operationId: "clop_01a14224-9b59-77ba-b518-16aaa9880991",
  outcome: OperationReceiptOutcome.Committed,
};

describe("operation receipt coverage", () => {
  it("knows the operation semantics of every registered tool", () => {
    const unknown = TOOL_REGISTRATIONS.map((tool) => tool.name).filter(
      (name) => !isClosedloopMcpToolName(name)
    );

    expect(unknown).toEqual([]);
  });

  it("records a receipt for every write or delete tool, or lists it as unsupported", () => {
    const unreceipted = TOOL_REGISTRATIONS.filter((tool) => {
      const scopes = toolRequiredScopes(tool);
      return scopes.includes(WRITE_SCOPE) || scopes.includes(DELETE_SCOPE);
    })
      .map((tool) => tool.name)
      .filter(isClosedloopMcpToolName)
      .filter(
        (name) =>
          !(
            RECEIPTED_OPERATION_KINDS.has(
              CLOSEDLOOP_MCP_TOOL_SEMANTICS[name].kind
            ) || UNSUPPORTED_RECEIPT_TOOLS.includes(name)
          )
      );

    expect(unreceipted).toEqual([]);
  });
});

describe("readClientCallId", () => {
  it("reads Claude Code's tool use id", () => {
    expect(
      readClientCallId({ "claudecode/toolUseId": "toolu_01FhDDPLosbqpeu78q" })
    ).toBe("toolu_01FhDDPLosbqpeu78q");
  });

  it("reads Codex's call id", () => {
    expect(
      readClientCallId({ callId: "exec-a9769d74-f0bd-47d8-91c4-ad45e8429f2a" })
    ).toBe("exec-a9769d74-f0bd-47d8-91c4-ad45e8429f2a");
  });

  it("drops a value that is not a short opaque key", () => {
    expect(readClientCallId({ callId: "id with spaces" })).toBeUndefined();
    expect(readClientCallId(undefined)).toBeUndefined();
  });
});

describe("attachOperationReceipt", () => {
  it("puts the receipt inside the JSON text body and the structured body", () => {
    const result = attachOperationReceipt(
      {
        content: [{ type: "text", text: JSON.stringify({ id: "d1" }) }],
        structuredContent: { id: "d1" },
      },
      RECEIPT
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { id: "d1", operationReceipt: RECEIPT },
            null,
            2
          ),
        },
      ],
      structuredContent: { id: "d1", operationReceipt: RECEIPT },
    });
  });

  it("leaves a text body that is not a JSON object untouched", () => {
    const result = attachOperationReceipt(
      { content: [{ type: "text", text: "Deleted." }] },
      RECEIPT
    );

    expect(result).toEqual({ content: [{ type: "text", text: "Deleted." }] });
  });
});

describe("withToolCallEvidence on a connected server", {
  concurrent: false,
}, () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      INTERNAL_API_SECRET: "test-internal-secret",
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  async function callCreateDocument(meta: Record<string, unknown>) {
    const fetchMock = stubCreateDocumentApi(RECEIPT);
    const { withToolCallEvidence } = await import("../tool-call-receipts.js");
    const server = await createDocumentTestServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    withToolCallEvidence(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "create-document",
      arguments: TOOL_ARGS,
      _meta: meta,
    });
    await client.close();
    const init = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    return { headers: new Headers(init[1].headers), result };
  }

  it("sends the harness call id and the raw-argument fingerprint with the write", async () => {
    const { headers } = await callCreateDocument({
      "claudecode/toolUseId": "toolu_01FhDDPLosbqpeu78q",
    });

    expect(headers.get(OperationEvidenceHeader.McpClient)).toBe(
      MCP_CLIENT_HEADER_VALUE
    );
    expect(headers.get(OperationEvidenceHeader.ClientCallId)).toBe(
      "toolu_01FhDDPLosbqpeu78q"
    );
    expect(headers.get(OperationEvidenceHeader.RequestFingerprint)).toBe(
      await computeRequestFingerprint("create-document", TOOL_ARGS)
    );
  });

  it("returns the write's receipt inside the tool's JSON text body", async () => {
    const { result } = await callCreateDocument({ callId: "exec-1" });

    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]?.text ?? "{}")).toEqual({
      id: "d1",
      operationReceipt: RECEIPT,
    });
  });

  it("sends no call id header when the harness sent none", async () => {
    const { headers } = await callCreateDocument({});

    expect(headers.has(OperationEvidenceHeader.ClientCallId)).toBe(false);
    expect(headers.get(OperationEvidenceHeader.RequestFingerprint)).toBe(
      await computeRequestFingerprint("create-document", TOOL_ARGS)
    );
  });
});
