import { BranchesListRolloutDecisionReason } from "@repo/api/src/types/branches-list-rollout";
import {
  DESKTOP_ANALYTICS_ARRAY_ELEMENT_MAX_LENGTH,
  DESKTOP_ANALYTICS_ARRAY_MAX_ITEMS,
  DesktopAnalyticsEventName,
} from "@repo/api/src/types/desktop-analytics";
import { FeatureAssignmentDelivery } from "@repo/api/src/types/feature-assignment-delivery";
import {
  OnboardingAccountMode,
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import {
  GridviewRolloutDecisionOutcome,
  GridviewRolloutDecisionReason,
  SharedAnalyticsComponent,
  Surface,
} from "@repo/api/src/types/surface-analytics";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_ANALYTICS_PROPERTY_MAX_BYTES,
  DESKTOP_ANALYTICS_STRING_MAX_LENGTH,
  parseDesktopAnalyticsPayload,
} from "../desktop-analytics-schema";

describe("parseDesktopAnalyticsPayload", () => {
  // ISS-10503 (PRD-736 D5, decision #12): the envelope distinct id.
  it("round-trips a well-formed v4 distinct id and preserves omission when absent", () => {
    const distinctId = "22222222-2222-4222-8222-222222222222";
    const withId = parseDesktopAnalyticsPayload({
      event: "command_completed",
      occurredAt: "2026-05-12T00:00:00.000Z",
      properties: { command_id: "cmd-1" },
      distinctId,
    });
    expect(withId.ok).toBe(true);
    if (withId.ok) {
      expect(withId.payload.distinctId).toBe(distinctId);
    }

    const withoutId = parseDesktopAnalyticsPayload({
      event: "command_completed",
      occurredAt: "2026-05-12T00:00:00.000Z",
      properties: { command_id: "cmd-1" },
    });
    expect(withoutId.ok).toBe(true);
    if (withoutId.ok) {
      // Omission preserved: the key must not exist at all (never null).
      expect("distinctId" in withoutId.payload).toBe(false);
    }
  });

  it("rejects a distinct id that is not a well-formed v4 UUID", () => {
    for (const distinctId of [
      "not-a-uuid",
      // Well-formed UUID, wrong version nibble — v4 is the injection control.
      "11111111-1111-1111-8111-111111111111",
      // Wrong variant nibble.
      "11111111-1111-4111-c111-111111111111",
      "",
    ]) {
      expect(
        parseDesktopAnalyticsPayload({
          event: "command_completed",
          occurredAt: "2026-05-12T00:00:00.000Z",
          properties: { command_id: "cmd-1" },
          distinctId,
        })
      ).toEqual({ ok: false, reason: "distinct_id_invalid" });
    }
  });

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

  it("accepts the renderer surface-analytics event with its component property (ISS-8752)", () => {
    const result = parseDesktopAnalyticsPayload({
      event: DesktopAnalyticsEventName.SharedComponentRendered,
      occurredAt: "2026-09-01T00:00:00.000Z",
      properties: {
        component: "branch_detail_page",
        surface: "desktop",
      },
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        event: DesktopAnalyticsEventName.SharedComponentRendered,
        occurredAt: "2026-09-01T00:00:00.000Z",
        properties: {
          component: "branch_detail_page",
          surface: "desktop",
        },
      },
    });
  });

  it("accepts grid-table rollout decisions with their required decision fields", () => {
    const result = parseDesktopAnalyticsPayload({
      event: DesktopAnalyticsEventName.GridviewRolloutDecision,
      occurredAt: "2026-09-01T00:00:00.000Z",
      properties: {
        component: SharedAnalyticsComponent.BranchesListSurfaceV2,
        outcome: GridviewRolloutDecisionOutcome.Disabled,
        reason: FeatureAssignmentDelivery.Timeout,
        surface: Surface.Desktop,
      },
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        event: DesktopAnalyticsEventName.GridviewRolloutDecision,
        occurredAt: "2026-09-01T00:00:00.000Z",
        properties: {
          component: SharedAnalyticsComponent.BranchesListSurfaceV2,
          outcome: GridviewRolloutDecisionOutcome.Disabled,
          reason: FeatureAssignmentDelivery.Timeout,
          surface: Surface.Desktop,
        },
      },
    });
  });

  it("preserves Branches quality and complete-read work measurements", () => {
    const result = parseDesktopAnalyticsPayload({
      event: DesktopAnalyticsEventName.GridviewRolloutDecision,
      occurredAt: "2026-09-01T00:00:00.000Z",
      properties: {
        component: SharedAnalyticsComponent.BranchesListSurfaceV2,
        [OnboardingAnalyticsProperty.GitHubConnected]: false,
        outcome: GridviewRolloutDecisionOutcome.Enabled,
        hydrated_row_count: 18,
        peak_request_concurrency: 4,
        reason: BranchesListRolloutDecisionReason.CompleteCohortRead,
        request_count: 7,
        row_count: 20,
        surface: Surface.Desktop,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      payload: {
        properties: {
          [OnboardingAnalyticsProperty.GitHubConnected]: false,
          hydrated_row_count: 18,
          peak_request_concurrency: 4,
          reason: BranchesListRolloutDecisionReason.CompleteCohortRead,
          request_count: 7,
          row_count: 20,
          surface: Surface.Desktop,
        },
      },
    });
  });

  it("normalizes skewed grid-table rollout reasons and stamps the desktop surface", () => {
    const result = parseDesktopAnalyticsPayload({
      event: DesktopAnalyticsEventName.GridviewRolloutDecision,
      occurredAt: "2026-09-01T00:00:00.000Z",
      properties: {
        component: SharedAnalyticsComponent.SessionsListSurfaceV2,
        outcome: GridviewRolloutDecisionOutcome.Unresolved,
        reason: "future-feature-assignment-delivery",
        surface: Surface.Web,
      },
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        event: DesktopAnalyticsEventName.GridviewRolloutDecision,
        occurredAt: "2026-09-01T00:00:00.000Z",
        properties: {
          component: SharedAnalyticsComponent.SessionsListSurfaceV2,
          outcome: GridviewRolloutDecisionOutcome.Unresolved,
          reason: FeatureAssignmentDelivery.Unavailable,
          surface: Surface.Desktop,
        },
      },
    });
  });

  it("normalizes legacy generic rollout reasons to the shared delivery vocabulary", () => {
    const result = parseDesktopAnalyticsPayload({
      event: DesktopAnalyticsEventName.GridviewRolloutDecision,
      occurredAt: "2026-09-01T00:00:00.000Z",
      properties: {
        component: SharedAnalyticsComponent.BranchesListSurfaceV2,
        outcome: GridviewRolloutDecisionOutcome.Disabled,
        reason: GridviewRolloutDecisionReason.FlagDisabled,
        surface: Surface.Desktop,
      },
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        event: DesktopAnalyticsEventName.GridviewRolloutDecision,
        occurredAt: "2026-09-01T00:00:00.000Z",
        properties: {
          component: SharedAnalyticsComponent.BranchesListSurfaceV2,
          outcome: GridviewRolloutDecisionOutcome.Disabled,
          reason: FeatureAssignmentDelivery.Assigned,
          surface: Surface.Desktop,
        },
      },
    });
  });

  it("rejects grid-table rollout decisions without valid decision fields", () => {
    expect(
      parseDesktopAnalyticsPayload({
        event: DesktopAnalyticsEventName.GridviewRolloutDecision,
        occurredAt: "2026-09-01T00:00:00.000Z",
        properties: {
          component: SharedAnalyticsComponent.BranchesListSurfaceV2,
          reason: FeatureAssignmentDelivery.Timeout,
          surface: Surface.Desktop,
        },
      })
    ).toEqual({
      ok: false,
      reason: "gridview_rollout_decision_outcome_invalid",
    });

    expect(
      parseDesktopAnalyticsPayload({
        event: DesktopAnalyticsEventName.GridviewRolloutDecision,
        occurredAt: "2026-09-01T00:00:00.000Z",
        properties: {
          component: SharedAnalyticsComponent.BranchesListSurfaceV2,
          outcome: GridviewRolloutDecisionOutcome.Disabled,
          reason: 42,
          surface: Surface.Desktop,
        },
      })
    ).toEqual({
      ok: false,
      reason: "gridview_rollout_decision_reason_invalid",
    });

    expect(
      parseDesktopAnalyticsPayload({
        event: DesktopAnalyticsEventName.GridviewRolloutDecision,
        occurredAt: "2026-09-01T00:00:00.000Z",
        properties: {
          component: SharedAnalyticsComponent.BranchDetailPage,
          outcome: GridviewRolloutDecisionOutcome.Disabled,
          reason: FeatureAssignmentDelivery.Timeout,
          surface: Surface.Desktop,
        },
      })
    ).toEqual({
      ok: false,
      reason: "gridview_rollout_decision_component_invalid",
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

  it("accepts an onboarding funnel event with string arrays on exactly the array keys (ISS-10502)", () => {
    const result = parseDesktopAnalyticsPayload({
      event: OnboardingAnalyticsEvent.FlowCompleted,
      occurredAt: "2026-09-18T00:00:00.000Z",
      properties: {
        [OnboardingAnalyticsProperty.FlowId]: "flow-1",
        [OnboardingAnalyticsProperty.Surface]: Surface.Desktop,
        [OnboardingAnalyticsProperty.StepsSkipped]: ["account", "invite_team"],
        [OnboardingAnalyticsProperty.HarnessesDetected]: ["Claude Code"],
        [OnboardingAnalyticsProperty.DeviceId]: "0f2a-node-uuid",
      },
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        event: OnboardingAnalyticsEvent.FlowCompleted,
        occurredAt: "2026-09-18T00:00:00.000Z",
        properties: {
          [OnboardingAnalyticsProperty.FlowId]: "flow-1",
          [OnboardingAnalyticsProperty.Surface]: Surface.Desktop,
          [OnboardingAnalyticsProperty.StepsSkipped]: [
            "account",
            "invite_team",
          ],
          [OnboardingAnalyticsProperty.HarnessesDetected]: ["Claude Code"],
          [OnboardingAnalyticsProperty.DeviceId]: "0f2a-node-uuid",
        },
      },
    });
  });

  // ISS-10913. THIS is the side that has to reach prod before the emitter in
  // #7793 — an API that predates the array declaration runs `account_mode`
  // through the SCALAR schema, the array fails, and the transform `z.NEVER`s
  // the WHOLE event, `account_provider` included. Without a case here nothing
  // tells you when the thing #7793 is waiting on regresses (tamsinb on #7815).
  it("accepts account_mode as an array on the account completion, beside account_provider (ISS-10913)", () => {
    const result = parseDesktopAnalyticsPayload({
      event: OnboardingAnalyticsEvent.StepCompleted,
      occurredAt: "2026-09-18T00:00:00.000Z",
      properties: {
        [OnboardingAnalyticsProperty.FlowId]: "flow-1",
        [OnboardingAnalyticsProperty.Surface]: Surface.Desktop,
        [OnboardingAnalyticsProperty.Step]: "account",
        [OnboardingAnalyticsProperty.AccountProvider]: "github",
        [OnboardingAnalyticsProperty.AccountMode]: [
          OnboardingAccountMode.Created,
          OnboardingAccountMode.SignedIn,
        ],
      },
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        event: OnboardingAnalyticsEvent.StepCompleted,
        occurredAt: "2026-09-18T00:00:00.000Z",
        properties: {
          [OnboardingAnalyticsProperty.FlowId]: "flow-1",
          [OnboardingAnalyticsProperty.Surface]: Surface.Desktop,
          [OnboardingAnalyticsProperty.Step]: "account",
          [OnboardingAnalyticsProperty.AccountProvider]: "github",
          [OnboardingAnalyticsProperty.AccountMode]: [
            OnboardingAccountMode.Created,
            OnboardingAccountMode.SignedIn,
          ],
        },
      },
    });
  });

  it("refuses a SCALAR account_mode, and takes the whole event with it (ISS-10913)", () => {
    // The reverse skew: the array schema is a strict `z.array`, so a scalar is
    // refused — and the refusal is WHOLE-EVENT, which is what makes the
    // declaration's ordering load-bearing rather than cosmetic.
    //
    // No installed build sends this. Nothing has ever emitted `account_mode`
    // in any shape, which is exactly why this declaration is safe to land
    // alone — so the only way a scalar reaches here is a FUTURE emitter bug,
    // and this is what makes that bug loud instead of silent (tamsinb).
    //
    // The reason reads `property_string_too_long`, not an array-shaped one,
    // because `desktopAnalyticsPropertyValueReason` branches on the VALUE's
    // type and the value here is a string. Pinned as-is rather than "fixed":
    // these reason strings are the wire contract, and the label is not what
    // this case is about — the refusal is.
    expect(
      parseDesktopAnalyticsPayload({
        event: OnboardingAnalyticsEvent.StepCompleted,
        occurredAt: "2026-09-18T00:00:00.000Z",
        properties: {
          [OnboardingAnalyticsProperty.AccountProvider]: "github",
          [OnboardingAnalyticsProperty.AccountMode]:
            OnboardingAccountMode.Created,
        },
      })
    ).toEqual({ ok: false, reason: "property_string_too_long" });
  });

  it("rejects arrays outside the array keys, non-string elements, and over-cap arrays", () => {
    // An array on a primitive-valued key is refused, not coerced.
    expect(
      parseDesktopAnalyticsPayload({
        event: OnboardingAnalyticsEvent.StepCompleted,
        occurredAt: "2026-09-18T00:00:00.000Z",
        properties: { [OnboardingAnalyticsProperty.Step]: ["welcome"] },
      })
    ).toEqual({ ok: false, reason: "property_array_invalid" });

    expect(
      parseDesktopAnalyticsPayload({
        event: OnboardingAnalyticsEvent.FlowCompleted,
        occurredAt: "2026-09-18T00:00:00.000Z",
        properties: { [OnboardingAnalyticsProperty.StepsSkipped]: [1, 2] },
      })
    ).toEqual({ ok: false, reason: "property_array_invalid" });

    expect(
      parseDesktopAnalyticsPayload({
        event: OnboardingAnalyticsEvent.FlowCompleted,
        occurredAt: "2026-09-18T00:00:00.000Z",
        properties: {
          [OnboardingAnalyticsProperty.StepsSkipped]: ["x"].concat(
            Array.from(
              { length: DESKTOP_ANALYTICS_ARRAY_MAX_ITEMS },
              (_, index) => `step-${index}`
            )
          ),
        },
      })
    ).toEqual({ ok: false, reason: "property_array_invalid" });

    expect(
      parseDesktopAnalyticsPayload({
        event: OnboardingAnalyticsEvent.FlowCompleted,
        occurredAt: "2026-09-18T00:00:00.000Z",
        properties: {
          [OnboardingAnalyticsProperty.HarnessesDetected]: [
            "x".repeat(DESKTOP_ANALYTICS_ARRAY_ELEMENT_MAX_LENGTH + 1),
          ],
        },
      })
    ).toEqual({ ok: false, reason: "property_array_invalid" });
  });

  it("still primitive-guards the non-array onboarding keys", () => {
    expect(
      parseDesktopAnalyticsPayload({
        event: OnboardingAnalyticsEvent.PageViewed,
        occurredAt: "2026-09-18T00:00:00.000Z",
        properties: {
          [OnboardingAnalyticsProperty.PageName]: "x".repeat(
            DESKTOP_ANALYTICS_STRING_MAX_LENGTH + 1
          ),
        },
      })
    ).toEqual({ ok: false, reason: "property_string_too_long" });
  });
});
