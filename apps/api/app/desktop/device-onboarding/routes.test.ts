import { generateKeyPairSync } from "node:crypto";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  desktopDeviceOnboardingService: {
    start: vi.fn(),
    poll: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
    getByUserCode: vi.fn(),
  },
  evaluateDesktopManagedPopEnforcement: vi.fn(),
  resolveSessionUser: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
  },
  scheduleLogFlush: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({ log: mocks.log }));
vi.mock("@/lib/route-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/route-utils")>()),
  scheduleLogFlush: mocks.scheduleLogFlush,
}));

vi.mock("./service", () => ({
  desktopDeviceOnboardingService: mocks.desktopDeviceOnboardingService,
}));

// Partial: the route reads `DesktopManagedFeatureFlagOutcome` as a runtime
// value, so the real const object has to survive the mock or every branch
// compares against `undefined`.
vi.mock("@/lib/auth/desktop-managed-pop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/desktop-managed-pop")>()),
  evaluateDesktopManagedPopEnforcement:
    mocks.evaluateDesktopManagedPopEnforcement,
}));

vi.mock("@/lib/auth/session-user", () => ({
  resolveSessionUser: mocks.resolveSessionUser,
}));

import {
  countedEndlessBody,
  maxPullForHandshakeCap,
  streamRequest,
} from "@/__tests__/utils/bounded-body.test-helpers";
import {
  oneDesktopConnectRejection,
  readDesktopConnectRejection,
} from "@/__tests__/utils/desktop-connect-rejected.test-helpers";
import {
  stubTrustedOriginEnv,
  TRUSTED_APP_ORIGIN,
  UNTRUSTED_ORIGIN,
} from "@/__tests__/utils/trusted-origin.test-helpers";
import { desktopConnectRejectionThrottle } from "@/app/desktop/contract";
import { DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES } from "@/app/desktop/route-helpers";
import { DesktopManagedFeatureFlagOutcome } from "@/lib/auth/desktop-managed-pop";
import { REQUEST_BODY_OVER_CAP_EVENT } from "@/lib/route-utils";
import { POST as approvePOST } from "./approve/route";
import { POST as pollPOST } from "./poll/route";
import { GET as sessionGET } from "./session/route";
import { POST as startPOST } from "./start/route";

const gatewayId = "019dd545-b11d-444d-9956-0310752e2481";
const deviceSessionId = "019dd545-9926-7447-99fe-2671bf53acb1";

function publicKeyPem(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  return publicKey.export({ format: "pem", type: "spki" }).toString();
}

