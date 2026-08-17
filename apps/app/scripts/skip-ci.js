const { execSync } = require("node:child_process");

const commitMessage = execSync("git log -1 --pretty=%B").toString().trim();
const commitRef = process.env.VERCEL_GIT_COMMIT_REF ?? "";
// ISS-4487 (PRD-576): machine-generated branches produce previews nobody opens.
// This is deliberately an ignored BUILD rather than `git.deploymentEnabled`
// in vercel.json: a disabled deployment posts no commit status at all, and
// `Vercel - api-stage` / `app-stage` / `web-stage` are required checks on
// `main`, so those PRs would never become mergeable. An ignored build still
// reports success ("Canceled by Ignored Build Step"), which satisfies them.
// Plain prefixes, not globs — Dependabot nests below its prefix
// (`dependabot/npm_and_yarn/<pkg>-<ver>`), and `startsWith` covers that.
const SKIPPED_BRANCH_PREFIXES = ["bot/", "codex/", "dependabot/", "symphony/"];

// This ignoreCommand never skips a merge-queue ref. NOT because a skipped build
// would fail to report — it would: a skip creates a CANCELED deployment and
// Vercel posts a `success` commit status for it (verified 2026-08-10, ISS-5433;
// the earlier comment here claimed the opposite and was wrong). The reason is
// that a queue ref is the last gate before `main`, so it is the one place we
// actually want the build to run rather than be reported green without evidence.
//
// Scope this precisely: continuing here is not the same as "the build always
// runs". This script is only the repo's ignoreCommand. Vercel's own
// affected-project filter runs outside it and does cancel unaffected projects on
// merge-queue refs — observed 2026-08-10 across 17 real `merge_group` head SHAs,
// where the three required Vercel contexts posted 39 "Deployment has completed",
// 9 "Skipped - Not affected" and 3 pending.
if (commitRef.startsWith("gh-readonly-queue/")) {
  console.log("Continuing build for GitHub merge queue ref.");
  process.exit(1);
}

if (SKIPPED_BRANCH_PREFIXES.some((prefix) => commitRef.startsWith(prefix))) {
  console.log(`Skipping build for machine-generated branch: ${commitRef}`);
  process.exit(0); // this causes Vercel to skip the build
}

if (commitMessage.includes("[skip ci]")) {
  console.log("Skipping build due to [skip ci] in commit message.");
  process.exit(0); // this causes Vercel to skip the build
}

process.exit(1); // continue with build
