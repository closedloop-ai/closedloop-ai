import {
  DocumentStatus,
  DocumentType,
  DocumentTypeAlias,
  IssueStatus,
} from "@closedloop-ai/loops-api/document";
import { describe, expect, it } from "vitest";
import type { NormalizedArtifactStatus } from "./artifact-status.js";
import {
  ARTIFACT_STATUS_DETAIL,
  ARTIFACT_STATUS_ROOT,
  DISPLAYED_ARTIFACT_STATUS,
  UNKNOWN_ARTIFACT_STATUS,
} from "./artifact-status.ts";
import {
  BRANCH_STATUS_MAPPING,
  DOCUMENT_STATUS_MAPPING,
  ISSUE_STATUS_MAPPING,
  PROJECT_STATUS_MAPPING,
  SESSION_STATUS_MAPPING,
  toArtifactStatusFromBranch,
  toArtifactStatusFromDocument,
  toArtifactStatusFromIssue,
  toArtifactStatusFromProject,
  toArtifactStatusFromPullRequestState,
  toArtifactStatusFromSession,
  toDisplayedArtifactStatus,
} from "./artifact-status-mapping.ts";
import { BranchStatus } from "./branch.ts";
import { BranchMergedState } from "./branch-merged-state.ts";
import { toBranchStatus } from "./branch-status-derivation.ts";
import { GitHubPRState } from "./github-status.ts";
import { ProjectStatus } from "./project.ts";
import { DISPLAYED_SESSION_STATUS } from "./session-status.ts";

type Fold = (raw: string | null | undefined) => NormalizedArtifactStatus;

const ROOTS: readonly string[] = Object.values(ARTIFACT_STATUS_ROOT);
const DISPLAYED: readonly string[] = Object.values(DISPLAYED_ARTIFACT_STATUS);
const DETAILS: readonly string[] = Object.values(ARTIFACT_STATUS_DETAIL);

const TABLES: ReadonlyArray<{
  name: string;
  namespace: string;
  vocabulary: readonly string[];
  table: Readonly<Record<string, NormalizedArtifactStatus>>;
  fold: Fold;
  wrongCase: string;
  allowedRoots: readonly string[];
}> = [
  {
    name: "document",
    namespace: "document.",
    vocabulary: Object.values(DocumentStatus),
    table: DOCUMENT_STATUS_MAPPING,
    fold: toArtifactStatusFromDocument,
    wrongCase: "draft",
    allowedRoots: ROOTS,
  },
  {
    name: "issue",
    namespace: "issue.",
    vocabulary: Object.values(IssueStatus),
    table: ISSUE_STATUS_MAPPING,
    fold: toArtifactStatusFromIssue,
    wrongCase: "todo",
    allowedRoots: ROOTS,
  },
  {
    name: "branch",
    namespace: "branch.",
    vocabulary: Object.values(BranchStatus),
    table: BRANCH_STATUS_MAPPING,
    fold: toArtifactStatusFromBranch,
    wrongCase: "DRAFT",
    allowedRoots: ROOTS,
  },
  {
    name: "project",
    namespace: "project.",
    vocabulary: Object.values(ProjectStatus),
    table: PROJECT_STATUS_MAPPING,
    fold: toArtifactStatusFromProject,
    wrongCase: "in_progress",
    allowedRoots: ROOTS,
  },
  {
    name: "session",
    namespace: "session.",
    vocabulary: Object.values(DISPLAYED_SESSION_STATUS),
    table: SESSION_STATUS_MAPPING,
    fold: toArtifactStatusFromSession,
    wrongCase: "ACTIVE",
    allowedRoots: DISPLAYED,
  },
];

const HOSTILE_INPUTS = [
  "",
  "nope",
  "__proto__",
  "constructor",
  "toString",
  null,
  undefined,
] as const;

