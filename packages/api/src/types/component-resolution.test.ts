/**
 * FEA-3704: regression coverage for the shared resolution DISPLAY model. Locks
 * the honest state derivation the AC enumerates: resolved/unresolved transitions,
 * definition-hash changes (stale), unknown normalizer contract (contract
 * mismatch), unavailable (inaccessible vs missing kept distinct upstream but both
 * honest), malformed, and older-client optional-field compatibility.
 */
import { describe, expect, it } from "vitest";
import { NORMALIZER_CONTRACT_VERSION } from "../definition-fingerprint.js";
import { ComponentResolvedState } from "./agent-component.js";
import {
  COMPONENT_RESOLUTION_LABELS,
  ComponentResolutionDisplayState,
  deriveResolutionDisplay,
  foldResolvedState,
  RESOLVED_STATE_PRECEDENCE,
  reduceResolvedState,
  resolutionLabel,
} from "./component-resolution.js";

describe("deriveResolutionDisplay", () => {
  it("maps a bare resolved row to resolved", () => {
    expect(
      deriveResolutionDisplay({
        resolvedState: ComponentResolvedState.Resolved,
      })
    ).toBe(ComponentResolutionDisplayState.Resolved);
  });

  it("maps unresolved to unresolved", () => {
    expect(
      deriveResolutionDisplay({
        resolvedState: ComponentResolvedState.Unresolved,
      })
    ).toBe(ComponentResolutionDisplayState.Unresolved);
  });

  it("maps inaccessible AND missing to unavailable (never collapsed together upstream, both honest here)", () => {
    expect(
      deriveResolutionDisplay({
        resolvedState: ComponentResolvedState.Inaccessible,
      })
    ).toBe(ComponentResolutionDisplayState.Unavailable);
    expect(
      deriveResolutionDisplay({ resolvedState: ComponentResolvedState.Missing })
    ).toBe(ComponentResolutionDisplayState.Unavailable);
  });

  it("maps an unknown/absent raw state to malformed — NEVER resolved", () => {
    expect(deriveResolutionDisplay({ resolvedState: "banana" })).toBe(
      ComponentResolutionDisplayState.Malformed
    );
    expect(deriveResolutionDisplay({ resolvedState: null })).toBe(
      ComponentResolutionDisplayState.Malformed
    );
    expect(deriveResolutionDisplay({ resolvedState: undefined })).toBe(
      ComponentResolutionDisplayState.Malformed
    );
  });

  it("flags stale-definition when observed != current fingerprint (resolved)", () => {
    expect(
      deriveResolutionDisplay({
        resolvedState: ComponentResolvedState.Resolved,
        observedDefinitionHash: "aaa",
        currentDefinitionHash: "bbb",
        normalizerContractVersion: NORMALIZER_CONTRACT_VERSION,
      })
    ).toBe(ComponentResolutionDisplayState.StaleDefinition);
  });

  it("stays resolved when observed == current fingerprint", () => {
    expect(
      deriveResolutionDisplay({
        resolvedState: ComponentResolvedState.Resolved,
        observedDefinitionHash: "same",
        currentDefinitionHash: "same",
        normalizerContractVersion: NORMALIZER_CONTRACT_VERSION,
      })
    ).toBe(ComponentResolutionDisplayState.Resolved);
  });

  it("flags contract-mismatch for an unknown normalizer contract version", () => {
    expect(
      deriveResolutionDisplay({
        resolvedState: ComponentResolvedState.Resolved,
        normalizerContractVersion: NORMALIZER_CONTRACT_VERSION + 1,
        // Even with a hash mismatch present, the unknown contract wins — the
        // fingerprint can't be trusted for the comparison.
        observedDefinitionHash: "aaa",
        currentDefinitionHash: "bbb",
      })
    ).toBe(ComponentResolutionDisplayState.ContractMismatch);
  });

  it("does NOT upgrade a non-resolved raw state via fingerprint inputs", () => {
    // A missing row with fingerprint noise stays unavailable, not stale/resolved.
    expect(
      deriveResolutionDisplay({
        resolvedState: ComponentResolvedState.Missing,
        observedDefinitionHash: "aaa",
        currentDefinitionHash: "bbb",
        normalizerContractVersion: NORMALIZER_CONTRACT_VERSION + 5,
      })
    ).toBe(ComponentResolutionDisplayState.Unavailable);
  });

  it("older-client optional-field compat: resolved with NO fingerprint fields stays resolved", () => {
    // An older desktop client omits observed/current hash + contract version.
    expect(
      deriveResolutionDisplay({
        resolvedState: ComponentResolvedState.Resolved,
      })
    ).toBe(ComponentResolutionDisplayState.Resolved);
    // A partial fingerprint (only one hash) is not enough to claim stale.
    expect(
      deriveResolutionDisplay({
        resolvedState: ComponentResolvedState.Resolved,
        observedDefinitionHash: "aaa",
      })
    ).toBe(ComponentResolutionDisplayState.Resolved);
  });
});

