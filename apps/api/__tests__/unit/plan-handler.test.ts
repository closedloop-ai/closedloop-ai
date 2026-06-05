/**
 * Unit tests for planHandler and requestChangesHandler in plan-handler.ts.
 *
 * Key behaviors tested:
 * - planHandler.requiresRepo is true (PLAN loop needs codebase access)
 * - requestChangesHandler.requiresRepo is true (pushes code, requires a repo)
 * - Handler shape matches LoopCommandHandler contract
 */

import { vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  EvaluationReportType: { PLAN: "PLAN", CODE: "CODE" },
}));

vi.mock("@repo/github/prompt-snapshot-parser", () => ({
  parsePromptsSnapshotFromMarkdownEntries: vi.fn().mockReturnValue(null),
}));

vi.mock("@/app/artifacts/artifact-version-service", () => ({
  artifactVersionService: {
    createVersion: vi.fn(),
    getLatest: vi.fn(),
  },
}));

vi.mock("@/app/artifacts/room-utils", () => ({
  resetArtifactRoom: vi.fn(),
}));

vi.mock("@/lib/judge-score-fanout", () => ({
  fanOutJudgeScores: vi.fn(),
}));

vi.mock("@/lib/loops/loop-artifact-ingestion", () => ({
  parseJsonArtifact: vi.fn(),
}));

vi.mock("@/lib/loops/loop-state", () => ({
  downloadArtifactFile: vi.fn(),
  downloadPromptSnapshotMarkdownEntries: vi.fn(),
}));

vi.mock("@/lib/prompts-service", () => ({
  upsertFromSnapshot: vi.fn(),
}));

// --- Imports (after mocks) ---

import { describe, expect, it } from "vitest";
import {
  planHandler,
  requestChangesHandler,
} from "@/lib/loops/loop-commands/plan-handler";

// ---------------------------------------------------------------------------
// planHandler — requiresRepo must be true (plans need codebase access)
// ---------------------------------------------------------------------------

describe("planHandler", () => {
  it("has requiresRepo set to true", () => {
    expect(planHandler.requiresRepo).toBe(true);
  });

  it("has requiresParent set to false", () => {
    expect(planHandler.requiresParent).toBe(false);
  });

  it("has includePrimaryArtifact set to false", () => {
    expect(planHandler.includePrimaryArtifact).toBe(false);
  });

  it("exposes downloadAndIngest as a function", () => {
    expect(typeof planHandler.downloadAndIngest).toBe("function");
  });

  it("exposes uploadAndIngest as a function", () => {
    expect(typeof planHandler.uploadAndIngest).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// requestChangesHandler — requiresRepo must be true
// ---------------------------------------------------------------------------

describe("requestChangesHandler", () => {
  it("has requiresRepo set to true", () => {
    expect(requestChangesHandler.requiresRepo).toBe(true);
  });

  it("has requiresParent set to true", () => {
    expect(requestChangesHandler.requiresParent).toBe(true);
  });

  it("has includePrimaryArtifact set to true", () => {
    expect(requestChangesHandler.includePrimaryArtifact).toBe(true);
  });

  it("exposes downloadAndIngest as a function", () => {
    expect(typeof requestChangesHandler.downloadAndIngest).toBe("function");
  });

  it("exposes uploadAndIngest as a function", () => {
    expect(typeof requestChangesHandler.uploadAndIngest).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Contrast: both planHandler and requestChangesHandler require a repo
// ---------------------------------------------------------------------------

describe("planHandler vs requestChangesHandler requiresRepo", () => {
  it("both require a repo", () => {
    expect(planHandler.requiresRepo).toBe(true);
    expect(requestChangesHandler.requiresRepo).toBe(true);
  });
});
