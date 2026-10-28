/**
 * @file desktop-lifecycle-triggers.ts
 * @description What started a desktop update, a shutdown, or a support upload,
 * and the wire sub-schemas that carry those three lifecycle events.
 *
 * Split out of `schema.ts` (ISS-7429), which sat two logical lines under the
 * 1,000-line `noExcessiveLinesPerFile` ceiling. One bounded vocabulary per
 * module is the shape this directory already uses
 * (`db-host-telemetry-refusal-reason.ts`, `harness-result-envelope-drop-reason.ts`),
 * reached by direct subpath import so no barrel re-export is introduced.
 */

import { z } from "zod";
import {
  clampedDesktopTelemetryString,
  tolerantDesktopTelemetryValue,
} from "./tolerant-desktop-value";

export const SupportUploadReason = {
  Unknown: "unknown",
  AlreadyUploaded: "already_uploaded",
  MissingS3StateKey: "missing_s3_state_key",
  MissingToken: "missing_token",
  NoUploadableFiles: "no_uploadable_files",
  UploadUrlHttpError: "upload_url_http_error",
  UploadUrlMalformedResponse: "upload_url_malformed_response",
  UploadUrlSuccessFalse: "upload_url_success_false",
  UploadUrlMissingUrl: "upload_url_missing_url",
  UploadUrlRequestFailed: "upload_url_request_failed",
  PutUrlDenied: "put_url_denied",
  PutHttpError: "put_http_error",
  PutRequestFailed: "put_request_failed",
  EventPostFailed: "event_post_failed",
} as const;

export type SupportUploadReason =
  (typeof SupportUploadReason)[keyof typeof SupportUploadReason];

export const DesktopUpdateTrigger = {
  Unknown: "unknown",
  UpdaterError: "updater-error",
  CheckForUpdates: "check-for-updates",
  ManualCheck: "manual-check",
  ApplyBeforeDownloaded: "apply-before-downloaded",
  RendererApplyUpdate: "renderer-apply-update",
  GatewayApplyUpdate: "gateway-apply-update",
  InstallBlockedReadOnlyVolume: "install-blocked-read-only-volume",
} as const;

export type DesktopUpdateTrigger =
  (typeof DesktopUpdateTrigger)[keyof typeof DesktopUpdateTrigger];

export const DesktopShutdownTrigger = {
  Unknown: "unknown",
  BeforeQuit: "before-quit",
  ShutdownSequence: "shutdown-sequence",
  ShutdownRejected: "shutdown-rejected",
  OuterHardExit: "outer-hard-exit",
  UpdateInstallFailed: "update-install-failed",
} as const;

export type DesktopShutdownTrigger =
  (typeof DesktopShutdownTrigger)[keyof typeof DesktopShutdownTrigger];

export const supportUploadDiagnosticsSchema = z.object({
  outcome: z.enum(["started", "skipped", "succeeded", "failed"]),
  loopId: z.string().optional(),
  s3StateKeySuffix: z.string().optional(),
  attemptedLogicalNames: z.array(z.string()).max(4).optional(),
  attemptedUploadedNames: z.array(z.string()).max(4).optional(),
  reason: tolerantDesktopTelemetryValue(SupportUploadReason).optional(),
  uploadedCount: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

/**
 * ISS-7488 — the bound on the two free-text `error` fields below.
 *
 * Unchanged in value; what changed is that overrunning it now CLAMPS instead of
 * failing the event. `status`, `version` and `phase` keep their `.max()` refusal:
 * each is a short producer-chosen token, so an over-long one is a malformed
 * payload rather than skew, and refusing it is the correct answer.
 *
 * Both fields are raw `err.message` with no producer-side scrub, so clamping
 * rather than refusing admits the head of a long error that used to cost the
 * whole event. `sanitizeDesktopTelemetryDiagnostics` scrubs credentials and
 * home-rooted paths out of both before anything is logged — the length bound
 * here is a payload bound, never the confidentiality one.
 */
const DESKTOP_LIFECYCLE_ERROR_MAX_CHARS = 512;

export const desktopUpdateDiagnosticsSchema = z.object({
  trigger: tolerantDesktopTelemetryValue(DesktopUpdateTrigger),
  status: z.string().max(64).optional(),
  version: z.string().max(64).optional(),
  percent: z.number().min(0).max(100).optional(),
  error: clampedDesktopTelemetryString(
    DESKTOP_LIFECYCLE_ERROR_MAX_CHARS
  ).optional(),
  downloaded: z.boolean().optional(),
  readyToInstall: z.boolean().optional(),
});

export const desktopShutdownDiagnosticsSchema = z.object({
  trigger: tolerantDesktopTelemetryValue(DesktopShutdownTrigger),
  result: z.enum(["timed_out", "failed"]).optional(),
  phase: z.string().max(128).optional(),
  duringUpdate: z.boolean().optional(),
  outerHardExit: z.boolean().optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  // ISS-7488 — clamped for the same reason as its update sibling above. Not a
  // measured rejection path, but the identical field composed from the identical
  // unbounded source; leaving one of the pair refusing would have re-opened the
  // defect on the next long shutdown error.
  error: clampedDesktopTelemetryString(
    DESKTOP_LIFECYCLE_ERROR_MAX_CHARS
  ).optional(),
});
