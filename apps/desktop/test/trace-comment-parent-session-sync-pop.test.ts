import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DesktopPopSigningRequest } from "../src/main/desktop-pop.js";
import { buildTraceCommentParentSessionSyncPopHeaders } from "../src/main/trace-comment-parent-session-sync-pop.js";

describe("trace comment parent-session sync PoP headers", () => {
  test("signs parent-session sync requests for desktop-managed keys", async () => {
    const signingRequests: DesktopPopSigningRequest[] = [];

    const headers = await buildTraceCommentParentSessionSyncPopHeaders(
      {
        getApiKeyProvenance: () => "DESKTOP_MANAGED",
        signDesktopRequest: (request) => {
          signingRequests.push(request);
          return {
            "X-Desktop-Gateway-Id": "gateway-1",
            "X-Desktop-Signature": "signature-1",
            "X-Desktop-Timestamp": "1234567890",
          };
        },
      },
      new URL(
        "https://api.example.test/desktop/agent-sessions/sync?computeTargetId=target-1"
      )
    );

    assert.deepEqual(signingRequests, [
      {
        method: "POST",
        pathname: "/desktop/agent-sessions/sync",
      },
    ]);
    assert.deepEqual(headers, {
      "X-Desktop-Gateway-Id": "gateway-1",
      "X-Desktop-Signature": "signature-1",
      "X-Desktop-Timestamp": "1234567890",
    });
  });

  test("does not sign parent-session sync requests for user-created keys", async () => {
    let signCalls = 0;

    const headers = await buildTraceCommentParentSessionSyncPopHeaders(
      {
        getApiKeyProvenance: () => "USER_CREATED",
        signDesktopRequest: () => {
          signCalls += 1;
          return null;
        },
      },
      new URL("https://api.example.test/desktop/agent-sessions/sync")
    );

    assert.equal(signCalls, 0);
    assert.equal(headers, undefined);
  });
});
