/**
 * @file desktop-client-version.ts
 * @description ISS-8590 — the running desktop build's version, and the trace
 * fragment that carries it, as one owner instead of a private static on
 * {@link Observability}.
 *
 * The trace fragment used to be hand-rolled at each reporter that wanted it, so
 * a reporter outside `observability.ts` could not attach the version at all
 * without reaching a private field. That is why `sync.durable_cursor.stalled`
 * shipped an empty trace: 474 stall events over the 7 days to 2026-09-08 and not
 * one of them said which build produced it.
 */

import type { TelemetryTraceContext } from "./telemetry-protocol.js";

let desktopClientVersion = "";

export function setDesktopClientVersion(version: string): void {
  desktopClientVersion = version;
}

export function getDesktopClientVersion(): string {
  return desktopClientVersion;
}

/**
 * A trace carrying this build's version, or an EMPTY trace when the process
 * never received one — the FEA-2038 db-host child, where `Observability.init`
 * does not run, is the reachable case.
 *
 * Omitted rather than defaulted, per the repo's cross-repo omission rule: a
 * reader must be able to tell "this build did not report a version" from a
 * version it can act on. A placeholder would make the two the same string.
 */
export function buildDesktopClientVersionTrace(): TelemetryTraceContext {
  return desktopClientVersion ? { desktopClientVersion } : {};
}
