import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { describe, expect, it, vi } from "vitest";
// ISS-7148: the one `Prisma.sql` tree renderer. This suite carried a private
// copy that was a strict subset of it — same recursion, but blind to the
// `separator` a `Prisma.join` fragment sets, so a joined fragment rendered as
// nothing rather than as its elements.
import { renderSql } from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { persistLatestGitHubPRReview } from "./pr-review-projection";

describe("persistLatestGitHubPRReview", () => {
  it("guards PR review conflict updates by submittedAt so stale replay cannot win", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);

    await persistLatestGitHubPRReview({ $executeRaw: executeRaw } as never, {
      pullRequestId: "11111111-1111-4111-8111-111111111111",
      githubReviewId: "review-1",
      authorLogin: "reviewer",
      authorAvatarUrl: "https://avatars.example/reviewer.png",
      state: ReviewDecision.Approved,
      body: "looks good",
      htmlUrl:
        "https://github.com/closedloop-ai/closedloop-ai/pull/42#pullrequestreview-1",
      submittedAt: new Date("2026-07-03T06:00:00.000Z"),
      fetchCredentialType: "github_app",
      fetchCredentialOwnerId: null,
      fetchMechanism: "webhook",
      fetchTrigger: "webhook",
      fetchObservedAt: new Date("2026-07-03T06:01:00.000Z"),
      fetchResultReason: "success",
    });

    const sql = renderSql(executeRaw.mock.calls[0]?.[0]);
    expect(sql).toContain('INSERT INTO "github_pr_reviews" (\n      "id",');
    expect(sql).toContain('"updated_at"\n    )');
    expect(sql).toContain("NOW()\n    )");
    expect(sql).toContain(
      'ON CONFLICT ("pull_request_id", "author_login") DO UPDATE SET'
    );
    expect(sql).toContain(
      '"github_pr_reviews"."submitted_at" < EXCLUDED."submitted_at"'
    );
    expect(sql).toContain(
      '"github_pr_reviews"."state" <> \'DISMISSED\'::"ReviewDecision"'
    );
    expect(sql).toContain('EXCLUDED."state" = \'DISMISSED\'::"ReviewDecision"');
  });
});
