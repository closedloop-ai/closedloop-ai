import {
  DesktopAnalyticsAckReason,
  DesktopAnalyticsAttributionModel,
  DesktopAnalyticsEventName,
} from "@repo/api/src/types/desktop-analytics";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DesktopAnalyticsCaptureInput,
  type DesktopAnalyticsHandlerContext,
  DesktopAnalyticsRateLimiter,
  handleDesktopAnalyticsEvent,
  handleDesktopAnalyticsPreAuthEvent,
} from "../desktop-analytics-handler";

vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createLogMockModule();
});

// apps/api sets no global mock reset, so the module-scoped log spy accumulates
// across every case in this file.
beforeEach(() => {
  vi.mocked(log.warn).mockReset();
});

const baseContext: DesktopAnalyticsHandlerContext = {
  organizationId: "org-1",
  userId: "user_db_1",
  clerkUserId: "clerk_user_1",
  targetId: "target-1",
  pluginVersion: "1.0.0",
};

const validPayload = {
  event: "command_completed",
  occurredAt: "2026-05-12T00:00:00.000Z",
  properties: {
    command_id: "cmd-1",
    operation_type: "GENERATE_PRD",
    latency_ms: 123,
  },
};

describe("handleDesktopAnalyticsEvent", () => {
  // PRD-736 P1: the `desktop-server-analytics-relay` flag is retired, so the
  // lane is always on. A valid event with only a capture sink is accepted with
  // NO feature-flag arrangement — in the pre-P1 handler this exact call went
  // through the default PostHog evaluator, which resolves `null` in this
  // unconfigured test environment and rejected the event with
  // `analytics_unavailable`, so this case fails if the flag read comes back.
  it("captures a valid event with no feature-flag dependency (always on)", async () => {
    const capture = vi.fn();

    await expect(
      handleDesktopAnalyticsEvent(validPayload, baseContext, { capture })
    ).resolves.toEqual({ accepted: true });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("forwards accepted events with server-owned identity and enrichment", async () => {
    const captures: DesktopAnalyticsCaptureInput[] = [];

    await expect(
      handleDesktopAnalyticsEvent(
        {
          ...validPayload,
          properties: {
            ...validPayload.properties,
            distinctId: "client-distinct",
            compute_target_id: "client-target",
          },
        },
        baseContext,
        {
          capture: (input) => {
            captures.push(input);
          },
        }
      )
    ).resolves.toEqual({ accepted: true });

    expect(captures).toEqual([
      {
        event: "command_completed",
        distinctId: "clerk_user_1",
        properties: {
          command_id: "cmd-1",
          operation_type: "GENERATE_PRD",
          latency_ms: 123,
          occurred_at: "2026-05-12T00:00:00.000Z",
          origin: "desktop",
          desktop_attribution_model: "gateway_owner",
          organization_id: "org-1",
          compute_target_id: "target-1",
          code_plugin_version: "1.0.0",
        },
      },
    ]);
  });

  it("accepts the exact Desktop connection-established payload with server enrichment", async () => {
    const captures: DesktopAnalyticsCaptureInput[] = [];

    await expect(
      handleDesktopAnalyticsEvent(
        {
          event: DesktopAnalyticsEventName.DesktopConnectionEstablished,
          occurredAt: "2026-05-12T00:00:00.000Z",
          properties: {
            environment: "production",
            desktop_client_version: "0.15.3",
            platform: "darwin",
          },
        },
        baseContext,
        {
          capture: (input) => {
            captures.push(input);
          },
        }
      )
    ).resolves.toEqual({ accepted: true });

    expect(captures).toEqual([
      {
        event: DesktopAnalyticsEventName.DesktopConnectionEstablished,
        distinctId: "clerk_user_1",
        properties: {
          environment: "production",
          desktop_client_version: "0.15.3",
          platform: "darwin",
          occurred_at: "2026-05-12T00:00:00.000Z",
          origin: "desktop",
          desktop_attribution_model: "gateway_owner",
          organization_id: "org-1",
          compute_target_id: "target-1",
          code_plugin_version: "1.0.0",
        },
      },
    ]);
    expect(captures[0].properties).not.toHaveProperty("desktop_id");
  });

  it("forwards Desktop agent-session sync failure analytics with server enrichment", async () => {
    const captures: DesktopAnalyticsCaptureInput[] = [];

    await expect(
      handleDesktopAnalyticsEvent(
        {
          event: DesktopAnalyticsEventName.AgentSessionSyncBatchFailed,
          occurredAt: "2026-05-12T00:00:00.000Z",
          properties: {
            reason: "ack_timeout",
            sync_mode: "backfill",
            session_count: 42,
            payload_bytes: 4096,
          },
        },
        baseContext,
        {
          capture: (input) => {
            captures.push(input);
          },
        }
      )
    ).resolves.toEqual({ accepted: true });

    expect(captures).toEqual([
      {
        event: DesktopAnalyticsEventName.AgentSessionSyncBatchFailed,
        distinctId: "clerk_user_1",
        properties: {
          reason: "ack_timeout",
          sync_mode: "backfill",
          session_count: 42,
          payload_bytes: 4096,
          occurred_at: "2026-05-12T00:00:00.000Z",
          origin: "desktop",
          desktop_attribution_model: "gateway_owner",
          organization_id: "org-1",
          compute_target_id: "target-1",
          code_plugin_version: "1.0.0",
        },
      },
    ]);
  });

  it("returns validation_failed for the rejected Desktop desktop_id property", async () => {
    const capture = vi.fn();

    await expect(
      handleDesktopAnalyticsEvent(
        {
          event: DesktopAnalyticsEventName.DesktopConnectionEstablished,
          occurredAt: "2026-05-12T00:00:00.000Z",
          properties: {
            desktop_id: "target-1",
            version: "0.15.3",
          },
        },
        baseContext,
        {
          capture,
        }
      )
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    });

    expect(capture).not.toHaveBeenCalled();
  });

  it("rejects missing Clerk identity without falling back to database userId", async () => {
    const capture = vi.fn();

    await expect(
      handleDesktopAnalyticsEvent(
        validPayload,
        { ...baseContext, clerkUserId: null },
        {
          capture,
        }
      )
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    });

    expect(capture).not.toHaveBeenCalled();
  });

  it("rate limits accepted attempts and contains forwarding failures", async () => {
    const rateLimiter = new DesktopAnalyticsRateLimiter();
    const acceptedDeps = {
      capture: vi.fn(),
      rateLimiter,
      now: () => 1000,
    };

    for (let index = 0; index < 120; index += 1) {
      await expect(
        handleDesktopAnalyticsEvent(validPayload, baseContext, acceptedDeps)
      ).resolves.toEqual({ accepted: true });
    }

    await expect(
      handleDesktopAnalyticsEvent(validPayload, baseContext, acceptedDeps)
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAnalyticsAckReason.RateLimited,
    });

    await expect(
      handleDesktopAnalyticsEvent(validPayload, baseContext, {
        capture: () => {
          throw new Error("posthog unavailable");
        },
        rateLimiter: new DesktopAnalyticsRateLimiter(),
      })
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAnalyticsAckReason.CaptureFailed,
    });
  });

  it("rate limits per org, gateway-owner Clerk user, and target key", async () => {
    const rateLimiter = new DesktopAnalyticsRateLimiter();
    const acceptedDeps = {
      capture: vi.fn(),
      rateLimiter,
      now: () => 1000,
    };
    const rateLimited = {
      accepted: false,
      reason: DesktopAnalyticsAckReason.RateLimited,
    };

    for (let index = 0; index < 120; index += 1) {
      await expect(
        handleDesktopAnalyticsEvent(validPayload, baseContext, acceptedDeps)
      ).resolves.toEqual({ accepted: true });
    }

    await expect(
      handleDesktopAnalyticsEvent(validPayload, baseContext, acceptedDeps)
    ).resolves.toEqual(rateLimited);

    // The database userId is not part of the key: the same gateway owner
    // shares the exhausted bucket.
    await expect(
      handleDesktopAnalyticsEvent(
        validPayload,
        { ...baseContext, userId: "user_db_2" },
        acceptedDeps
      )
    ).resolves.toEqual(rateLimited);

    for (const otherKeyContext of [
      { ...baseContext, organizationId: "org-2" },
      { ...baseContext, clerkUserId: "clerk_user_2" },
      { ...baseContext, targetId: "target-2" },
    ]) {
      await expect(
        handleDesktopAnalyticsEvent(validPayload, otherKeyContext, acceptedDeps)
      ).resolves.toEqual({ accepted: true });
    }
  });

  it("evicts expired and oldest rate-limit entries", () => {
    const rateLimiter = new DesktopAnalyticsRateLimiter({ maxEntries: 2 });
    const entries = (
      rateLimiter as unknown as { entries: Map<string, unknown> }
    ).entries;

    expect(rateLimiter.attempt("expired-a", 0)).toBe(true);
    expect(rateLimiter.attempt("expired-b", 0)).toBe(true);
    expect(rateLimiter.attempt("active", 60_001)).toBe(true);

    expect(entries.size).toBe(1);
    expect(entries.has("active")).toBe(true);

    expect(rateLimiter.attempt("next-a", 60_002)).toBe(true);
    expect(rateLimiter.attempt("next-b", 60_003)).toBe(true);

    expect(entries.size).toBe(2);
    expect(entries.has("active")).toBe(false);
    expect(entries.has("next-a")).toBe(true);
    expect(entries.has("next-b")).toBe(true);
  });
});

