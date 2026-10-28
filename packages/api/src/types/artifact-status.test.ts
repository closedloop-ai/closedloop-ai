import { describe, expect, it } from "vitest";
import {
  ARTIFACT_STATUS_DETAIL,
  ARTIFACT_STATUS_ROOT,
  DISPLAYED_ARTIFACT_STATUS,
  isArtifactStatusRoot,
  UNKNOWN_ARTIFACT_STATUS,
} from "./artifact-status.ts";

describe("ARTIFACT_STATUS_ROOT", () => {
  it("declares exactly the five ruled roots in the ruled semantic order", () => {
    expect(Object.values(ARTIFACT_STATUS_ROOT)).toEqual([
      "todo",
      "in_progress",
      "in_review",
      "done",
      "canceled",
    ]);
  });
});

describe("DISPLAYED_ARTIFACT_STATUS", () => {
  it("is exactly the roots plus unknown, in root order", () => {
    expect(Object.values(DISPLAYED_ARTIFACT_STATUS)).toEqual([
      ...Object.values(ARTIFACT_STATUS_ROOT),
      "unknown",
    ]);
  });
});

describe("ARTIFACT_STATUS_DETAIL", () => {
  // ISS-10364 (operator ruling, 2026-09-23/24) retired `waiting`/`stale` from
  // the displayed session-status vocabulary, so `session.waiting`/`session.stale`
  // are gone too — the `emits exactly the declared detail set` test in
  // `artifact-status-mapping.test.ts` proved they were genuinely orphaned once
  // no table emitted either. Eighteen keys now, not twenty.
  it("declares exactly the eighteen namespaced detail keys", () => {
    expect(Object.values(ARTIFACT_STATUS_DETAIL)).toEqual([
      "document.drafting",
      "document.changes_requested",
      "document.approved",
      "document.executed",
      "document.superseded",
      "issue.triage",
      "issue.backlog",
      "issue.blocked",
      "branch.draft",
      "branch.pr_open",
      "branch.review",
      "branch.changes_requested",
      "branch.merged",
      "branch.closed_without_merge",
      "project.archived",
      "session.running",
      "session.completed",
      "session.failed",
    ]);
  });
});

describe("isArtifactStatusRoot", () => {
  it.each(Object.values(ARTIFACT_STATUS_ROOT))("accepts root %s", (root) => {
    expect(isArtifactStatusRoot(root)).toBe(true);
  });

  it.each([
    DISPLAYED_ARTIFACT_STATUS.Unknown,
    "",
    "TODO",
    "__proto__",
    "constructor",
    null,
    undefined,
  ])("rejects %j", (value) => {
    expect(isArtifactStatusRoot(value)).toBe(false);
  });
});

describe("UNKNOWN_ARTIFACT_STATUS", () => {
  it("is a frozen singleton carrying the unknown root and no detail", () => {
    expect(Object.isFrozen(UNKNOWN_ARTIFACT_STATUS)).toBe(true);
    expect(UNKNOWN_ARTIFACT_STATUS.root).toBe(
      DISPLAYED_ARTIFACT_STATUS.Unknown
    );
    expect(Object.hasOwn(UNKNOWN_ARTIFACT_STATUS, "detail")).toBe(false);
  });
});
