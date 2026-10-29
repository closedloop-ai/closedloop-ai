/**
 * @file claude-code-telemetry-payload-bound.ts
 * @description ISS-10717 — bounds a Claude Code telemetry payload to the
 * ingest route's byte cap before it is sent.
 *
 * The component cap and the byte cap are two different limits and only one of
 * them was enforced. `DESKTOP_CLAUDE_CODE_TELEMETRY_MAX_COMPONENTS_PER_REQUEST`
 * bounds the component COUNT at 200; the route bounds the BODY at
 * `DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_REQUEST_MAX_BYTES`. A component carries
 * eleven `CLAUDE_CODE_TELEMETRY_TEXT_MAX` strings, so 200 of them is a
 * schema-valid payload several times the byte cap.
 *
 * What made that a wedge rather than a dropped session: the route answers 413,
 * and the client reads 413 as LANE-WIDE (deliberately — the producer is supposed
 * to bound its own body against this same shared cap, so a 413 could only mean
 * the deployed cap disagrees with this build's). With no producer-side bound
 * that assumption was simply false, and the oversized session returned to the
 * head of an oldest-owed-first queue every tick with the rest of the corpus
 * behind it. This module makes the client's assumption true.
 *
 * Components are shed from the TAIL, which is the cheapest end: the producer
 * already orders them by cost descending, so what survives is what a reader asks
 * about. Every shed sets `componentsTruncated`, so the cloud keeps the tail it
 * already holds instead of deleting what this request could not carry — the same
 * contract the count cap uses.
 */

import type {
  DesktopClaudeCodeComponentTelemetryInput,
  DesktopClaudeCodeDropCounterInput,
  DesktopClaudeCodeSessionTelemetryInput,
} from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import {
  DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_PROTOCOL_VERSION,
  DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_REQUEST_MAX_BYTES,
} from "@repo/api/src/types/desktop-claude-code-telemetry-sync";

/**
 * Shed components until the serialized request fits the route's cap.
 *
 * Returns the session unchanged when it already fits, which is every ordinary
 * session. The envelope is measured WHOLE — protocol version and drop counters
 * included — because that is what the route weighs, not the session alone.
 *
 * A payload that cannot fit even with zero components is returned at zero rather
 * than pretended to fit: the counters are the irreducible part and trimming them
 * would under-report the machine's shortfall, which is the one number this lane
 * exists to make honest.
 */
export function boundClaudeCodeTelemetryPayload(input: {
  session: DesktopClaudeCodeSessionTelemetryInput;
  dropCounters: readonly DesktopClaudeCodeDropCounterInput[];
}): DesktopClaudeCodeSessionTelemetryInput {
  const { session, dropCounters } = input;
  if (fitsRequestCap(session, dropCounters)) {
    return session;
  }
  // Binary search on the kept PREFIX rather than popping one at a time: the
  // prefix is cost-ordered so "fits" is monotonic in its length, and a linear
  // shed would serialize an over-cap payload once per component.
  const all = session.components ?? [];
  let low = 0;
  let high = all.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (fitsRequestCap(shedTo(session, all, mid), dropCounters)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return shedTo(session, all, low);
}

function fitsRequestCap(
  session: DesktopClaudeCodeSessionTelemetryInput,
  dropCounters: readonly DesktopClaudeCodeDropCounterInput[]
): boolean {
  const body = JSON.stringify({
    protocolVersion: DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_PROTOCOL_VERSION,
    session,
    dropCounters,
  });
  return (
    Buffer.byteLength(body, "utf8") <=
    DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_REQUEST_MAX_BYTES
  );
}

function shedTo(
  session: DesktopClaudeCodeSessionTelemetryInput,
  all: readonly DesktopClaudeCodeComponentTelemetryInput[],
  keep: number
): DesktopClaudeCodeSessionTelemetryInput {
  return {
    ...session,
    components: all.slice(0, keep),
    componentsTruncated: true,
  };
}