describe.each(TABLES)(
  "$name mapping table",
  ({ namespace, vocabulary, table, fold, wrongCase, allowedRoots }) => {
    it("covers every vocabulary member and nothing else", () => {
      expect(Object.keys(table).sort()).toEqual([...vocabulary].sort());
    });

    it("maps every row onto a declared root", () => {
      for (const row of Object.values(table)) {
        expect(allowedRoots).toContain(row.root);
      }
    });

    it("carries only declared detail keys from its own namespace", () => {
      for (const row of Object.values(table)) {
        if (row.detail === undefined) {
          expect(Object.hasOwn(row, "detail")).toBe(false);
          continue;
        }
        expect(DETAILS).toContain(row.detail);
        expect(row.detail.startsWith(namespace)).toBe(true);
      }
    });

    it("is frozen down to every row", () => {
      expect(Object.isFrozen(table)).toBe(true);
      for (const row of Object.values(table)) {
        expect(Object.isFrozen(row)).toBe(true);
      }
    });

    it("folds every vocabulary member to its own row by identity", () => {
      for (const member of vocabulary) {
        expect(fold(member)).toBe(table[member]);
      }
    });

    it("returns the frozen row, so a caller cannot rewrite the table", () => {
      const [member] = vocabulary;
      const row = fold(member) as { root: string };
      expect(() => {
        row.root = ARTIFACT_STATUS_ROOT.Done;
      }).toThrow(TypeError);
      expect(fold(member).root).toBe(table[member]?.root);
    });

    it.each([...HOSTILE_INPUTS, wrongCase])(
      "folds unrecognized input %j to the unknown singleton",
      (raw) => {
        expect(fold(raw)).toBe(UNKNOWN_ARTIFACT_STATUS);
      }
    );
  }
);

describe("ruled rows", () => {
  it("document", () => {
    expect(DOCUMENT_STATUS_MAPPING).toEqual({
      DRAFT: { root: "in_progress", detail: "document.drafting" },
      IN_REVIEW: { root: "in_review" },
      CHANGES_REQUESTED: {
        root: "in_review",
        detail: "document.changes_requested",
      },
      APPROVED: { root: "done", detail: "document.approved" },
      EXECUTED: { root: "done", detail: "document.executed" },
      OBSOLETE: { root: "canceled", detail: "document.superseded" },
    });
  });

  it("issue", () => {
    expect(ISSUE_STATUS_MAPPING).toEqual({
      TRIAGE: { root: "todo", detail: "issue.triage" },
      BACKLOG: { root: "todo", detail: "issue.backlog" },
      TODO: { root: "todo" },
      IN_PROGRESS: { root: "in_progress" },
      IN_REVIEW: { root: "in_review" },
      BLOCKED: { root: "in_progress", detail: "issue.blocked" },
      DONE: { root: "done" },
      CANCELED: { root: "canceled" },
    });
  });

  it("branch", () => {
    expect(BRANCH_STATUS_MAPPING).toEqual({
      draft: { root: "in_progress", detail: "branch.draft" },
      open: { root: "in_review", detail: "branch.pr_open" },
      review: { root: "in_review", detail: "branch.review" },
      blocked: { root: "in_review", detail: "branch.changes_requested" },
      merged: { root: "done", detail: "branch.merged" },
      closed: { root: "canceled", detail: "branch.closed_without_merge" },
    });
  });

  it("project", () => {
    expect(PROJECT_STATUS_MAPPING).toEqual({
      NOT_STARTED: { root: "todo" },
      IN_PROGRESS: { root: "in_progress" },
      COMPLETED: { root: "done" },
      ARCHIVED: { root: "done", detail: "project.archived" },
    });
  });

  // ISS-10364 (operator ruling, 2026-09-23/24) retired `waiting`/`stale`/
  // `unknown` from `DISPLAYED_SESSION_STATUS`, so the three rows this table
  // used to carry for them are gone.
  it("session (provisional)", () => {
    expect(SESSION_STATUS_MAPPING).toEqual({
      active: { root: "in_progress", detail: "session.running" },
      inactive: { root: "done", detail: "session.completed" },
      error: { root: "canceled", detail: "session.failed" },
    });
  });

  it("ISS-10364: no table row carries the unknown root any more", () => {
    const unknownRows = TABLES.flatMap(({ name, table }) =>
      Object.entries(table)
        .filter(([, row]) => row.root === DISPLAYED_ARTIFACT_STATUS.Unknown)
        .map(([key]) => `${name}:${key}`)
    );
    expect(unknownRows).toEqual([]);
  });

  it("emits exactly the declared detail set across all tables", () => {
    const emitted = new Set<string>();
    for (const { table } of TABLES) {
      for (const row of Object.values(table)) {
        if (row.detail !== undefined) {
          emitted.add(row.detail);
        }
      }
    }
    expect([...emitted].sort()).toEqual([...DETAILS].sort());
  });
});

