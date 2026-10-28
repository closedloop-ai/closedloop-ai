import { BranchesListRolloutDecisionReason } from "@repo/api/src/types/branches-list-rollout";
import {
  DESKTOP_ANALYTICS_ARRAY_PROPERTY_KEYS,
  DesktopAnalyticsEventName,
  DesktopAnalyticsPropertyKey,
} from "@repo/api/src/types/desktop-analytics";
import { FeatureAssignmentDelivery } from "@repo/api/src/types/feature-assignment-delivery";
import { OnboardingAnalyticsEvent } from "@repo/api/src/types/onboarding-analytics";
import {
  GridviewRolloutDecisionOutcome,
  GridviewRolloutDecisionReason,
  SharedAnalyticsComponent,
  Surface,
} from "@repo/api/src/types/surface-analytics";
import {
  SURFACE_ANALYTICS_IPC_CHANNEL,
  type SurfaceAnalyticsIpcResult,
} from "../../shared/surface-analytics-ipc-contract.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

type IpcMainLike = {
  handle: (
    channel: typeof SURFACE_ANALYTICS_IPC_CHANNEL,
    listener: (event: unknown, payload?: unknown) => unknown
  ) => void;
};

type SurfaceAnalyticsIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  /** Forward one accepted event to the product-analytics transport. */
  captureAnalytics: (
    event: DesktopAnalyticsEventName,
    properties: Record<string, unknown>
  ) => void;
};

/**
 * ISS-8752: renderer half of the surface-attributed analytics port. Accepts
 * only the desktop-relayed surface events (a closed set derived from the
 * desktop analytics contract, so a renderer cannot smuggle arbitrary event
 * names into the lane) and only primitive property values. Identity is never
 * accepted from the renderer — the cloud attaches it server-side, and its
 * schema strips identity keys besides.
 */
export function registerSurfaceAnalyticsIpcHandlers(
  ipcMain: IpcMainLike,
  deps: SurfaceAnalyticsIpcDeps
): void {
  ipcMain.handle(
    SURFACE_ANALYTICS_IPC_CHANNEL,
    (event, payload): SurfaceAnalyticsIpcResult => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      const parsed = parseSurfaceAnalyticsPayload(payload);
      if (!parsed.ok) {
        return parsed;
      }
      deps.captureAnalytics(parsed.event, parsed.properties);
      return { ok: true };
    }
  );
}

type ParsedSurfaceAnalyticsPayload =
  | {
      ok: true;
      event: RendererSurfaceAnalyticsEvent;
      properties: Record<string, string | number | boolean | null | string[]>;
    }
  | { ok: false; error: string };

function parseSurfaceAnalyticsPayload(
  payload: unknown
): ParsedSurfaceAnalyticsPayload {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "payload_not_object" };
  }
  const { event, properties } = payload as {
    event?: unknown;
    properties?: unknown;
  };
  if (
    typeof event !== "string" ||
    !RENDERER_SURFACE_ANALYTICS_EVENTS.has(event as DesktopAnalyticsEventName)
  ) {
    return { ok: false, error: "event_not_allowed" };
  }
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return { ok: false, error: "properties_not_object" };
  }
  const propertyRecord = properties as Record<string, unknown>;
  if (propertyRecord.surface !== Surface.Desktop) {
    return { ok: false, error: "surface_not_allowed" };
  }
  // Component attribution belongs to the MLP shared-component events only;
  // the onboarding funnel events (ISS-10502) carry flow context instead.
  if (
    SHARED_COMPONENT_SURFACE_EVENTS.has(event as DesktopAnalyticsEventName) &&
    (typeof propertyRecord.component !== "string" ||
      !SHARED_ANALYTICS_COMPONENTS.has(propertyRecord.component))
  ) {
    return { ok: false, error: "component_not_allowed" };
  }
  if (event === DesktopAnalyticsEventName.GridviewRolloutDecision) {
    const rolloutDecisionError =
      validateGridviewRolloutDecisionProperties(propertyRecord);
    if (rolloutDecisionError) {
      return { ok: false, error: rolloutDecisionError };
    }
  }
  return {
    ok: true,
    event: event as RendererSurfaceAnalyticsEvent,
    properties: acceptSurfaceAnalyticsProperties(propertyRecord),
  };
}

