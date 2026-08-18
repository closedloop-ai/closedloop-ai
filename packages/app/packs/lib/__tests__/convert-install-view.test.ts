/**
 * @file convert-install-view.test.ts
 * @description Unit coverage for the pure convert→install view-model + phase
 * state machine (FEA-4080). Behavioral: call the functions with capability
 * fixtures resolved from the real FEA-4078 map and assert the resolved summary
 * state, the block/confirm predicates, the PackInstallState treatment mapping,
 * and the confirm transition. No DOM, no timing, no source scans.
 */

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import {
  ConvertFailureClass,
  ConvertInstallState,
} from "@repo/api/src/types/convert-install";
import {
  ConversionSupport,
  resolveConversionCapability,
} from "@repo/api/src/types/harness-conversion";
import { HarnessName } from "@repo/crewd/model";
import { describe, expect, it } from "vitest";
import {
  ConvertInstallPhase,
  ConvertInstallSummaryState,
  conversionIdentityKey,
  convertInstallPhaseForOutcome,
  displaySummaryState,
  isBlockedSummaryState,
  isRetryableFailure,
  phaseAfterConfirm,
  requiresLossConfirm,
  resolveConvertInstallSummaryState,
  summaryPackInstallState,
} from "../convert-install-view";
import { PackInstallState } from "../install-state";

// Real capability cells from the FEA-4078 map, so the fixtures can't drift from
// the contract the Sheet actually reads.
const cleanCapability = resolveConversionCapability(
  AgentComponentKind.Skill,
  HarnessName.Codex,
  HarnessName.Claude
);
const partialCapability = resolveConversionCapability(
  AgentComponentKind.Subagent,
  HarnessName.Claude,
  HarnessName.Codex
);
const unsupportedCapability = resolveConversionCapability(
  AgentComponentKind.Hook,
  HarnessName.Claude,
  HarnessName.Codex
);

describe("resolveConvertInstallSummaryState", () => {
  it("maps a lossless capability to Clean", () => {
    expect(cleanCapability.support).toBe(ConversionSupport.Supported);
    expect(
      resolveConvertInstallSummaryState({
        capability: cleanCapability,
        targetOffline: false,
      })
    ).toBe(ConvertInstallSummaryState.Clean);
  });

  it("maps a lossy capability to Partial", () => {
    expect(partialCapability.support).toBe(ConversionSupport.Partial);
    expect(partialCapability.droppedFields.length).toBeGreaterThan(0);
    expect(
      resolveConvertInstallSummaryState({
        capability: partialCapability,
        targetOffline: false,
      })
    ).toBe(ConvertInstallSummaryState.Partial);
  });

  it("maps an impossible capability to Unsupported", () => {
    expect(unsupportedCapability.support).toBe(ConversionSupport.Unsupported);
    expect(
      resolveConvertInstallSummaryState({
        capability: unsupportedCapability,
        targetOffline: false,
      })
    ).toBe(ConvertInstallSummaryState.Unsupported);
  });

  it("blocks with Offline even when the convert WOULD succeed", () => {
    // A clean-convertible component still can't install on an unreachable
    // target — offline wins over the capability verdict.
    expect(
      resolveConvertInstallSummaryState({
        capability: cleanCapability,
        targetOffline: true,
      })
    ).toBe(ConvertInstallSummaryState.Offline);
  });
});

describe("isBlockedSummaryState", () => {
  it("blocks unsupported and offline; allows clean/partial", () => {
    expect(isBlockedSummaryState(ConvertInstallSummaryState.Unsupported)).toBe(
      true
    );
    expect(isBlockedSummaryState(ConvertInstallSummaryState.Offline)).toBe(
      true
    );
    expect(isBlockedSummaryState(ConvertInstallSummaryState.Clean)).toBe(false);
    expect(isBlockedSummaryState(ConvertInstallSummaryState.Partial)).toBe(
      false
    );
  });
});

describe("requiresLossConfirm", () => {
  it("requires an explicit loss confirm only for the partial state", () => {
    expect(requiresLossConfirm(ConvertInstallSummaryState.Partial)).toBe(true);
    expect(requiresLossConfirm(ConvertInstallSummaryState.Clean)).toBe(false);
  });
});

describe("summaryPackInstallState", () => {
  it("reuses the FEA-4083 PackInstallState treatment for every summary state", () => {
    const cases: [ConvertInstallSummaryState, PackInstallState][] = [
      [ConvertInstallSummaryState.Clean, PackInstallState.NotInstalled],
      [ConvertInstallSummaryState.Partial, PackInstallState.NotInstalled],
      [ConvertInstallSummaryState.Unsupported, PackInstallState.Unsupported],
      [ConvertInstallSummaryState.Offline, PackInstallState.Offline],
      [ConvertInstallSummaryState.Converting, PackInstallState.Converting],
      [ConvertInstallSummaryState.Error, PackInstallState.Failed],
    ];
    for (const [summary, expected] of cases) {
      expect(summaryPackInstallState(summary)).toBe(expected);
    }
  });
});

describe("displaySummaryState", () => {
  it("overrides the resting summary with the live converting/error phase", () => {
    expect(
      displaySummaryState({
        summaryState: ConvertInstallSummaryState.Clean,
        phase: ConvertInstallPhase.Converting,
      })
    ).toBe(ConvertInstallSummaryState.Converting);
    expect(
      displaySummaryState({
        summaryState: ConvertInstallSummaryState.Partial,
        phase: ConvertInstallPhase.Error,
      })
    ).toBe(ConvertInstallSummaryState.Error);
  });

  it("falls through to the resting summary in preview", () => {
    expect(
      displaySummaryState({
        summaryState: ConvertInstallSummaryState.Unsupported,
        phase: ConvertInstallPhase.Preview,
      })
    ).toBe(ConvertInstallSummaryState.Unsupported);
  });
});

