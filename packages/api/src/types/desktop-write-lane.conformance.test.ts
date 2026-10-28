import { describe, expect, it } from "vitest";
import { AgentComponentInvocationSyncRejectReason } from "./agent-component-invocation";
import { DesktopAgentSessionsSyncErrorCode } from "./agent-session";
import { DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID } from "./desktop-sync-ack-detail";
import {
  DesktopAgentComponentInvocationSyncRestErrorCode,
  DesktopAnalyticsRestErrorCode,
  DesktopComponentsSyncRestErrorCode,
  DesktopWriteLaneRejectReason,
  DesktopWriteLaneRestErrorCode,
} from "./desktop-write-lane";

/**
 * ISS-8618 (PRD-699 §7.5). `DesktopWriteLaneRejectReason` claims to be the ONE
 * rejection vocabulary of the desktop write lane. Every route's object now
 * initializes from it — `agent-session.ts` was the last holdout and derives as
 * of ISS-10197 — so no route can hold a member the canonical set does not.
 *
 * Deriving does not close the VALUE side, which is what an installed desktop
 * actually dispatches on. An initializer binds a member to whichever canonical
 * member it NAMES, so `RateLimited: DesktopWriteLaneRejectReason.IngestionFailed`
 * leaves both the canonical set and every emitted set unchanged while
 * `/desktop/agent-sessions/sync` starts answering a 429 with a string
 * `apps/desktop/src/main/agent-sync/sync-lane-cloud-health.ts` maps to a
 * different reason. Two cases compose to close it: the per-object cases pin
 * each route member to the canonical member it names, and `EXPECTED_WIRE_VALUES`
 * pins each canonical member to its literal string. The two set-direction cases
 * pin membership.
 */

/**
 * Every `code` a desktop write-lane route can send, keyed by the object that
 * declares it. Typed `Record<string, string>` on purpose so a member added to
 * one of these objects flows in without this suite having to be edited; the
 * assertions below are what judge it.
 */
const ROUTE_VOCABULARIES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "agent-sessions/sync": DesktopAgentSessionsSyncErrorCode,
  "agent-sessions/invocations/sync (ack reason)":
    AgentComponentInvocationSyncRejectReason,
  // ISS-11426: the same route's 403 `code` carrier — a different field from the
  // ack reason above, and both are judged against the canonical set.
  "agent-sessions/invocations/sync (403 code)":
    DesktopAgentComponentInvocationSyncRestErrorCode,
  analytics: DesktopAnalyticsRestErrorCode,
  "components/sync": DesktopComponentsSyncRestErrorCode,
  telemetry: DesktopWriteLaneRestErrorCode,
};

/**
 * The wire strings, spelled independently of the module under test, and keyed
 * by MEMBER NAME rather than by the value type. Now that every route
 * initializes from the canonical const, this table is the only literal pin left
 * on THIS vocabulary, and a value-keyed one cannot carry it: swapping two members
 * (`IngestionFailed: "rate_limited"`) leaves the value union and every emitted
 * set byte-identical, so it compiles and passes while all five routes start
 * answering with each other's strings. Typed
 * `Record<keyof typeof DesktopWriteLaneRejectReason, string>`, so ADDING a
 * reason without spelling it here fails `tsc` rather than passing unchecked.
 */
const EXPECTED_WIRE_VALUES: Record<
  keyof typeof DesktopWriteLaneRejectReason,
  string
> = {
  AnalyticsUnavailable: "analytics_unavailable",
  CaptureFailed: "capture_failed",
  FeatureDisabled: "feature_disabled",
  GenerationConflict: "generation_conflict",
  IngestionFailed: "ingestion_failed",
  InternalError: "internal_error",
  PartConflict: "part_conflict",
  ProtocolUnsupported: "protocol_unsupported",
  RateLimited: "rate_limited",
  SchemaVersionUnsupported: "schema_version_unsupported",
  SessionMissing: "session_missing",
  TargetNotOwned: "target_not_owned",
  ValidationFailed: "validation_failed",
};

describe("desktop write-lane rejection vocabulary", () => {
  it("initializes the agent-session codes from the canonical set", () => {
    expect({ ...DesktopAgentSessionsSyncErrorCode }).toEqual({
      FeatureDisabled: DesktopWriteLaneRejectReason.FeatureDisabled,
      IngestionFailed: DesktopWriteLaneRejectReason.IngestionFailed,
      InternalError: DesktopWriteLaneRejectReason.InternalError,
      RateLimited: DesktopWriteLaneRejectReason.RateLimited,
      TargetNotOwned: DesktopWriteLaneRejectReason.TargetNotOwned,
      ValidationFailed: DesktopWriteLaneRejectReason.ValidationFailed,
    });
  });

  it("initializes the invocation reasons from the canonical set", () => {
    // Not a second literal table: the binding IS the initializer, so the pin
    // that matters is that it stayed one.
    expect({ ...AgentComponentInvocationSyncRejectReason }).toEqual({
      GenerationConflict: DesktopWriteLaneRejectReason.GenerationConflict,
      IngestionFailed: DesktopWriteLaneRejectReason.IngestionFailed,
      PartConflict: DesktopWriteLaneRejectReason.PartConflict,
      ProtocolUnsupported: DesktopWriteLaneRejectReason.ProtocolUnsupported,
      RateLimited: DesktopWriteLaneRejectReason.RateLimited,
      SessionMissing: DesktopWriteLaneRejectReason.SessionMissing,
      ValidationFailed: DesktopWriteLaneRejectReason.ValidationFailed,
    });
  });

  it("pins every canonical member to the wire string it has always sent", () => {
    expect({ ...DesktopWriteLaneRejectReason }).toEqual(EXPECTED_WIRE_VALUES);
  });

  it("carries every route's codes, so no route speaks a private reason", () => {
    const canonical = new Set<string>(
      Object.values(DesktopWriteLaneRejectReason)
    );

    for (const [route, vocabulary] of Object.entries(ROUTE_VOCABULARIES)) {
      for (const code of Object.values(vocabulary)) {
        expect(
          canonical.has(code),
          `${route} can send "${code}", which is not a DesktopWriteLaneRejectReason`
        ).toBe(true);
      }
    }
  });

  it("carries no reason no route can send", () => {
    const emitted = new Set<string>(
      Object.values(ROUTE_VOCABULARIES).flatMap((vocabulary) =>
        Object.values(vocabulary)
      )
    );

    for (const reason of Object.values(DesktopWriteLaneRejectReason)) {
      expect(
        emitted.has(reason),
        `"${reason}" is canonical but no desktop write-lane route emits it`
      ).toBe(true);
    }
  });

  it("keeps the details.reason carrier outside the code vocabulary", () => {
    // Same lane, different field: `code` is the rejection, `details.reason`
    // qualifies one. Folding them would let a `code`-only consumer believe it
    // had enumerated every reason the lane can answer with.
    expect(DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID).toBe(
      "compute_target_id_invalid"
    );
    expect(
      new Set<string>(Object.values(DesktopWriteLaneRejectReason)).has(
        DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID
      )
    ).toBe(false);
  });
});