describe("labels", () => {
  it("has a label for every display state (exhaustive)", () => {
    for (const state of Object.values(ComponentResolutionDisplayState)) {
      const label = COMPONENT_RESOLUTION_LABELS[state];
      expect(label.state).toBe(state);
      expect(label.label.length).toBeGreaterThan(0);
      expect(label.description.length).toBeGreaterThan(0);
    }
  });

  it("resolutionLabel derives state then labels it", () => {
    expect(
      resolutionLabel({ resolvedState: ComponentResolvedState.Resolved }).tone
    ).toBe("positive");
    expect(resolutionLabel({ resolvedState: null }).tone).toBe("danger");
  });

  it("every display state has a UNIQUE visible label (no two states collapse)", () => {
    // The disambiguation this model exists to protect is only real if the labels
    // are pairwise distinct across the WHOLE display-state set. A regression that
    // relabeled e.g. Unresolved → "Resolved" would let the honest "unresolved"
    // and the honest "resolved" render identical text; that must fail HERE, at
    // the SSOT, not silently pass a component test that reads the same map.
    const states = Object.values(ComponentResolutionDisplayState);
    const labels = states.map((s) => COMPONENT_RESOLUTION_LABELS[s].label);
    expect(new Set(labels).size).toBe(states.length);
  });
});

describe("org-level resolution fold (shared by cloud + desktop)", () => {
  it("ranks resolved > inaccessible > unresolved > missing", () => {
    expect(RESOLVED_STATE_PRECEDENCE[ComponentResolvedState.Resolved]).toBe(3);
    expect(RESOLVED_STATE_PRECEDENCE[ComponentResolvedState.Inaccessible]).toBe(
      2
    );
    expect(RESOLVED_STATE_PRECEDENCE[ComponentResolvedState.Unresolved]).toBe(
      1
    );
    expect(RESOLVED_STATE_PRECEDENCE[ComponentResolvedState.Missing]).toBe(0);
  });

  it("foldResolvedState keeps the higher-precedence state (order-independent)", () => {
    expect(
      foldResolvedState(
        ComponentResolvedState.Missing,
        ComponentResolvedState.Resolved
      )
    ).toBe(ComponentResolvedState.Resolved);
    expect(
      foldResolvedState(
        ComponentResolvedState.Resolved,
        ComponentResolvedState.Missing
      )
    ).toBe(ComponentResolvedState.Resolved);
  });

  it("NEVER collapses inaccessible into missing", () => {
    expect(
      foldResolvedState(
        ComponentResolvedState.Inaccessible,
        ComponentResolvedState.Missing
      )
    ).toBe(ComponentResolvedState.Inaccessible);
  });

  it("reduceResolvedState surfaces resolved when ANY device backs it", () => {
    expect(
      reduceResolvedState([
        ComponentResolvedState.Missing,
        ComponentResolvedState.Unresolved,
        ComponentResolvedState.Resolved,
      ])
    ).toBe(ComponentResolvedState.Resolved);
  });

  it("reduceResolvedState returns missing only when every device agrees", () => {
    expect(
      reduceResolvedState([
        ComponentResolvedState.Missing,
        ComponentResolvedState.Missing,
      ])
    ).toBe(ComponentResolvedState.Missing);
  });

  it("reduceResolvedState defaults empty input to unresolved (never resolved)", () => {
    expect(reduceResolvedState([])).toBe(ComponentResolvedState.Unresolved);
  });
});
