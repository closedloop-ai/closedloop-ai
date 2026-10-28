import assert from "node:assert/strict";
import { BranchesListRolloutDecisionReason } from "@repo/api/src/types/branches-list-rollout";
import { DesktopAnalyticsEventName } from "@repo/api/src/types/desktop-analytics";
import { FeatureAssignmentDelivery } from "@repo/api/src/types/feature-assignment-delivery";
import {
  OnboardingAccountMode,
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
  OnboardingFailureReason,
} from "@repo/api/src/types/onboarding-analytics";
import {
  GridviewRolloutDecisionOutcome,
  SharedAnalyticsComponent,
  Surface,
} from "@repo/api/src/types/surface-analytics";
import { describe, test } from "vitest";
import { registerSurfaceAnalyticsIpcHandlers } from "../src/main/ipc/surface-analytics-ipc.js";
import { SURFACE_ANALYTICS_IPC_CHANNEL } from "../src/shared/surface-analytics-ipc-contract.js";

type IpcHandler = (event: unknown, payload?: unknown) => unknown;

type CapturedEvent = {
  event: string;
  properties: Record<string, unknown>;
};

function makeHandler(
  isTrustedSender: (sender: unknown) => boolean = () => true
): { handler: IpcHandler; captured: CapturedEvent[] } {
  const handlers = new Map<string, IpcHandler>();
  const captured: CapturedEvent[] = [];
  registerSurfaceAnalyticsIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    {
      isTrustedSender,
      captureAnalytics: (event, properties) => {
        captured.push({ event, properties });
      },
    }
  );
  const handler = handlers.get(SURFACE_ANALYTICS_IPC_CHANNEL);
  if (!handler) {
    throw new Error("handler not registered on the surface-analytics channel");
  }
  return { handler, captured };
}

const TRUSTED_EVENT = { sender: {} };
const UNTRUSTED_SENDER_ERROR = /untrusted sender/;

