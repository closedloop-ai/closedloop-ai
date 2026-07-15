import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { GitHubOAuthRequiredReason } from "@repo/api/src/types/github";
import { fetchGitHubIntegrationStatus } from "../src/main/github-integration-status-client.js";

test("fetches GitHub integration status with the signed-in Desktop user token", async () => {
  const requests: Array<{ authorization: string | null; url: string }> = [];
  const getAccessToken = mock.fn(() =>
    Promise.resolve("desktop-access-user-b")
  );
  const fetchImpl: typeof fetch = (input, init) => {
    requests.push({
      authorization: new Headers(init?.headers).get("Authorization"),
      url: input.toString(),
    });
    return Promise.resolve(
      Response.json({
        success: true,
        data: {
          connected: false,
          githubDataConnection: {
            connected: false,
            sources: [],
            oauthRequiredReasons: [
              GitHubOAuthRequiredReason.NoAppInstallation,
              GitHubOAuthRequiredReason.NoUserGrant,
            ],
          },
        },
      })
    );
  };

  const status = await fetchGitHubIntegrationStatus({
    fetch: fetchImpl,
    getAccessToken,
    getApiOrigin: () => "https://api.example.test",
  });

  assert.equal(getAccessToken.mock.callCount(), 1);
  assert.equal(
    requests[0]?.url,
    "https://api.example.test/integrations/github"
  );
  assert.equal(requests[0]?.authorization, "Bearer desktop-access-user-b");
  assert.equal(status?.connected, false);
  assert.deepEqual(status?.githubDataConnection?.oauthRequiredReasons, [
    GitHubOAuthRequiredReason.NoAppInstallation,
    GitHubOAuthRequiredReason.NoUserGrant,
  ]);
});

test("returns null without fetching when the Desktop user token is unavailable", async () => {
  let fetchCalled = false;
  const fetchImpl: typeof fetch = () => {
    fetchCalled = true;
    return Promise.resolve(Response.json({ connected: false }));
  };

  const status = await fetchGitHubIntegrationStatus({
    fetch: fetchImpl,
    getAccessToken: () => Promise.reject(new Error("session unavailable")),
    getApiOrigin: () => "https://api.example.test",
  });

  assert.equal(status, null);
  assert.equal(fetchCalled, false);
});

test("returns null when GitHub integration status cannot be trusted", async () => {
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      Response.json({
        success: true,
        data: { connected: false, githubDataConnection: { connected: "no" } },
      })
    );

  const status = await fetchGitHubIntegrationStatus({
    fetch: fetchImpl,
    getAccessToken: () => Promise.resolve("desktop-access-user-b"),
    getApiOrigin: () => "https://api.example.test",
  });

  assert.equal(status, null);
});
