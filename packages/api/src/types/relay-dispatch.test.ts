import { describe, expect, it } from "vitest";
import {
  isRelayDispatchDiagnosticReason,
  normalizeLenientRelayDispatchResult,
  RelayDispatchConditionRationale,
  RelayDispatchDiagnosticReason,
  RelayDispatchMetadataLimit,
  RelayDispatchReason,
  relayDispatchNotDelivered,
  relayDispatchResultSchema,
} from "./relay-dispatch";

describe("relay dispatch diagnostic contract", () => {
  it("keeps a rationale entry for every diagnostic reason", () => {
    expect(Object.keys(RelayDispatchConditionRationale).sort()).toEqual(
      Object.values(RelayDispatchDiagnosticReason).sort()
    );
    for (const rationale of Object.values(RelayDispatchConditionRationale)) {
      expect(rationale.reason).toBe(RelayDispatchReason.TargetNotConnected);
      expect(rationale.condition.length).toBeGreaterThan(0);
      expect(rationale.compatibilityRationale.length).toBeGreaterThan(0);
    }
  });

  it("omits absent optional metadata from not-delivered envelopes", () => {
    const result = relayDispatchNotDelivered(
      RelayDispatchDiagnosticReason.PeerTimeout
    );

    expect(JSON.parse(JSON.stringify(result))).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerTimeout,
    });
    expect("peerStatusCode" in result).toBe(false);
    expect("peerErrorCode" in result).toBe(false);
  });

  it("carries bounded peer metadata when present", () => {
    expect(
      relayDispatchNotDelivered(RelayDispatchDiagnosticReason.PeerHttpNotOk, {
        peerStatusCode: 503,
      })
    ).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerHttpNotOk,
      peerStatusCode: 503,
    });
  });

  it("carries a bounded peer error code when present, with no status code", () => {
    const result = relayDispatchNotDelivered(
      RelayDispatchDiagnosticReason.PeerNetworkFailed,
      { peerErrorCode: "ECONNRESET" }
    );
    expect(result).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerNetworkFailed,
      peerErrorCode: "ECONNRESET",
    });
    expect("peerStatusCode" in result).toBe(false);
  });

  it("drops unsafe diagnostic metadata at the strict wire boundary", () => {
    const result = relayDispatchResultSchema.parse({
      delivered: false,
      reason: "x".repeat(RelayDispatchMetadataLimit.ReasonMaxLength + 1),
      diagnosticReason: "x".repeat(
        RelayDispatchMetadataLimit.DiagnosticReasonMaxLength + 1
      ),
      peerStatusCode: 99,
      peerErrorCode: "x".repeat(
        RelayDispatchMetadataLimit.PeerErrorCodeMaxLength + 1
      ),
    });

    expect(JSON.parse(JSON.stringify(result))).toEqual({
      delivered: false,
    });
  });

  it("preserves bounded future diagnostics without changing lenient delivery fallback", () => {
    expect(
      normalizeLenientRelayDispatchResult(
        {
          delivered: "not-a-boolean",
          reason: "future_reason",
          diagnosticReason: "future_diagnostic",
          peerErrorCode: "ECONNRESET",
        },
        true
      )
    ).toEqual({
      delivered: true,
      reason: "future_reason",
      diagnosticReason: "future_diagnostic",
      peerErrorCode: "ECONNRESET",
    });
  });

  it("falls back to fallbackDelivered when the input does not parse at all", () => {
    expect(normalizeLenientRelayDispatchResult(null, true)).toEqual({
      delivered: true,
    });
    expect(normalizeLenientRelayDispatchResult(null, false)).toEqual({
      delivered: false,
    });
  });

  it("carries a real boolean delivered field and a bounded peer status code through", () => {
    expect(
      normalizeLenientRelayDispatchResult(
        { delivered: false, peerStatusCode: 502 },
        true
      )
    ).toEqual({
      delivered: false,
      peerStatusCode: 502,
    });
  });
});

describe("isRelayDispatchDiagnosticReason", () => {
  it("accepts every known diagnostic reason value", () => {
    for (const reason of Object.values(RelayDispatchDiagnosticReason)) {
      expect(isRelayDispatchDiagnosticReason(reason)).toBe(true);
    }
  });

  it("rejects an unknown string", () => {
    expect(isRelayDispatchDiagnosticReason("not_a_reason")).toBe(false);
  });

  it("rejects a non-string value", () => {
    expect(isRelayDispatchDiagnosticReason(42)).toBe(false);
    expect(isRelayDispatchDiagnosticReason(undefined)).toBe(false);
  });
});
