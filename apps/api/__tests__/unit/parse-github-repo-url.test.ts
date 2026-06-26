import { describe, expect, it } from "vitest";
import { parseGitHubRepoUrl } from "@/app/integrations/github/public-repositories/service";

describe("parseGitHubRepoUrl", () => {
  describe("full https URLs", () => {
    it("parses https://github.com/owner/repo", () => {
      expect(parseGitHubRepoUrl("https://github.com/owner/repo")).toEqual({
        owner: "owner",
        name: "repo",
      });
    });

    it("parses http://github.com/owner/repo", () => {
      expect(parseGitHubRepoUrl("http://github.com/owner/repo")).toEqual({
        owner: "owner",
        name: "repo",
      });
    });

    it("parses https://github.com/owner/repo.git", () => {
      expect(parseGitHubRepoUrl("https://github.com/owner/repo.git")).toEqual({
        owner: "owner",
        name: "repo",
      });
    });

    it("parses https://github.com/owner/repo/ with trailing slash", () => {
      expect(parseGitHubRepoUrl("https://github.com/owner/repo/")).toEqual({
        owner: "owner",
        name: "repo",
      });
    });

    it("parses uppercase HTTPS protocol", () => {
      expect(parseGitHubRepoUrl("HTTPS://github.com/owner/repo")).toEqual({
        owner: "owner",
        name: "repo",
      });
    });
  });

  describe("URLs without protocol", () => {
    it("parses github.com/owner/repo without protocol", () => {
      expect(parseGitHubRepoUrl("github.com/owner/repo")).toEqual({
        owner: "owner",
        name: "repo",
      });
    });

    it("parses www.github.com/owner/repo", () => {
      expect(parseGitHubRepoUrl("www.github.com/owner/repo")).toEqual({
        owner: "owner",
        name: "repo",
      });
    });
  });

  describe("owner/repo shorthand", () => {
    it("parses bare owner/repo", () => {
      expect(parseGitHubRepoUrl("owner/repo")).toEqual({
        owner: "owner",
        name: "repo",
      });
    });

    it("parses owner/repo with hyphens and dots", () => {
      expect(parseGitHubRepoUrl("my-org/my.repo-name")).toEqual({
        owner: "my-org",
        name: "my.repo-name",
      });
    });
  });

  describe("whitespace handling", () => {
    it("strips leading and trailing whitespace", () => {
      expect(parseGitHubRepoUrl("  https://github.com/owner/repo  ")).toEqual({
        owner: "owner",
        name: "repo",
      });
    });
  });

  describe("invalid inputs", () => {
    it("returns null for empty string", () => {
      expect(parseGitHubRepoUrl("")).toBeNull();
    });

    it("returns null for a URL with path depth beyond owner/repo", () => {
      expect(
        parseGitHubRepoUrl("https://github.com/owner/repo/tree/main")
      ).toBeNull();
    });

    it("returns null for a github.com URL with only an owner and no repo", () => {
      expect(parseGitHubRepoUrl("https://github.com/owner")).toBeNull();
    });

    it("returns null for a bare owner with no slash", () => {
      expect(parseGitHubRepoUrl("just-an-owner")).toBeNull();
    });

    it("returns null for a non-GitHub domain URL", () => {
      expect(parseGitHubRepoUrl("https://gitlab.com/owner/repo")).toBeNull();
    });

    it("returns null when owner segment is empty", () => {
      expect(parseGitHubRepoUrl("https://github.com//repo")).toBeNull();
    });

    it("returns null when repo segment is empty after stripping .git", () => {
      expect(parseGitHubRepoUrl("owner/")).toBeNull();
    });
  });
});
