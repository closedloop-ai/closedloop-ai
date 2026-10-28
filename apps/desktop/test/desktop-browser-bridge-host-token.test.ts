/**
 * @file desktop-browser-bridge-host-token.test.ts
 * @description ISS-8412 — main's half of the host-token handoff.
 *
 * The token now arrives in the Electron child's environment instead of its
 * argv, so main owes two things: it must put the token on the dev renderer URL
 * it loads in-process (or the bridge host can never authenticate), and it must
 * take the variable OUT of `process.env` so nothing it later spawns — the
 * db-host utilityProcess, every Engineer CLI — inherits a credential that mints
 * an authorized bridge host.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  appendBridgeHostToken,
  resolveDevRendererUrlWithBridgeToken,
  takeBridgeHostTokenFromEnv,
} from "../src/main/browser-bridge-host-token.js";
import {
  desktopBrowserBridgeHostTokenEnvVar,
  desktopBrowserBridgeTokenParam,
} from "../src/shared/desktop-browser-bridge-contract.mjs";

const DEV_RENDERER_URL = "http://127.0.0.1:5199/design-system/index.html";
const HOST_TOKEN = "h".repeat(43);

// FIRST in this file on purpose: the resolver consumes `process.env` exactly
// once per process and caches what it found, which is what makes every later
// renderer load (the recovery reload, the health reporter's comparison) agree
// with the initial one. A case that ran before this one would consume an unset
// variable and leave this one asserting against the cached null.
test("main takes the token off the environment and onto the URL it loads", () => {
  process.env[desktopBrowserBridgeHostTokenEnvVar] = HOST_TOKEN;

  const resolved = resolveDevRendererUrlWithBridgeToken(
    ["electron", `--closedloop-renderer-url=${DEV_RENDERER_URL}`],
    { isPackaged: false }
  );

  assert.notEqual(resolved, null);
  assert.equal(
    new URL(resolved ?? "").searchParams.get(desktopBrowserBridgeTokenParam),
    HOST_TOKEN
  );
  assert.equal(
    Object.hasOwn(process.env, desktopBrowserBridgeHostTokenEnvVar),
    false,
    "the host token stayed in the environment for every child to inherit"
  );

  // Stable across calls, even though the variable is gone: the recovery reload
  // and the health reporter's recovered-URL comparison both read this again.
  assert.equal(
    resolveDevRendererUrlWithBridgeToken(
      ["electron", `--closedloop-renderer-url=${DEV_RENDERER_URL}`],
      { isPackaged: false }
    ),
    resolved
  );
});

test("a packaged build never receives the token, however the variable is set", () => {
  const env = { [desktopBrowserBridgeHostTokenEnvVar]: HOST_TOKEN };

  assert.equal(takeBridgeHostTokenFromEnv(env), HOST_TOKEN);
  assert.equal(
    resolveDevRendererUrlWithBridgeToken(
      ["electron", `--closedloop-renderer-url=${DEV_RENDERER_URL}`],
      { isPackaged: true }
    ),
    null
  );
});

test("the variable is removed even when what it held was unusable", () => {
  for (const value of ["", "too-short", HOST_TOKEN.slice(0, 42)]) {
    const env: Record<string, string | undefined> = {
      [desktopBrowserBridgeHostTokenEnvVar]: value,
      PATH: "/usr/bin",
    };

    assert.equal(takeBridgeHostTokenFromEnv(env), null);
    assert.equal(
      Object.hasOwn(env, desktopBrowserBridgeHostTokenEnvVar),
      false,
      `a ${value.length}-character value was left for children to inherit`
    );
    assert.equal(env.PATH, "/usr/bin");
  }
});

test("no token is attached to a URL that is not a loopback dev renderer", () => {
  assert.equal(appendBridgeHostToken(null, HOST_TOKEN), null);
  assert.equal(
    appendBridgeHostToken(DEV_RENDERER_URL, null),
    DEV_RENDERER_URL,
    "a launch with no token must leave the URL untouched"
  );
  for (const url of [
    "https://app.closedloop.ai/design-system/index.html",
    "http://example.com/design-system/index.html",
    "app://renderer/index.html",
    "not a url",
  ]) {
    assert.equal(
      appendBridgeHostToken(url, HOST_TOKEN),
      url,
      `the host token was attached to ${url}`
    );
  }
});

test("a loopback dev renderer URL keeps its own query and gains the token", () => {
  const withQuery = `${DEV_RENDERER_URL}?golden=1`;

  const applied = new URL(appendBridgeHostToken(withQuery, HOST_TOKEN) ?? "");

  assert.equal(applied.searchParams.get("golden"), "1");
  assert.equal(
    applied.searchParams.get(desktopBrowserBridgeTokenParam),
    HOST_TOKEN
  );
});
