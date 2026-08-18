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
  ISSUE_STATUS_OPTIONS,
  IssueStatus,
  PullRequestState,
} from "../src/document";
import { LoopErrorCode } from "../src/error-codes";
import {
  DESKTOP_SIGNED_LAUNCH_MANAGED_KEY_ERROR_MESSAGE,
  resolveFriendlyError,
} from "../src/friendly-error";

describe("shared contract exports", () => {
  it("exposes document enums used by design-system", () => {
    expect(DocumentType.Feature).toBe("FEATURE");
    expect(DocumentStatus.InReview).toBe("IN_REVIEW");
    expect(PullRequestState.Open).toBe("OPEN");
  });

  it("exposes the full Feature status vocabulary incl. TRIAGE (PRD-495)", () => {
    // TRIAGE is a normal, human-selectable status; it is only excluded as the
    // human-create *default* (handled in the create paths), not as an option.
    expect(ISSUE_STATUS_OPTIONS).toContain(IssueStatus.Triage);
    expect(ISSUE_STATUS_OPTIONS).toContain(IssueStatus.Backlog);
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

  it("explains MISSING_REQUIRED_ARTIFACTS in operator terms (ISS-5872)", () => {
    expect(
      resolveFriendlyError({
        code: LoopErrorCode.MissingRequiredArtifacts,
      }).title
    ).toBe("Required output was never written");
  });

  it("degrades an unrecognized error code to the generic failure, never a throw", () => {
    // Cross-repo skew: a desktop build newer than this client can emit a code
    // this build has never heard of. `LoopEventErrorSchema.code` is `z.string()`
    // so the event is accepted, and resolution must fall back rather than crash
    // or leave the loop un-terminalized.
    const result = resolveFriendlyError({
      code: "SOME_FUTURE_DESKTOP_CODE",
      message: "produced no widget.json",
    });
    expect(result.title).toBe("Operation failed");
    expect(result.code).toBe("SOME_FUTURE_DESKTOP_CODE");
  });

  it("keeps unknown errors honest while preserving available metadata", () => {
    const result = resolveFriendlyError({
      timestamp: "2026-08-08T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      title: "Operation failed",
      timestamp: "2026-08-08T00:00:00.000Z",
    });
    expect(result).not.toHaveProperty("code");
  });

  it("selects exact desktop signing guidance for its gateway message", () => {
    expect(
      resolveFriendlyError({
        code: LoopErrorCode.ProcessFailed,
        message: DESKTOP_SIGNED_LAUNCH_MANAGED_KEY_ERROR_MESSAGE,
      }).title
    ).toBe("Desktop managed signing is not ready");
  });

  it("humanizes a future runner subcode without hiding the failure", () => {
    expect(
      resolveFriendlyError({
        code: LoopErrorCode.RunnerError,
        result: { subcode: "FUTURE_RUNNER_FAILURE" },
      })
    ).toMatchObject({
      title: "Future Runner Failure",
      description: "The runner reported an unrecognized failure reason.",
    });
  });
});
