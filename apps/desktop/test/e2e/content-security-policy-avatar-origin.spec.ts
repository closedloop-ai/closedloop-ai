/**
 * ISS-10402: launched-app proof that Chromium enforces the packaged `app://`
 * policy exactly as written — one remote image origin and no other.
 *
 * The node-lane spec (`test/content-security-policy.test.ts`) pins the POLICY
 * STRINGS: it proves what we emit. It cannot prove that Chromium received the
 * header on an `app://` response and parsed `img-src` the way we meant, which is
 * the layer the avatar regression actually lived at. This spec drives that layer
 * in the real packaged renderer.
 *
 * WHY A VIOLATION EVENT AND NOT A RENDERED AVATAR. Asserting a real Clerk avatar
 * paints would make this spec depend on a live network fetch to img.clerk.com,
 * which is flaky in CI and offline everywhere else. CSP adjudicates BEFORE the
 * request leaves: a disallowed origin fires `securitypolicyviolation` and never
 * hits the network, an allowed one fires nothing and then fails on its own
 * (unreachable host) with a plain `error`. So the violation event is the exact
 * signal, and it needs no network at all.
 *
 * TWO ORIGINS, BECAUSE THE CONTRACT IS PER-ORIGIN. A one-origin fixture cannot
 * tell "the policy admits Clerk" from "the policy admits everything" — an
 * `img-src *` regression would pass it. The disallowed origin is the positive
 * control on the SAME locator (an `<img>` in the same document under the same
 * policy): it must fire, proving the listener, the document and the enforcement
 * are all live, and only then does the absence of a Clerk violation mean
 * anything.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktop-app";

/** The one remote origin `img-src` admits (src/shared/content-security-policy.ts). */
const ALLOWED_AVATAR_URL = "https://img.clerk.com/e2e-iss-10402-avatar.png";
/**
 * A remote image origin the policy must NOT admit. `.invalid` is reserved by
 * RFC 2606 and never resolves, so even a policy bug that let the request out
 * cannot reach anything.
 */
const BLOCKED_IMAGE_URL = "https://avatars.iss-10402.invalid/control.png";

const CSP_VIOLATION_TIMEOUT_MS = 15_000;

type ImageCspProbe = {
  violations: { blockedURI: string; effectiveDirective: string }[];
  controlFired: boolean;
};

test.describe("desktop CSP: remote image origins (ISS-10402)", () => {
  test("Chromium admits the Clerk avatar host and blocks every other remote image origin", async () => {
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-e2e-csp-avatar-",
    });
    try {
      const probe = await page.evaluate(
        async ({
          allowedUrl,
          blockedUrl,
          timeoutMs,
        }): Promise<ImageCspProbe> => {
          const violations: ImageCspProbe["violations"] = [];
          let resolveControl: () => void = () => {
            // replaced synchronously by the promise executor below
          };
          const controlSeen = new Promise<void>((resolve) => {
            resolveControl = resolve;
          });
          const onViolation = (event: SecurityPolicyViolationEvent) => {
            violations.push({
              blockedURI: event.blockedURI,
              effectiveDirective:
                event.effectiveDirective || event.violatedDirective,
            });
            if (event.blockedURI.startsWith("https://avatars.iss-10402")) {
              resolveControl();
            }
          };
          document.addEventListener("securitypolicyviolation", onViolation);

          const appendImage = (src: string) => {
            const image = document.createElement("img");
            image.src = src;
            image.width = 1;
            image.height = 1;
            image.style.position = "fixed";
            image.style.opacity = "0";
            image.setAttribute("data-iss-10402-probe", "true");
            document.body.append(image);
            return image;
          };
          // Both requests are initiated under the same policy in the same
          // document; the allowed one goes first so a violation for it would be
          // recorded no later than the control's.
          const allowedImage = appendImage(allowedUrl);
          const blockedImage = appendImage(blockedUrl);

          const timedOut = Symbol("timeout");
          const raced = await Promise.race([
            controlSeen.then(() => "fired" as const),
            new Promise((resolve) => setTimeout(resolve, timeoutMs)).then(
              () => timedOut
            ),
          ]);
          // One more frame so a same-tick violation for the allowed URL, had the
          // policy been wrong, has certainly been delivered before we read.
          await new Promise((resolve) =>
            requestAnimationFrame(() => resolve(null))
          );

          document.removeEventListener("securitypolicyviolation", onViolation);
          allowedImage.remove();
          blockedImage.remove();
          return { controlFired: raced === "fired", violations };
        },
        {
          allowedUrl: ALLOWED_AVATAR_URL,
          blockedUrl: BLOCKED_IMAGE_URL,
          timeoutMs: CSP_VIOLATION_TIMEOUT_MS,
        }
      );

      // POSITIVE CONTROL. Without this the assertion below is satisfied by a
      // renderer that never received a CSP at all.
      expect(
        probe.controlFired,
        `the disallowed origin ${BLOCKED_IMAGE_URL} must raise a CSP violation; saw ${JSON.stringify(probe.violations)}`
      ).toBe(true);
      expect(
        probe.violations.map((violation) => violation.effectiveDirective)
      ).toContain("img-src");

      // THE REGRESSION. Before ISS-10402 `img-src` carried no remote origin, so
      // the Clerk avatar raised a violation here and no avatar rendered anywhere
      // in the app.
      expect(
        probe.violations.filter((violation) =>
          violation.blockedURI.startsWith("https://img.clerk.com")
        ),
        "the Clerk avatar host must not be blocked by the packaged policy"
      ).toEqual([]);

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
