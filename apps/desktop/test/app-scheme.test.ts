import assert from "node:assert/strict";
import test from "node:test";
import { APP_SCHEME, APP_SCHEME_PRIVILEGES } from "../src/main/app-scheme.js";

// FEA-3549 / FEA-3548: the renderer `fetch()`es prepared transcripts over the
// `app://` scheme. Without `supportFetchAPI` + `corsEnabled` Chromium blocks the
// cross-origin fetch from the loopback dev origin ("Cross origin requests are
// only supported for protocol schemes: …") and transcripts never load. This
// pins the privilege set the app registers before `ready` so a regression that
// drops CORS/fetch/stream fails here rather than silently in the packaged app.
test("app:// scheme is registered with fetch + CORS + stream privileges", () => {
  assert.equal(APP_SCHEME_PRIVILEGES.scheme, APP_SCHEME);
  assert.equal(APP_SCHEME, "app");
  assert.deepEqual(APP_SCHEME_PRIVILEGES.privileges, {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  });
});
