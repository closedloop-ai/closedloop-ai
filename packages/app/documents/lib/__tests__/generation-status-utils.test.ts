/**
 * Unit tests for isCommandDisabled — the per-command disabled predicate
 * used by run-loop menu items across feature, plan, and PRD editors.
 */

import type { GenerationStatus } from "@repo/api/src/types/document";
import { describe, expect, it } from "vitest";
import {
  isCommandDisabled,
  isRunInFlightForCommand,
} from "../generation-status-utils";

const makeGenerationStatus = (
  overrides: Partial<GenerationStatus> = {}
): GenerationStatus => ({
  status: "NONE",
  command: null,
  htmlUrl: null,
  startedAt: null,
  completedAt: null,
  correlationId: null,
  ...overrides,
});

describe("isCommandDisabled", () => {
  it("returns true when localMutationPending is true", () => {
    expect(
      isCommandDisabled({
        generationStatus: undefined,
        isLoading: false,
        targetCommand: "evaluate_feature",
        localMutationPending: true,
      })
    ).toBe(true);
  });

  it("returns true when isLoading is true", () => {
    expect(
      isCommandDisabled({
        generationStatus: undefined,
        isLoading: true,
        targetCommand: "evaluate_feature",
        localMutationPending: false,
      })
    ).toBe(true);
  });

  it("returns true when an active loop matches the target command", () => {
    const status = makeGenerationStatus({
      status: "RUNNING",
      command: "evaluate_feature",
    });
    expect(
      isCommandDisabled({
        generationStatus: status,
        isLoading: false,
        targetCommand: "evaluate_feature",
        localMutationPending: false,
      })
    ).toBe(true);
  });

  it("returns true for PENDING status matching target command", () => {
    const status = makeGenerationStatus({
      status: "PENDING",
      command: "plan",
    });
    expect(
      isCommandDisabled({
        generationStatus: status,
        isLoading: false,
        targetCommand: "plan",
        localMutationPending: false,
      })
    ).toBe(true);
  });

  it("returns true for QUEUED status matching target command", () => {
    const status = makeGenerationStatus({
      status: "QUEUED",
      command: "execute",
    });
    expect(
      isCommandDisabled({
        generationStatus: status,
        isLoading: false,
        targetCommand: "execute",
        localMutationPending: false,
      })
    ).toBe(true);
  });

  it("returns false when active loop is for a DIFFERENT command", () => {
    const status = makeGenerationStatus({
      status: "RUNNING",
      command: "evaluate_feature",
    });
    expect(
      isCommandDisabled({
        generationStatus: status,
        isLoading: false,
        targetCommand: "plan",
        localMutationPending: false,
      })
    ).toBe(false);
  });

  it("returns false when status is terminal (SUCCESS)", () => {
    const status = makeGenerationStatus({
      status: "SUCCESS",
      command: "evaluate_feature",
    });
    expect(
      isCommandDisabled({
        generationStatus: status,
        isLoading: false,
        targetCommand: "evaluate_feature",
        localMutationPending: false,
      })
    ).toBe(false);
  });

  it("returns false when status is terminal (FAILURE)", () => {
    const status = makeGenerationStatus({
      status: "FAILURE",
      command: "plan",
    });
    expect(
      isCommandDisabled({
        generationStatus: status,
        isLoading: false,
        targetCommand: "plan",
        localMutationPending: false,
      })
    ).toBe(false);
  });

  it("returns false when no generation status and no loading and no local pending", () => {
    expect(
      isCommandDisabled({
        generationStatus: undefined,
        isLoading: false,
        targetCommand: "evaluate_feature",
        localMutationPending: false,
      })
    ).toBe(false);
  });

  it("returns false when status is NONE", () => {
    const status = makeGenerationStatus({ status: "NONE", command: null });
    expect(
      isCommandDisabled({
        generationStatus: status,
        isLoading: false,
        targetCommand: "plan",
        localMutationPending: false,
      })
    ).toBe(false);
  });
});

/**
 * ISS-5508: the one of `isCommandDisabled`'s three causes a user can be told
 * about. These cases are the whole point of splitting it out — the explanation
 * must never fire on the two causes that say nothing about a run existing.
 */
describe("isRunInFlightForCommand", () => {
  it("is true only while a run of the SAME command is still going", () => {
    for (const status of ["PENDING", "QUEUED", "RUNNING"] as const) {
      expect(
        isRunInFlightForCommand({
          generationStatus: makeGenerationStatus({
            status,
            command: "execute",
          }),
          targetCommand: "execute",
        })
      ).toBe(true);
    }
  });

  it("is false for a settled run, another command, or no status at all", () => {
    for (const status of ["SUCCESS", "FAILURE", "NONE"] as const) {
      expect(
        isRunInFlightForCommand({
          generationStatus: makeGenerationStatus({
            status,
            command: "execute",
          }),
          targetCommand: "execute",
        })
      ).toBe(false);
    }
    expect(
      isRunInFlightForCommand({
        generationStatus: makeGenerationStatus({
          status: "RUNNING",
          command: "plan",
        }),
        targetCommand: "execute",
      })
    ).toBe(false);
    expect(
      isRunInFlightForCommand({
        generationStatus: undefined,
        targetCommand: "execute",
      })
    ).toBe(false);
  });

  it("does NOT follow the disabled predicate's other two causes", () => {
    // A pending local mutation and a still-loading status poll both disable the
    // control. Neither is evidence a run exists, so an explanation driven off
    // `isCommandDisabled` would assert one that is not happening.
    const noRun = {
      generationStatus: undefined,
      targetCommand: "execute" as const,
    };

    expect(isCommandDisabled({ ...noRun, isLoading: true })).toBe(true);
    expect(
      isCommandDisabled({
        ...noRun,
        isLoading: false,
        localMutationPending: true,
      })
    ).toBe(true);
    expect(isRunInFlightForCommand(noRun)).toBe(false);
  });
});
