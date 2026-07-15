import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitHubConnectIpcChannel,
  GitHubConnectOpenFailureReason,
  registerGitHubConnectOpenerIpcHandlers,
} from "../src/main/github-connect-opener-ipc.js";

type IpcHandlerWithRequest = (
  event: unknown,
  request?: { install?: boolean; returnTo?: string }
) => unknown;

const TRUSTED_EVENT = { sender: "trusted" };

function register(options: {
  trusted?: boolean;
  webAppOrigin?: string;
  openExternal?: (url: string) => Promise<unknown>;
}): { handlers: Map<string, IpcHandlerWithRequest>; opened: string[] } {
  const handlers = new Map<string, IpcHandlerWithRequest>();
  const opened: string[] = [];
  registerGitHubConnectOpenerIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    {
      isTrustedSender: () => options.trusted ?? true,
      getWebAppOrigin: () => options.webAppOrigin ?? "https://app.example.test",
      openExternal:
        options.openExternal ??
        ((url) => {
          opened.push(url);
          return Promise.resolve();
        }),
    }
  );
  return { handlers, opened };
}

test("opens the first-party GitHub connect URL for a trusted renderer", async () => {
  const { handlers, opened } = register({
    webAppOrigin: "http://localhost:3000",
  });

  const result = await handlers.get(GitHubConnectIpcChannel.Open)?.(
    TRUSTED_EVENT
  );

  assert.deepEqual(result, {
    ok: true,
    url: "http://localhost:3000/api/integrations/github?returnTo=%2Fbranches",
  });
  assert.deepEqual(opened, [
    "http://localhost:3000/api/integrations/github?returnTo=%2Fbranches",
  ]);
});

test("accepts a branches detail return target from a trusted renderer", async () => {
  const { handlers, opened } = register({
    webAppOrigin: "http://localhost:3000",
  });

  const result = await handlers.get(GitHubConnectIpcChannel.Open)?.(
    TRUSTED_EVENT,
    { returnTo: "/branches/owner%2Frepo::feature" }
  );

  assert.deepEqual(result, {
    ok: true,
    url: "http://localhost:3000/api/integrations/github?returnTo=%2Fbranches%2Fowner%252Frepo%3A%3Afeature",
  });
  assert.deepEqual(opened, [
    "http://localhost:3000/api/integrations/github?returnTo=%2Fbranches%2Fowner%252Frepo%3A%3Afeature",
  ]);
});

test("accepts an insights return target without forcing install mode", async () => {
  const { handlers, opened } = register({
    webAppOrigin: "http://localhost:3000",
  });

  const result = await handlers.get(GitHubConnectIpcChannel.Open)?.(
    TRUSTED_EVENT,
    { returnTo: "/insights" }
  );

  assert.deepEqual(result, {
    ok: true,
    url: "http://localhost:3000/api/integrations/github?returnTo=%2Finsights",
  });
  assert.deepEqual(opened, [
    "http://localhost:3000/api/integrations/github?returnTo=%2Finsights",
  ]);
});

test("uses install mode only when a trusted renderer requests it", async () => {
  const { handlers, opened } = register({
    webAppOrigin: "http://localhost:3000",
  });

  const result = await handlers.get(GitHubConnectIpcChannel.Open)?.(
    TRUSTED_EVENT,
    { install: true, returnTo: "/insights" }
  );

  assert.deepEqual(result, {
    ok: true,
    url: "http://localhost:3000/api/integrations/github?returnTo=%2Finsights&install=true",
  });
  assert.deepEqual(opened, [
    "http://localhost:3000/api/integrations/github?returnTo=%2Finsights&install=true",
  ]);
});

test("falls back to branches for untrusted return targets", async () => {
  const { handlers, opened } = register({
    webAppOrigin: "http://localhost:3000",
  });

  const result = await handlers.get(GitHubConnectIpcChannel.Open)?.(
    TRUSTED_EVENT,
    { returnTo: "/settings" }
  );

  assert.deepEqual(result, {
    ok: true,
    url: "http://localhost:3000/api/integrations/github?returnTo=%2Fbranches",
  });
  assert.deepEqual(opened, [
    "http://localhost:3000/api/integrations/github?returnTo=%2Fbranches",
  ]);
});

test("rejects an untrusted sender before opening a URL", async () => {
  const { handlers, opened } = register({ trusted: false });

  const result = await handlers.get(GitHubConnectIpcChannel.Open)?.({
    sender: "evil",
  });

  assert.deepEqual(result, {
    ok: false,
    reason: GitHubConnectOpenFailureReason.UntrustedSender,
  });
  assert.deepEqual(opened, []);
});

test("rejects an invalid configured origin before opening a URL", async () => {
  const { handlers, opened } = register({ webAppOrigin: "file:///tmp/app" });

  const result = await handlers.get(GitHubConnectIpcChannel.Open)?.(
    TRUSTED_EVENT
  );

  assert.deepEqual(result, {
    ok: false,
    reason: GitHubConnectOpenFailureReason.InvalidOrigin,
  });
  assert.deepEqual(opened, []);
});

test("reports opener failures without throwing to the renderer", async () => {
  const { handlers } = register({
    openExternal: () => Promise.reject(new Error("open failed")),
  });

  const result = await handlers.get(GitHubConnectIpcChannel.Open)?.(
    TRUSTED_EVENT
  );

  assert.deepEqual(result, {
    ok: false,
    reason: GitHubConnectOpenFailureReason.OpenFailed,
  });
});