/**
 * Keep only allowlisted keys with values the wire accepts: primitives, plus
 * string arrays on exactly the declared array keys — the ISS-10502 pair plus
 * `account_mode` (ISS-10913); read them from
 * {@link DESKTOP_ANALYTICS_ARRAY_PROPERTY_KEYS}, never from this sentence. A
 * disallowed value is
 * DROPPED (best-effort), never forwarded for the relay to refuse whole.
 */
function acceptSurfaceAnalyticsProperties(
  propertyRecord: Record<string, unknown>
): Record<string, string | number | boolean | null | string[]> {
  const accepted: Record<string, string | number | boolean | null | string[]> =
    {};
  for (const [key, value] of Object.entries(propertyRecord)) {
    if (!DESKTOP_ANALYTICS_PROPERTY_KEYS.has(key)) {
      continue;
    }
    if (DESKTOP_ANALYTICS_ARRAY_PROPERTY_KEYS.has(key)) {
      if (isStringArray(value)) {
        accepted[key] = value;
      }
      continue;
    }
    if (
      value === null ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      typeof value === "boolean"
    ) {
      accepted[key] = value;
    }
  }
  return accepted;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((element) => typeof element === "string")
  );
}

type RendererSurfaceAnalyticsEvent =
  | typeof DesktopAnalyticsEventName.SharedComponentRendered
  | typeof DesktopAnalyticsEventName.GridviewRolloutDecision
  | OnboardingAnalyticsEvent;

/**
 * The two MLP shared-component events, which are the only payloads that must
 * name a `component`; onboarding funnel events carry flow context instead.
 */
const SHARED_COMPONENT_SURFACE_EVENTS: ReadonlySet<DesktopAnalyticsEventName> =
  new Set([
    DesktopAnalyticsEventName.SharedComponentRendered,
    DesktopAnalyticsEventName.GridviewRolloutDecision,
  ]);

/**
 * The desktop-analytics contract members a RENDERER may originate. Derived
 * member-by-member from the contract consts (not restated strings), and
 * deliberately narrower than the whole contract: command/connection/plugin
 * lifecycle events belong to the main process's own reporters, and a renderer
 * claiming one would forge lifecycle telemetry. The onboarding FTUE funnel
 * (PRD-736, ISS-10502) runs its FSM in the renderer, so every onboarding
 * event is renderer-originated on desktop.
 */
const RENDERER_SURFACE_ANALYTICS_EVENTS: ReadonlySet<DesktopAnalyticsEventName> =
  new Set([
    ...SHARED_COMPONENT_SURFACE_EVENTS,
    ...Object.values(OnboardingAnalyticsEvent),
  ]);

const SHARED_ANALYTICS_COMPONENTS: ReadonlySet<string> = new Set(
  Object.values(SharedAnalyticsComponent)
);

const DESKTOP_ANALYTICS_PROPERTY_KEYS: ReadonlySet<string> = new Set(
  Object.values(DesktopAnalyticsPropertyKey)
);

const GRIDVIEW_ROLLOUT_DECISION_OUTCOMES: ReadonlySet<string> = new Set(
  Object.values(GridviewRolloutDecisionOutcome)
);

const GRIDVIEW_ROLLOUT_DECISION_REASONS: ReadonlySet<string> = new Set([
  ...Object.values(BranchesListRolloutDecisionReason),
  ...Object.values(GridviewRolloutDecisionReason),
  ...Object.values(FeatureAssignmentDelivery),
]);

function validateGridviewRolloutDecisionProperties(
  properties: Record<string, unknown>
): "outcome_not_allowed" | "reason_not_allowed" | null {
  if (
    typeof properties.outcome !== "string" ||
    !GRIDVIEW_ROLLOUT_DECISION_OUTCOMES.has(properties.outcome)
  ) {
    return "outcome_not_allowed";
  }
  if (
    typeof properties.reason !== "string" ||
    !GRIDVIEW_ROLLOUT_DECISION_REASONS.has(properties.reason)
  ) {
    return "reason_not_allowed";
  }
  return null;
}
