/**
 * Thin typed wrappers over the `gh` CLI. Used by the apply sweep to find/approve
 * PRs and gather review comments for the self-improve drain. PR *creation* is
 * done by the harness inside a fix run (as in the legacy bash), not here.
 */
import { execCommand } from "../exec-cli.js";

export function gh(
  args: string[],
  opts: { cwd?: string } = {}
): Promise<string> {
  return execCommand("gh", args, opts);
}

async function ghJson<T>(
  args: string[],
  opts: { cwd?: string } = {}
): Promise<T> {
  const out = await gh(args, opts);
  return JSON.parse(out || "null") as T;
}

export type PrRef = {
  number: number;
  url: string;
  headRefName: string;
  updatedAt: string;
  state: string;
};

export class GitHubClient {
  private readonly repo: string;

  constructor(repo: string) {
    this.repo = repo;
  }

  /** Open PR URL for a head branch, or null. */
  async prUrlForHead(head: string): Promise<string | null> {
    const rows = await ghJson<Array<{ url: string }>>([
      "pr",
      "list",
      "--repo",
      this.repo,
      "--state",
      "open",
      "--head",
      head,
      "--json",
      "url",
    ]);
    return rows[0]?.url ?? null;
  }

  /** Open PR URL matching a title search (e.g. an issue slug), or null. */
  async prUrlForSearch(query: string): Promise<string | null> {
    const rows = await ghJson<Array<{ url: string }>>([
      "pr",
      "list",
      "--repo",
      this.repo,
      "--state",
      "open",
      "--search",
      `${query} in:title`,
      "--json",
      "url",
    ]);
    return rows[0]?.url ?? null;
  }

  /** True if a remote branch exists (a fix may have pushed without opening a PR yet). */
  async remoteBranchExists(branch: string, cwd?: string): Promise<boolean> {
    const out = await gh(
      ["api", `repos/${this.repo}/git/refs/heads/${branch}`],
      { cwd }
    ).catch(() => "");
    return out.includes('"ref"');
  }

  listRecentPrs(limit: number): Promise<PrRef[]> {
    return ghJson<PrRef[]>([
      "pr",
      "list",
      "--repo",
      this.repo,
      "--state",
      "all",
      "--limit",
      String(limit),
      "--json",
      "number,url,headRefName,updatedAt,state",
    ]);
  }

  issueComments(
    prNumber: number
  ): Promise<
    Array<{ user: { login: string }; body: string; created_at: string }>
  > {
    return ghJson([
      "api",
      `repos/${this.repo}/issues/${prNumber}/comments`,
      "--paginate",
    ]);
  }

  reviewComments(prNumber: number): Promise<
    Array<{
      user: { login: string };
      body: string;
      created_at: string;
      path?: string;
    }>
  > {
    return ghJson([
      "api",
      `repos/${this.repo}/pulls/${prNumber}/comments`,
      "--paginate",
    ]);
  }

  reviews(
    prNumber: number
  ): Promise<
    Array<{ user: { login: string }; body: string; submitted_at?: string }>
  > {
    return ghJson([
      "api",
      `repos/${this.repo}/pulls/${prNumber}/reviews`,
      "--paginate",
    ]);
  }

  async approve(prNumber: number, body: string): Promise<void> {
    await gh([
      "pr",
      "review",
      String(prNumber),
      "--repo",
      this.repo,
      "--approve",
      "--body",
      body,
    ]);
  }

  /** The authenticated gh login (used to skip a bot's own comments / own PRs). */
  async currentLogin(): Promise<string> {
    const out = await ghJson<{ login: string }>(["api", "user"]);
    return out.login;
  }
}
