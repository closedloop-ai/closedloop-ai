import { describe, expect, it } from "vitest";
import { normalizeSelectedPullRequestInput } from "../selected-pull-request-identity";

/**
 * The files lane and the checks lane of one selected pull request now share
 * this entry validation. Before they did, only the checks lane refused a
 * segment containing `/`, so the slash cases below are the ones that used to
 * answer differently depending on which half of the same PR was being read.
 */
describe("normalizeSelectedPullRequestInput", () => {
  it("re-derives the reported identity from the normalized full name", () => {
    expect(normalizeSelectedPullRequestInput("Acme", "Widgets", 7)).toEqual({
      owner: "acme",
      repo: "widgets",
      pullNumber: 7,
      repositoryFullName: "acme/widgets",
    });
  });

  it("trims surrounding whitespace on both segments", () => {
    expect(
      normalizeSelectedPullRequestInput("  acme  ", " widgets ", 1)
    ).toEqual({
      owner: "acme",
      repo: "widgets",
      pullNumber: 1,
      repositoryFullName: "acme/widgets",
    });
  });

  it("refuses an owner carrying a slash instead of folding it away", () => {
    expect(normalizeSelectedPullRequestInput("/acme", "widgets", 7)).toBeNull();
    expect(
      normalizeSelectedPullRequestInput("evil/acme", "widgets", 7)
    ).toBeNull();
  });

  it("refuses a repo carrying a slash", () => {
    expect(
      normalizeSelectedPullRequestInput("acme", "widgets/private", 7)
    ).toBeNull();
  });

  /**
   * The two inputs the guard actually decides. Every other slash placement
   * over-segments the folded name and is refused downstream by
   * `parseRepositoryFullName` with or without the refinement; these two are
   * absorbed by `normalizeRepoFullName`'s leading- and trailing-slash strips,
   * so only the refinement stops them resolving to a repository the caller
   * never named.
   */
  it("refuses the two slash placements normalization would otherwise absorb", () => {
    expect(normalizeSelectedPullRequestInput("/acme", "widgets", 7)).toBeNull();
    expect(normalizeSelectedPullRequestInput("acme", "widgets/", 7)).toBeNull();
  });

  it("refuses an empty segment", () => {
    expect(normalizeSelectedPullRequestInput("", "widgets", 7)).toBeNull();
    expect(normalizeSelectedPullRequestInput("acme", "   ", 7)).toBeNull();
  });

  it("refuses a pull number that is not a positive integer", () => {
    expect(normalizeSelectedPullRequestInput("acme", "widgets", 0)).toBeNull();
    expect(normalizeSelectedPullRequestInput("acme", "widgets", -1)).toBeNull();
    expect(
      normalizeSelectedPullRequestInput("acme", "widgets", 1.5)
    ).toBeNull();
  });
});
