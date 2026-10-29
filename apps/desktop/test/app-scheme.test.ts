import assert from "node:assert/strict";
import { DESKTOP_RENDERER_ORIGIN } from "@repo/realtime-contract/desktop-renderer-origin";
import { test } from "vitest";
import {
  APP_RENDERER_ORIGIN,
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
} from "../src/main/app-scheme.js";

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

// PLN-2189 T-4.5: doc-sync admits the desktop renderer by this exact origin,
// so a scheme or host rename that left the service's constant behind would
// lock every desktop client out of the document editor.
test("the renderer origin is the one doc-sync admits", () => {
  assert.equal(APP_RENDERER_ORIGIN, DESKTOP_RENDERER_ORIGIN);
});
