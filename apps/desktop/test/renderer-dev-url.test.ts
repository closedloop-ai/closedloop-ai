import assert from "node:assert/strict";
import test from "node:test";
import {
  RendererDevServerArg,
  resolveDevRendererUrl,
} from "../src/main/renderer-dev-url.js";

test("resolveDevRendererUrl accepts loopback Vite URLs for unpackaged desktop", () => {
  const url = "http://127.0.0.1:5173/design-system/index.html";

  assert.equal(
    resolveDevRendererUrl([`${RendererDevServerArg.Prefix}${url}`], {
      isPackaged: false,
    }),
    url
  );
});

test("resolveDevRendererUrl ignores the dev renderer URL in packaged builds", () => {
  assert.equal(
    resolveDevRendererUrl(
      [`${RendererDevServerArg.Prefix}http://127.0.0.1:5173/`],
      { isPackaged: true }
    ),
    null
  );
});

test("resolveDevRendererUrl rejects non-loopback and non-http URLs", () => {
  for (const url of [
    "https://127.0.0.1:5173/",
    "http://app.closedloop.ai/",
    "http://user:pass@127.0.0.1:5173/",
    "not a url",
  ]) {
    assert.equal(
      resolveDevRendererUrl([`${RendererDevServerArg.Prefix}${url}`], {
        isPackaged: false,
      }),
      null
    );
  }
});
