import {
  MCP_CLIENT_HEADER_VALUE,
  OperationEvidenceHeader,
  OperationSource,
} from "@repo/api/src/types/attribution-evidence";

const MCP_CLIENT_HEADER = OperationEvidenceHeader.McpClient;
const MCP_CLIENT_VALUE = MCP_CLIENT_HEADER_VALUE;
const CLIENT_CALL_ID_HEADER = OperationEvidenceHeader.ClientCallId;
const REQUEST_FINGERPRINT_HEADER = OperationEvidenceHeader.RequestFingerprint;

import { describe, expect, it } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  readOperationReceiptRequest,
  receiptRouteTemplate,
} from "./operation-receipt-request";

const REQUESTED_AT = new Date("2026-10-16T12:00:00.000Z");
const INTERNAL_SECRET = "test-internal-secret";

function authContext(
  authMethod: AuthContext["authMethod"],
  apiKeyId?: string
): AuthContext {
  return {
    user: { id: "user-a", organizationId: "org-a" } as AuthContext["user"],
    clerkUserId: "clerk_user_a",
    clerkOrgId: "clerk_org_a",
    authMethod,
    ...(apiKeyId ? { apiKeyId } : {}),
  };
}

function request(headers: Record<string, string>): Request {
  return new Request("http://localhost/documents", { method: "POST", headers });
}

describe("readOperationReceiptRequest", () => {
  it("gives a browser session write no receipt", () => {
    expect(
      readOperationReceiptRequest(
        authContext("session"),
        request({}),
        REQUESTED_AT
      )
    ).toBeNull();
  });

  it("gives a Desktop session write no receipt", () => {
    expect(
      readOperationReceiptRequest(
        authContext("desktop_session"),
        request({}),
        REQUESTED_AT
      )
    ).toBeNull();
  });

  it("records a direct API-key write as api with its key and owner", () => {
    expect(
      readOperationReceiptRequest(
        authContext("api_key", "key-1"),
        request({}),
        REQUESTED_AT
      )
    ).toEqual({
      organizationId: "org-a",
      principalUserId: "user-a",
      apiKeyId: "key-1",
      source: OperationSource.Api,
      requestedAt: REQUESTED_AT,
    });
  });

  it("records an MCP write with its harness call id and fingerprint", () => {
    expect(
      readOperationReceiptRequest(
        authContext("api_key", "key-1"),
        request({
          "x-internal-secret": INTERNAL_SECRET,
          [MCP_CLIENT_HEADER]: MCP_CLIENT_VALUE,
          [CLIENT_CALL_ID_HEADER]: "toolu_01FhDDPLosbqpeu78qAfDU3y",
          [REQUEST_FINGERPRINT_HEADER]: "ab12",
        }),
        REQUESTED_AT
      )
    ).toEqual({
      organizationId: "org-a",
      principalUserId: "user-a",
      apiKeyId: "key-1",
      source: OperationSource.Mcp,
      clientCallId: "toolu_01FhDDPLosbqpeu78qAfDU3y",
      requestFingerprint: "ab12",
      requestedAt: REQUESTED_AT,
    });
  });

  it("ignores call id headers from a caller without the internal secret", () => {
    const result = readOperationReceiptRequest(
      authContext("api_key"),
      request({
        "x-internal-secret": "forged",
        [MCP_CLIENT_HEADER]: MCP_CLIENT_VALUE,
        [CLIENT_CALL_ID_HEADER]: "toolu_forged",
      }),
      REQUESTED_AT
    );

    expect(result?.source).toBe(OperationSource.Api);
    expect(result?.clientCallId).toBeUndefined();
  });

  it("does not treat another internal-secret holder as MCP without the marker", () => {
    const result = readOperationReceiptRequest(
      authContext("api_key"),
      request({
        "x-internal-secret": INTERNAL_SECRET,
        [CLIENT_CALL_ID_HEADER]: "toolu_relay",
      }),
      REQUESTED_AT
    );

    expect(result?.source).toBe(OperationSource.Api);
    expect(result?.clientCallId).toBeUndefined();
  });

  it("drops a call id that is not an opaque key", () => {
    const result = readOperationReceiptRequest(
      authContext("api_key"),
      request({
        "x-internal-secret": INTERNAL_SECRET,
        [MCP_CLIENT_HEADER]: MCP_CLIENT_VALUE,
        [CLIENT_CALL_ID_HEADER]: "toolu 01; DROP",
      }),
      REQUESTED_AT
    );

    expect(result?.source).toBe(OperationSource.Mcp);
    expect(result?.clientCallId).toBeUndefined();
  });
});

describe("receiptRouteTemplate", () => {
  it("names each dynamic segment by its param, never by its value", () => {
    const route = receiptRouteTemplate(
      new Request(
        "http://localhost/documents/PRD-12/threads/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/replies"
      ),
      { id: "PRD-12", threadId: "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" }
    );

    expect(route).toBe("/documents/[id]/threads/[threadId]/replies");
  });

  it("matches an encoded segment against its decoded param", () => {
    const route = receiptRouteTemplate(
      new Request("http://localhost/comments/c-1/reactions/%F0%9F%91%8D"),
      { commentId: "c-1", emoji: "\u{1F44D}" }
    );

    expect(route).toBe("/comments/[commentId]/reactions/[emoji]");
  });

  it("keeps a static route as it is", () => {
    expect(
      receiptRouteTemplate(new Request("http://localhost/settings/pensero"), {})
    ).toBe("/settings/pensero");
  });
});
