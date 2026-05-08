/**
 * Null-workstream regression tests for PR-related webhook handlers.
 *
 * The bug class
 * -------------
 * A PR artifact's `workstreamId` is nullable. Before commit c9bd4c9e, three
 * handlers coerced it via `?? ""` and then passed the empty string into
 * `workstreamEvent.create({ workstreamId })`, which would either:
 *   (a) throw a foreign-key violation at runtime (check-run-handler), or
 *   (b) silently persist an invalid FK that later blew up downstream reads.
 *
 * Each handler's main test file exercises the "happy path" with a
 * workstream-attached PR, so this branch was never touched. This file pins
 * the contract that a null `workstreamId` is legitimate input: handlers
 * still complete the detail update / upsert, but must NOT attempt to emit a
 * workstream event.
 *
 * Handlers covered
 *   - pull-request-review-comment-handler (created action)
 *   - pull-request-review-handler         (submitted action)
 *   - check-run-handler                   (completed, status change)
 *
 * Out of scope: `markLinkedArtifactsOnMerge` and other paths that don't
 * create workstream events from `workstreamId`. Those are document-status
 * updates and don't share the bug class.
 */

import type {
  CheckRunEvent,
  PullRequestReviewCommentCreatedEvent,
  PullRequestReviewSubmittedEvent,
} from "@octokit/webhooks-types";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

vi.mock("@repo/database", () => {
  const mockWithDb: any = vi.fn();
  mockWithDb.tx = vi.fn();
  return {
    ArtifactType: {
      DOCUMENT: "DOCUMENT",
      PULL_REQUEST: "PULL_REQUEST",
      DEPLOYMENT: "DEPLOYMENT",
    },
    withDb: mockWithDb,
  };
});

