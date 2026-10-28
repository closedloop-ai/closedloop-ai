/**
 * @file update-attempt-record.ts
 * @description ISS-7247: the persisted upgrade-attempt record and the pure
 * decisions over it. Pure so the outcome that matters most — an install that
 * reports `install_started` and returns on the OLD version is a FAILURE — is
 * decided in one place testable without Electron, a filesystem, or a restart.
 */
import {
  UpdateEvent,
  UpdateFailureReason,
} from "@closedloop-ai/telemetry-contract/app";
import { z } from "zod";
import type { DesktopUpdateEventInput } from "../telemetry/app-otel-runtime-update.js";

/**
 * The upgrade expectation carried across the restart boundary.
 *
 * `.strict()` because the types do not constrain this: the file was written by a
 * DIFFERENT BUILD, and may be truncated by a crash mid-write. A record that does
 * not parse is discarded rather than trusted.
 */
export const PendingUpdateAttemptSchema = z
  .object({
    fromVersion: z.string().min(1),
    toVersion: z.string().min(1),
    /**
     * Boots that reached reconciliation with telemetry live. Persisted BEFORE
     * the terminal record is emitted, so a boot that dies before it can report
     * still leaves its evidence behind.
     */
    bootAttempts: z.number().int().min(0),
  })
  .strict();

/** The parsed pending-attempt record. */
export type PendingUpdateAttempt = z.infer<typeof PendingUpdateAttemptSchema>;

/**
 * LOOSE where the attempt is strict, because builds that predate its fields read
 * it: a downgrade after a bad release must not make an older build discard a
 * newer build's file and reset the ISS-7225 age stamp to 0. An unparseable
 * attempt degrades to "no attempt" rather than taking the stamp with it.
 */
export const UpdateTelemetryStateSchema = z
  .object({
    pendingAttempt: PendingUpdateAttemptSchema.optional().catch(undefined),
    /** ISS-7225: the version this install is on, and when it first ran it. */
    installedVersion: z.string().min(1).optional().catch(undefined),
    installedVersionFirstSeenAtMs: z
      .number()
      .int()
      .min(0)
      .optional()
      .catch(undefined),
  })
  .loose();

/** The parsed on-disk update-telemetry state. */
export type UpdateTelemetryState = z.infer<typeof UpdateTelemetryStateSchema>;

/** Substrings that identify a code-signing / notarization staging failure. */
const SIGNATURE_ERROR_MARKERS = [
  "code signature",
  "codesign",
  "notariz",
  "signature",
  "not signed",
];
/** Substrings that identify a filesystem permission failure. */
const PERMISSION_ERROR_MARKERS = ["eacces", "eperm", "permission denied"];
/** Substrings that identify an out-of-disk failure. */
const DISK_ERROR_MARKERS = ["enospc", "no space left", "disk full"];
/** Substrings that identify a transport failure fetching the artifact. */
const DOWNLOAD_ERROR_MARKERS = [
  "econnreset",
  "etimedout",
  "enotfound",
  "socket hang up",
  "net::",
  "download",
  "status code 4",
  "status code 5",
];

/**
 * Exists so the MESSAGE never travels: an electron-updater staging error embeds
 * the bundle's absolute path, which on macOS names the user, and this lane is
 * keyless. Order is precedence — the specific diagnoses beat the broad download
 * bucket, so "failed to download update: EACCES" reads as permission. An
 * unrecognized message degrades to `unknown`, never a confident wrong reason.
 */
export function classifyUpdateFailureReason(
  message: string
): UpdateFailureReason {
  const normalized = message.toLowerCase();
  if (SIGNATURE_ERROR_MARKERS.some((marker) => normalized.includes(marker))) {
    return UpdateFailureReason.Signature;
  }
  if (PERMISSION_ERROR_MARKERS.some((marker) => normalized.includes(marker))) {
    return UpdateFailureReason.Permission;
  }
  if (DISK_ERROR_MARKERS.some((marker) => normalized.includes(marker))) {
    return UpdateFailureReason.Disk;
  }
  if (DOWNLOAD_ERROR_MARKERS.some((marker) => normalized.includes(marker))) {
    return UpdateFailureReason.DownloadError;
  }
  return UpdateFailureReason.Unknown;
}

/**
 * The terminal record for a pending attempt, given the version actually running.
 *
 * - expected build, first surviving boot — the ONLY clean success;
 * - ORIGINAL build — the install did not take and the user is stranded, a
 *   FAILURE however healthy the pre-restart events looked;
 * - expected build on a LATER boot — an earlier boot died before it could
 *   report, so a boot-crash even though the app is now up;
 * - neither — reported as exactly that, not folded into the two above.
 *
 * `bootAttempts` includes this boot, so a clean restart arrives as 1.
 */
export function resolveUpdateAttemptOutcome(
  attempt: PendingUpdateAttempt,
  currentVersion: string
): DesktopUpdateEventInput {
  const base = {
    fromVersion: attempt.fromVersion,
    toVersion: attempt.toVersion,
    bootAttempts: attempt.bootAttempts,
  };
  if (currentVersion === attempt.toVersion) {
    if (attempt.bootAttempts <= 1) {
      return { ...base, event: UpdateEvent.RestartedOnNewVersion };
    }
    return {
      ...base,
      event: UpdateEvent.RestartFailed,
      failureReason: UpdateFailureReason.CrashOnBoot,
    };
  }
  if (currentVersion === attempt.fromVersion) {
    return {
      ...base,
      event: UpdateEvent.RestartFailed,
      failureReason: UpdateFailureReason.VersionUnchanged,
    };
  }
  return {
    ...base,
    event: UpdateEvent.RestartFailed,
    failureReason: UpdateFailureReason.UnexpectedVersion,
  };
}

/** Milliseconds in a day, for the ISS-7225 version-age counter. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * ISS-7225: whole days since this installation first ran its current version.
 *
 * `undefined`, not `0`, when the stamp is missing or in the future (a backwards
 * clock): `0` would read as "upgraded today", the exact opposite of the stuck
 * installation this measure exists to find.
 */
export function resolveCurrentVersionAgeDays(
  firstSeenAtMs: number | undefined,
  nowMs: number
): number | undefined {
  if (firstSeenAtMs === undefined || firstSeenAtMs > nowMs) {
    return undefined;
  }
  return Math.floor((nowMs - firstSeenAtMs) / MS_PER_DAY);
}
