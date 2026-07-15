/**
 * Unit tests for the bundled-fallback renderer loader
 * (apps/desktop/src/main/renderer-load.ts) — the pure orchestrator that
 * `DesktopWindow.loadContent` delegates to.
 *
 * Regression: when the dev Vite renderer (e.g.
 * http://127.0.0.1:5175/design-system/index.html) isn't running, its
 * `loadURL` rejects with ERR_CONNECTION_REFUSED (-102). This must NOT be
 * fatal — the loader must fall back to the bundled `app://` asset, and the
 * whole operation must resolve (never reject), because the caller invokes it
 * fire-and-forget where a rejection would become an unhandled rejection crash.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  loadRendererContent,
  type RendererLoadDeps,
} from "../src/main/renderer-load.js";

const BUNDLED_URL = "app://renderer/design-system/index.html";
const DEV_URL = "http://127.0.0.1:5175/design-system/index.html";

const DEV_LOAD_FAILED_RE = /Dev renderer load failed/;
const BUNDLED_LOAD_FAILED_RE = /Bundled renderer load failed/;

type Harness = {
  deps: RendererLoadDeps;
  loaded: string[];
  allowed: string[];
  warnings: string[];
  errors: string[];
  registerCalls: number;
};

function makeHarness(
  loadUrl: (url: string) => Promise<unknown>,
  devRendererUrl: string | null
): Harness {
  const loaded: string[] = [];
  const allowed: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  let registerCalls = 0;

  const deps: RendererLoadDeps = {
    devRendererUrl,
    bundledRendererUrl: BUNDLED_URL,
    loadUrl: (url) => {
      loaded.push(url);
      return loadUrl(url);
    },
    allowRendererUrl: (url) => {
      allowed.push(url);
    },
    registerAppProtocol: () => {
      registerCalls += 1;
    },
    log: {
      warn: (_tag, message) => warnings.push(message),
      error: (_tag, message) => errors.push(message),
    },
  };

  return {
    deps,
    loaded,
    allowed,
    warnings,
    errors,
    get registerCalls() {
      return registerCalls;
    },
  };
}

test("falls back to the bundled renderer when the dev loadURL rejects", async () => {
  const h = makeHarness(
    (url) =>
      url === DEV_URL
        ? Promise.reject(
            new Error("ERR_CONNECTION_REFUSED (-102) loading dev renderer")
          )
        : Promise.resolve(),
    DEV_URL
  );

  const outcome = await loadRendererContent(h.deps);

  assert.equal(outcome, "bundled");
  // Attempted the dev URL first, then fell through to the bundled asset.
  assert.deepEqual(h.loaded, [DEV_URL, BUNDLED_URL]);
  // Bundled load is permitted by the nav guards and the protocol is registered.
  assert.equal(h.registerCalls, 1);
  assert.ok(h.allowed.includes(BUNDLED_URL));
  // The dev-server failure logged a warning (non-fatal), not an error.
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], DEV_LOAD_FAILED_RE);
  assert.equal(h.errors.length, 0);
});

test("does not reject/throw when the dev renderer is unavailable", async () => {
  const h = makeHarness(
    (url) =>
      url === DEV_URL
        ? Promise.reject(new Error("ERR_CONNECTION_REFUSED"))
        : Promise.resolve(),
    DEV_URL
  );

  // The whole operation resolves — the caller (`void this.loadContent()`)
  // can never surface an unhandled rejection.
  await assert.doesNotReject(() => loadRendererContent(h.deps));
});

test("loads the dev renderer directly when it is available", async () => {
  const h = makeHarness(() => Promise.resolve(), DEV_URL);

  const outcome = await loadRendererContent(h.deps);

  assert.equal(outcome, "dev");
  assert.deepEqual(h.loaded, [DEV_URL]);
  // No fallback → bundled protocol/allowlist not touched.
  assert.equal(h.registerCalls, 0);
  assert.deepEqual(h.allowed, [DEV_URL]);
  assert.equal(h.warnings.length, 0);
  assert.equal(h.errors.length, 0);
});

test("loads the bundled renderer directly when no dev URL is configured", async () => {
  const h = makeHarness(() => Promise.resolve(), null);

  const outcome = await loadRendererContent(h.deps);

  assert.equal(outcome, "bundled");
  assert.deepEqual(h.loaded, [BUNDLED_URL]);
  assert.equal(h.registerCalls, 1);
  assert.deepEqual(h.allowed, [BUNDLED_URL]);
});

test("reports failure (without throwing) when even the bundled load rejects", async () => {
  const h = makeHarness(
    () => Promise.reject(new Error("bundled asset missing")),
    DEV_URL
  );

  const outcome = await loadRendererContent(h.deps);

  assert.equal(outcome, "failed");
  assert.deepEqual(h.loaded, [DEV_URL, BUNDLED_URL]);
  // Dev failure → warn; bundled failure → error. Still never rejects.
  assert.equal(h.warnings.length, 1);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], BUNDLED_LOAD_FAILED_RE);
});