vi.mock("@repo/github", () => ({
  queryStatusCheckRollup: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Imports after mocks
import { queryStatusCheckRollup } from "@repo/github";
import { handleCheckRun } from "@/app/webhooks/github/handlers/check-run-handler";
import { handlePullRequestReviewComment } from "@/app/webhooks/github/handlers/pull-request-review-comment-handler";
import { handlePullRequestReview } from "@/app/webhooks/github/handlers/pull-request-review-handler";
import {
  getMockWithDb,
  mockWithDbTx as setupMockWithDbTx,
} from "../utils/db-helpers";
import { makePrDetailRow } from "../utils/pr-detail-helpers";

const mockWithDb = getMockWithDb();
const mockQueryStatusCheckRollup = queryStatusCheckRollup as unknown as Mock;

// ---------------------------------------------------------------------------
// Minimal event builders — each handler under test only reads a small subset
// of fields, so we cast through `any` to skip the full Octokit event shape.
// ---------------------------------------------------------------------------

function minimalUser() {
  return {
    login: "reviewer",
    id: 1,
    node_id: "U_1",
    avatar_url: "",
    gravatar_id: "",
    url: "",
    html_url: "",
    followers_url: "",
    following_url: "",
    gists_url: "",
    starred_url: "",
    subscriptions_url: "",
    organizations_url: "",
    repos_url: "",
    events_url: "",
    received_events_url: "",
    type: "User" as const,
    site_admin: false,
  };
}

function minimalRepository(id: number) {
  return {
    id,
    node_id: `R_${id}`,
    name: "repo",
    full_name: "org/repo",
    private: false,
    owner: minimalUser(),
    html_url: "",
    description: null,
    fork: false,
    url: "",
  };
}

function minimalPullRequest(number: number) {
  return {
    id: 1,
    node_id: "PR_1",
    number,
    title: `Test PR ${number}`,
    html_url: `https://github.com/org/repo/pull/${number}`,
    user: minimalUser(),
    state: "open",
    draft: false,
    merged: false,
    url: "",
    diff_url: "",
    patch_url: "",
    issue_url: "",
    commits_url: "",
    review_comments_url: "",
    review_comment_url: "",
    comments_url: "",
    statuses_url: "",
    created_at: "2026-02-10T00:00:00Z",
    updated_at: "2026-02-10T00:00:00Z",
  };
}

function buildReviewCommentEvent(): PullRequestReviewCommentCreatedEvent {
  return {
    action: "created",
    comment: {
      id: 1,
      node_id: "PRRC_1",
      diff_hunk: "@@ -1,1 +1,1 @@",
      path: "src/file.ts",
      line: 1,
      body: "comment body",
      pull_request_review_id: null,
      user: minimalUser(),
      created_at: "2026-02-10T12:00:00Z",
      updated_at: "2026-02-10T12:00:00Z",
      html_url: "https://github.com/org/repo/pull/1#discussion_r1",
      pull_request_url: "",
      author_association: "CONTRIBUTOR" as const,
      url: "",
      _links: {
        self: { href: "" },
        html: { href: "" },
        pull_request: { href: "" },
      },
    },
    pull_request: minimalPullRequest(1),
    repository: minimalRepository(100),
    sender: minimalUser(),
  } as any;
}

function buildReviewSubmittedEvent(): PullRequestReviewSubmittedEvent {
  return {
    action: "submitted",
    review: {
      id: 1,
      node_id: "PRR_1",
      user: minimalUser(),
      body: "Looks good",
      state: "approved",
      html_url: "https://github.com/org/repo/pull/1#pullrequestreview-1",
      pull_request_url: "",
      author_association: "CONTRIBUTOR" as const,
      submitted_at: "2026-02-10T12:00:00Z",
      commit_id: "abc123",
      _links: { html: { href: "" }, pull_request: { href: "" } },
    },
    pull_request: minimalPullRequest(1),
    repository: minimalRepository(100),
    sender: minimalUser(),
  } as any;
}

function buildCheckRunEvent(): CheckRunEvent {
  return {
    action: "completed",
    check_run: {
      id: 1,
      name: "ci / test",
      head_sha: "abc123def456abc123def456abc123def456abc1",
      conclusion: "success",
      check_suite: { head_branch: "feat/test" },
    },
    repository: { id: 100, full_name: "org/repo" },
    installation: { id: 99 },
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("webhook handlers skip workstreamEvent.create when workstreamId is null", () => {
  describe("handlePullRequestReviewComment (created)", () => {
    let mockTx: any;

    beforeEach(() => {
      vi.clearAllMocks();
      mockTx = {
        gitHubInstallationRepository: { findFirst: vi.fn() },
        pullRequestDetail: { findUnique: vi.fn() },
        gitHubPRReviewComment: {
          upsert: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn(),
          deleteMany: vi.fn(),
        },
        workstreamEvent: { create: vi.fn() },
      };
      setupMockWithDbTx(mockTx);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("upserts the comment but skips workstreamEvent.create", async () => {
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid",
      });
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr",
          workstreamId: null,
          linkedDoc: { id: "artifact-doc", slug: "plan-x" },
        })
      );

      const response = await handlePullRequestReviewComment(
        buildReviewCommentEvent()
      );

      // The comment upsert still runs — this is the detail-row write.
      expect(mockTx.gitHubPRReviewComment.upsert).toHaveBeenCalledTimes(1);
      // But no workstream event is emitted.
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();

      const json = await response.json();
      expect(json.ok).toBe(true);
    });
  });

  describe("handlePullRequestReview (submitted)", () => {
    let mockTx: any;

    beforeEach(() => {
      vi.clearAllMocks();
      mockTx = {
        gitHubInstallationRepository: { findFirst: vi.fn() },
        pullRequestDetail: {
          findUnique: vi.fn(),
          update: vi.fn().mockResolvedValue({}),
        },
        gitHubPRReview: {
          upsert: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([{ state: "APPROVED" }]),
        },
        workstreamEvent: { create: vi.fn() },
      };
      setupMockWithDbTx(mockTx);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("upserts the reviewer record but skips workstreamEvent.create", async () => {
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid",
      });
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr",
          workstreamId: null,
          linkedDoc: { id: "artifact-doc", slug: "plan-x" },
        })
      );

      const response = await handlePullRequestReview(
        buildReviewSubmittedEvent()
      );

      // Per-reviewer upsert and aggregate update still run.
      expect(mockTx.gitHubPRReview.upsert).toHaveBeenCalledTimes(1);
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalled();
      // But no workstream event is emitted.
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();

      const json = await response.json();
      expect(json.ok).toBe(true);
    });
  });

  describe("handleCheckRun (completed, status changed)", () => {
    let mockDb: any;
    let mockTx: any;

    beforeEach(() => {
      vi.clearAllMocks();
      mockDb = {
        gitHubInstallationRepository: { findFirst: vi.fn() },
        pullRequestDetail: { findFirst: vi.fn() },
      };
      mockTx = {
        pullRequestDetail: {
          findUnique: vi.fn(),
          update: vi.fn().mockResolvedValue({}),
        },
        workstreamEvent: { create: vi.fn() },
      };
      mockWithDb.mockImplementation((fn: any) => fn(mockDb));
      mockWithDb.tx.mockImplementation((fn: any) => fn(mockTx));
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("updates checksStatus but skips workstreamEvent.create", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid",
        owner: "org",
        name: "repo",
      });
      mockDb.pullRequestDetail.findFirst.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr",
          number: 1,
          headSha,
          workstreamId: null,
          linkedDoc: { id: "artifact-doc", slug: "plan-x" },
        })
      );
      mockQueryStatusCheckRollup.mockResolvedValue("SUCCESS");
      mockTx.pullRequestDetail.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "UNKNOWN",
        prState: "OPEN",
      });

      const response = await handleCheckRun(buildCheckRunEvent());

      // checksStatus is still updated on the detail row.
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { artifactId: "artifact-pr" },
        data: { checksStatus: "PASSING" },
      });
      // But no workstream event is emitted.
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();

      const json = await response.json();
      expect(json.ok).toBe(true);
    });
  });
});
