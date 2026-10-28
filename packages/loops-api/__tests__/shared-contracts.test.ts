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
  isPrimaryRepoObserved,
  isSnapshotCorrectable,
  PullRequestState,
} from "../src/document";
import { LoopErrorCode } from "../src/error-codes";
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
          fullName: "closedloop-ai/closedloop-ai",
          role: "primary",
          position: 0,
        },
      ],
      source: "project_defaults",
    });

    expect(parsed.repositories[0]?.fullName).toBe(
      "closedloop-ai/closedloop-ai"
    );
  });

  // ISS-8164. Spelled as literals, not as SnapshotSource members: a fixture
  // built from the const it polices still passes when a member is renamed or
  // dropped, which is exactly the drift these rows exist to catch.
  //
  // The columns differ on `parent_artifact` and `legacy` on purpose. Both read
  // unobserved but neither is correctable: an inherited snapshot may be a human
  // selection copied from the parent, and a legacy row is the backfill of this
  // artifact's own caller-supplied `target_repo`/`target_branch` — pinned
  // branches and all. `project_defaults` is the only guess nobody chose.
  it.each([
    ["project_defaults", false, true],
    ["parent_artifact", false, false],
    ["legacy", false, false],
    ["none", false, false],
    ["loop_selection", true, false],
    ["branch_link", true, false],
  ] as const)(
    "classifies %s as primaryObserved=%s correctable=%s",
    (source, observed, correctable) => {
      expect(isPrimaryRepoObserved(source)).toBe(observed);
      expect(isSnapshotCorrectable(source)).toBe(correctable);
    }
  );

  it("accepts a branch-link snapshot at the persistence boundary", () => {
    const parsed = artifactRepositorySnapshotSchema.parse({
      repositories: [
        {
          fullName: "example-org/infrastructure",
          role: "primary",
          position: 0,
        },
      ],
      source: "branch_link",
    });

    expect(parsed.source).toBe("branch_link");
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

  it("explains MISSING_REQUIRED_ARTIFACTS in operator terms (ISS-5872)", () => {
    expect(
      resolveFriendlyError({
        code: LoopErrorCode.MissingRequiredArtifacts,
      }).title
    ).toBe("Required output was never written");
  });

  it("degrades an unrecognized error code to the generic failure, never a throw", () => {
    // Cross-repo skew: a desktop build newer than this client can emit a code
    // this build has never heard of, so resolution must fall back rather than
    // crash.
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
});