describe("toArtifactStatusFromSession", () => {
  it("never inherits the session write-path fail-open to active", () => {
    expect(toArtifactStatusFromSession("garbage")).toBe(
      UNKNOWN_ARTIFACT_STATUS
    );
    expect(toArtifactStatusFromSession("garbage").root).not.toBe(
      ARTIFACT_STATUS_ROOT.InProgress
    );
  });

  // ISS-10364: "stale" is a plain literal now (the member is retired). Nothing
  // upstream can still produce it, so this pins the same fallback as any other
  // unrecognized spelling rather than a dedicated stale detail.
  it("ISS-10364: folds the retired `stale` spelling to the unknown singleton", () => {
    expect(toArtifactStatusFromSession("stale")).toBe(UNKNOWN_ARTIFACT_STATUS);
  });

  // ISS-5981's backfill was waived, so cloud rows storing this literal are real,
  // and the retirement must not move them from In progress to Unknown. Written
  // as a literal rather than `LEGACY_WAITING_WIRE_STATUS`: the value under test
  // is what a stored row holds, not what this build names it.
  it("ISS-10364: keeps a stored legacy `waiting` row on the active row's answer", () => {
    expect(toArtifactStatusFromSession("waiting")).toEqual(
      SESSION_STATUS_MAPPING[DISPLAYED_SESSION_STATUS.ACTIVE]
    );
    expect(toArtifactStatusFromSession("waiting").root).toBe(
      ARTIFACT_STATUS_ROOT.InProgress
    );
  });
});

describe("toDisplayedArtifactStatus", () => {
  it.each([DocumentType.Feature, DocumentTypeAlias.Issue])(
    "reads the issue table for subtype %s",
    (subtype) => {
      expect(toDisplayedArtifactStatus(subtype, IssueStatus.Triage)).toBe(
        ISSUE_STATUS_MAPPING.TRIAGE
      );
      expect(toDisplayedArtifactStatus(subtype, DocumentStatus.Approved)).toBe(
        UNKNOWN_ARTIFACT_STATUS
      );
    }
  );

  it.each([
    DocumentType.Prd,
    DocumentType.ImplementationPlan,
    DocumentType.Template,
    DocumentType.Doc,
    "SOME_FUTURE_SUBTYPE",
    null,
    undefined,
  ])("reads the document table for subtype %j", (subtype) => {
    expect(toDisplayedArtifactStatus(subtype, DocumentStatus.Draft)).toBe(
      DOCUMENT_STATUS_MAPPING.DRAFT
    );
    expect(toDisplayedArtifactStatus(subtype, IssueStatus.Todo)).toBe(
      UNKNOWN_ARTIFACT_STATUS
    );
  });

  it("resolves the shared IN_REVIEW value to the same root through both arms", () => {
    const viaIssue = toDisplayedArtifactStatus(
      DocumentType.Feature,
      IssueStatus.InReview
    );
    const viaDocument = toDisplayedArtifactStatus(
      DocumentType.Prd,
      DocumentStatus.InReview
    );
    expect(viaIssue.root).toBe(ARTIFACT_STATUS_ROOT.InReview);
    expect(viaDocument.root).toBe(ARTIFACT_STATUS_ROOT.InReview);
    expect(Object.hasOwn(viaIssue, "detail")).toBe(false);
    expect(Object.hasOwn(viaDocument, "detail")).toBe(false);
  });

  it.each([
    [DocumentType.Feature, BranchStatus.Open],
    [DocumentType.Feature, DISPLAYED_SESSION_STATUS.ACTIVE],
    [DocumentType.Prd, BranchStatus.Open],
    [DocumentType.Prd, DISPLAYED_SESSION_STATUS.ACTIVE],
  ])(
    "is documents-only: subtype %s with branch/session value %s is unknown",
    (subtype, raw) => {
      expect(toDisplayedArtifactStatus(subtype, raw)).toBe(
        UNKNOWN_ARTIFACT_STATUS
      );
    }
  );

  it.each(HOSTILE_INPUTS)(
    "folds hostile raw %j to the unknown singleton",
    (raw) => {
      expect(toDisplayedArtifactStatus(DocumentType.Feature, raw)).toBe(
        UNKNOWN_ARTIFACT_STATUS
      );
      expect(toDisplayedArtifactStatus(DocumentType.Prd, raw)).toBe(
        UNKNOWN_ARTIFACT_STATUS
      );
    }
  );
});

