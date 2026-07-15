import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchRepoComponents,
  RepoComponentsTruncatedError,
  RepoTreeTruncatedError,
} from "./pack-repo-import";

const getInstallationOctokitMock = vi.fn();

vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: (installationId: string) =>
    getInstallationOctokitMock(installationId),
}));

type TreeEntry = { type: string; path: string; sha: string };

function base64(content: string): string {
  return Buffer.from(content, "utf-8").toString("base64");
}

/**
 * Build a fake Octokit whose git.getBlob resolves a blob's content from a
 * sha→content map, so tests can assert exactly which blobs were fetched.
 */
function makeOctokit(opts: {
  defaultBranch?: string;
  tree: TreeEntry[];
  truncated?: boolean;
  blobs: Record<string, string>;
}) {
  const getBlob = vi.fn(({ file_sha }: { file_sha: string }) =>
    Promise.resolve({
      data: { content: base64(opts.blobs[file_sha] ?? ""), encoding: "base64" },
    })
  );
  const getTree = vi.fn(() =>
    Promise.resolve({
      data: { tree: opts.tree, truncated: opts.truncated ?? false },
    })
  );
  const reposGet = vi.fn(() =>
    Promise.resolve({
      data: { default_branch: opts.defaultBranch ?? "main" },
    })
  );
  return {
    octokit: {
      repos: { get: reposGet },
      git: { getTree, getBlob },
    },
    getBlob,
    getTree,
    reposGet,
  };
}