// ISS-10503 (PRD-736 D5, invariant 5): the alias handshake on the
// authenticated lane.
describe("handleDesktopAnalyticsEvent alias handshake (ISS-10503)", () => {
  const ONBOARDING_ID = "22222222-2222-4222-8222-222222222222";

  it("emits one alias and still captures under the server-resolved clerk identity", async () => {
    const capture = vi.fn();
    const alias = vi.fn();

    await expect(
      handleDesktopAnalyticsEvent(
        { ...validPayload, distinctId: ONBOARDING_ID },
        baseContext,
        { alias, capture }
      )
    ).resolves.toEqual({ accepted: true, aliased: true });

    expect(alias).toHaveBeenCalledExactlyOnceWith({
      distinctId: "clerk_user_1",
      alias: ONBOARDING_ID,
    });
    // The envelope id is the alias trigger, never the capture identity.
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ distinctId: "clerk_user_1" })
    );
  });

  it("emits no alias when the payload carries no distinct id", async () => {
    const alias = vi.fn();

    await handleDesktopAnalyticsEvent(validPayload, baseContext, {
      alias,
      capture: vi.fn(),
    });

    expect(alias).not.toHaveBeenCalled();
  });

  it("captures the event even when the alias emission throws, and logs without the id", async () => {
    const capture = vi.fn();

    await expect(
      handleDesktopAnalyticsEvent(
        { ...validPayload, distinctId: ONBOARDING_ID },
        baseContext,
        {
          alias: () => {
            throw new Error("posthog down");
          },
          capture,
        }
      )
      // PR #7768 review: the ack must SAY the alias failed, or the client
      // clears its pending-alias latch on a capture that never merged.
    ).resolves.toEqual({ accepted: true, aliased: false });

    expect(capture).toHaveBeenCalledTimes(1);
    // No-logging rule (PRD-736 decision #13): the warn names the event, never
    // the onboarding id.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls[0])).not.toContain(
      ONBOARDING_ID
    );
  });

  it("accepts a distinct-id-bearing payload when no alias sink is supplied (socket transports)", async () => {
    const capture = vi.fn();

    await expect(
      handleDesktopAnalyticsEvent(
        { ...validPayload, distinctId: ONBOARDING_ID },
        baseContext,
        { capture }
      )
    ).resolves.toEqual({ accepted: true });

    expect(capture).toHaveBeenCalledTimes(1);
  });
});

