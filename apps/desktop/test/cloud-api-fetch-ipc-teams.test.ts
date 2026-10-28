import { TeamRole } from "@repo/api/src/types/teams";
import { describe, expect, it } from "vitest";
import {
  API_ORIGIN,
  createHarness,
} from "./cloud-api-fetch-ipc-test-harness.js";

const teamId = "019c24dc-9445-75ec-8136-c4e6d83147fa";
const memberId = "019c24dc-9445-75ec-8136-c4e6d83147fb";
const memberPath = `/teams/${teamId}/members/${memberId}`;
const repositoryPath = `/teams/${teamId}/repositories/${memberId}`;

const writes = [
  { method: "POST", path: "/teams", body: { name: "Engineering" } },
  { method: "PUT", path: `/teams/${teamId}`, body: { name: "Platform" } },
  { method: "DELETE", path: `/teams/${teamId}`, body: undefined },
  {
    method: "POST",
    path: `/teams/${teamId}/members`,
    body: { userId: memberId, role: TeamRole.Member },
  },
  { method: "PUT", path: memberPath, body: { role: TeamRole.Admin } },
  { method: "DELETE", path: memberPath, body: undefined },
  {
    method: "POST",
    path: `/teams/${teamId}/repositories`,
    body: {
      installationRepositoryId: memberId,
      isDefaultSelected: true,
      isPrimary: true,
    },
  },
  {
    method: "PUT",
    path: repositoryPath,
    body: { isDefaultSelected: false, isPrimary: false },
  },
  { method: "DELETE", path: repositoryPath, body: undefined },
];

describe("Teams authenticated Desktop cloud admission", () => {
  it.each(writes)(
    "admits $method $path with main-held identity",
    async ({ path, method, body }) => {
      const harness = createHarness();
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      const result = await harness.invoke({
        path,
        method,
        ...(serialized === undefined ? {} : { body: serialized }),
      });
      expect(result.kind).toBe("response");
      expect(harness.fetchCalls).toHaveLength(1);
      const request = harness.fetchCalls[0];
      expect(request.url.toString()).toBe(`${API_ORIGIN}${path}`);
      expect(request.init.body).toBe(serialized);
      const headers = new Headers(request.init.headers);
      expect(headers.get("authorization")).toBe("Bearer real-access-token");
      expect(headers.get("x-organization-id")).toBe("org-1");
    }
  );

  it("preserves a legacy role payload for the existing server guard", async () => {
    const harness = createHarness();
    const body = JSON.stringify({ role: TeamRole.Owner });
    await harness.invoke({ path: memberPath, method: "PUT", body });
    expect(harness.fetchCalls[0].init.body).toBe(body);
  });

  it.each([
    "/teams",
    `/teams/${teamId}`,
    `/teams/${teamId}/members`,
    `/teams/${teamId}/repositories`,
    "/users",
    "/me",
    "/integrations/github/repositories",
  ])("admits the bodyless read %s", async (path) => {
    const harness = createHarness();
    expect((await harness.invoke({ path, method: "GET" })).kind).toBe(
      "response"
    );
    expect(harness.fetchCalls).toHaveLength(1);
  });

  it.each([
    { method: "POST", path: "/teams/" },
    { method: "POST", path: "/teams-admin" },
    { method: "PUT", path: `/teams/${teamId}/members` },
    { method: "POST", path: memberPath },
    { method: "PATCH", path: `/teams/${teamId}` },
    { method: "DELETE", path: "/teams" },
    { method: "PUT", path: `${memberPath}/role` },
    { method: "DELETE", path: `${repositoryPath}/nested` },
    { method: "POST", path: "/teams/not-a-uuid/members" },
  ])("refuses unrelated $method $path", async ({ method, path }) => {
    const harness = createHarness();
    expect((await harness.invoke({ path, method, body: "{}" })).kind).toBe(
      "network-error"
    );
    expect(harness.fetchCalls).toHaveLength(0);
  });

  it("does not send a team write without a resolved sign-in token", async () => {
    const harness = createHarness({
      getAccessToken: () => Promise.resolve(null),
    });
    const result = await harness.invoke({
      path: "/teams",
      method: "POST",
      body: JSON.stringify({ name: "Engineering" }),
    });
    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      expect(result.status).toBe(401);
    }
    expect(harness.fetchCalls).toHaveLength(0);
  });
});
