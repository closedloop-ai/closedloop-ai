/**
 * ISS-7665. `bootstrap/claim` is unauthenticated and had no test file at all,
 * so ISS-7565's 64 KiB handshake cap on it was unpinned: nothing failed if the
 * bound were dropped or if the read went back to buffering the whole body
 * before measuring it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  countedEndlessBody,
  maxPullForHandshakeCap,
  streamRequest,
} from "@/__tests__/utils/bounded-body.test-helpers";
import { DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES } from "@/app/desktop/route-helpers";

const mocks = vi.hoisted(() => ({ getAttempt: vi.fn() }));

vi.mock("@/app/desktop/onboarding-attempt/service", () => ({
  desktopOnboardingAttemptsService: { get: mocks.getAttempt },
}));

// Origin trust is env-driven and orthogonal to the body cap under test.
vi.mock("@/lib/auth/canonical-trusted-origin", () => ({
  canonicalizeTrustedOrigin: (origin: string) => origin,
}));

import { POST } from "./route";

const CLAIM_URL = "https://api.test/desktop/bootstrap/claim";
const GATEWAY_ID = "33333333-3333-4333-8333-333333333333";
const WEB_APP_ORIGIN = "https://app.test";

describe("POST /desktop/bootstrap/claim body cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAttempt.mockResolvedValue(null);
  });

  it("cancels an over-cap body instead of buffering it", async () => {
    const endless = countedEndlessBody();

    const response = await POST(streamRequest(CLAIM_URL, endless.body));

    expect(endless.cancelled()).toBe(true);
    expect(endless.bytesPulled()).toBeLessThanOrEqual(maxPullForHandshakeCap());
    expect(mocks.getAttempt).not.toHaveBeenCalled();
    // The desktop contract envelope, not a 413 — this route reports a refused
    // body as an invalid claim request, the same as its nine sibling handshake
    // routes. Pinned so the shape cannot drift silently.
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_BOOTSTRAP_CLAIM_REQUEST",
      retryable: false,
    });
  });

  it("still reads the largest body its own validator accepts", async () => {
    // The paired arm: without it, a route that refused every body would pass
    // the cancellation case above. This is the real do-no-harm statement — the
    // cap cannot refuse any body this endpoint can legitimately accept.
    const body = largestSchemaValidClaimBody();
    expect(Buffer.byteLength(body)).toBeLessThan(
      DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES
    );

    const response = await POST(
      new Request(CLAIM_URL, { method: "POST", body })
    );

    // The 255-char id proves the whole body was read and parsed, not truncated.
    expect(mocks.getAttempt).toHaveBeenCalledWith("a".repeat(255));
    await expect(response.json()).resolves.not.toMatchObject({
      code: "INVALID_BOOTSTRAP_CLAIM_REQUEST",
    });
  });
});

/**
 * The variable-length fields of the `.strict()` claim validator at their
 * declared maxima: `onboardingAttemptId` 255 and `gatewayPublicKey` 16,384.
 * (`webAppOrigin` stays a real origin — it is canonicalized, not padded.) An
 * unparseable legacy `gatewayPublicKey` degrades to a null binding rather than
 * erroring, so this reaches the attempt lookup.
 */
function largestSchemaValidClaimBody(): string {
  return JSON.stringify({
    gatewayId: GATEWAY_ID,
    gatewayPublicKey: "k".repeat(16_384),
    onboardingAttemptId: "a".repeat(255),
    webAppOrigin: WEB_APP_ORIGIN,
  });
}
