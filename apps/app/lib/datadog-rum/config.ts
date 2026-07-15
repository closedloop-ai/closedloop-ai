import type { RumEvent, RumInitConfiguration } from "@datadog/browser-rum";
import { env } from "@/env";
import { appEnvironment } from "@/lib/environment";

const DEFAULT_SESSION_SAMPLE_RATE = 100;
const SESSION_REPLAY_SAMPLE_RATE = 0;

export type DatadogRumConfig = Pick<
  RumInitConfiguration,
  | "applicationId"
  | "beforeSend"
  | "clientToken"
  | "defaultPrivacyLevel"
  | "env"
  | "service"
  | "sessionReplaySampleRate"
  | "sessionSampleRate"
  | "site"
  | "trackLongTasks"
  | "trackResources"
  | "trackUserInteractions"
  | "version"
>;

export function getDatadogRumConfig(): DatadogRumConfig | null {
  const applicationId = env.NEXT_PUBLIC_DATADOG_RUM_APPLICATION_ID;
  const clientToken = env.NEXT_PUBLIC_DATADOG_RUM_CLIENT_TOKEN;
  const site = env.NEXT_PUBLIC_DATADOG_RUM_SITE;

  if (!(applicationId && clientToken && site)) {
    return null;
  }

  return {
    applicationId,
    beforeSend: scrubDatadogRumEvent,
    clientToken,
    defaultPrivacyLevel: "mask-user-input",
    env: appEnvironment,
    service: "cl-app",
    sessionReplaySampleRate: SESSION_REPLAY_SAMPLE_RATE,
    sessionSampleRate: parseSampleRate(
      env.NEXT_PUBLIC_DATADOG_RUM_SESSION_SAMPLE_RATE,
      DEFAULT_SESSION_SAMPLE_RATE
    ),
    site,
    trackLongTasks: true,
    trackResources: true,
    // Collect interactions for INP/long-task attribution. Egress is gated to
    // staff in `scrubDatadogRumEvent` (see `staffCaptureEnabled`); non-staff
    // `action` events are dropped before they leave the browser (FEA-2400).
    trackUserInteractions: true,
    version: getDatadogRumVersion(),
  };
}

/**
 * Benign client-side error signatures dropped before reaching Datadog RUM
 * (FEA-2404). Each is non-actionable at the application-component level, so
 * suppressing at source keeps the real-prod `cl-app` `@type:error` baseline at
 * ~0 without masking genuine app errors — a novel/unlisted error class still
 * flows through. Matched by substring against the error message or stack.
 *
 * Kept narrow and per-class on purpose so the list is auditable against the
 * sibling monitor exclusions in FEA-2403.
 */
const BENIGN_ERROR_SIGNATURES: readonly string[] = [
  // Next.js `notFound()` control flow (navigating to a deleted/missing
  // artifact). The Datadog browser-rum Next.js plugin captures the thrown
  // control-flow digest as an error even though the user just sees a 404.
  "NEXT_HTTP_ERROR_FALLBACK;404",
  // Clerk's own `@clerk/ui` internal mount watchdog. Clerk lazy-loads its UI
  // renderer chunks; a slow network or post-deploy stale chunk trips this 10s
  // timeout. Transient client-side chunk-load, not actionable in error tracking.
  "[Clerk UI] Component renderer did not mount within 10s",
  // React hydration text mismatch. In `cl-app` the document/PRD body is never
  // server-rendered (spinner-gated, no SSR dehydration), so #418 originates in
  // shared SSR chrome mutated by browser extensions / Clerk's SSR widget —
  // third-party DOM injection, not our components. Scoped to #418 as observed;
  // do not widen to the whole hydration family without evidence. Anchored to
  // the trailing `;` (React emits `Minified React error #<code>;`) so it cannot
  // also match sibling codes like #4180-#4189.
  "Minified React error #418;",
];

function isBenignRumError(event: RumEvent): boolean {
  if (event.type !== "error" || !event.error) {
    return false;
  }
  const haystack = `${event.error.message ?? ""} ${event.error.stack ?? ""}`;
  return BENIGN_ERROR_SIGNATURES.some((signature) =>
    haystack.includes(signature)
  );
}

export function scrubDatadogRumEvent(event: RumEvent): boolean {
  // Gate interaction egress to staff. `trackUserInteractions` is on at init so
  // RUM can attribute INP/long-tasks, but `action` events carry computed names
  // (button/link text, document/project titles). Drop them for non-staff so no
  // such text leaves the browser — matching the prior no-interaction posture.
  if (event.type === "action" && !staffCaptureEnabled) {
    return false;
  }

  if (event.type === "resource" && event.resource) {
    const parsed = tryParseUrl(event.resource.url);
    // Drop local desktop gateway resource telemetry; preserve normal app URLs.
    if (
      parsed &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    ) {
      return false;
    }
  }

  // Drop known-benign, non-actionable client error classes at source (FEA-2404).
  if (isBenignRumError(event)) {
    return false;
  }

  return true;
}

export function getDatadogRumVersion(): string {
  return (
    process.env.NEXT_PUBLIC_DATADOG_RUM_BUILD_VERSION ??
    process.env.NEXT_PUBLIC_DATADOG_RUM_VERSION ??
    "unknown"
  );
}

function parseSampleRate(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(100, Math.max(0, parsed));
}

function tryParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Whether the current session belongs to staff who have opted into enhanced
 * capture (see FEA-2400). `trackUserInteractions` is an init-time-only RUM
 * option and RUM initializes before user identity is known, so we always
 * collect interactions but gate their *egress* in `scrubDatadogRumEvent`, which
 * drops `action` events unless this flag is set. Non-staff sessions therefore
 * behave exactly as before (no action names — e.g. button/link text, document
 * titles — leave the browser). Flipped on/off by the staff-capture controller.
 */
let staffCaptureEnabled = false;

/**
 * Enable or disable staff-scoped RUM action egress. Called by
 * `apps/app/lib/datadog-rum/staff-capture.ts` in response to the
 * `web-frontend-capture` feature flag.
 */
export function setDatadogRumStaffCapture(enabled: boolean): void {
  staffCaptureEnabled = enabled;
}

/** Test/inspection helper: current staff-capture egress state. */
export function isDatadogRumStaffCaptureEnabled(): boolean {
  return staffCaptureEnabled;
}
