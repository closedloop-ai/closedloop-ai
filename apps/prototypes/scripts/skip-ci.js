const { execFileSync, execSync } = require("node:child_process");

// ISS-9687: this project now publishes two artifacts — the prototype sandbox
// itself, and the Storybook static build mounted at `/storybook/` — and only
// the first lives under this project's Vercel Root Directory.
//
// Scope what this script can do, because the two gates are easy to conflate.
// Vercel's own affected-project filter runs OUTSIDE the Ignored Build Step and
// decides FIRST: it cancels a project it considers unaffected and reports
// `success` with "Skipped - Not affected" (on since ISS-4488; see the same note
// in apps/app/scripts/skip-ci.js and .github/workflows/pr-test.yml). So this
// script is a NARROWING filter only — it can stop a build Vercel was going to
// run, it cannot start one Vercel already cancelled. Keeping `/storybook` fresh
// on a commit that touches neither this Root Directory nor a workspace
// dependency of it therefore ALSO needs that filter disabled for this project,
// which is a dashboard fact this repo can neither observe nor enforce
// (docs/design/storybook-governance.md §Hosting).
//
// What this list does own is the other half: never skipping a commit that does
// feed either artifact. Entries ending in `/` are directory prefixes; the rest
// are exact repo-root-relative file paths.
const DEPLOY_TRIGGER_PATHS = [
  "apps/prototypes/",
  "apps/storybook/",
  // Storybook indexes desktop-renderer stories by filesystem glob, which no
  // package dependency reaches — see the `stories` array in
  // apps/storybook/.storybook/main.ts. Scoped to `src/`, NOT to that glob root:
  // what the build compiles is each story's IMPORT CLOSURE, and that already
  // escapes `components/` today (update-banner.stories.tsx reads
  // `src/shared/packaged-update-install-blocked-reason.ts`, the settings
  // stories read `src/renderer/hooks/use-cloud-status.ts`). Same owning source
  // boundary, for the same reason, as the `storybook` path filter in
  // .github/workflows/pr-test.yml.
  "apps/desktop/src/",
  // Every workspace package, not a hand-listed subset. Both artifacts bundle
  // `@repo/*` transitively (packages/app pulls packages/api, and so on), so any
  // enumeration of that closure drifts the moment a package gains a dependency.
  "packages/",
  // Resolution inputs: a dependency bump changes what either build produces
  // without touching a single file above.
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  // The build contract itself: `prototypes#build`'s task dependency, extra
  // inputs and cached outputs all live here, so a commit touching only this
  // file changes what gets built and what a cache hit is allowed to restore.
  "turbo.json",
];

const commitRef = process.env.VERCEL_GIT_COMMIT_REF ?? "";
const VIBE_BRANCH_PREFIX = "vibe/";
// ISS-12353 (Perrin Upcott, 2026-10-09, PRD-791): this project builds only the
// deployment refs and the three prototype lanes, so an ordinary PR branch and
// a merge-queue ref get no prototype or Storybook preview. Match the
// git.deploymentEnabled policy in this app's vercel.json. The prefixes are the
// ones packages/database/scripts/vibe-environment-retention.ts retains; this
// script runs before install and cannot import that module, so
// scripts/deploy/vercel-branch-deployment-policy.test.ts pins the copy.
const DEPLOY_REFS = new Set(["green", "production"]);
const REVIEW_PREFIXES = [
  "prototype/",
  VIBE_BRANCH_PREFIX,
  "functional-prototype/",
];

if (
  !(
    DEPLOY_REFS.has(commitRef) ||
    REVIEW_PREFIXES.some((prefix) => commitRef.startsWith(prefix))
  )
) {
  console.log(
    `Skipping build: ${commitRef} is not a deployment or review ref.`
  );
  process.exit(0);
}

const commitMessage = execSync("git log -1 --pretty=%B").toString().trim();

// ISS-9704: the SUBJECT line only, never the whole body. A bare `includes` over
// the full message meant a commit that merely DISCUSSED this marker — in prose,
// in backticks, in a changelog bullet — cancelled every Vercel deploy. A real
// directive is conventionally written on the subject line; a mention is not.
// GitHub Actions applies its own copy of this rule to the whole message and
// creates no run for the two events it covers — `push` and `pull_request`, and
// only those. Not configurable from this repo, so the mention still costs every
// required PR context — docs/runbooks/pr-authoring.md.
const commitSubject = commitMessage.split("\n", 1)[0];

if (commitSubject.includes("[skip ci]")) {
  console.log("Skipping build due to [skip ci] in commit message.");
  process.exit(0); // this causes Vercel to skip the build
}

// ISS-12135: a vibe session's branch always builds its Storybook, which is the
// link design reviews. Skipping an unaffected push there would leave the
// branch with no Storybook of its own, and the branch alias of a project with
// no deployment on the branch is answered by stage production instead.
if (commitRef.startsWith(VIBE_BRANCH_PREFIX)) {
  console.log("Continuing build for a vibe session branch.");
  process.exit(1);
}

const changedFiles = readChangedFiles();

// No usable range means no evidence, which is not the same as no relevant
// change: a branch's first deployment exposes no previous SHA, a shallow clone
// cannot resolve one, and a redeploy of the same commit diffs to nothing. Build.
if (changedFiles === null || changedFiles.length === 0) {
  console.log("Continuing build: no usable changed-file range.");
  process.exit(1);
}

const triggering = changedFiles.filter(isDeployTriggerPath);

if (triggering.length === 0) {
  console.log(
    `Skipping build: none of ${changedFiles.length} changed file(s) affect the prototype sandbox or the hosted Storybook.`
  );
  process.exit(0); // this causes Vercel to skip the build
}

console.log(`Continuing build: ${triggering[0]} changed.`);
process.exit(1); // continue with build

function isDeployTriggerPath(file) {
  return DEPLOY_TRIGGER_PATHS.some((trigger) =>
    trigger.endsWith("/") ? file.startsWith(trigger) : file === trigger
  );
}

/**
 * Repo-root-relative paths changed since the last successful deployment of this
 * project and branch, or `null` when that base commit does not resolve.
 *
 * `VERCEL_GIT_PREVIOUS_SHA` is the base. Vercel documents it as exposed exactly
 * when an Ignored Build Step is configured, which is this script, and as the
 * last SUCCESSFUL deployment — so it spans every commit that has not been
 * deployed yet. `HEAD^` is the obvious fallback and is wrong: it sees only the
 * final commit, so a push whose Storybook change sat in an earlier commit of the
 * same push would be skipped.
 */
function readChangedFiles() {
  const base = process.env.VERCEL_GIT_PREVIOUS_SHA;

  if (!base) {
    return null;
  }

  try {
    // execFileSync, not a shell string: `base` comes from the environment.
    // `--no-renames`: with rename detection on (git's default), a file moved
    // out of a trigger path is listed only at its destination, so the removal
    // from this deployment's inputs never reaches the filter.
    const output = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", base, "HEAD"],
      { stdio: ["ignore", "pipe", "ignore"] }
    ).toString();

    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // Unknown or unreachable base: shallow clone, force-push, rebased branch.
    return null;
  }
}