function jsonRequest(body: unknown, headers?: HeadersInit): Request {
  return new Request("https://api.closedloop.ai/desktop/device-onboarding", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function startBody(overrides: Record<string, unknown> = {}) {
  return {
    webAppOrigin: TRUSTED_APP_ORIGIN,
    gatewayId,
    gatewayPublicKeyPem: publicKeyPem(),
    machineName: "Daveth-MBP",
    platform: "darwin",
    desktopVersion: "0.13.22",
    desktopSecurityUpgradeProtocolVersion: 1,
    ...overrides,
  };
}

const DEVICE_ONBOARDING_URL =
  "https://api.closedloop.ai/desktop/device-onboarding";
const SESSION_LOOKUP_URL = `${DEVICE_ONBOARDING_URL}/session`;

// Written independently of the constant on purpose: the streaming test sizes
// its safety ceiling and its assertion bound FROM the cap, so without this pin
// widening the cap would move the bound and its own proof together.
describe("DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES", () => {
  it("pins the desktop handshake cap at 64 KiB", () => {
    expect(DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES).toBe(65_536);
  });
});

describe("Desktop device-onboarding route contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubTrustedOriginEnv();
    desktopConnectRejectionThrottle.clear();
    mocks.evaluateDesktopManagedPopEnforcement.mockResolvedValue(
      DesktopManagedFeatureFlagOutcome.Enabled
    );
    mocks.resolveSessionUser.mockResolvedValue({
      clerkUserId: "clerk-user-1",
      user: {
        id: "user-1",
        organizationId: "org-1",
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ISS-7565: `start` reads its body before ANY auth runs, so an anonymous
  // caller decides what gets buffered. The refusal STATUS cannot prove the cap
  // — this route's `.strict()` schema returns the same 400 for an over-long
  // field — so the assertion is on the only thing the cap changes: how much of
  // the stream the route pulls before it gives up.
  it("stops pulling an oversized start body instead of buffering it", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {
      // silence
    });
    const stream = countedEndlessBody();

    const response = await startPOST(
      streamRequest(DEVICE_ONBOARDING_URL, stream.body)
    );

    // Cancellation is what proves the cap fired; the envelope assertion is what
    // proves an already-installed Desktop build still sees the code it handles.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_DEVICE_SESSION_REQUEST",
      retryable: false,
    });
    expect(stream.cancelled()).toBe(true);
    expect(stream.bytesPulled()).toBeLessThanOrEqual(maxPullForHandshakeCap());
    expect(mocks.desktopDeviceOnboardingService.start).not.toHaveBeenCalled();
    // These routes deliberately keep their own 400 envelope, so the log is the
    // ONLY thing that tells a firing cap apart from an ordinary bad request.
    expect(warn).toHaveBeenCalledWith(
      REQUEST_BODY_OVER_CAP_EVENT,
      expect.objectContaining({ maxBytes: DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES })
    );
  });

  it("rejects a non-allowlisted webAppOrigin without starting a device session", async () => {
    // This route has no Origin-header comparison at all, so the allowlist is
    // the only thing between an attacker-supplied webAppOrigin and a persisted
    // device session. The body is otherwise valid — the paired test below sends
    // the same shape with an allowlisted origin and reaches the service — so
    // the 400 cannot be blamed on schema validation or a bad public key.
    const response = await startPOST(
      jsonRequest(startBody({ webAppOrigin: UNTRUSTED_ORIGIN }))
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_DEVICE_SESSION_REQUEST",
      retryable: false,
    });
    expect(mocks.desktopDeviceOnboardingService.start).not.toHaveBeenCalled();
  });

  it("starts a device session for an allowlisted webAppOrigin", async () => {
    mocks.desktopDeviceOnboardingService.start.mockResolvedValue({
      status: "rate_limited",
    });

    const response = await startPOST(jsonRequest(startBody()));

    expect(response.status).toBe(429);
    expect(mocks.desktopDeviceOnboardingService.start).toHaveBeenCalledWith(
      expect.objectContaining({ webAppOrigin: TRUSTED_APP_ORIGIN })
    );
  });

  // PLN-2216 T-3.4: installed and new Desktops send this field, and the schema
  // is `.strict()` with a required literal, so dropping or retyping it on either
  // side turns every device onboarding into a 400.
  it("accepts a start payload carrying desktopSecurityUpgradeProtocolVersion", async () => {
    mocks.desktopDeviceOnboardingService.start.mockResolvedValue({
      status: "started",
      deviceSessionId,
      deviceSessionSecret: "secret",
      userCode: "ABCD1234",
      verificationUrl: `${TRUSTED_APP_ORIGIN}/desktop/connect`,
      expiresAt: new Date("2026-10-22T12:00:00.000Z"),
      pollIntervalSeconds: 5,
    });

    const response = await startPOST(
      jsonRequest(startBody({ desktopSecurityUpgradeProtocolVersion: 1 }))
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deviceSessionId,
      userCode: "ABCD1234",
    });
    expect(mocks.desktopDeviceOnboardingService.start).toHaveBeenCalledWith(
      expect.objectContaining({ desktopSecurityUpgradeProtocolVersion: 1 })
    );
  });

  it.each([
    ["omits", undefined],
    ["sends an unknown", 2],
  ])(
    "rejects a start payload that %s desktopSecurityUpgradeProtocolVersion",
    async (_label, desktopSecurityUpgradeProtocolVersion) => {
      const response = await startPOST(
        jsonRequest(startBody({ desktopSecurityUpgradeProtocolVersion }))
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        code: "INVALID_DEVICE_SESSION_REQUEST",
        retryable: false,
      });
      expect(mocks.desktopDeviceOnboardingService.start).not.toHaveBeenCalled();
    }
  );

  it("returns an exact retryable rate-limit contract on start", async () => {
    mocks.desktopDeviceOnboardingService.start.mockResolvedValue({
      status: "rate_limited",
    });

    const response = await startPOST(
      jsonRequest(
        {
          webAppOrigin: "http://localhost:3000",
          gatewayId,
          gatewayPublicKeyPem: publicKeyPem(),
          machineName: "Daveth-MBP",
          platform: "darwin",
          desktopVersion: "0.13.22",
          desktopSecurityUpgradeProtocolVersion: 1,
        },
        { "x-forwarded-for": "203.0.113.10, 10.0.0.1" }
      )
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      code: "DEVICE_SESSION_RATE_LIMITED",
      retryable: true,
    });
    expect(mocks.desktopDeviceOnboardingService.start).toHaveBeenCalledWith(
      expect.objectContaining({ requestIp: "203.0.113.10" })
    );
  });

  it("returns an exact retryable poll failure when persistence throws", async () => {
    mocks.desktopDeviceOnboardingService.poll.mockRejectedValue(
      new Error("database unavailable")
    );

    const response = await pollPOST(
      jsonRequest({
        deviceSessionId,
        deviceSessionSecret: "secret",
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "DEVICE_SESSION_POLL_FAILED",
      retryable: true,
    });
  });

  it("returns an exact retryable approval failure when persistence throws", async () => {
    mocks.desktopDeviceOnboardingService.approve.mockRejectedValue(
      new Error("database unavailable")
    );

    const response = await approvePOST(
      jsonRequest({
        userCode: "ABCD1234",
        action: "approve",
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "DEVICE_SESSION_APPROVAL_FAILED",
      retryable: true,
    });
  });

  it("returns an exact retryable deny failure when persistence throws", async () => {
    mocks.desktopDeviceOnboardingService.deny.mockRejectedValue(
      new Error("database unavailable")
    );

    const response = await approvePOST(
      jsonRequest({
        userCode: "ABCD1234",
        action: "deny",
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "DEVICE_SESSION_APPROVAL_FAILED",
      retryable: true,
    });
    expect(mocks.desktopDeviceOnboardingService.deny).toHaveBeenCalledWith({
      userCode: "ABCD1234",
      organizationId: "org-1",
      userId: "user-1",
    });
  });

  it("returns only non-secret presentation fields from the session lookup", async () => {
    const createdAt = new Date("2026-06-26T18:40:00.000Z");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    mocks.desktopDeviceOnboardingService.getByUserCode = vi
      .fn()
      .mockResolvedValue({
        id: deviceSessionId,
        userCode: "ABCD1234",
        machineName: "Daveth-MBP",
        platform: "darwin",
        webAppOrigin: "https://app.closedloop.ai",
        status: "pending",
        createdAt,
        expiresAt,
        // Secret/internal columns that must never reach the browser.
        deviceSessionSecretHash: "hash-should-never-be-returned",
        gatewayPublicKeyPem: "-----BEGIN PUBLIC KEY-----",
        onboardingAttemptId: "attempt-should-never-be-returned",
        requestIpHash: "ip-should-never-be-returned",
      });

    const response = await sessionGET(
      new Request(
        "https://api.closedloop.ai/desktop/device-onboarding/session?code=ABCD1234"
      )
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      userCode: "ABCD1234",
      machineName: "Daveth-MBP",
      platform: "darwin",
      webAppOrigin: "https://app.closedloop.ai",
      status: "pending",
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    const serialized = JSON.stringify(body);
    for (const secret of [
      "hash-should-never-be-returned",
      // PEM sentinel value (catches a leak even under a renamed field) plus
      // the field name as a secondary guard.
      "-----BEGIN PUBLIC KEY-----",
      "gatewayPublicKeyPem",
      "attempt-should-never-be-returned",
      "ip-should-never-be-returned",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("returns an exact retryable session lookup failure when persistence throws", async () => {
    mocks.desktopDeviceOnboardingService.getByUserCode = vi
      .fn()
      .mockRejectedValue(new Error("database unavailable"));

    const response = await sessionGET(
      new Request(
        "https://api.closedloop.ai/desktop/device-onboarding/session?code=ABCD1234"
      )
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "DEVICE_SESSION_LOOKUP_FAILED",
      retryable: true,
    });
  });

  it("blocks approval before mutation when the rollout flag is disabled", async () => {
    mocks.evaluateDesktopManagedPopEnforcement.mockResolvedValue(
      DesktopManagedFeatureFlagOutcome.Disabled
    );

    const response = await approvePOST(
      jsonRequest({
        userCode: "ABCD1234",
        action: "approve",
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      code: "DESKTOP_SECURITY_UPGRADE_DISABLED",
      retryable: false,
    });
    expect(mocks.desktopDeviceOnboardingService.approve).not.toHaveBeenCalled();
  });

  // ISS-8132 BUG 2. The fail-closed refusal is unchanged — a flag provider the
  // route could not reach still blocks the approval. What changed is that it no
  // longer shares the DISABLED arm's non-retryable 403: the browser reads 403
  // as a terminal "forbidden" state and stops offering the button, so a PostHog
  // blip used to end the connect flow org-wide. The paired 403 case above is
  // what makes this a distinction and not just a status change.
  it("answers a retryable failure, not a permanent refusal, when the rollout flag cannot be evaluated", async () => {
    mocks.evaluateDesktopManagedPopEnforcement.mockResolvedValue(
      DesktopManagedFeatureFlagOutcome.Faulted
    );

    const response = await approvePOST(
      jsonRequest({
        userCode: "ABCD1234",
        action: "approve",
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "DEVICE_SESSION_APPROVAL_FAILED",
      retryable: true,
    });
    expect(mocks.desktopDeviceOnboardingService.approve).not.toHaveBeenCalled();
    // `cause` is what stops the counter reading a provider outage as a
    // confirmed approval failure — the wire code cannot tell them apart.
    expect(readDesktopConnectRejection(mocks.log.warn)).toEqual(
      oneDesktopConnectRejection({
        reason: "DEVICE_SESSION_APPROVAL_FAILED",
        stage: "device_onboarding_approve",
        orgId: "org-1",
        cause: "feature_flag_lookup_faulted",
      })
    );
  });

  // ISS-8132. `deny` is deliberately NOT gated on the rollout flag, so a
  // provider fault must not reach the approve arm's 503 and block a user from
  // refusing a device they do not recognise.
  it("denies a device without consulting the rollout flag", async () => {
    mocks.evaluateDesktopManagedPopEnforcement.mockResolvedValue(
      DesktopManagedFeatureFlagOutcome.Faulted
    );
    mocks.desktopDeviceOnboardingService.deny.mockResolvedValue({
      status: "denied",
      machineName: "Daveth-MBP",
      platform: "darwin",
      webAppOrigin: TRUSTED_APP_ORIGIN,
    });

    const response = await approvePOST(
      jsonRequest({ userCode: "ABCD1234", action: "deny" })
    );

    expect(response.status).toBe(200);
    expect(mocks.evaluateDesktopManagedPopEnforcement).not.toHaveBeenCalled();
    expect(mocks.desktopDeviceOnboardingService.deny).toHaveBeenCalledWith({
      userCode: "ABCD1234",
      organizationId: "org-1",
      userId: "user-1",
    });
  });

  // ISS-8132 items 3 & 4. The suite's `beforeEach` installs a session for every
  // other case, so `resolveSessionUser` had never returned null OR rejected in
  // either route — the only authorization gate on both was unexecuted. The
  // rejecting row matters on its own: `.catch(() => null)` turns a Clerk outage
  // into a NON-retryable 401, which is the shape ISS-7974 fixed on the sibling
  // `/desktop/authorize` route. Pinned as-is here, not fixed — see the PR.
  const unauthenticatedSessions = [
    {
      name: "signed out",
      arrange: () => mocks.resolveSessionUser.mockResolvedValue(null),
    },
    {
      name: "the auth provider is down",
      arrange: () =>
        mocks.resolveSessionUser.mockRejectedValue(new Error("clerk down")),
    },
  ];

  it.each(unauthenticatedSessions)(
    "refuses approve without touching the device session when $name",
    async ({ arrange }) => {
      arrange();

      const response = await approvePOST(
        jsonRequest({ userCode: "ABCD1234", action: "approve" })
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        code: "SESSION_REQUIRED",
        retryable: false,
      });
      expect(
        mocks.desktopDeviceOnboardingService.approve
      ).not.toHaveBeenCalled();
      expect(mocks.desktopDeviceOnboardingService.deny).not.toHaveBeenCalled();
    }
  );

  it.each(unauthenticatedSessions)(
    "refuses the session lookup without reading the device session when $name",
    async ({ arrange }) => {
      arrange();
      mocks.desktopDeviceOnboardingService.getByUserCode = vi.fn();

      const response = await sessionGET(
        new Request(`${SESSION_LOOKUP_URL}?code=ABCD1234`)
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        code: "SESSION_REQUIRED",
        retryable: false,
      });
      // The load-bearing half: this route returns machineName / platform /
      // webAppOrigin for any code, so the auth gate is the only thing stopping
      // an unauthenticated caller enumerating device sessions.
      expect(
        mocks.desktopDeviceOnboardingService.getByUserCode
      ).not.toHaveBeenCalled();
    }
  );

  // ISS-8132 item 5. This 404 is the wire-facing consequence of EVERY service
  // null — expired, already-claimed, denied, or unknown code — and neither
  // action reached it. Its 503 sibling has a test for both.
  it.each(["approve", "deny"] as const)(
    "maps a null %s result to the not-found contract",
    async (action) => {
      mocks.desktopDeviceOnboardingService[action].mockResolvedValue(null);

      const response = await approvePOST(
        jsonRequest({ userCode: "ABCD1234", action })
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        code: "DEVICE_SESSION_NOT_FOUND",
        retryable: false,
      });
    }
  );

  // ISS-8132 item 10. `DEVICE_SESSION_INVALID` appears in exactly one other
  // test in the repo, a desktop-side fixture that hand-writes the response — so
  // the server arm producing it was unreached and the two could drift apart
  // with both suites green. The null-vs-undefined discrimination is the point:
  // collapse them and a wrong secret becomes a retryable 503 the desktop
  // retries forever.
  //
  // Scoped deliberately to that MAPPING: `poll` is mocked here, so this says
  // nothing about which inputs make the service return null. The service's
  // secret-hash predicate is pinned in `service.test.ts`.
  it("maps a null poll result to a non-retryable invalid", async () => {
    mocks.desktopDeviceOnboardingService.poll.mockResolvedValue(null);

    const response = await pollPOST(
      jsonRequest({ deviceSessionId, deviceSessionSecret: "wrong" })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      code: "DEVICE_SESSION_INVALID",
      retryable: false,
    });
  });

  // ISS-8132 item 11. `INVALID_DEVICE_SESSION_APPROVAL` was asserted nowhere in
  // the repo. Both rows reach the same branch through different schema rules.
  const invalidApprovalBodies = [
    {
      name: "the user code is shorter than the minimum",
      body: { userCode: "AB", action: "approve" },
    },
    {
      name: "the action is outside the enum",
      body: { userCode: "ABCD1234", action: "revoke" },
    },
  ];

  it.each(invalidApprovalBodies)(
    "rejects the approval body when $name",
    async ({ body }) => {
      const response = await approvePOST(jsonRequest(body));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        code: "INVALID_DEVICE_SESSION_APPROVAL",
        retryable: false,
      });
      expect(
        mocks.desktopDeviceOnboardingService.approve
      ).not.toHaveBeenCalled();
      expect(mocks.desktopDeviceOnboardingService.deny).not.toHaveBeenCalled();
    }
  );

  // ISS-8132 item 11. `approve` was the one handshake route in this group with
  // no body-cap test. It resolves the Clerk session BEFORE reading the body, so
  // unlike `start` and `poll` the cap here bounds what an AUTHENTICATED caller
  // can make the route buffer — the case `route-helpers.ts` calls out.
  it("stops pulling an oversized approval body instead of buffering it", async () => {
    const stream = countedEndlessBody();

    const response = await approvePOST(
      streamRequest(DEVICE_ONBOARDING_URL, stream.body)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_DEVICE_SESSION_APPROVAL",
      retryable: false,
    });
    expect(stream.cancelled()).toBe(true);
    // cap + TWO chunks, not one: awaiting the session gives the stream's pull
    // loop an extra turn before the reader consumes, so a further 16 KiB chunk
    // is already queued. Same bound `/desktop/authorize`'s mint test uses.
    expect(stream.bytesPulled()).toBeLessThanOrEqual(maxPullForHandshakeCap(2));
    expect(mocks.desktopDeviceOnboardingService.approve).not.toHaveBeenCalled();
    // The 400 envelope is shared with an ordinary bad body, so the log is the
    // only thing that tells a firing cap apart from schema rejection.
    expect(mocks.log.warn).toHaveBeenCalledWith(
      REQUEST_BODY_OVER_CAP_EVENT,
      expect.objectContaining({ maxBytes: DESKTOP_HANDSHAKE_REQUEST_MAX_BYTES })
    );
  });

  // ISS-8132 item 11. The existing body-cap test for this route asserts status
  // only; the envelope is what proves an already-installed Desktop build still
  // sees the code it handles, which is why `start`'s cap test asserts it.
  it("rejects a malformed poll body with the exact invalid-poll contract", async () => {
    const response = await pollPOST(
      jsonRequest({ deviceSessionId: "not-a-uuid", deviceSessionSecret: "s" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "INVALID_DEVICE_SESSION_POLL",
      retryable: false,
    });
    expect(mocks.desktopDeviceOnboardingService.poll).not.toHaveBeenCalled();
  });

  // ISS-8132 item 11. The whitespace row is the one worth having: `?.trim()
  // .toUpperCase()` on whitespace yields "", and only the falsy check stops a
  // `findUnique({ where: { userCode: "" } })`.
  const invalidLookupCodes = [
    { name: "the code parameter is absent", query: "" },
    { name: "the code parameter is only whitespace", query: "?code=%20%20" },
  ];

  it.each(invalidLookupCodes)(
    "rejects the session lookup without querying when $name",
    async ({ query }) => {
      mocks.desktopDeviceOnboardingService.getByUserCode = vi.fn();

      const response = await sessionGET(
        new Request(`${SESSION_LOOKUP_URL}${query}`)
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        code: "INVALID_DEVICE_SESSION_CODE",
        retryable: false,
      });
      expect(
        mocks.desktopDeviceOnboardingService.getByUserCode
      ).not.toHaveBeenCalled();
    }
  );

  // ISS-8132 item 11. Both arms of `(!row || row.expiresAt <= new Date())`.
  // The expired arm is the only place the browser approval page learns the code
  // timed out — it decides what a real user sees after leaving the tab open
  // past the 10-minute TTL. The suite covered only the 200 and the 503.
  const missingLookupRows = [
    { name: "no device session matches the code", row: null },
    {
      name: "the matching device session has expired",
      row: {
        userCode: "ABCD1234",
        machineName: "Daveth-MBP",
        platform: "darwin",
        webAppOrigin: TRUSTED_APP_ORIGIN,
        status: "pending",
        createdAt: new Date("2026-06-26T18:40:00.000Z"),
        expiresAt: new Date(Date.now() - 60_000),
      },
    },
  ];

  it.each(missingLookupRows)(
    "returns the not-found contract when $name",
    async ({ row }) => {
      mocks.desktopDeviceOnboardingService.getByUserCode = vi
        .fn()
        .mockResolvedValue(row);

      const response = await sessionGET(
        new Request(`${SESSION_LOOKUP_URL}?code=ABCD1234`)
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        code: "DEVICE_SESSION_NOT_FOUND",
        retryable: false,
      });
    }
  );

  // ISS-8132 item 12, wire half. `startRejectionBranches` below pins the
  // telemetry for this branch; this pins the body an installed Desktop parses.
  it("returns the exact retryable persist-failure contract on start", async () => {
    mocks.desktopDeviceOnboardingService.start.mockRejectedValue(
      new Error("database unavailable")
    );

    const response = await startPOST(jsonRequest(startBody()));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: "DEVICE_SESSION_PERSIST_FAILED",
      retryable: true,
    });
  });
});

