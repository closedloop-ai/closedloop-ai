import { ComponentResolvedState } from "@repo/api/src/types/agent-component";
import type { ComponentResolutionInput } from "@repo/api/src/types/component-resolution";
import { describe, expect, it } from "vitest";
import {
  DefinitionAbsenceReason,
  deriveDefinitionAbsence,
} from "../definition-absence";

// NORMALIZER_CONTRACT_VERSION is 1 — any other value forces a contract-mismatch
// refinement of the `resolved` raw state.
const MISMATCHED_CONTRACT_VERSION = 2;

describe("deriveDefinitionAbsence", () => {
  it("reports NeverRecorded for an unresolved (name-only) component", () => {
    const resolution: ComponentResolutionInput = {
      resolvedState: ComponentResolvedState.Unresolved,
    };

    expect(deriveDefinitionAbsence(resolution).reason).toBe(
      DefinitionAbsenceReason.NeverRecorded
    );
  });

  it("reports Unavailable for an inaccessible component", () => {
    const resolution: ComponentResolutionInput = {
      resolvedState: ComponentResolvedState.Inaccessible,
    };

    expect(deriveDefinitionAbsence(resolution).reason).toBe(
      DefinitionAbsenceReason.Unavailable
    );
  });

  it("reports Unavailable for a missing component", () => {
    const resolution: ComponentResolutionInput = {
      resolvedState: ComponentResolvedState.Missing,
    };

    expect(deriveDefinitionAbsence(resolution).reason).toBe(
      DefinitionAbsenceReason.Unavailable
    );
  });

  it("reports Unavailable for a malformed (unrecognized) resolution shape", () => {
    const resolution: ComponentResolutionInput = {
      resolvedState: "some-unrecognized-shape",
    };

    expect(deriveDefinitionAbsence(resolution).reason).toBe(
      DefinitionAbsenceReason.Unavailable
    );
  });

  it("reports Unavailable for a resolved component whose body was not captured", () => {
    const resolution: ComponentResolutionInput = {
      resolvedState: ComponentResolvedState.Resolved,
    };

    expect(deriveDefinitionAbsence(resolution, false).reason).toBe(
      DefinitionAbsenceReason.Unavailable
    );
  });

  it("reports Unavailable for a resolved component when bodyCaptured is omitted (defaults false)", () => {
    const resolution: ComponentResolutionInput = {
      resolvedState: ComponentResolvedState.Resolved,
    };

    expect(deriveDefinitionAbsence(resolution).reason).toBe(
      DefinitionAbsenceReason.Unavailable
    );
  });

  it("reports CapturedEmpty for a resolved component with a genuinely captured body", () => {
    const resolution: ComponentResolutionInput = {
      resolvedState: ComponentResolvedState.Resolved,
    };

    expect(deriveDefinitionAbsence(resolution, true).reason).toBe(
      DefinitionAbsenceReason.CapturedEmpty
    );
  });

  it("reports CapturedEmpty for a stale-definition component with a captured body", () => {
    const resolution: ComponentResolutionInput = {
      resolvedState: ComponentResolvedState.Resolved,
      observedDefinitionHash: "hash-observed",
      currentDefinitionHash: "hash-current",
    };

    expect(deriveDefinitionAbsence(resolution, true).reason).toBe(
      DefinitionAbsenceReason.CapturedEmpty
    );
  });

  it("reports Unavailable for a stale-definition component whose body was not captured", () => {
    const resolution: ComponentResolutionInput = {
      resolvedState: ComponentResolvedState.Resolved,
      observedDefinitionHash: "hash-observed",
      currentDefinitionHash: "hash-current",
    };

    expect(deriveDefinitionAbsence(resolution, false).reason).toBe(
      DefinitionAbsenceReason.Unavailable
    );
  });

  it("reports CapturedEmpty for a contract-mismatch component with a captured body", () => {
    const resolution: ComponentResolutionInput = {
      resolvedState: ComponentResolvedState.Resolved,
      normalizerContractVersion: MISMATCHED_CONTRACT_VERSION,
    };

    expect(deriveDefinitionAbsence(resolution, true).reason).toBe(
      DefinitionAbsenceReason.CapturedEmpty
    );
  });

  it("reports Unavailable for a contract-mismatch component whose body was not captured", () => {
    const resolution: ComponentResolutionInput = {
      resolvedState: ComponentResolvedState.Resolved,
      normalizerContractVersion: MISMATCHED_CONTRACT_VERSION,
    };

    expect(deriveDefinitionAbsence(resolution, false).reason).toBe(
      DefinitionAbsenceReason.Unavailable
    );
  });

  it("never upgrades an unresolved raw state to CapturedEmpty, even with a captured body", () => {
    // The carve-out is scoped to the `resolved` family — an unresolved name-only
    // component stays NeverRecorded regardless of `bodyCaptured`.
    const resolution: ComponentResolutionInput = {
      resolvedState: ComponentResolvedState.Unresolved,
    };

    expect(deriveDefinitionAbsence(resolution, true).reason).toBe(
      DefinitionAbsenceReason.NeverRecorded
    );
  });

  it("never upgrades an unavailable raw state to CapturedEmpty, even with a captured body", () => {
    const resolution: ComponentResolutionInput = {
      resolvedState: ComponentResolvedState.Missing,
    };

    expect(deriveDefinitionAbsence(resolution, true).reason).toBe(
      DefinitionAbsenceReason.Unavailable
    );
  });

  it.each([
    DefinitionAbsenceReason.NeverRecorded,
    DefinitionAbsenceReason.Unavailable,
    DefinitionAbsenceReason.CapturedEmpty,
  ])("gives %s a non-empty title and description", (reason) => {
    const resolutionByReason: Record<
      DefinitionAbsenceReason,
      ComponentResolutionInput
    > = {
      [DefinitionAbsenceReason.NeverRecorded]: {
        resolvedState: ComponentResolvedState.Unresolved,
      },
      [DefinitionAbsenceReason.Unavailable]: {
        resolvedState: ComponentResolvedState.Missing,
      },
      [DefinitionAbsenceReason.CapturedEmpty]: {
        resolvedState: ComponentResolvedState.Resolved,
      },
    };
    const bodyCapturedByReason: Record<DefinitionAbsenceReason, boolean> = {
      [DefinitionAbsenceReason.NeverRecorded]: false,
      [DefinitionAbsenceReason.Unavailable]: false,
      [DefinitionAbsenceReason.CapturedEmpty]: true,
    };

    const copy = deriveDefinitionAbsence(
      resolutionByReason[reason],
      bodyCapturedByReason[reason]
    );

    expect(copy.reason).toBe(reason);
    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.description.length).toBeGreaterThan(0);
  });

  it("gives each reason a distinct title", () => {
    const never = deriveDefinitionAbsence({
      resolvedState: ComponentResolvedState.Unresolved,
    });
    const unavailable = deriveDefinitionAbsence({
      resolvedState: ComponentResolvedState.Missing,
    });
    const captured = deriveDefinitionAbsence(
      { resolvedState: ComponentResolvedState.Resolved },
      true
    );

    const titles = new Set([never.title, unavailable.title, captured.title]);
    expect(titles.size).toBe(3);
  });
});
