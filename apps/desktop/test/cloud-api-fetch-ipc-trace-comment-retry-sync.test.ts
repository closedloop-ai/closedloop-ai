import assert from "node:assert/strict";
import {
  CommentTargetType,
  hasTraceCommentRoutes,
  traceCommentRetrySyncPath,
} from "@repo/api/src/types/comment";
import { test } from "vitest";
import {
  API_ORIGIN,
  createHarness,
  NOT_ALLOWLISTED_ERROR,
} from "./cloud-api-fetch-ipc-test-harness.js";

/**
 * ISS-11213: the legacy trace-comment rail's retry door POSTs over the bridge
 * now that desktop writes every comment over HTTP (PLN-2162 M5.2). Exactly that
 * POST is admitted, on both owner kinds, and nothing next to it.
 */

const TARGET_ID = "0199a1b2-0000-7000-8000-00000000d004";
const COMMENT_ID = "0199a1b2-0000-7000-8000-00000000e005";

type Route = { method: string; path: string };

const ADMITTED_ROUTES: Route[] = [
  {
    method: "POST",
    path: "/agent-sessions/session-1/trace-comments/comment-1/retry-sync",
  },
  {
    method: "POST",
    path: "/branches/acme%2Ffrontend%3A%3Amain/trace-comments/comment-1/retry-sync",
  },
  ...Object.values(CommentTargetType)
    .filter(hasTraceCommentRoutes)
    .map((type) => ({
      method: "POST",
      path: traceCommentRetrySyncPath({ type, id: TARGET_ID }, COMMENT_ID),
    })),
];

const SESSION_RETRY_PATH = `/agent-sessions/${TARGET_ID}/trace-comments/${COMMENT_ID}/retry-sync`;

const REFUSED_NEIGHBOURS: Route[] = [
  // Each other write method on the same path.
  { method: "PATCH", path: SESSION_RETRY_PATH },
  { method: "PUT", path: SESSION_RETRY_PATH },
  { method: "DELETE", path: SESSION_RETRY_PATH },
  // Missing ids, nested paths, unknown owners and suffixes.
  {
    method: "POST",
    path: `/agent-sessions/${TARGET_ID}/trace-comments/retry-sync`,
  },
  {
    method: "POST",
    path: `/agent-sessions/${TARGET_ID}/trace-comments//retry-sync`,
  },
  {
    method: "POST",
    path: `/agent-sessions//trace-comments/${COMMENT_ID}/retry-sync`,
  },
  {
    method: "POST",
    path: `/agent-sessions/${TARGET_ID}/x/trace-comments/${COMMENT_ID}/retry-sync`,
  },
  { method: "POST", path: `${SESSION_RETRY_PATH}/x` },
  { method: "POST", path: `${SESSION_RETRY_PATH}/` },
  {
    method: "POST",
    path: `/documents/${TARGET_ID}/trace-comments/${COMMENT_ID}/retry-sync`,
  },
  {
    method: "POST",
    path: `/agent-sessions/${TARGET_ID}/trace-comments/${COMMENT_ID}/retry`,
  },
  {
    method: "POST",
    path: `/agent-sessions/${TARGET_ID}/trace-comments/${COMMENT_ID}/abandon`,
  },
];

test("admits the trace-comment retry-sync POST on both owner kinds", async () => {
  for (const { method, path } of ADMITTED_ROUTES) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({ path, method, body: "{}" });

    assert.equal(result.kind, "response", `${method} ${path} must be admitted`);
    assert.equal(fetchCalls.length, 1, `${method} ${path} must fetch once`);
    const call = fetchCalls[0];
    assert.equal(call.url.toString(), `${API_ORIGIN}${path}`);
    assert.equal(call.init.method, method);
    const headers = call.init.headers as Headers;
    assert.equal(headers.get("authorization"), "Bearer real-access-token");
  }
});

test("refuses every neighbour of the trace-comment retry-sync POST", async () => {
  for (const { method, path } of REFUSED_NEIGHBOURS) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({
      path,
      method,
      ...(method === "DELETE" ? {} : { body: "{}" }),
    });

    assert.equal(
      result.kind,
      "network-error",
      `${method} ${path} must be rejected`
    );
    if (result.kind === "network-error") {
      assert.match(result.message, NOT_ALLOWLISTED_ERROR);
    }
    assert.equal(fetchCalls.length, 0, `${method} ${path} must not fetch`);
  }
});