// `poll` is the other pre-auth device-onboarding route; `start` is covered above.
describe("POST /desktop/device-onboarding/poll body cap", () => {
  it("stops pulling an oversized body instead of buffering it", async () => {
    const stream = countedEndlessBody();

    const response = await pollPOST(
      streamRequest(DEVICE_ONBOARDING_URL, stream.body)
    );

    expect(response.status).toBe(400);
    expect(stream.cancelled()).toBe(true);
    expect(stream.bytesPulled()).toBeLessThanOrEqual(maxPullForHandshakeCap());
  });
});

/**
 * ISS-6343. Each row drives ONE rejection branch of the production handler and
 * pins the reason it reports. The reason/stage strings are written here
 * independently of the route so a swapped or dropped constant reddens a row.
 */
const startRejectionBranches = [
  {
    name: "the body fails schema validation",
    arrange: () => {
      // no service behavior needed — the route rejects before calling it
    },
    request: () => jsonRequest({}),
    status: 400,
    fields: {
      reason: "INVALID_DEVICE_SESSION_REQUEST",
      stage: "device_onboarding_start",
    },
  },
  {
    name: "the webAppOrigin is not allowlisted",
    arrange: () => {
      // no service behavior needed — the route rejects before calling it
    },
    request: () => jsonRequest(startBody({ webAppOrigin: UNTRUSTED_ORIGIN })),
    status: 400,
    fields: {
      reason: "INVALID_DEVICE_SESSION_REQUEST",
      stage: "device_onboarding_start",
    },
  },
  {
    name: "the start is rate limited",
    arrange: () => {
      mocks.desktopDeviceOnboardingService.start.mockResolvedValue({
        status: "rate_limited",
      });
    },
    request: () => jsonRequest(startBody()),
    status: 429,
    fields: {
      reason: "DEVICE_SESSION_RATE_LIMITED",
      stage: "device_onboarding_start",
    },
  },
  {
    name: "device session persistence throws",
    arrange: () => {
      mocks.desktopDeviceOnboardingService.start.mockRejectedValue(
        new Error("database unavailable")
      );
    },
    request: () => jsonRequest(startBody()),
    status: 503,
    fields: {
      reason: "DEVICE_SESSION_PERSIST_FAILED",
      stage: "device_onboarding_start",
    },
  },
];

describe("POST /desktop/device-onboarding/start rejection telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubTrustedOriginEnv();
    desktopConnectRejectionThrottle.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(startRejectionBranches)(
    "reports $fields.reason when $name",
    async ({ arrange, request, status, fields }) => {
      arrange();

      const response = await startPOST(request());

      // Pins that the intended branch ran, not some other rejection.
      expect(response.status).toBe(status);
      expect(readDesktopConnectRejection(mocks.log.warn)).toEqual(
        oneDesktopConnectRejection(fields)
      );
    }
  );

  it("reports nothing when the device session starts", async () => {
    mocks.desktopDeviceOnboardingService.start.mockResolvedValue({
      status: "started",
      deviceSessionId,
      deviceSessionSecret: "secret",
      userCode: "ABCD1234",
      verificationUrl: `${TRUSTED_APP_ORIGIN}/desktop/connect`,
      expiresAt: new Date("2026-06-29T12:15:00.000Z"),
      pollIntervalSeconds: 2,
    });

    const response = await startPOST(jsonRequest(startBody()));

    expect(response.status).toBe(200);
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });
});
