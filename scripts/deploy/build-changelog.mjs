import { writeFile } from "node:fs/promises";

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const baseBranch = process.env.DEPLOY_BASE_BRANCH || "production";
const headBranch = process.env.DEPLOY_HEAD_BRANCH || "main";
const outputPath = process.env.CHANGELOG_PATH || "changelog.md";

if (!token) {
  throw new Error("GITHUB_TOKEN is required to build the changelog.");
}

if (!repository || !repository.includes("/")) {
  throw new Error("GITHUB_REPOSITORY must be set (owner/repo).");
}

const [owner, repo] = repository.split("/");

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
};

async function api(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${text}`);
  }
  return response.json();
}

const compare = await api(
  `/repos/${owner}/${repo}/compare/${baseBranch}...${headBranch}`
);

if (!compare || compare.ahead_by === 0) {
  await writeFile(
    outputPath,
    `No changes to deploy between \`${baseBranch}\` and \`${headBranch}\`.`
  );
  process.exit(0);
}

const commits = Array.isArray(compare.commits) ? compare.commits : [];
const prs = new Map();
const fallbackCommits = [];

for (const commit of commits) {
  const sha = commit.sha;
  try {
    const commitPRs = await api(
      `/repos/${owner}/${repo}/commits/${sha}/pulls`
    );
    if (Array.isArray(commitPRs) && commitPRs.length > 0) {
      for (const pr of commitPRs) {
        if (!prs.has(pr.number)) {
          prs.set(pr.number, {
            number: pr.number,
            title: pr.title,
            author: pr.user?.login,
            url: pr.html_url,
          });
        }
      }
    } else {
      fallbackCommits.push(commit);
    }
  } catch {
    fallbackCommits.push(commit);
  }
}

const lines = [];
lines.push(
  `Deploying ${compare.ahead_by} commit${
    compare.ahead_by === 1 ? "" : "s"
  } from \`${headBranch}\` → \`${baseBranch}\``
);
lines.push("");

if (prs.size > 0) {
  lines.push("Included PRs:");
  for (const pr of prs.values()) {
    const author = pr.author ? ` (by @${pr.author})` : "";
    lines.push(`- #${pr.number}: ${pr.title}${author}`);
  }
} else if (fallbackCommits.length > 0) {
  lines.push("Included commits:");
  for (const commit of fallbackCommits) {
    const message = String(commit.commit?.message || "").split("\n")[0];
    const shortSha = String(commit.sha || "").slice(0, 7);
    lines.push(`- ${message} (${shortSha})`);
  }
}

await writeFile(outputPath, lines.join("\n"));