describe("surface-analytics IPC", () => {
  test("rejects an untrusted sender before touching the payload", () => {
    const { handler, captured } = makeHandler(() => false);
    assert.throws(
      () =>
        handler(TRUSTED_EVENT, {
          event: DesktopAnalyticsEventName.SharedComponentRendered,
          properties: {},
        }),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(captured.length, 0);
  });

  test("forwards an allowlisted event with primitive properties only", () => {
    const { handler, captured } = makeHandler();
    const result = handler(TRUSTED_EVENT, {
      event: DesktopAnalyticsEventName.SharedComponentRendered,
      properties: {
        component: SharedAnalyticsComponent.BranchDetailPage,
        surface: Surface.Desktop,
        future_property: "drop me at the IPC boundary",
        nested: { drop: "me" },
        fn: () => "drop me too",
      },
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(captured, [
      {
        event: DesktopAnalyticsEventName.SharedComponentRendered,
        properties: {
          component: SharedAnalyticsComponent.BranchDetailPage,
          surface: Surface.Desktop,
        },
      },
    ]);
  });

  test("forwards a grid-table rollout decision with delivery reason", () => {
    const { handler, captured } = makeHandler();
    const result = handler(TRUSTED_EVENT, {
      event: DesktopAnalyticsEventName.GridviewRolloutDecision,
      properties: {
        component: SharedAnalyticsComponent.BranchesListSurfaceV2,
        outcome: GridviewRolloutDecisionOutcome.Disabled,
        reason: FeatureAssignmentDelivery.Offline,
        surface: Surface.Desktop,
      },
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(captured, [
      {
        event: DesktopAnalyticsEventName.GridviewRolloutDecision,
        properties: {
          component: SharedAnalyticsComponent.BranchesListSurfaceV2,
          outcome: GridviewRolloutDecisionOutcome.Disabled,
          reason: FeatureAssignmentDelivery.Offline,
          surface: Surface.Desktop,
        },
      },
    ]);
  });

  test("forwards Branches hydration and complete-read work measurements", () => {
    const { handler, captured } = makeHandler();
    const result = handler(TRUSTED_EVENT, {
      event: DesktopAnalyticsEventName.GridviewRolloutDecision,
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

    assert.deepEqual(result, { ok: true });
    assert.equal(
      captured[0]?.properties.reason,
      BranchesListRolloutDecisionReason.CompleteCohortRead
    );
    assert.equal(captured[0]?.properties.hydrated_row_count, 18);
    assert.equal(
      captured[0]?.properties[OnboardingAnalyticsProperty.GitHubConnected],
      false
    );
    assert.equal(captured[0]?.properties.peak_request_concurrency, 4);
    assert.equal(captured[0]?.properties.request_count, 7);
  });

  test("refuses a grid-table rollout decision without valid decision fields", () => {
    const { handler, captured } = makeHandler();
    assert.deepEqual(
      handler(TRUSTED_EVENT, {
        event: DesktopAnalyticsEventName.GridviewRolloutDecision,
        properties: {
          component: SharedAnalyticsComponent.BranchesListSurfaceV2,
          reason: FeatureAssignmentDelivery.Offline,
          surface: Surface.Desktop,
        },
      }),
      { ok: false, error: "outcome_not_allowed" }
    );
    assert.deepEqual(
      handler(TRUSTED_EVENT, {
        event: DesktopAnalyticsEventName.GridviewRolloutDecision,
        properties: {
          component: SharedAnalyticsComponent.BranchesListSurfaceV2,
          outcome: GridviewRolloutDecisionOutcome.Disabled,
          reason: "unknown-reason",
          surface: Surface.Desktop,
        },
      }),
      { ok: false, error: "reason_not_allowed" }
    );
    assert.equal(captured.length, 0);
  });

  test("refuses a main-process lifecycle event name from the renderer", () => {
    const { handler, captured } = makeHandler();
    const result = handler(TRUSTED_EVENT, {
      event: DesktopAnalyticsEventName.CommandCompleted,
      properties: {},
    });
    assert.deepEqual(result, { ok: false, error: "event_not_allowed" });
    assert.equal(captured.length, 0);
  });

  test("refuses a malformed payload", () => {
    const { handler, captured } = makeHandler();
    assert.deepEqual(handler(TRUSTED_EVENT, "not-an-object"), {
      ok: false,
      error: "payload_not_object",
    });
    assert.deepEqual(
      handler(TRUSTED_EVENT, {
        event: DesktopAnalyticsEventName.SharedComponentRendered,
        properties: "not-an-object",
      }),
      { ok: false, error: "properties_not_object" }
    );
    assert.deepEqual(
      handler(TRUSTED_EVENT, {
        event: DesktopAnalyticsEventName.SharedComponentRendered,
        properties: [],
      }),
      { ok: false, error: "properties_not_object" }
    );
    assert.equal(captured.length, 0);
  });

  test("refuses missing or non-desktop surface attribution", () => {
    const { handler, captured } = makeHandler();
    for (const surface of [undefined, Surface.Web, "forged"]) {
      assert.deepEqual(
        handler(TRUSTED_EVENT, {
          event: DesktopAnalyticsEventName.SharedComponentRendered,
          properties: {
            component: SharedAnalyticsComponent.BranchDetailPage,
            surface,
          },
        }),
        { ok: false, error: "surface_not_allowed" }
      );
    }
    assert.equal(captured.length, 0);
  });

  test("refuses missing or unknown shared component attribution", () => {
    const { handler, captured } = makeHandler();
    for (const component of [undefined, "unknown_component", 42]) {
      assert.deepEqual(
        handler(TRUSTED_EVENT, {
          event: DesktopAnalyticsEventName.SharedComponentRendered,
          properties: { component, surface: Surface.Desktop },
        }),
        { ok: false, error: "component_not_allowed" }
      );
    }
    assert.equal(captured.length, 0);
  });

  test("forwards an onboarding funnel event without component attribution (ISS-10502)", () => {
    const { handler, captured } = makeHandler();
    const result = handler(TRUSTED_EVENT, {
      event: OnboardingAnalyticsEvent.StepCompleted,
      properties: {
        [OnboardingAnalyticsProperty.Surface]: Surface.Desktop,
        [OnboardingAnalyticsProperty.FlowId]: "flow-1",
        [OnboardingAnalyticsProperty.Step]: "session_discovery",
        [OnboardingAnalyticsProperty.SessionsFoundCount]: 12,
      },
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(captured, [
      {
        event: OnboardingAnalyticsEvent.StepCompleted,
        properties: {
          [OnboardingAnalyticsProperty.Surface]: Surface.Desktop,
          [OnboardingAnalyticsProperty.FlowId]: "flow-1",
          [OnboardingAnalyticsProperty.Step]: "session_discovery",
          [OnboardingAnalyticsProperty.SessionsFoundCount]: 12,
        },
      },
    ]);
  });

  test("still requires desktop surface attribution on onboarding events", () => {
    const { handler, captured } = makeHandler();
    assert.deepEqual(
      handler(TRUSTED_EVENT, {
        event: OnboardingAnalyticsEvent.FlowStarted,
        properties: { [OnboardingAnalyticsProperty.FlowId]: "flow-1" },
      }),
      { ok: false, error: "surface_not_allowed" }
    );
    assert.equal(captured.length, 0);
  });

  test("accepts string arrays on exactly the array keys and drops arrays elsewhere", () => {
    const { handler, captured } = makeHandler();
    const result = handler(TRUSTED_EVENT, {
      event: OnboardingAnalyticsEvent.FlowCompleted,
      properties: {
        [OnboardingAnalyticsProperty.Surface]: Surface.Desktop,
        [OnboardingAnalyticsProperty.StepsSkipped]: ["account"],
        [OnboardingAnalyticsProperty.HarnessesDetected]: [
          "Claude Code",
          "Codex",
        ],
        // An array on a primitive key and a non-string element are DROPPED at
        // this boundary (best-effort), never forwarded for the relay to refuse.
        [OnboardingAnalyticsProperty.Step]: ["not-a-primitive"],
      },
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(captured, [
      {
        event: OnboardingAnalyticsEvent.FlowCompleted,
        properties: {
          [OnboardingAnalyticsProperty.Surface]: Surface.Desktop,
          [OnboardingAnalyticsProperty.StepsSkipped]: ["account"],
          [OnboardingAnalyticsProperty.HarnessesDetected]: [
            "Claude Code",
            "Codex",
          ],
        },
      },
    ]);
  });

  test("drops an array-key value whose elements are not all strings", () => {
    const { handler, captured } = makeHandler();
    const result = handler(TRUSTED_EVENT, {
      event: OnboardingAnalyticsEvent.FlowCompleted,
      properties: {
        [OnboardingAnalyticsProperty.Surface]: Surface.Desktop,
        [OnboardingAnalyticsProperty.StepsSkipped]: ["account", 42],
      },
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(captured, [
      {
        event: OnboardingAnalyticsEvent.FlowCompleted,
        properties: {
          [OnboardingAnalyticsProperty.Surface]: Surface.Desktop,
        },
      },
    ]);
  });
});

test.each([
  [OnboardingAccountMode.Created, OnboardingAccountMode.LoggedOut],
  [OnboardingAccountMode.CreationUnconfirmed],
  [OnboardingAccountMode.CreationUnattempted],
  [OnboardingAccountMode.Unknown],
])("failed account event survives IPC: %s", (...accountMode) => {
  const { handler, captured } = makeHandler();
  const payload = {
    event: OnboardingAnalyticsEvent.StepFailed,
    properties: {
      [OnboardingAnalyticsProperty.Surface]: Surface.Desktop,
      [OnboardingAnalyticsProperty.Step]: "account",
      [OnboardingAnalyticsProperty.AccountMode]: accountMode,
      [OnboardingAnalyticsProperty.FailureReason]:
        OnboardingFailureReason.Cancelled,
    },
  };
  assert.deepEqual(handler(TRUSTED_EVENT, payload), { ok: true });
  assert.deepEqual(captured, [payload]);
});
