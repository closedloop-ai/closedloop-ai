import { GitHubPRState } from "@repo/api/src/types/github";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { describe, expect, it } from "vitest";
import { createPullRequest } from "@/__tests__/fixtures/github-webhook-fixtures";
import { pullRequestInput } from "@/__tests__/support/branches/github-projection-writer.test-fixtures";
import { pullRequestToDetailUpdate } from "@/app/webhooks/github/handlers/pull-request-detail-update";
import {
  buildPullRequestDetailCreate,
  buildPullRequestDetailUpdate,
} from "./github-projection-writer";

describe("PullRequestDetail projection payloads", () => {
  it("leaves the exact PR-head pair to the authority compare-and-set", () => {
    const input = {
      ...pullRequestInput(),
      headRefOid: "exact-head-oid",
    };

    const create = buildPullRequestDetailCreate(input);
    const update = buildPullRequestDetailUpdate(input);

    expect(create).not.toHaveProperty("headRefName");
    expect(create).not.toHaveProperty("headRefOid");
    expect(update).not.toHaveProperty("headRefName");
    expect(update).not.toHaveProperty("headRefOid");
  });

  // ISS-8243. Omitting `number` from the update payload is what unblocked the
  // ISS-6421 atom-barrier cases: with the column present, concurrent FK writers
  // on the row blocked until they timed out, and they pass without it. Why the
  // lock behaves that way is still contested — see ISS-8243. The create arm
  // establishes the key and must keep writing it; only the update arm omits it.
  // Both halves are pinned here because dropping it from BOTH would take the
  // column with it, and adding it back to the update arm is exactly the
  // regression this exists to catch.
  it("omits the unique-key number on update while the create shape still sets it", () => {
    const input = pullRequestInput();

    expect(buildPullRequestDetailCreate(input).number).toBe(input.number);
    expect(buildPullRequestDetailUpdate(input)).not.toHaveProperty("number");
  });

  // ISS-8155 AC-2. `base_ref_name` is the PR's OWN base; before it existed the
  // read borrowed the owning Branch's current base and mislabelled every
  // historical PR of a reused branch. Both shapes must carry it or a row that
  // takes the create arm and a row that takes the update arm disagree.
  it("persists the PR's own base ref on both the create and the update shape", () => {
    const input = { ...pullRequestInput(), baseBranch: "release/24" };

    expect(buildPullRequestDetailCreate(input).baseRefName).toBe("release/24");
    expect(buildPullRequestDetailUpdate(input).baseRefName).toBe("release/24");
  });

  // ISS-8155: NULL is the column's only spelling of "unmeasured". The backfill
  // lane coalesces its own absent base ref to `""` before it reaches this
  // builder, so on CREATE an empty ref must store nothing — two spellings of
  // absence in one column is the distinction the read cannot then undo.
  it("stores no base ref rather than an empty one when the producer measured none", () => {
    const input = { ...pullRequestInput(), baseBranch: "" };

    expect(buildPullRequestDetailCreate(input).baseRefName).toBeNull();
  });

  // ISS-8155, whitlockk's review: this expectation CHANGED, and the reason is that
  // it was asserting the wrong contract. It previously required the UPDATE arm
  // to store NULL for an empty base ref, identically to the create arm. On a new
  // row NULL is the honest "unmeasured"; on an existing row it is a DESTRUCTIVE
  // CLEAR, because `mapPullRequestNode` coalesces an absent GraphQL
  // `baseRefName` to `""`, so any provenance-poorer refresh silently erased a
  // base another producer had already measured. GitHub PRs always have a base,
  // so no producer can mean "clear it" — absence means "nothing to say". The
  // update arm is now omission-preserving, matching the timestamp and author
  // fields it sits beside and the divergence note in the shared-builder test.
  it("leaves a measured base ref alone when a poorer producer reports none", () => {
    const input = { ...pullRequestInput(), baseBranch: "" };

    expect(buildPullRequestDetailUpdate(input)).not.toHaveProperty(
      "baseRefName"
    );
  });

  it("clears stored author identity when the provider reports a ghost author", () => {
    const update = buildPullRequestDetailUpdate({
      ...pullRequestInput(),
      authorLogin: null,
      authorProviderUserId: null,
      authorActorType: null,
    });

    expect(update.authorLogin).toBeNull();
    expect(update.authorProviderUserId).toBeNull();
    expect(update.authorActorType).toBeNull();
  });

  // ISS-8155 AC-2, "no second mapping path". The webhook is ONE producer with
  // two write sites — the branch-owned projection write and this detail-only
  // update — and they used to map the columns through separate object literals.
  // That is how `authorLogin` ended up webhook-only and `baseRefName` had no
  // producer at all. Agreement on the shared columns is the contract; drift on
  // any one of them fails here.
  it("maps the webhook detail lane's columns through the shared builder", () => {
    const pullRequest = createPullRequest({
      number: 123,
      title: "Shared writer",
      html_url: "https://github.com/acme/app/pull/123",
      additions: 44,
      deletions: 6,
      changed_files: 3,
    });
    pullRequest.base.ref = "release/24";
    pullRequest.user.login = "octocat";
    pullRequest.user.id = 123;
    pullRequest.user.type = GitHubActorType.User;

    const { body: _builderBody, ...sharedColumns } =
      buildPullRequestDetailUpdate(
        {
          number: 123,
          title: "Shared writer",
          htmlUrl: "https://github.com/acme/app/pull/123",
          baseBranch: "release/24",
          prState: GitHubPRState.Open,
          isDraft: false,
          additions: 44,
          deletions: 6,
          changedFiles: 3,
          githubCreatedAt: new Date("2026-02-10T00:00:00Z"),
          githubUpdatedAt: new Date("2026-02-10T00:00:00Z"),
          closedAt: null,
          mergedAt: null,
          mergeCommitSha: null,
          authorLogin: "octocat",
          authorProviderUserId: "123",
          authorActorType: GitHubActorType.User,
        },
        { setCurrent: false }
      );
    const webhookUpdate = pullRequestToDetailUpdate(pullRequest);

    expect(sharedColumns.baseRefName).toBe("release/24");
    expect(sharedColumns.authorLogin).toBe("octocat");
    expect(sharedColumns.authorProviderUserId).toBe("123");
    expect(webhookUpdate).toMatchObject(sharedColumns);
    // The one deliberate divergence: this lane's payload is authoritative for
    // the row, so a cleared description clears the column. The shared builder
    // preserves omission for the provenance-poorer producers that share it.
    expect(webhookUpdate.body).toBeNull();
    expect(sharedColumns).not.toHaveProperty("isCurrent");
  });
});
