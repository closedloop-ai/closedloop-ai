/**
 * @file onboarding-legal-link-external-open.test.ts
 * @description ISS-11397. The guided-onboarding welcome step renders its "Full
 * Privacy Policy" anchor with `target="_blank"`, so in the desktop renderer the
 * click reaches the renderer navigation guards, which hand the
 * URL to `shell.openExternal` only when `isAllowedRendererExternalUrl` admits it
 * and otherwise denies the open silently. The renderer build defines no
 * `NEXT_PUBLIC_WEB_URL`, so the href that actually ships there is the shared
 * default — and that default is only reachable if this allowlist admits it. This
 * pins the two halves against each other, which neither package can do alone.
 */
import assert from "node:assert/strict";
import {
  DEFAULT_WEB_ORIGIN,
  privacyPolicyHref,
  termsOfServiceHref,
} from "@repo/app/onboarding/lib/legal-links";
import { afterEach, describe, test } from "vitest";
import {
  isAllowedExternalUrl,
  isAllowedRendererExternalUrl,
} from "../src/main/settings/external-url-allowlist.js";
import { DEFAULT_WEB_APP_ORIGIN } from "../src/shared/contracts.js";

/** The stage APP origin — the shape `readWebAppOrigin()` yields on stage. */
const STAGE_WEB_APP_ORIGIN = "https://app.stage.example";
const originalWebUrl = process.env.NEXT_PUBLIC_WEB_URL;

function restoreWebUrl(): void {
  if (originalWebUrl === undefined) {
    Reflect.deleteProperty(process.env, "NEXT_PUBLIC_WEB_URL");
    return;
  }
  process.env.NEXT_PUBLIC_WEB_URL = originalWebUrl;
}

describe("onboarding legal links open in the system browser", () => {
  afterEach(() => {
    restoreWebUrl();
  });

  test("the shipped desktop hrefs clear the renderer external-URL allowlist", () => {
    Reflect.deleteProperty(process.env, "NEXT_PUBLIC_WEB_URL");

    const privacy = privacyPolicyHref();
    const terms = termsOfServiceHref();

    // Literals on purpose, both of them: every onboarding-side assertion
    // composes its expectation from these same constants, so renaming a path
    // would leave those green while the shipped link 404s against `apps/web`.
    // This is the one place the paths are pinned to the routes that exist.
    assert.equal(privacy, `${DEFAULT_WEB_ORIGIN}/legal/privacy`);
    assert.equal(terms, `${DEFAULT_WEB_ORIGIN}/legal/terms`);
    // `webAppOrigin` is null on a renderer whose origin could not be resolved;
    // the fixed host set must carry these links on its own.
    assert.equal(isAllowedRendererExternalUrl(privacy, null), true);
    assert.equal(isAllowedRendererExternalUrl(terms, null), true);
    assert.equal(isAllowedExternalUrl(privacy), true);
    assert.equal(isAllowedExternalUrl(terms), true);
  });

  test("a non-production marketing origin is denied, because the second argument is the APP origin", () => {
    // @tamsinb: the main process passes `readWebAppOrigin()` here
    // (`src/main/window.ts:498`), which is the APP origin — `app.closedloop.ai`,
    // or `app.stage.example` on stage — never the marketing host. So the
    // origin-equality arm of `isAllowedRendererExternalUrl` can never rescue a
    // web-stage href, and the fixed production set does not carry one either.
    // A configured non-production `NEXT_PUBLIC_WEB_URL` therefore yields a link
    // that is silently denied, which is the ISS-4898 fail-closed posture and the
    // reason the shipped default is a production host rather than a stage one.
    process.env.NEXT_PUBLIC_WEB_URL = "https://web-stage.stage.example";

    const privacy = privacyPolicyHref();

    assert.equal(privacy, "https://web-stage.stage.example/legal/privacy");
    assert.equal(isAllowedExternalUrl(privacy), false);
    assert.equal(
      isAllowedRendererExternalUrl(privacy, STAGE_WEB_APP_ORIGIN),
      false
    );
    assert.equal(
      isAllowedRendererExternalUrl(privacy, DEFAULT_WEB_APP_ORIGIN),
      false
    );
    // The same call, same second argument, on a URL the origin arm DOES admit —
    // so the three denials above are about this href, not a predicate that
    // refuses everything.
    assert.equal(
      isAllowedRendererExternalUrl(
        `${STAGE_WEB_APP_ORIGIN}/legal/privacy`,
        STAGE_WEB_APP_ORIGIN
      ),
      true
    );
  });
});
