import { describe, expect, it } from "vitest";

import { PrCommentAuthorKind } from "../src/branch-view";
import { Priority } from "../src/common";
import {
  DesktopSecurityStatus,
  PluginUpdateOutcome,
} from "../src/compute-target";
import {
  artifactRepositorySnapshotSchema,
  DocumentStatus,
  DocumentType,
  FEATURE_STATUS_OPTIONS,
  FeatureStatus,
  PullRequestState,
} from "../src/document";
import { resolveFriendlyError } from "../src/friendly-error";

describe("shared contract exports", () => {
  it("exposes document enums used by design-system", () => {
    expect(DocumentType.Feature).toBe("FEATURE");
    expect(DocumentStatus.InReview).toBe("IN_REVIEW");
    expect(PullRequestState.Open).toBe("OPEN");
  });

  it("exposes the full Feature status vocabulary incl. TRIAGE (PRD-495)", () => {
    // TRIAGE is a normal, human-selectable status; it is only excluded as the
    // human-create *default* (handled in the create paths), not as an option.
    expect(FEATURE_STATUS_OPTIONS).toContain(FeatureStatus.Triage);
    expect(FEATURE_STATUS_OPTIONS).toContain(FeatureStatus.Backlog);
  });

  it("exposes compute-target and comment enums used by design-system", () => {
    expect(Priority.High).toBe("HIGH");
    expect(PluginUpdateOutcome.Success).toBe("success");
    expect(DesktopSecurityStatus.Protected).toBe("protected");
    expect(PrCommentAuthorKind.Bot).toBe("bot");
  });

  it("parses artifact repository snapshots", () => {
    const parsed = artifactRepositorySnapshotSchema.parse({
      repositories: [
        {
          fullName: "closedloop-ai/symphony-alpha",
          role: "primary",
          position: 0,
        },
      ],
      source: "project_defaults",
    });

    expect(parsed.repositories[0]?.fullName).toBe(
      "closedloop-ai/symphony-alpha"
    );
  });

  it("resolves known loop errors to display-safe copy", () => {
    expect(resolveFriendlyError({ code: "RUNNER_ERROR" }).title).toBe(
      "Runner failed"
    );
  });

  it("preserves specialized process-failure copy", () => {
    expect(resolveFriendlyError({ code: "PROCESS_FAILED" }).title).toBe(
      "Command failed"
    );
  });

  it("preserves runner subcode copy", () => {
    expect(
      resolveFriendlyError({
        code: "RUNNER_ERROR",
        result: { subcode: "CLAUDE_UNKNOWN_SKILL" },
      }).title
    ).toBe("Closedloop plugin command unavailable");
  });
});