// ISS-10503 (PRD-736 D5): the pre-auth mode.
describe("handleDesktopAnalyticsPreAuthEvent (ISS-10503)", () => {
  const PRE_AUTH_ID = "33333333-3333-4333-9333-333333333333";
  const preAuthPayload = {
    event: DesktopAnalyticsEventName.FlowStarted,
    occurredAt: "2026-09-22T00:00:00.000Z",
    properties: { flow_id: PRE_AUTH_ID, surface: "desktop" },
    distinctId: PRE_AUTH_ID,
  };

  it("captures under the client-supplied distinct id with pre-auth attribution and no authenticated enrichment", async () => {
    const captures: DesktopAnalyticsCaptureInput[] = [];

    await expect(
      handleDesktopAnalyticsPreAuthEvent(preAuthPayload, {
        capture: (input) => {
          captures.push(input);
        },
      })
    ).resolves.toEqual({ accepted: true });

    expect(captures).toHaveLength(1);
    expect(captures[0]?.distinctId).toBe(PRE_AUTH_ID);
    expect(captures[0]?.properties).toMatchObject({
      desktop_attribution_model:
        DesktopAnalyticsAttributionModel.PreAuthDistinctId,
      origin: "desktop",
      occurred_at: preAuthPayload.occurredAt,
    });
    expect(captures[0]?.properties).not.toHaveProperty("organization_id");
    expect(captures[0]?.properties).not.toHaveProperty("compute_target_id");
    expect(captures[0]?.properties).not.toHaveProperty("gateway_session_id");
  });

  it("rejects a payload without a distinct id, logging without one", async () => {
    const capture = vi.fn();
    const { distinctId: _omitted, ...withoutDistinctId } = preAuthPayload;

    await expect(
      handleDesktopAnalyticsPreAuthEvent(withoutDistinctId, { capture })
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    });

    expect(capture).not.toHaveBeenCalled();
  });

  it("rejects a distinct id that is a UUID but not v4", async () => {
    const capture = vi.fn();

    await expect(
      handleDesktopAnalyticsPreAuthEvent(
        {
          ...preAuthPayload,
          distinctId: "11111111-1111-1111-8111-111111111111",
        },
        { capture }
      )
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAnalyticsAckReason.ValidationFailed,
    });

    expect(capture).not.toHaveBeenCalled();
  });

  // PR #7768 review: a per-id window alone is no flood bound — minted ids each
  // open a new window — so a per-instance GLOBAL window backstops it (the edge
  // rate limit is per IP; deny rule off). Two DIFFERENT ids share this budget.
  it("bounds pre-auth spend across all distinct ids with the global window", async () => {
    const globalRateLimiter = new DesktopAnalyticsRateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
    });
    const deps = { capture: vi.fn(), globalRateLimiter, now: () => 1000 };
    const otherId = "44444444-4444-4444-a444-444444444444";

    await expect(
      handleDesktopAnalyticsPreAuthEvent(preAuthPayload, deps)
    ).resolves.toEqual({ accepted: true });
    await expect(
      handleDesktopAnalyticsPreAuthEvent(
        { ...preAuthPayload, distinctId: otherId },
        deps
      )
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAnalyticsAckReason.RateLimited,
    });
    expect(deps.capture).toHaveBeenCalledTimes(1);
  });

  // If the budget were global (or keyed on anything but the distinct id), the
  // second id's first event would be refused here — the two-key fixture is
  // what tells a per-id window from a shared one.
  it("rate-limits per distinct id, not globally", async () => {
    const rateLimiter = new DesktopAnalyticsRateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
    });
    const deps = { capture: vi.fn(), now: () => 1000, rateLimiter };
    const otherId = "44444444-4444-4444-a444-444444444444";

    await expect(
      handleDesktopAnalyticsPreAuthEvent(preAuthPayload, deps)
    ).resolves.toEqual({ accepted: true });
    await expect(
      handleDesktopAnalyticsPreAuthEvent(preAuthPayload, deps)
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAnalyticsAckReason.RateLimited,
    });
    await expect(
      handleDesktopAnalyticsPreAuthEvent(
        { ...preAuthPayload, distinctId: otherId },
        deps
      )
    ).resolves.toEqual({ accepted: true });
  });
});
