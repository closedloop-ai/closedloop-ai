import { BranchDetailChecksDelivery } from "@repo/api/src/types/branch-associated-pull-request";
import {
  mergeBranchPullRequestDetail,
  selectBranchPullRequestDetail,
} from "@repo/api/src/types/branch-selected-pull-request-detail";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { makeBranchDetail } from "../../__tests__/branch-fixtures";
import { canonicalBranchDetailResponseFixture } from "../../test-fixtures/canonical-branch-projection";
import { readBranchSelectedPullRequestDetail } from "../branch-detail-read";
import { createHttpBranchesDataSource } from "../branches-data-source";

const LAZY = `checks=${BranchDetailChecksDelivery.Lazy}`;

describe("HTTP Branch detail read (ISS-12278)", () => {
  it("asks for lazily delivered checks", async () => {
    const api = { get: vi.fn().mockResolvedValue({ id: "branch-1" }) };

    await createHttpBranchesDataSource(api).detail("branch-1");

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith(`/branches/branch-1?${LAZY}`);
  });

  it("keeps the selected PR identity alongside the checks delivery", async () => {
    const api = { get: vi.fn().mockResolvedValue({ id: "branch-1" }) };

    await createHttpBranchesDataSource(api).detail("branch-1", {
      repositoryFullName: "closedloop-ai/closedloop-ai",
      pullRequestNumber: 17,
    });

    expect(api.get).toHaveBeenCalledWith(
      `/branches/branch-1?repositoryFullName=closedloop-ai%2Fclosedloop-ai&pullRequestNumber=17&${LAZY}`
    );
  });

  it("retries once without the parameter when an older server rejects it", async () => {
    const detail = { id: "branch-1" };
    const api = {
      get: vi
        .fn()
        .mockRejectedValueOnce(new ApiError("Unrecognized key", 400))
        .mockResolvedValueOnce(detail),
    };

    await expect(
      createHttpBranchesDataSource(api).detail("branch-1")
    ).resolves.toBe(detail);
    expect(api.get).toHaveBeenNthCalledWith(2, "/branches/branch-1");
  });

  it("does not retry any other failure", async () => {
    const failure = new ApiError("Branch not found", 404);
    const api = { get: vi.fn().mockRejectedValue(failure) };

    await expect(
      createHttpBranchesDataSource(api).detail("branch-1")
    ).rejects.toBe(failure);
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});

const SELECTION = { repositoryFullName: "owner/repo", pullRequestNumber: 17 };

describe("selected PR detail compatibility and merge", () => {
  it("fetches only the selected projection on a supporting server", async () => {
    const projection = selectBranchPullRequestDetail(
      makeBranchDetail({ prNumber: 17 })
    );
    const api = { get: vi.fn().mockResolvedValue(projection) };
    expect(
      await readBranchSelectedPullRequestDetail(api, "branch-1", SELECTION)
    ).toEqual(projection);
    expect(api.get).toHaveBeenCalledExactlyOnceWith(
      "/branches/branch-1/selected-pull-request?repositoryFullName=owner%2Frepo&pullRequestNumber=17"
    );
  });

  it.each([
    { checksTotal: -1 },
    { prNumber: 1.5 },
    { additions: Number.POSITIVE_INFINITY },
    { canonicalMetricCycle: { outcome: "unknown" } },
    { associatedPullRequests: { items: "invalid" } },
  ])(
    "rejects malformed selected projection data before caching it: %j",
    async (invalid) => {
      const api = {
        get: vi.fn().mockResolvedValue({
          ...selectBranchPullRequestDetail(makeBranchDetail()),
          ...invalid,
        }),
      };
      await expect(
        readBranchSelectedPullRequestDetail(api, "branch-1", SELECTION)
      ).rejects.toThrow();
      expect(api.get).toHaveBeenCalledOnce();
    }
  );

  it("falls back to the legacy detail route when the new route is absent", async () => {
    const detail = makeBranchDetail({ prNumber: 17 });
    const api = {
      get: vi
        .fn()
        .mockRejectedValueOnce(new ApiError("Not found", 404))
        .mockResolvedValueOnce(detail),
    };
    expect(
      await readBranchSelectedPullRequestDetail(api, "branch-1", SELECTION)
    ).toEqual(detail);
    expect(api.get).toHaveBeenNthCalledWith(
      2,
      `/branches/branch-1?repositoryFullName=owner%2Frepo&pullRequestNumber=17&${LAZY}`
    );
  });

  it.each([401, 403, 500])(
    "does not retry a %s failure against another route",
    async (status) => {
      const error = new ApiError("Unavailable", status);
      const api = { get: vi.fn().mockRejectedValue(error) };
      await expect(
        readBranchSelectedPullRequestDetail(api, "branch-1", SELECTION)
      ).rejects.toBe(error);
      expect(api.get).toHaveBeenCalledOnce();
    }
  );

  it("keeps branch evidence while replacing PR fields and clearing absent optional fields", () => {
    const branch = makeBranchDetail({
      prNumber: 1,
      prTitle: "Previous",
      pullRequestRefreshPending: true,
      reviewedParticipants: [],
    });
    const selected = selectBranchPullRequestDetail(
      makeBranchDetail({
        prNumber: 17,
        prTitle: "Selected",
        headSha: "new-head",
      })
    );
    const merged = mergeBranchPullRequestDetail(branch, selected);
    expect(merged.prNumber).toBe(17);
    expect(merged.prTitle).toBe("Selected");
    expect(merged.headSha).toBe("new-head");
    expect(merged.sessions).toBe(branch.sessions);
    expect(merged.commits).toBe(branch.commits);
    expect(merged).not.toHaveProperty("pullRequestRefreshPending");
    expect(merged).not.toHaveProperty("reviewedParticipants");
    for (const key of [
      "sessions",
      "commits",
      "mergedTrace",
      "canonicalProjection",
    ]) {
      expect(selected).not.toHaveProperty(key);
    }
  });

  it("round-trips every canonical projection field without duplicating branch evidence on the wire", () => {
    const branch = canonicalBranchDetailResponseFixture;
    expect(
      mergeBranchPullRequestDetail(
        branch,
        selectBranchPullRequestDetail(branch)
      )
    ).toEqual(branch);
  });
});
