/**
 * @file renderer-load-failure-source.ts
 * @description Which renderer-lifecycle listener observed a load failure.
 *
 * Split out of `schema.ts` (ISS-7429), which sat two logical lines under the
 * 1,000-line `noExcessiveLinesPerFile` ceiling. One bounded vocabulary per
 * module is the shape this directory already uses
 * (`db-host-telemetry-refusal-reason.ts`, `harness-result-envelope-drop-reason.ts`),
 * reached by direct subpath import so no barrel re-export is introduced.
 */

import { z } from "zod";

/**
 * ISS-6331 — which renderer-lifecycle listener observed a load failure. The
 * desktop mirror is `RendererLoadFailureSource` in
 * `apps/desktop/src/main/telemetry/telemetry-protocol.ts`; a value only the
 * producer knows about is rejected by `desktopTelemetryEventSchema`, which drops
 * the WHOLE event as `telemetry.validation_failed` rather than the one field —
 * so a new source MUST be added here in the same change.
 */
export const RendererLoadFailureSource = {
  /** `webContents` `did-fail-load` on the MAIN frame. */
  DidFailLoad: "did_fail_load",
  /** `webContents` `preload-error` — the preload script itself threw. */
  PreloadError: "preload_error",
} as const;

export type RendererLoadFailureSource =
  (typeof RendererLoadFailureSource)[keyof typeof RendererLoadFailureSource];

export const RENDERER_LOAD_FAILURE_SOURCE = z.enum(
  Object.values(RendererLoadFailureSource)
);
