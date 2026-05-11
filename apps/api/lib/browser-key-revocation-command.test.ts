import {
  BROWSER_KEY_APPROVAL_REQUEST_OPERATION_ID,
  BROWSER_KEY_APPROVAL_REQUEST_PATH,
  BROWSER_KEY_REVOCATION_OPERATION_ID,
  BROWSER_KEY_REVOCATION_PATH,
} from "@repo/api/src/types/compute-target";
import { describe, expect, it } from "vitest";
import {
  buildBrowserKeyApprovalRequestCommandInput,
  buildBrowserKeyRevocationCommandInput,
  isReservedBrowserKeyRevocationCommand,
  isReservedBrowserKeyRevocationRelayOperation,
} from "./browser-key-revocation-command";

describe("browser key revocation command helpers", () => {
  it("recognizes reserved operation ids and namespace-normalized paths", () => {
    expect(
      isReservedBrowserKeyRevocationCommand({
        operationId: BROWSER_KEY_REVOCATION_OPERATION_ID,
        path: "/api/gateway/symphony/chat/run-1",
      })
    ).toBe(true);
    expect(
      isReservedBrowserKeyRevocationCommand({
        operationId: "symphony_chat",
        path: "/api/engineer/internal/browser-key/revoke",
      })
    ).toBe(true);
    expect(
      isReservedBrowserKeyRevocationCommand({
        operationId: BROWSER_KEY_APPROVAL_REQUEST_OPERATION_ID,
        path: "/api/gateway/symphony/chat/run-1",
      })
    ).toBe(true);
    expect(
      isReservedBrowserKeyRevocationCommand({
        operationId: "symphony_chat",
        path: "/api/engineer/internal/browser-key/approval-request",
      })
    ).toBe(true);
  });

  it("recognizes reserved relay operation payloads", () => {
    expect(
      isReservedBrowserKeyRevocationRelayOperation({
        operationId: "op-1",
        operation: "engineer_http_request",
        params: {
          request: {
            path: `${BROWSER_KEY_REVOCATION_PATH}?fingerprint=ignored`,
          },
        },
        streaming: false,
      })
    ).toBe(true);
    expect(
      isReservedBrowserKeyRevocationRelayOperation({
        operationId: BROWSER_KEY_APPROVAL_REQUEST_OPERATION_ID,
        operation: "engineer_http_request",
        params: {},
        streaming: false,
      })
    ).toBe(true);
    expect(
      isReservedBrowserKeyRevocationRelayOperation({
        operationId: "op-2",
        operation: "engineer_http_request",
        params: {
          request: {
            path: `${BROWSER_KEY_APPROVAL_REQUEST_PATH}?fingerprint=ignored`,
          },
        },
        streaming: false,
      })
    ).toBe(true);
  });

  it("builds the internal revocation command body", () => {
    expect(
      buildBrowserKeyRevocationCommandInput({
        publicKeyId: "key-1",
        userId: "user-1",
        fingerprint: "cl:abcdefghijklmnopqrstuv",
      })
    ).toEqual({
      operationId: BROWSER_KEY_REVOCATION_OPERATION_ID,
      method: "POST",
      path: BROWSER_KEY_REVOCATION_PATH,
      body: {
        publicKeyId: "key-1",
        userId: "user-1",
        fingerprint: "cl:abcdefghijklmnopqrstuv",
      },
    });
  });

  it("builds the internal approval-request command body", () => {
    expect(
      buildBrowserKeyApprovalRequestCommandInput({
        publicKeyId: "key-1",
        userId: "user-1",
        fingerprint: "cl:abcdefghijklmnopqrstuv",
      })
    ).toEqual({
      operationId: BROWSER_KEY_APPROVAL_REQUEST_OPERATION_ID,
      method: "POST",
      path: BROWSER_KEY_APPROVAL_REQUEST_PATH,
      body: {
        publicKeyId: "key-1",
        userId: "user-1",
        fingerprint: "cl:abcdefghijklmnopqrstuv",
      },
    });
  });
});
