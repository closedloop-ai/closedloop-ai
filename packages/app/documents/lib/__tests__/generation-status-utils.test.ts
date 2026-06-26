/**
 * Unit tests for isCommandDisabled — the per-command disabled predicate
 * used by run-loop menu items across feature, plan, and PRD editors.
 */

import type { GenerationStatus } from "@repo/api/src/types/document";
import { describe, expect, it } from "vitest";
import {
  getStatusMessage,
  isCommandDisabled,
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

describe("getStatusMessage", () => {
  it("returns a waiting message for PENDING", () => {
    expect(getStatusMessage("PENDING", "execute")).toBe("Waiting to start...");
  });

  it("returns a command-specific queued message for QUEUED", () => {
    expect(getStatusMessage("QUEUED", "execute")).toBe(
      "Queued for execution..."
    );
    expect(getStatusMessage("QUEUED", "explore")).toBe(
      "Queued for exploration..."
    );
  });

  it("returns the bare running verb for RUNNING without an initiator", () => {
    expect(getStatusMessage("RUNNING", "execute")).toBe(
      "Executing plan and creating PR..."
    );
  });

  it("prefixes the initiator name and lowercases the verb for RUNNING", () => {
    expect(
      getStatusMessage("RUNNING", "execute", {
        firstName: "Ada",
        lastName: "Lovelace",
      })
    ).toBe("Ada Lovelace is executing plan and creating PR...");
  });

  it("returns a command-specific failure message for FAILURE", () => {
    expect(getStatusMessage("FAILURE", "execute")).toBe(
      "Plan execution failed"
    );
    expect(getStatusMessage("FAILURE", "explore")).toBe(
      "Codebase exploration failed"
    );
  });

  it("returns an empty string for terminal/unknown statuses", () => {
    expect(getStatusMessage("SUCCESS", "execute")).toBe("");
    expect(getStatusMessage("NONE", null)).toBe("");
  });
});
