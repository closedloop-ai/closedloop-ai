import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { describe, expect, it, vi } from "vitest";
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
        "https://github.com/closedloop-ai/symphony-alpha/pull/42#pullrequestreview-1",
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

function renderSql(value: unknown): string {
  if (!isMockSql(value)) {
    return String(value);
  }
  return value.strings
    .map((sqlPart, index) => {
      const nested = value.values?.[index];
      return nested === undefined ? sqlPart : `${sqlPart}${renderSql(nested)}`;
    })
    .join("");
}

function isMockSql(value: unknown): value is {
  strings: readonly string[];
  values?: readonly unknown[];
} {
  return Boolean(
    value &&
      typeof value === "object" &&
      "strings" in value &&
      Array.isArray((value as { strings?: unknown }).strings)
  );
}