describe("fetchRepoComponents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("classifies canonical Claude Code files into components", async () => {
    const { octokit, getBlob } = makeOctokit({
      tree: [
        { type: "blob", path: "agents/reviewer.md", sha: "sha-agent" },
        { type: "blob", path: "commands/deploy.md", sha: "sha-command" },
        { type: "blob", path: "skills/lint/SKILL.md", sha: "sha-skill" },
        // Non-candidate files must be ignored (no blob fetch).
        { type: "blob", path: "README.md", sha: "sha-readme" },
        { type: "tree", path: "agents", sha: "sha-dir" },
      ],
      blobs: {
        "sha-agent": "# Reviewer agent",
        "sha-command": "# Deploy command",
        "sha-skill": "# Lint skill",
      },
    });
    getInstallationOctokitMock.mockResolvedValue(octokit);

    const components = await fetchRepoComponents({
      installationId: "inst-1",
      owner: "acme",
      repo: "shared",
    });

    expect(getInstallationOctokitMock).toHaveBeenCalledWith("inst-1");
    // Only the three candidate blobs are fetched, not README / dir entries.
    expect(getBlob).toHaveBeenCalledTimes(3);
    expect(components).toEqual(
      expect.arrayContaining([
        { kind: "agent", name: "reviewer", content: "# Reviewer agent" },
        { kind: "command", name: "deploy", content: "# Deploy command" },
        { kind: "skill", name: "lint", content: "# Lint skill" },
      ])
    );
    expect(components).toHaveLength(3);
  });

  it("resolves the repo default branch when no ref is given", async () => {
    const { octokit, getTree, reposGet } = makeOctokit({
      defaultBranch: "develop",
      tree: [{ type: "blob", path: "agents/a.md", sha: "sha-a" }],
      blobs: { "sha-a": "a" },
    });
    getInstallationOctokitMock.mockResolvedValue(octokit);

    await fetchRepoComponents({
      installationId: "inst-1",
      owner: "acme",
      repo: "shared",
    });

    expect(reposGet).toHaveBeenCalledWith({ owner: "acme", repo: "shared" });
    expect(getTree).toHaveBeenCalledWith(
      expect.objectContaining({ tree_sha: "develop", recursive: "true" })
    );
  });

  it("does not resolve the default branch when a ref is supplied", async () => {
    const { octokit, getTree, reposGet } = makeOctokit({
      tree: [{ type: "blob", path: "agents/a.md", sha: "sha-a" }],
      blobs: { "sha-a": "a" },
    });
    getInstallationOctokitMock.mockResolvedValue(octokit);

    await fetchRepoComponents({
      installationId: "inst-1",
      owner: "acme",
      repo: "shared",
      ref: "v1.2.3",
    });

    expect(reposGet).not.toHaveBeenCalled();
    expect(getTree).toHaveBeenCalledWith(
      expect.objectContaining({ tree_sha: "v1.2.3" })
    );
  });

  it("only imports files under the given subPath", async () => {
    const { octokit, getBlob } = makeOctokit({
      tree: [
        { type: "blob", path: ".claude/agents/inside.md", sha: "sha-in" },
        { type: "blob", path: "agents/outside.md", sha: "sha-out" },
      ],
      blobs: {
        "sha-in": "inside content",
        "sha-out": "outside content",
      },
    });
    getInstallationOctokitMock.mockResolvedValue(octokit);

    const components = await fetchRepoComponents({
      installationId: "inst-1",
      owner: "acme",
      repo: "shared",
      subPath: ".claude",
    });

    // The subPath is stripped before classification, and files outside it are
    // never fetched.
    expect(getBlob).toHaveBeenCalledTimes(1);
    expect(getBlob).toHaveBeenCalledWith(
      expect.objectContaining({ file_sha: "sha-in" })
    );
    expect(components).toEqual([
      { kind: "agent", name: "inside", content: "inside content" },
    ]);
  });

  it("normalizes subPath leading/trailing slashes", async () => {
    const { octokit, getBlob } = makeOctokit({
      tree: [{ type: "blob", path: ".claude/agents/a.md", sha: "sha-a" }],
      blobs: { "sha-a": "a" },
    });
    getInstallationOctokitMock.mockResolvedValue(octokit);

    const components = await fetchRepoComponents({
      installationId: "inst-1",
      owner: "acme",
      repo: "shared",
      subPath: "/.claude/",
    });

    expect(getBlob).toHaveBeenCalledTimes(1);
    expect(components).toEqual([{ kind: "agent", name: "a", content: "a" }]);
  });

  it("throws RepoTreeTruncatedError and fetches no blobs when the tree is truncated", async () => {
    const { octokit, getBlob } = makeOctokit({
      truncated: true,
      tree: [{ type: "blob", path: "agents/a.md", sha: "sha-a" }],
      blobs: { "sha-a": "a" },
    });
    getInstallationOctokitMock.mockResolvedValue(octokit);

    await expect(
      fetchRepoComponents({
        installationId: "inst-1",
        owner: "acme",
        repo: "shared",
      })
    ).rejects.toBeInstanceOf(RepoTreeTruncatedError);

    // Import must fail before any component blob is read, so callers never
    // receive a silently-partial component set.
    expect(getBlob).not.toHaveBeenCalled();
  });

  /** Build N distinct candidate agent files (each a valid component path). */
  function agentTree(count: number): {
    tree: TreeEntry[];
    blobs: Record<string, string>;
  } {
    const tree: TreeEntry[] = [];
    const blobs: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
      const sha = `sha-${i}`;
      tree.push({ type: "blob", path: `agents/a${i}.md`, sha });
      blobs[sha] = `content ${i}`;
    }
    return { tree, blobs };
  }

  it("throws RepoComponentsTruncatedError and fetches no blobs when candidates exceed the cap", async () => {
    // 301 candidate components — one over MAX_COMPONENT_FILES (300). Slicing to
    // the cap would silently drop the 301st, so the import must fail loudly.
    const { tree, blobs } = agentTree(301);
    const { octokit, getBlob } = makeOctokit({ tree, blobs });
    getInstallationOctokitMock.mockResolvedValue(octokit);

    await expect(
      fetchRepoComponents({
        installationId: "inst-1",
        owner: "acme",
        repo: "shared",
      })
    ).rejects.toBeInstanceOf(RepoComponentsTruncatedError);

    // No partial import: the truncation must be detected before any blob fetch.
    expect(getBlob).not.toHaveBeenCalled();
  });

  it("surfaces the total candidate count and subPath guidance in the truncation error", async () => {
    const { tree, blobs } = agentTree(305);
    const { octokit } = makeOctokit({ tree, blobs });
    getInstallationOctokitMock.mockResolvedValue(octokit);

    const error = await fetchRepoComponents({
      installationId: "inst-1",
      owner: "acme",
      repo: "shared",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RepoComponentsTruncatedError);
    // The message reports the actual candidate count and the actionable fix.
    expect((error as Error).message).toContain("305");
    expect((error as Error).message).toContain("subPath");
  });

  it("imports normally when candidates are exactly at the cap", async () => {
    // Exactly MAX_COMPONENT_FILES (300) candidates: at the cap is not over it,
    // so every candidate blob is fetched and no truncation error is thrown.
    const { tree, blobs } = agentTree(300);
    const { octokit, getBlob } = makeOctokit({ tree, blobs });
    getInstallationOctokitMock.mockResolvedValue(octokit);

    const components = await fetchRepoComponents({
      installationId: "inst-1",
      owner: "acme",
      repo: "shared",
    });

    expect(getBlob).toHaveBeenCalledTimes(300);
    expect(components).toHaveLength(300);
  });
});
