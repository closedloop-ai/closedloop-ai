import {
  DESKTOP_SERVER_ANALYTICS_RELAY_FLAG,
  DesktopAnalyticsAckReason,
  DesktopAnalyticsEventName,
} from "@repo/api/src/types/desktop-analytics";
import { describe, expect, it, vi } from "vitest";
import {
  type DesktopAnalyticsCaptureInput,
  type DesktopAnalyticsHandlerContext,
  DesktopAnalyticsRateLimiter,
  handleDesktopAnalyticsEvent,
} from "../desktop-analytics-handler";

const baseContext: DesktopAnalyticsHandlerContext = {
  organizationId: "org-1",
  userId: "user_db_1",
  clerkUserId: "clerk_user_1",
  targetId: "target-1",
  gatewaySessionId: "session-1",
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
  it("returns feature_disabled unless the exact server relay flag is enabled", async () => {
    const capture = vi.fn();
    const isFeatureEnabled = vi.fn(
      (flag: string) => flag !== DESKTOP_SERVER_ANALYTICS_RELAY_FLAG
    );

    await expect(
      handleDesktopAnalyticsEvent(validPayload, baseContext, {
        capture,
        isFeatureEnabled,
      })
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAnalyticsAckReason.FeatureDisabled,
    });

    expect(isFeatureEnabled).toHaveBeenCalledWith(
      DESKTOP_SERVER_ANALYTICS_RELAY_FLAG,
      "clerk_user_1"
    );
    expect(capture).not.toHaveBeenCalled();
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
          isFeatureEnabled: async () => true,
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
          gateway_session_id: "session-1",
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
          isFeatureEnabled: async () => true,
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
          gateway_session_id: "session-1",
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
          isFeatureEnabled: async () => true,
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
          gateway_session_id: "session-1",
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
          isFeatureEnabled: async () => true,
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
          isFeatureEnabled: async () => true,
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
      isFeatureEnabled: async () => true,
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
        isFeatureEnabled: async () => true,
        rateLimiter: new DesktopAnalyticsRateLimiter(),
      })
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAnalyticsAckReason.CaptureFailed,
    });
  });

  it("rate limits relay reconnects with a stable gateway-owner target key", async () => {
    const rateLimiter = new DesktopAnalyticsRateLimiter();
    const acceptedDeps = {
      capture: vi.fn(),
      isFeatureEnabled: async () => true,
      rateLimiter,
      now: () => 1000,
    };

    for (let index = 0; index < 120; index += 1) {
      await expect(
        handleDesktopAnalyticsEvent(
          validPayload,
          { ...baseContext, relaySocketId: "socket-a" },
          acceptedDeps
        )
      ).resolves.toEqual({ accepted: true });
    }

    await expect(
      handleDesktopAnalyticsEvent(
        validPayload,
        { ...baseContext, relaySocketId: "socket-b" },
        acceptedDeps
      )
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAnalyticsAckReason.RateLimited,
    });
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
