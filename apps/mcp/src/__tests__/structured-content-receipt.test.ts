/**
 * ISS-12552: the write tools that declare an `outputSchema` must still answer
 * an MCP SDK client once the transport puts the write's receipt into
 * `structuredContent`. The SDK advertises each output schema closed, and
 * `Client.callTool` validates the structured content against it, so a key the
 * schema does not declare fails the whole call. Driven through a real
 * `McpServer`, the real tool registrations, `withToolCallEvidence`, and the SDK
 * `Client`, with only `fetch` stubbed.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AttachmentPurpose } from "@repo/api/src/types/attachment.js";
import { OperationReceiptOutcome } from "@repo/api/src/types/attribution-evidence.js";
import { DocumentType } from "@repo/api/src/types/document.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const RECEIPT = {
  operationId: "clop_01a14224-9b59-77ba-b518-16aaa9880993",
  outcome: OperationReceiptOutcome.Committed,
};
const DOCUMENT_ID = "0199f1d2-0000-7000-8000-000000000001";

const API_BODIES: Record<string, Record<string, unknown>> = {
  "/documents": { id: DOCUMENT_ID, title: "Plan" },
  [`/documents/${DOCUMENT_ID}/versions`]: { id: DOCUMENT_ID, latestVersion: 2 },
  [`/documents/${DOCUMENT_ID}/attachments/images`]: {
    attachmentId: "att-1",
    attachmentRef: "attachment://att-1",
    attachment: {
      id: "att-1",
      artifactId: DOCUMENT_ID,
      filename: "shot.png",
      mimeType: "image/png",
      sizeBytes: 512,
      purpose: AttachmentPurpose.Inline,
      createdAt: "2026-10-22T00:00:00Z",
      createdById: "user-1",
    },
  },
};

const TOOL_CALLS = [
  {
    name: "create-document",
    arguments: {
      title: "Plan",
      type: DocumentType.Prd,
      projectId: "PRO-1",
      content: "body",
    },
  },
  {
    name: "create-document-version",
    arguments: { documentId: DOCUMENT_ID, content: "body" },
  },
  {
    name: "create-inline-image-attachment",
    arguments: {
      entityId: DOCUMENT_ID,
      filename: "shot.png",
      mimeType: "image/png",
      dataBase64: "aW1hZ2U=",
    },
  },
] as const;

describe("structured content keeps the operation receipt valid", {
  concurrent: false,
}, () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      INTERNAL_API_SECRET: "test-internal-secret",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const path = new URL(String(input)).pathname;
        return Promise.resolve(
          Response.json({
            success: true,
            data: { ...API_BODIES[path], operationReceipt: RECEIPT },
          })
        );
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it.each(TOOL_CALLS)(
    "an SDK client accepts $name with its receipt",
    async (call) => {
      const client = await connectClientToWriteTools();
      try {
        const result = await client.callTool({
          ...call,
          _meta: { "claudecode/toolUseId": "toolu_01StructuredReceipt" },
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          operationReceipt: RECEIPT,
        });
      } finally {
        await client.close();
      }
    }
  );
});

async function connectClientToWriteTools(): Promise<Client> {
  const { createApiClient } = await import("../api-client.js");
  const { withToolCallEvidence } = await import("../tool-call-receipts.js");
  const { registerCreateDocument } = await import(
    "../tools/create-document.js"
  );
  const { registerCreateDocumentVersion } = await import(
    "../tools/create-document-version.js"
  );
  const { registerCreateInlineImageAttachment } = await import(
    "../tools/create-inline-image-attachment.js"
  );
  const { createUrlBuilder } = await import("../tools/tool-utils.js");
  const apiClient = createApiClient(
    { userId: "u1", organizationId: "o1", scopes: ["write"] },
    "sk_live_test"
  );
  const urls = createUrlBuilder(() => null);
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerCreateDocument(server, apiClient, urls);
  registerCreateDocumentVersion(server, apiClient, urls);
  registerCreateInlineImageAttachment(server, apiClient);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  withToolCallEvidence(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  // `callTool` validates structured content only against a schema it has
  // listed, which is what every real client does on connect.
  await client.listTools();
  return client;
}
