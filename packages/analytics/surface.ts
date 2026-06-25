/**
 * Surface-attributed analytics primitives (FEA-1517).
 *
 * Shared components (`@repo/app`) render on more than one surface — the web
 * app and the desktop renderer. To distinguish usage by surface and measure
 * MLP adoption, feature-usage events carry a `surface` attribute supplied via
 * injected context (see `surface-context.tsx`), so the shared components that
 * emit them stay surface-agnostic.
 *
 * This module is intentionally free of React and PostHog imports so it can be
 * imported from any runtime or surface (including the Vite-based desktop
 * renderer, which does not consume `@posthog/next`).
 */

/** The surface a shared component rendered on. */
export const Surface = {
  Web: "web",
  Desktop: "desktop",
} as const;
export type Surface = (typeof Surface)[keyof typeof Surface];

/** Event names emitted by the surface-attributed analytics port. */
export const SurfaceAnalyticsEvent = {
  SharedComponentRendered: "shared_component_rendered",
  OperatingModeSwitch: "operating_mode_switch",
  DesktopMlpFeatureUsed: "desktop_mlp_feature_used",
} as const;
export type SurfaceAnalyticsEvent =
  (typeof SurfaceAnalyticsEvent)[keyof typeof SurfaceAnalyticsEvent];

/** Primitive values an analytics property may hold (no PII, no objects). */
export type AnalyticsPropertyValue = string | number | boolean | null;

/** Free-form analytics properties an emitter accepts alongside its known fields. */
export type SurfaceAnalyticsProperties = Record<
  string,
  AnalyticsPropertyValue | undefined
>;

/**
 * The capture sink each shell injects. Matches the shape of the PostHog
 * client's `capture` (event name + properties) so a web adapter can forward
 * straight to `useAnalytics().capture`, while other surfaces inject their own.
 */
export type SurfaceAnalyticsCapture = (
  event: SurfaceAnalyticsEvent,
  properties: SurfaceAnalyticsProperties
) => void;
