/**
 * ISS-12552: the stateless fallback (a task restart, a TTL expiry, an eviction,
 * a non-sticky load balancer) serves tool calls with the same evidence as a
 * session: the harness call id reaches the API and the write's receipt comes
 * back in the tool's JSON body. Driven over real HTTP through
 * `handleMcpStatelessRequest`, not through the wrapper directly.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  OperationEvidenceHeader,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentTestServer,
  stubCreateDocumentApi,
} from "./support/create-document-test-server.js";

const ORIGINAL_ENV = { ...process.env };
const REAL_FETCH = globalThis.fetch;
const CALL_ID = "toolu_01StatelessFallback";
const RECEIPT = {
  operationId: "clop_01a14224-9b59-77ba-b518-16aaa9880993",
  outcome: OperationReceiptOutcome.Committed,
};

describe("the stateless fallback carries tool-call evidence", {
  concurrent: false,
}, () => {
  let http: Server | undefined;

  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      INTERNAL_API_SECRET: "test-internal-secret",
    };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
    await new Promise<void>((resolve) => {
      if (http) {
        http.close(() => resolve());
      } else {
        resolve();
      }
    });
    http = undefined;
  });

  it("sends the call id to the API and returns the receipt in the tool body", async () => {
    const fetchMock = stubCreateDocumentApi(RECEIPT);
    const { handleMcpStatelessRequest } = await import(
      "../mcp-stateless-request.js"
    );
    const serve = async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      await handleMcpStatelessRequest(
        req,
        res,
        text ? JSON.parse(text) : undefined,
        createDocumentTestServer
      );
    };
    http = createServer((req, res) => {
      serve(req, res).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    await new Promise<void>((resolve) => http?.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;

    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        { fetch: REAL_FETCH }
      )
    );
    const result = await client.callTool({
      name: "create-document",
      arguments: { title: "Plan" },
      _meta: { "claudecode/toolUseId": CALL_ID },
    });
    await client.close();

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(
      new Headers(init.headers).get(OperationEvidenceHeader.ClientCallId)
    ).toBe(CALL_ID);
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]?.text ?? "{}")).toEqual({
      id: "d1",
      operationReceipt: RECEIPT,
    });
  });
});
