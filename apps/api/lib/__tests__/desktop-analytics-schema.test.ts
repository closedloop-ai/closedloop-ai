import { DesktopAnalyticsEventName } from "@repo/api/src/types/desktop-analytics";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_ANALYTICS_PROPERTY_MAX_BYTES,
  DESKTOP_ANALYTICS_STRING_MAX_LENGTH,
  parseDesktopAnalyticsPayload,
} from "../desktop-analytics-schema";

describe("parseDesktopAnalyticsPayload", () => {
  it("accepts an allowlisted event with bounded properties", () => {
    const result = parseDesktopAnalyticsPayload({
      event: "command_completed",
      occurredAt: "2026-05-12T00:00:00.000Z",
      properties: {
        command_id: "cmd-1",
        operation_type: "GENERATE_PRD",
        latency_ms: 42,
      },
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        event: "command_completed",
        occurredAt: "2026-05-12T00:00:00.000Z",
        properties: {
          command_id: "cmd-1",
          operation_type: "GENERATE_PRD",
          latency_ms: 42,
        },
      },
    });
  });

  it("accepts the exact Desktop connection-established relay payload", () => {
    const result = parseDesktopAnalyticsPayload({
      event: DesktopAnalyticsEventName.DesktopConnectionEstablished,
      occurredAt: "2026-05-12T00:00:00.000Z",
      properties: {
        environment: "production",
        desktop_client_version: "0.15.3",
        platform: "darwin",
      },
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        event: DesktopAnalyticsEventName.DesktopConnectionEstablished,
        occurredAt: "2026-05-12T00:00:00.000Z",
        properties: {
          environment: "production",
          desktop_client_version: "0.15.3",
          platform: "darwin",
        },
      },
    });
  });

  it("accepts Desktop agent-session sync failure analytics", () => {
    const result = parseDesktopAnalyticsPayload({
      event: DesktopAnalyticsEventName.AgentSessionSyncBatchFailed,
      occurredAt: "2026-05-12T00:00:00.000Z",
      properties: {
        reason: "ack_timeout",
        sync_mode: "backfill",
        session_count: 42,
        payload_bytes: 4096,
      },
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        event: DesktopAnalyticsEventName.AgentSessionSyncBatchFailed,
        occurredAt: "2026-05-12T00:00:00.000Z",
        properties: {
          reason: "ack_timeout",
          sync_mode: "backfill",
          session_count: 42,
          payload_bytes: 4096,
        },
      },
    });
  });

  it("rejects unknown events and invalid timestamps", () => {
    expect(
      parseDesktopAnalyticsPayload({
        event: "command_completed_v2",
        occurredAt: "2026-05-12T00:00:00.000Z",
      })
    ).toEqual({ ok: false, reason: "event_not_allowed" });

    expect(
      parseDesktopAnalyticsPayload({
        event: "command_completed",
        occurredAt: "not-a-date",
      })
    ).toEqual({ ok: false, reason: "occurred_at_invalid" });
  });

  it("drops client identity properties and legacy generic version before server enrichment", () => {
    const result = parseDesktopAnalyticsPayload({
      event: "desktop_connection_established",
      occurredAt: "2026-05-12T00:00:00.000Z",
      properties: {
        distinctId: "client-user",
        clerkUserId: "client-clerk",
        organization_id: "client-org",
        compute_target_id: "client-target",
        version: "0.15.3",
        environment: "production",
      },
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        event: "desktop_connection_established",
        occurredAt: "2026-05-12T00:00:00.000Z",
        properties: { environment: "production" },
      },
    });
  });

  it("rejects unknown properties, long strings, and oversize payloads", () => {
    expect(
      parseDesktopAnalyticsPayload({
        event: "command_completed",
        occurredAt: "2026-05-12T00:00:00.000Z",
        properties: { unreviewed_field: "x" },
      })
    ).toEqual({ ok: false, reason: "property_not_allowed" });

    expect(
      parseDesktopAnalyticsPayload({
        event: DesktopAnalyticsEventName.DesktopConnectionEstablished,
        occurredAt: "2026-05-12T00:00:00.000Z",
        properties: { desktop_id: "target-1" },
      })
    ).toEqual({ ok: false, reason: "property_not_allowed" });

    expect(
      parseDesktopAnalyticsPayload({
        event: "command_completed",
        occurredAt: "2026-05-12T00:00:00.000Z",
        properties: {
          command_id: "x".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH + 1),
        },
      })
    ).toEqual({ ok: false, reason: "property_string_too_long" });

    const largeProperties = {
      command_id: "a".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH),
      operation_type: "b".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH),
      error: "c".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH),
      reason: "d".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH),
      surface: "e".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH),
      version: "f".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH),
      environment: "g".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH),
      platform: "h".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH),
      shell: "i".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH),
      error_code: "j".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH),
      failure_reason: "k".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH),
      operation_class: "l".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH),
      outcome: "m".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH),
      check_id: "n".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH),
      desktop_client_version: "o".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH),
      error_class: "p".repeat(DESKTOP_ANALYTICS_STRING_MAX_LENGTH),
      latency_ms: 1,
      duration_ms: 2,
      plugin_count: 3,
      replay_command_count: 4,
      time_to_resolve_ms: 5,
      found_elsewhere: true,
    };
    expect(JSON.stringify(largeProperties).length).toBeGreaterThan(
      DESKTOP_ANALYTICS_PROPERTY_MAX_BYTES
    );
    expect(
      parseDesktopAnalyticsPayload({
        event: "command_failed",
        occurredAt: "2026-05-12T00:00:00.000Z",
        properties: largeProperties,
      })
    ).toEqual({ ok: false, reason: "properties_too_large" });
  });
});
