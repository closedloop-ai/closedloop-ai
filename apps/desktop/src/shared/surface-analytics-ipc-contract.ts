import type { OnboardingAnalyticsEvent } from "@repo/api/src/types/onboarding-analytics";
import type {
  AnalyticsPropertyValue,
  SharedAnalyticsComponent,
  Surface,
  SurfaceAnalyticsEvent,
} from "@repo/api/src/types/surface-analytics";

/**
 * Renderer → main relay for the surface-attributed analytics port (ISS-8752).
 * The renderer has no PostHog client by design; it hands surface events to the
 * main process, which forwards them through the product-analytics HTTP lane
 * where the cloud enforces the event/property allowlist and attaches identity.
 * The onboarding FTUE funnel (PRD-736, ISS-10502) rides the same channel: its
 * events carry `surface` but no `component` — component attribution belongs to
 * the MLP shared-component events only.
 */
export const SURFACE_ANALYTICS_IPC_CHANNEL = "desktop:surface-analytics";

export type SurfaceAnalyticsIpcPayload =
  | {
      event:
        | typeof SurfaceAnalyticsEvent.SharedComponentRendered
        | typeof SurfaceAnalyticsEvent.GridviewRolloutDecision;
      properties: Record<string, AnalyticsPropertyValue> & {
        component: SharedAnalyticsComponent;
        surface: typeof Surface.Desktop;
      };
    }
  | {
      event: OnboardingAnalyticsEvent;
      properties: Record<string, AnalyticsPropertyValue> & {
        surface: typeof Surface.Desktop;
      };
    };

/**
 * Full IPC response shape (never a bare boolean): `ok: false` names why the
 * event was refused so the renderer can tell a rejected payload from a
 * fire-and-forget success.
 */
export type SurfaceAnalyticsIpcResult =
  | { ok: true }
  | { ok: false; error: string };