describe("phaseAfterConfirm", () => {
  it("starts converting from a clean preview", () => {
    expect(
      phaseAfterConfirm({
        phase: ConvertInstallPhase.Preview,
        summaryState: ConvertInstallSummaryState.Clean,
      })
    ).toBe(ConvertInstallPhase.Converting);
  });

  it("starts converting from a partial preview (after the loss confirm)", () => {
    expect(
      phaseAfterConfirm({
        phase: ConvertInstallPhase.Preview,
        summaryState: ConvertInstallSummaryState.Partial,
      })
    ).toBe(ConvertInstallPhase.Converting);
  });

  it("retries converting from the error phase", () => {
    expect(
      phaseAfterConfirm({
        phase: ConvertInstallPhase.Error,
        summaryState: ConvertInstallSummaryState.Clean,
      })
    ).toBe(ConvertInstallPhase.Converting);
  });

  it("never advances a blocked summary out of preview", () => {
    for (const blocked of [
      ConvertInstallSummaryState.Unsupported,
      ConvertInstallSummaryState.Offline,
    ]) {
      expect(
        phaseAfterConfirm({
          phase: ConvertInstallPhase.Preview,
          summaryState: blocked,
        })
      ).toBe(ConvertInstallPhase.Preview);
    }
  });

  it("is a no-op while already converting", () => {
    expect(
      phaseAfterConfirm({
        phase: ConvertInstallPhase.Converting,
        summaryState: ConvertInstallSummaryState.Clean,
      })
    ).toBe(ConvertInstallPhase.Converting);
  });
});

describe("convertInstallPhaseForOutcome", () => {
  it("lands a lossless install in Done", () => {
    expect(convertInstallPhaseForOutcome(ConvertInstallState.Installed)).toBe(
      ConvertInstallPhase.Done
    );
  });

  it("lands a lossy (partial) install in Done", () => {
    expect(convertInstallPhaseForOutcome(ConvertInstallState.Partial)).toBe(
      ConvertInstallPhase.Done
    );
  });

  it("keeps a still-streaming launch in Converting, not Done", () => {
    // A clean convert's engine outcome is `Converting` (the run was launched and
    // streams to completion). The Sheet must NOT claim it finished.
    expect(convertInstallPhaseForOutcome(ConvertInstallState.Converting)).toBe(
      ConvertInstallPhase.Converting
    );
  });

  it("surfaces the retryable error phase for an error outcome", () => {
    expect(convertInstallPhaseForOutcome(ConvertInstallState.Error)).toBe(
      ConvertInstallPhase.Error
    );
  });

  it("maps a post-launch unsupported outcome to the error phase", () => {
    expect(convertInstallPhaseForOutcome(ConvertInstallState.Unsupported)).toBe(
      ConvertInstallPhase.Error
    );
  });
});

describe("isRetryableFailure", () => {
  it("keeps retry available for a transient failure", () => {
    expect(isRetryableFailure(ConvertFailureClass.Transient)).toBe(true);
  });

  it("blocks retry for a permanent failure", () => {
    expect(isRetryableFailure(ConvertFailureClass.Permanent)).toBe(false);
  });

  it("blocks retry for the not-applicable (unsupported) permanent subtype", () => {
    expect(isRetryableFailure(ConvertFailureClass.NotApplicable)).toBe(false);
  });

  it("degrades an unclassified failure to retryable (older producer)", () => {
    // An older desktop producer that predates `failureClass`, or a rejected
    // engine call that left no outcome, must stay retryable so it degrades
    // safely per the cross-repo compatibility rule.
    expect(isRetryableFailure(undefined)).toBe(true);
  });
});

describe("conversionIdentityKey", () => {
  const base = {
    packId: "pack-1",
    currentHarness: HarnessName.Codex,
    targetHarness: HarnessName.Claude,
    sourceHarness: HarnessName.Codex,
  };

  it("changes when the target harness changes on the same pack", () => {
    // The stale-phase bug: same packId, different target — the key MUST differ
    // so the Sheet body remounts and a stale in-flight result can't paint Done
    // against the new target.
    const toClaude = conversionIdentityKey(base);
    const toOpencode = conversionIdentityKey({
      ...base,
      targetHarness: HarnessName.Opencode,
    });
    expect(toClaude).not.toBe(toOpencode);
  });

  it("changes when the current (from) harness changes on the same pack", () => {
    const fromCodex = conversionIdentityKey(base);
    const fromOpencode = conversionIdentityKey({
      ...base,
      currentHarness: HarnessName.Opencode,
    });
    expect(fromCodex).not.toBe(fromOpencode);
  });

  it("changes when the source provenance changes on the same pack", () => {
    const provCodex = conversionIdentityKey(base);
    const provClaude = conversionIdentityKey({
      ...base,
      sourceHarness: HarnessName.Claude,
    });
    expect(provCodex).not.toBe(provClaude);
  });

  it("is stable across calls for an identical conversion identity", () => {
    expect(conversionIdentityKey(base)).toBe(
      conversionIdentityKey({ ...base })
    );
  });

  it("defaults an omitted source provenance to the current harness", () => {
    // A never-converted component (no sourceHarness) whose current format equals
    // its provenance must key identically to one that names it explicitly.
    const { sourceHarness: _omit, ...noProvenance } = base;
    expect(conversionIdentityKey(noProvenance)).toBe(
      conversionIdentityKey(base)
    );
  });
});
