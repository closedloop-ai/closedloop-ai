/**
 * Gate for desktop telemetry NETWORK EGRESS (FEA-2199).
 *
 * The always-on local OTel SDK (PRD-479) is unaffected by this — it keeps
 * buffering operational signal locally regardless. This decides only whether a
 * launch is allowed to ship that signal over the keyless relay (FEA-1993) to the
 * prod Collector → Datadog/PostHog.
 *
 * Why: non-production launches were polluting the prod telemetry stream. The
 * desktop E2E harness (`test/e2e/helpers/desktop-app.ts`) launches the unpackaged
 * `dist/main/index.js` with a fresh per-test `--user-data-dir` (a new
 * `app.installation.id` every run) and inherits the CI environment, so each
 * short-lived test phoned home a `start`/`shutdown` pair — ~1859 distinct
 * one-shot "installs" in 5 days — and `pnpm dev` leaked the Electron runtime
 * version. That both poisoned the per-version fleet slicing the dashboard
 * (PRD-484) depends on and is a telemetry-hygiene problem in its own right.
 *
 * Default: egress is enabled only for a packaged (real installed) app. An
 * explicit env override exists for the deliberate cases (an engineer exercising
 * the relay path locally, or a stage build opting in). `OTEL_SDK_DISABLED`
 * remains the full-SDK kill switch; this governs only the egress transport.
 */

/** Opt in/out of telemetry egress regardless of packaging. */
export const DESKTOP_TELEMETRY_EGRESS_ENV_VAR =
  "CLOSEDLOOP_DESKTOP_TELEMETRY_EGRESS";

const EGRESS_ENABLE_VALUES = new Set(["1", "true", "yes"]);
const EGRESS_DISABLE_VALUES = new Set(["0", "false", "no"]);

export type ResolveDesktopTelemetryEgressEnabledInput = {
  /** `app.isPackaged` — true only for a real installed/packaged build. */
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
};

/**
 * Returns whether this launch may egress telemetry over the relay.
 *
 * Resolution order:
 *   1. `CLOSEDLOOP_DESKTOP_TELEMETRY_EGRESS` if set to a recognized value
 *      (`1|true|yes` → enable, `0|false|no` → disable). Trimmed, case-insensitive.
 *   2. Otherwise the packaging default: enabled iff `isPackaged`.
 *
 * An unset/blank/unrecognized override falls through to the packaging default,
 * so a stray empty value can never silently flip prod behavior.
 */
export function resolveDesktopTelemetryEgressEnabled({
  isPackaged,
  env,
}: ResolveDesktopTelemetryEgressEnabledInput): boolean {
  const override = env[DESKTOP_TELEMETRY_EGRESS_ENV_VAR]?.trim().toLowerCase();
  if (override) {
    if (EGRESS_ENABLE_VALUES.has(override)) {
      return true;
    }
    if (EGRESS_DISABLE_VALUES.has(override)) {
      return false;
    }
  }
  return isPackaged;
}
