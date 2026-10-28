import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { DocumentType } from "@repo/api/src/types/document";
import { TagEntityType } from "@repo/api/src/types/tag";
import { describe, expect, it } from "vitest";
import {
  API_ORIGIN,
  createHarness,
  UNTRUSTED_EVENT,
} from "./cloud-api-fetch-ipc-test-harness.js";

const artifactId = "00000000-0000-4000-8000-000000000001";
const tagId = "00000000-0000-4000-8000-000000000002";
const cohortBody = JSON.stringify({ artifactIds: [artifactId] });
// The single entity-tag route admits an ARTIFACT attach body and an ARTIFACT
// detach query only (ISS-10995, `refusedEntityTagWrite`).
const entityTagAttachBody = JSON.stringify({
  entityId: artifactId,
  entityType: TagEntityType.Artifact,
  tagId,
});
const listingRoutes = [
  ["POST", "/documents/costs"],
  ["POST", "/artifacts/related-sessions"],
  ["POST", "/documents"],
  ["PUT", `/documents/${artifactId}`],
  ["DELETE", `/documents/${artifactId}`],
  ["POST", `${BatchMutationRoute.DocumentsUpdateStatus}/v2`],
  ["POST", `${BatchMutationRoute.DocumentsUpdatePriority}/v2`],
  ["POST", "/artifact-links"],
  ["POST", `/artifacts/${artifactId}/favorite`],
  ["DELETE", `/artifacts/${artifactId}/favorite`],
  ["POST", "/entity-tags", entityTagAttachBody],
  ["POST", "/entity-tags/batch"],
  [
    "DELETE",
    `/entity-tags?entityId=${artifactId}&entityType=${TagEntityType.Artifact}&tagId=${tagId}`,
  ],
  ["POST", "/tags"],
] as const;

describe("Desktop shared Documents/Issues listing transport", () => {
  it.each(listingRoutes)(
    "forwards only the required %s %s route with main-held identity",
    async (method, path, body = cohortBody) => {
      const { invoke, fetchCalls } = createHarness();
      const result = await invoke({
        path,
        method,
        body,
        headers: { Authorization: "Bearer renderer-spoof" },
      });
      expect(result.kind).toBe("response");
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url.toString()).toBe(`${API_ORIGIN}${path}`);
      expect(fetchCalls[0].init.body).toBe(body);
      expect((fetchCalls[0].init.headers as Headers).get("authorization")).toBe(
        "Bearer real-access-token"
      );
    }
  );
  it.each([
    ["POST", "/documents/costs/extra"],
    ["PUT", "/documents/costs"],
    ["PUT", "/documents/not-a-uuid"],
    ["PUT", `/documents/${artifactId}/versions`],
    ["DELETE", "/documents/not-a-uuid"],
    ["DELETE", `/documents/${artifactId}/versions`],
    ["DELETE", "/documents/batch-delete"],
    ["POST", "/artifacts/related-sessions/extra"],
    ["DELETE", "/artifact-links"],
    ["POST", "/artifacts/not-an-id/favorite"],
    ["POST", `/artifacts/${artifactId}/favorite/extra`],
    ["PUT", `/artifacts/${artifactId}/favorite`],
    ["POST", "/entity-tags/batch/extra"],
    ["DELETE", "/entity-tags/batch"],
    ["PATCH", `/tags/${artifactId}`],
  ])(
    "refuses neighboring %s %s routes without a network request",
    async (method, path) => {
      const { invoke, fetchCalls } = createHarness();
      const result = await invoke({ path, method, body: "{}" });
      expect(result.kind).toBe("network-error");
      expect(fetchCalls).toHaveLength(0);
    }
  );
  it("forwards the server-paged Issues read with its query intact", async () => {
    const { invoke, fetchCalls } = createHarness();
    const path = `/documents?types=${DocumentType.Feature}&includeTotal=true&limit=25&offset=25&search=evergreen`;
    const result = await invoke({ path, method: "GET" });
    expect(result.kind).toBe("response");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url.toString()).toBe(`${API_ORIGIN}${path}`);
  });
  it("refuses an untrusted renderer before the permitted cost read", () => {
    const { invoke, fetchCalls } = createHarness();
    expect(() =>
      invoke(
        { method: "POST", path: "/documents/costs", body: "{}" },
        UNTRUSTED_EVENT
      )
    ).toThrow("untrusted sender");
    expect(fetchCalls).toHaveLength(0);
  });
});
