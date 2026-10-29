/**
 * @file telemetry-relay-sink.ts
 * @description ISS-7109 — the process-local seam that lets telemetry raised in a
 * DESKTOP CHILD PROCESS reach the one monitored transport, which lives in main.
 *
 * ## Why this exists
 *
 * `Observability.init` has exactly one production call site: the main-process
 * composition root. Every other desktop process — today the FEA-2038 DB-host
 * `utilityProcess`, which owns SQLite, Prisma, every store, and the live hook —
 * loads the same modules but never initialises `Observability`, so its
 * `telemetry` field is null and `telemetry?.emit(event)` silently no-ops.
 *
 * That made every `collector.records_dropped` event ISS-6417 added a discard:
 * the emit ran, returned, and sent nothing. The call site's comment claimed the
 * drop was monitored, and a reviewer reading either half saw correct code.
 * Adding a second bare `emit(...)` there would have looked equally correct and
 * sent equally nothing — a signal cannot leave a child process without a
 * message crossing the process boundary.
 *
 * ## The route
 *
 * A child installs a sink at startup ({@link setTelemetryRelaySink}); the
 * `Observability` emit path consults it FIRST and hands the event to it instead
 * of the local (null) transport. The sink posts the event to main, which
 * re-emits it on the child's behalf on the real transport. That is the same
 * shape as `reportDbHostExitedUnexpectedly` — which works precisely because
 * MAIN observes the child's exit and emits for it.
 *
 * ## Why the registry is a module of its own
 *
 * `observability.ts` reads the sink and the DB-host worker writes it. Putting
 * the registry in either would make the other import it and close an import
 * cycle; keeping it here, importing nothing but a type, leaves both edges
 * one-way. It is deliberately a process-global: it describes WHICH PROCESS this
 * module graph is loaded in, which is a property of the process, not of any
 * caller — and a per-caller option would reintroduce the exact failure this
 * fixes, an unwired seam that no-ops in silence.
 *
 * Main never installs a sink, so `getTelemetryRelaySink()` answers null there
 * and the emit path is byte-for-byte what it was.
 */

import type { TelemetryEventPayload } from "./telemetry-protocol.js";

/**
 * Hands one event to whatever carries telemetry off this process. Must not
 * throw: it is called from arbitrary code paths that treat emitting as
 * fire-and-forget, so a transport failure is the sink's problem to absorb (and
 * report locally), never the caller's.
 */
export type TelemetryRelaySink = (event: TelemetryEventPayload) => void;

let relaySink: TelemetryRelaySink | null = null;

/**
 * Install (or, with `null`, remove) this process's telemetry relay.
 *
 * Call once, at process start, BEFORE any work that can emit. A child that
 * installs it late drops every event raised in the window before installation —
 * which is the defect, not a milder version of it.
 */
export function setTelemetryRelaySink(sink: TelemetryRelaySink | null): void {
  relaySink = sink;
}

/** The installed relay, or `null` in a process that emits directly (main). */
export function getTelemetryRelaySink(): TelemetryRelaySink | null {
  return relaySink;
}
