import assert from "node:assert/strict";
import { TagEntityType } from "@repo/api/src/types/tag";
import { DOC_SYNC_TOKEN_PATH } from "@repo/realtime-contract/protocol";
import { test } from "vitest";
import { serveDocumentAsset } from "../src/main/ipc/document-asset-proxy.js";
import {
  createHarness,
  NOT_ALLOWLISTED_ERROR,
  UNTRUSTED_EVENT,
} from "./cloud-api-fetch-ipc-test-harness.js";

const documentRequests = [
  ["POST", "/documents"],
  ["POST", "/documents/costs"],
  ["POST", "/documents/batch-update-status"],
  ["POST", "/documents/batch-update-priority"],
  ["POST", "/documents/batch-delete"],
  ["POST", "/documents/merge"],
  ["POST", "/documents/00000000-0000-4000-8000-000000000001/versions"],
  ["POST", "/documents/00000000-0000-4000-8000-000000000001/attachments"],
  [
    "POST",
    "/documents/00000000-0000-4000-8000-000000000001/attachments/resolve",
  ],
  [
    "POST",
    "/documents/00000000-0000-4000-8000-000000000001/context-attachments",
  ],
  ["POST", "/documents/00000000-0000-4000-8000-000000000001/threads"],
  [
    "POST",
    "/documents/00000000-0000-4000-8000-000000000001/threads/thread-1/replies",
  ],
  [
    "POST",
    "/documents/00000000-0000-4000-8000-000000000001/threads/thread-1/resolve",
  ],
  [
    "POST",
    "/documents/00000000-0000-4000-8000-000000000001/threads/thread-1/unresolve",
  ],
  ["POST", "/collaboration/auth"],
  ["POST", DOC_SYNC_TOKEN_PATH],
  ["POST", "/artifact-links/pull-requests"],
  ["PUT", "/custom-fields/00000000-0000-4000-8000-000000000002"],
  ["POST", "/artifacts/related-sessions"],
  ["POST", "/artifact-links"],
  ["POST", "/artifact-links/batch-move"],
  ["POST", "/artifacts/00000000-0000-4000-8000-000000000001/favorite"],
  ["POST", "/tags"],
  ["POST", "/entity-tags/batch"],
  ["POST", "/custom-fields"],
  [
    "POST",
    "/documents/00000000-0000-4000-8000-000000000001/custom-field-settings",
  ],
  ["POST", "/custom-fields/field-1/enum-options"],
  ["POST", "/custom-fields/field-1/enum-options/reorder"],
  ["PUT", "/documents/00000000-0000-4000-8000-000000000001"],
  ["PUT", "/custom-fields/field-1/enum-options/option-1"],
  ["DELETE", "/documents/00000000-0000-4000-8000-000000000001"],
  [
    "DELETE",
    "/documents/00000000-0000-4000-8000-000000000001/attachments/attachment-1",
  ],
  [
    "DELETE",
    "/documents/00000000-0000-4000-8000-000000000001/custom-field-settings/field-1",
  ],
  ["DELETE", "/artifact-links/link-1"],
  ["DELETE", "/artifacts/00000000-0000-4000-8000-000000000001/favorite"],
  [
    "DELETE",
    `/entity-tags?tagId=tag-1&entityType=${TagEntityType.Artifact}&entityId=doc-1`,
  ],
] as const;

test("forwards shared Documents writes with main-held credentials and unchanged bodies", async () => {
  for (const [method, path] of documentRequests) {
    const { invoke, fetchCalls } = createHarness();
    const body = JSON.stringify({ documentId: "doc-1" });
    const result = await invoke({ method, path, body });
    assert.equal(result.kind, "response", `${method} ${path}`);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].init.body, body);
    const headers = fetchCalls[0].init.headers as Headers;
    assert.equal(headers.get("authorization"), "Bearer real-access-token");
    assert.equal(headers.get("x-organization-id"), "org-1");
  }
});

