import { describe, expect, it } from "vitest";
import { selectedPullRequestRepositoryFullName } from "./selected-pull-request-repository-identity";

/**
 * Each case pins one rung of the precedence chain, so reordering the operands
 * in the single owner fails here rather than silently answering about a
 * different repository on whichever lane was not edited.
 */
describe("selectedPullRequestRepositoryFullName", () => {
  it("prefers the detail's joined repository over every other source", () => {
    expect(
      selectedPullRequestRepositoryFullName(
        {
          branch: {
            repository: { fullName: "branch-join/repo" },
            repositoryFullName: "branch-column/repo",
          },
        },
        {
          repository: { fullName: "Detail-Join/Repo" },
          repositoryFullName: "detail-column/repo",
        }
      )
    ).toBe("detail-join/repo");
  });

  it("falls to the detail's denormalized column before either branch source", () => {
    expect(
      selectedPullRequestRepositoryFullName(
        {
          branch: {
            repository: { fullName: "branch-join/repo" },
            repositoryFullName: "branch-column/repo",
          },
        },
        { repository: null, repositoryFullName: "detail-column/repo" }
      )
    ).toBe("detail-column/repo");
  });

  it("falls to the branch's joined repository before the branch column", () => {
    expect(
      selectedPullRequestRepositoryFullName(
        {
          branch: {
            repository: { fullName: "branch-join/repo" },
            repositoryFullName: "branch-column/repo",
          },
        },
        { repository: null, repositoryFullName: null }
      )
    ).toBe("branch-join/repo");
  });

  it("falls to the branch's denormalized column last", () => {
    expect(
      selectedPullRequestRepositoryFullName(
        {
          branch: {
            repository: null,
            repositoryFullName: "branch-column/repo",
          },
        },
        { repository: null, repositoryFullName: null }
      )
    ).toBe("branch-column/repo");
  });

  it("normalizes whatever source wins, so lanes compare byte-identical keys", () => {
    expect(
      selectedPullRequestRepositoryFullName(
        { branch: null },
        { repository: null, repositoryFullName: "  Acme/Widgets.git  " }
      )
    ).toBe("acme/widgets");
  });

  it("reports null rather than an empty name when no source has one", () => {
    expect(
      selectedPullRequestRepositoryFullName(
        { branch: { repository: null, repositoryFullName: null } },
        { repository: null, repositoryFullName: null }
      )
    ).toBeNull();
  });

  it("reports null for an empty detail column rather than an empty key", () => {
    // `??` skips only null/undefined, so an empty string is a PRESENT value
    // that ends the chain — the branch fallback is not consulted. Preserved
    // from all three copies; pinned so the null-vs-fallback answer cannot
    // change on one lane alone.
    expect(
      selectedPullRequestRepositoryFullName(
        {
          branch: {
            repository: null,
            repositoryFullName: "branch-column/repo",
          },
        },
        { repository: null, repositoryFullName: "" }
      )
    ).toBeNull();
  });
});