/**
 * ISS-9437. A branch row in a MIXED artifact table carries the raw GitHub PR state in
 * `Artifact.status`, not a `BranchStatus`, so `toArtifactStatusFromBranch` misses it —
 * pinned below, because that miss is the whole reason this fold exists.
 */
describe("toArtifactStatusFromPullRequestState", () => {
  it("folds a PR state that toArtifactStatusFromBranch cannot", () => {
    expect(toArtifactStatusFromBranch(GitHubPRState.Merged)).toBe(
      UNKNOWN_ARTIFACT_STATUS
    );

    expect(toArtifactStatusFromPullRequestState(GitHubPRState.Merged)).toEqual({
      root: ARTIFACT_STATUS_ROOT.Done,
      detail: ARTIFACT_STATUS_DETAIL.BranchMerged,
    });
  });

  it.each([
    [GitHubPRState.Open, ARTIFACT_STATUS_ROOT.InReview],
    [GitHubPRState.Merged, ARTIFACT_STATUS_ROOT.Done],
    [GitHubPRState.Closed, ARTIFACT_STATUS_ROOT.Canceled],
  ])("folds %s onto root %s", (prState, root) => {
    expect(toArtifactStatusFromPullRequestState(prState).root).toBe(root);
  });

  it("returns the unknown singleton for a nullish state", () => {
    expect(toArtifactStatusFromPullRequestState(null)).toBe(
      UNKNOWN_ARTIFACT_STATUS
    );
    expect(toArtifactStatusFromPullRequestState(undefined)).toBe(
      UNKNOWN_ARTIFACT_STATUS
    );
  });

  /**
   * The drift guard. This fold composes `toBranchStatus` — the module that calls
   * itself the ONE `GitHubPRState`-to-`BranchStatus` derivation — rather than
   * restating its three rows as a second table. Asserting the composition here is
   * what keeps that true: rewrite the fold as a hand-written `Record` and this goes
   * red the moment a branch root moves in only one of them.
   */
  it.each(Object.values(GitHubPRState))(
    "agrees with toBranchStatus + BRANCH_STATUS_MAPPING for %s",
    (prState) => {
      const viaDerivation =
        BRANCH_STATUS_MAPPING[
          toBranchStatus(
            null,
            prState,
            false,
            prState === GitHubPRState.Merged
              ? BranchMergedState.Merged
              : BranchMergedState.NotMerged
          )
        ];

      expect(toArtifactStatusFromPullRequestState(prState)).toBe(viaDerivation);
    }
  );
});
