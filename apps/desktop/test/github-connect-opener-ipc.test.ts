import assert from "node:assert/strict";
import { GitHubConnectReturnSegment } from "@repo/api/src/types/github-clerk-link";
import { test } from "vitest";
import {
  GitHubConnectOpenFailureReason,
  registerGitHubConnectOpenerIpcHandlers,
} from "../src/main/ipc/github-connect-opener-ipc.js";
import { GitHubConnectIpcChannel } from "../src/shared/github-connect-opener-ipc-channel.js";

type IpcHandlerWithRequest = (
  event: unknown,
  request?: { install?: boolean; returnTo?: string; returnToDesktop?: boolean }
) => unknown;

const TRUSTED_EVENT = { sender: "trusted" };

function register(options: {
  trusted?: boolean;
  webAppOrigin?: string;
  openExternal?: (url: string) => Promise<unknown>;
  returnWatch?: { start: () => void; stop: () => void };
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
      returnWatch: options.returnWatch,
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
    url: "http://localhost:3000/connect/github/link?returnTo=%2Fbranches",
  });
  assert.deepEqual(opened, [
    "http://localhost:3000/connect/github/link?returnTo=%2Fbranches",
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
    url: "http://localhost:3000/connect/github/link?returnTo=%2Fbranches%2Fowner%252Frepo%3A%3Afeature",
  });
  assert.deepEqual(opened, [
    "http://localhost:3000/connect/github/link?returnTo=%2Fbranches%2Fowner%252Frepo%3A%3Afeature",
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
    url: "http://localhost:3000/connect/github/link?returnTo=%2Finsights",
  });
  assert.deepEqual(opened, [
    "http://localhost:3000/connect/github/link?returnTo=%2Finsights",
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

// ISS-5958: this opener and the web app's own return-path validator gate the
// same two-process contract. They read one list now, and this asserts THIS side
// honors every entry on it -- the apps/app suite asserts the same list from its
// side, so a segment added to the list cannot reach production honored by only
// one. Settings is the entry that paid for the lesson: until both sides took
// it, connecting from Settings -> Account silently landed the user on Branches.
test("returns to every shared return segment the list declares", async () => {
  for (const segment of Object.values(GitHubConnectReturnSegment)) {
    const { handlers, opened } = register({
      webAppOrigin: "http://localhost:3000",
    });
    const expected = `http://localhost:3000/connect/github/link?returnTo=%2F${segment}`;

    const result = await handlers.get(GitHubConnectIpcChannel.Open)?.(
      TRUSTED_EVENT,
      { returnTo: `/${segment}` }
    );

    assert.deepEqual(result, { ok: true, url: expected });
    assert.deepEqual(opened, [expected]);
  }
});

test("falls back to branches for untrusted return targets", async () => {
  for (const returnTo of [
    "/settings/secret",
    "/admin",
    // The `parsed.search` half of the query/hash guard. This case works because
    // "settings" IS a GitHubConnectReturnSegment, so deleting the check flips
    // the assertion to `returnTo=%2Fsettings`.
    "/settings?tab=integrations",
    // ISS-8143: the `parsed.hash` half had no such case, so deleting it was a
    // surviving mutant — same reasoning, different half of the same condition.
    "/settings#tab",
    // ISS-8143: the `catch`. Unparseable even against the base, because `[`
    // opens an IPv6 host literal that never closes.
    "http://[",
    "https://evil.example.test/settings",
  ]) {
    const { handlers, opened } = register({
      webAppOrigin: "http://localhost:3000",
    });

    const result = await handlers.get(GitHubConnectIpcChannel.Open)?.(
      TRUSTED_EVENT,
      { returnTo }
    );

    assert.deepEqual(result, {
      ok: true,
      url: "http://localhost:3000/connect/github/link?returnTo=%2Fbranches",
    });
    assert.deepEqual(opened, [
      "http://localhost:3000/connect/github/link?returnTo=%2Fbranches",
    ]);
  }
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

function countingWatch() {
  const watch = { started: 0, start: () => undefined, stop: () => undefined };
  watch.start = () => {
    watch.started += 1;
  };
  return watch;
}

test("watches for the connection when the renderer asks to return to Desktop", async () => {
  const returnWatch = countingWatch();
  const { handlers, opened } = register({ returnWatch });

  await handlers.get(GitHubConnectIpcChannel.Open)?.(TRUSTED_EVENT, {
    returnTo: "/dashboard",
    returnToDesktop: true,
  });

  assert.equal(opened.length, 1);
  assert.equal(returnWatch.started, 1);
});

test("an older renderer that does not ask opens the browser with no watch", async () => {
  const returnWatch = countingWatch();
  const { handlers, opened } = register({ returnWatch });

  await handlers.get(GitHubConnectIpcChannel.Open)?.(TRUSTED_EVENT, {
    returnTo: "/dashboard",
  });

  assert.equal(opened.length, 1);
  assert.equal(returnWatch.started, 0);
});

test("does not watch a connect the browser never opened", async () => {
  const returnWatch = countingWatch();
  const { handlers } = register({
    openExternal: () => Promise.reject(new Error("open failed")),
    returnWatch,
  });

  await handlers.get(GitHubConnectIpcChannel.Open)?.(TRUSTED_EVENT, {
    returnToDesktop: true,
  });

  assert.equal(returnWatch.started, 0);
});

test("the return flag never reaches the URL the browser opens", async () => {
  const { handlers, opened } = register({
    webAppOrigin: "http://localhost:3000",
  });

  await handlers.get(GitHubConnectIpcChannel.Open)?.(TRUSTED_EVENT, {
    returnTo: "/dashboard",
    returnToDesktop: true,
  });

  assert.deepEqual(opened, [
    "http://localhost:3000/connect/github/link?returnTo=%2Fdashboard",
  ]);
});
