import assert from "node:assert/strict";
import test from "node:test";
import {
  RendererDevServerArg,
  resolveDevRendererUrl,
  resolveTranscriptAllowedOrigin,
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

// FEA-3549 / FEA-3548: the renderer fetches prepared transcripts over the
// `corsEnabled` `app://` scheme. In dev the fetch is cross-origin from the
// loopback Vite origin, so the transcript response must echo an ACAO header —
// but ONLY for a bare loopback HTTP origin (never `*`, never remote).
test("resolveTranscriptAllowedOrigin echoes a bare loopback HTTP origin", () => {
  for (const origin of [
    "http://127.0.0.1:5186",
    "http://localhost:5173",
    "http://[::1]:4000",
  ]) {
    assert.equal(resolveTranscriptAllowedOrigin(origin), origin);
  }
});

test("resolveTranscriptAllowedOrigin normalizes a trailing slash to a bare origin", () => {
  // A URL string with a path/trailing slash still yields the bare origin (the
  // exact ACAO grammar) rather than being rejected or echoed verbatim.
  assert.equal(
    resolveTranscriptAllowedOrigin("http://127.0.0.1:5186/"),
    "http://127.0.0.1:5186"
  );
});

test("resolveTranscriptAllowedOrigin denies missing, remote, non-http, and credentialed origins", () => {
  assert.equal(resolveTranscriptAllowedOrigin(null), null);
  for (const origin of [
    "", // same-origin packaged fetch sends no Origin
    "https://127.0.0.1:5186", // https loopback is not the dev renderer shape
    "http://app.closedloop.ai", // remote origin
    "https://app.closedloop.ai",
    "http://user:pass@127.0.0.1:5186", // credentialed
    "app://renderer", // the packaged scheme is same-origin, no ACAO
    "not an origin",
  ]) {
    assert.equal(resolveTranscriptAllowedOrigin(origin), null);
  }
});