test("keeps sibling endpoints and unrelated document methods closed", async () => {
  for (const [method, path] of [
    ["POST", "/documents/00000000-0000-4000-8000-000000000001/admin"],
    ["POST", "/documents/00000000-0000-4000-8000-000000000001/versions/nested"],
    ["POST", "/collaboration/admin"],
    ["POST", `${DOC_SYNC_TOKEN_PATH}/admin`],
    ["PUT", DOC_SYNC_TOKEN_PATH],
    ["PUT", "/documents/00000000-0000-4000-8000-000000000001/versions"],
    ["PATCH", "/documents/00000000-0000-4000-8000-000000000001"],
    [
      "DELETE",
      "/documents/00000000-0000-4000-8000-000000000001/versions/version-1",
    ],
    ["DELETE", "/custom-fields/field-1"],
    ["POST", "/documents-admin"],
    ["PUT", "/documents/merge"],
    ["PUT", "/documents/by-slug"],
    ["DELETE", "/documents/summary"],
    ["PUT", "/custom-fields/references"],
    ["POST", "/integrations/linear/connect"],
    // ISS-12435: the Run action's write was removed with Loops.
    ["POST", "/documents/00000000-0000-4000-8000-000000000001/run-loop"],
    // ISS-12856: their document-detail callers were removed.
    [
      "POST",
      "/documents/00000000-0000-4000-8000-000000000001/context-attachments/gdrive",
    ],
    ["POST", "/documents/00000000-0000-4000-8000-000000000001/judge-ratings"],
    ["POST", "/integrations/linear/export"],
    ["PUT", "/documents/00000000-0000-4000-8000-000000000001/rating"],
  ]) {
    const { invoke, fetchCalls } = createHarness();
    const result = await invoke({ method, path, body: "{}" });
    assert.equal(result.kind, "network-error");
    if (result.kind === "network-error") {
      assert.match(result.message, NOT_ALLOWLISTED_ERROR);
    }
    assert.equal(fetchCalls.length, 0);
  }
});

test("does not give untrusted or signed-out renderers document writes", async () => {
  const untrusted = createHarness();
  assert.throws(
    () =>
      untrusted.invoke(
        { path: "/documents", method: "POST", body: "{}" },
        UNTRUSTED_EVENT
      ),
    UNTRUSTED_SENDER_ERROR
  );
  assert.equal(untrusted.fetchCalls.length, 0);
  const signedOut = createHarness({
    getAccessToken: () => Promise.resolve(null),
  });
  const result = await signedOut.invoke({
    path: "/documents",
    method: "POST",
    body: "{}",
  });
  assert.equal(result.kind, "response");
  if (result.kind === "response") {
    assert.equal(result.status, 401);
  }
  assert.equal(signedOut.fetchCalls.length, 0);
});

const UNTRUSTED_SENDER_ERROR = /untrusted sender/;

test("authenticated attachment responses mint capabilities fenced to the account generation", async () => {
  let admission = { userId: "user-1", organizationId: "org-1", generation: 1 };
  const { invoke } = createHarness(
    { getAccountAdmission: () => admission },
    Response.json({
      success: true,
      data: { downloadUrl: "https://storage.closedloop.test/signed-file" },
    })
  );
  const result = await invoke({
    path: "/documents/00000000-0000-4000-8000-000000000001/attachments/file-1",
  });
  assert.equal(result.kind, "response");
  if (result.kind !== "response") {
    throw new Error("Expected an attachment response");
  }
  const url = JSON.parse(result.bodyText).data.downloadUrl;
  assert.match(url, DOCUMENT_ASSET_URL_PATTERN);
  admission = { ...admission, generation: 2 };
  const response = await serveDocumentAsset(new Request(url), {}, () => {
    throw new Error("Stale capability must never reach storage");
  });
  assert.equal(response.status, 404);
});
const DOCUMENT_ASSET_URL_PATTERN = /^app:\/\/renderer\/document-assets\//;
