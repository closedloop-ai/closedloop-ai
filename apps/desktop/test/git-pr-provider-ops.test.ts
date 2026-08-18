/**
 * ISS-5299 wave-3 — closes uncovered branches in git-pr.ts (`GET /git/user`)
 * and git-pr-create.ts.
 *
 * PLN-1535 M5 deletion 2 retired the local-`gh` PR data lane, so the
 * `/pr/files`, `/pr/file-diff` and git-pr-comments-provider cases this file
 * also carried went with the code they covered. The retired routes' 410
 * contract is asserted in gateway-server.test.ts, over all eight paths at once.
 *
 * Drives real handlers (registerGitPrRoutes, registerGitPrCreateRoute) through
 * a scripted fake `gh` binary. No production-source edits, no logic duplication.
 *
 * Structurally unreachable branches — skipped with rationale:
 *   git-pr-create.ts L113 rethrow in resolveCreateRequest — assertRepoAllowed
 *                         only throws DirectoryNotAllowedError
 */
import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "node:test";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerGitPrRoutes } from "../src/server/operations/git-pr.js";
import { registerGitPrCreateRoute } from "../src/server/operations/git-pr-create.js";
import { configureBinaryPathsResolver } from "../src/server/operations/symphony-loop.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
} from "./helpers/git-gateway-op-harness.js";

const { makeTempDir } = createGitOpTempDirs("iss5299-pr-wave3-");

afterEach(() => {
  configureBinaryPathsResolver(null);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeExec(
  dir: string,
  name: string,
  script: string
): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, script);
  await chmod(p, 0o755);
  return p;
}

function makePrDispatcher(allowedDirs: string[]): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerGitPrRoutes(dispatcher, () => allowedDirs);
  return dispatcher;
}

function makeCreateDispatcher(allowedDirs: string[]): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerGitPrCreateRoute(dispatcher, () => allowedDirs);
  return dispatcher;
}

// ─── git-pr.ts: GET /api/gateway/git/user  (L166, L171) ──────────────────────

test("GET /user: empty gh output returns 500 could-not-determine-user (L166)", {
  timeout: 10_000,
}, async () => {
  const binDir = makeTempDir();
  const ghBin = await makeExec(binDir, "gh", "#!/bin/sh\nprintf ''");
  configureBinaryPathsResolver(() => ({ gh: ghBin }));
  const res = await dispatchOperation({
    dispatcher: makePrDispatcher([makeTempDir()]),
    method: "GET",
    pathname: "/api/gateway/git/user",
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, "Could not determine GitHub user");
});

test("GET /user: gh exits non-zero returns 500 failed-to-get-user (L171)", {
  timeout: 10_000,
}, async () => {
  const binDir = makeTempDir();
  const ghBin = await makeExec(binDir, "gh", "#!/bin/sh\nexit 1");
  configureBinaryPathsResolver(() => ({ gh: ghBin }));
  const res = await dispatchOperation({
    dispatcher: makePrDispatcher([makeTempDir()]),
    method: "GET",
    pathname: "/api/gateway/git/user",
  });
  assert.equal(res.statusCode, 500);
  assert.equal(
    res.body.error,
    "Failed to get GitHub user. Ensure gh is installed and authenticated."
  );
});

// ─── git-pr-create.ts: ticketUrl present (L124) ──────────────────────────────

test("POST /pr: ticketUrl present → fullBody appended with Linear link → 200 (L124)", {
  timeout: 10_000,
}, async () => {
  const binDir = makeTempDir();
  const ghBin = await makeExec(
    binDir,
    "gh",
    '#!/bin/sh\nprintf "https://github.com/o/r/pull/7\\n"'
  );
  const gitBin = await makeExec(binDir, "git", "#!/bin/sh\nprintf 'main\\n'");
  configureBinaryPathsResolver(() => ({ gh: ghBin, git: gitBin }));
  const dir = makeTempDir();
  const res = await dispatchOperation({
    dispatcher: makeCreateDispatcher([dir]),
    method: "POST",
    pathname: "/api/gateway/git/pr",
    body: JSON.stringify({
      repoPath: dir,
      title: "My PR",
      body: "some description",
      ticketUrl: "https://linear.app/my-team/issue/ABC-123",
    }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.number, 7);
});

// ─── git-pr-create.ts: viewExistingPullRequest (L59) ─────────────────────────

test("POST /pr: gh pr create fails with already-exists → viewExistingPullRequest succeeds → 200 (L59)", {
  timeout: 10_000,
}, async () => {
  const binDir = makeTempDir();
  const ghBin = await makeExec(
    binDir,
    "gh",
    `#!/bin/sh
case "$2" in
  create) printf 'A pull request already exists for this branch.\\n' >&2; exit 1 ;;
  view) printf '{"url":"https://github.com/o/r/pull/55","number":55}\\n' ;;
  *) exit 0 ;;
esac`
  );
  const gitBin = await makeExec(binDir, "git", "#!/bin/sh\nprintf 'main\\n'");
  configureBinaryPathsResolver(() => ({ gh: ghBin, git: gitBin }));
  const dir = makeTempDir();
  const res = await dispatchOperation({
    dispatcher: makeCreateDispatcher([dir]),
    method: "POST",
    pathname: "/api/gateway/git/pr",
    body: JSON.stringify({ repoPath: dir, title: "My PR" }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(String(res.body.message).includes("already exists"));
  assert.equal(res.body.number, 55);
});

// ─── git-pr-create.ts: non-URL from pr create → readPullRequestView (L168, L175)

test("POST /pr: non-URL from gh pr create falls through to readPullRequestView (L168, L175)", {
  timeout: 10_000,
}, async () => {
  const binDir = makeTempDir();
  const ghBin = await makeExec(
    binDir,
    "gh",
    `#!/bin/sh
case "$2" in
  create) printf 'PR was created successfully\\n' ;;
  view) printf '{"url":"https://github.com/o/r/pull/77","number":77}\\n' ;;
  *) exit 0 ;;
esac`
  );
  const gitBin = await makeExec(binDir, "git", "#!/bin/sh\nprintf 'main\\n'");
  configureBinaryPathsResolver(() => ({ gh: ghBin, git: gitBin }));
  const dir = makeTempDir();
  const res = await dispatchOperation({
    dispatcher: makeCreateDispatcher([dir]),
    method: "POST",
    pathname: "/api/gateway/git/pr",
    body: JSON.stringify({ repoPath: dir, title: "My PR" }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.number, 77);
  assert.ok(String(res.body.message).includes("77"));
});

// ─── git-pr-create.ts: labels present, prNumber absent (L281, L288) ───────────

test("POST /pr: labels requested but prNumber unavailable → labelsApplied false (L281, L288)", {
  timeout: 10_000,
}, async () => {
  const binDir = makeTempDir();
  // gh pr view returns no number field
  const ghBin = await makeExec(
    binDir,
    "gh",
    `#!/bin/sh
case "$2" in
  create) printf 'PR was created\\n' ;;
  view) printf '{"url":"https://github.com/o/r/pull/99"}\\n' ;;
  *) exit 0 ;;
esac`
  );
  const gitBin = await makeExec(binDir, "git", "#!/bin/sh\nprintf 'main\\n'");
  configureBinaryPathsResolver(() => ({ gh: ghBin, git: gitBin }));
  const dir = makeTempDir();
  const res = await dispatchOperation({
    dispatcher: makeCreateDispatcher([dir]),
    method: "POST",
    pathname: "/api/gateway/git/pr",
    body: JSON.stringify({
      repoPath: dir,
      title: "My PR",
      labels: [{ name: "bug", color: "ff0000" }],
    }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.labelsApplied, false);
  const unapplied = res.body.unappliedLabels as string[];
  assert.ok(Array.isArray(unapplied));
  assert.ok(unapplied.includes("bug"));
});

// ─── git-pr-create.ts: applyPullRequestLabels no GitHub remote (L337) ─────────

test("POST /pr: labels requested but git remote is not GitHub → unapplied labels reported (L337)", {
  timeout: 10_000,
}, async () => {
  const binDir = makeTempDir();
  const ghBin = await makeExec(
    binDir,
    "gh",
    '#!/bin/sh\nprintf "https://github.com/owner/repo/pull/42\\n"'
  );
  const gitBin = await makeExec(
    binDir,
    "git",
    `#!/bin/sh
case "$1" in
  rev-parse) printf 'main\\n' ;;
  remote) printf 'https://gitlab.com/owner/repo.git\\n' ;;
  *) exit 0 ;;
esac`
  );
  configureBinaryPathsResolver(() => ({ gh: ghBin, git: gitBin }));
  const dir = makeTempDir();
  const res = await dispatchOperation({
    dispatcher: makeCreateDispatcher([dir]),
    method: "POST",
    pathname: "/api/gateway/git/pr",
    body: JSON.stringify({
      repoPath: dir,
      title: "My PR",
      labels: [{ name: "feature", color: "0075ca" }],
    }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.labelsApplied, false);
});

// ─── git-pr-create.ts: listRepositoryLabelNames catch (L416), description (L440)

test("POST /pr: label-list gh call fails → catch returns [] → label creation proceeds (L416, L440)", {
  timeout: 10_000,
}, async () => {
  const binDir = makeTempDir();
  // Fail label listing; succeed for pr create and label add calls.
  const ghBin = await makeExec(
    binDir,
    "gh",
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    *"labels?per_page"*) printf 'label list error\\n' >&2; exit 1 ;;
  esac
done
case "$2" in
  create) printf 'https://github.com/myowner/myrepo/pull/42\\n' ;;
esac
exit 0`
  );
  const gitBin = await makeExec(
    binDir,
    "git",
    `#!/bin/sh
case "$1" in
  rev-parse) printf 'main\\n' ;;
  remote) printf 'https://github.com/myowner/myrepo.git\\n' ;;
  *) exit 0 ;;
esac`
  );
  configureBinaryPathsResolver(() => ({ gh: ghBin, git: gitBin }));
  const dir = makeTempDir();
  const res = await dispatchOperation({
    dispatcher: makeCreateDispatcher([dir]),
    method: "POST",
    pathname: "/api/gateway/git/pr",
    body: JSON.stringify({
      repoPath: dir,
      title: "My PR",
      labels: [{ name: "feat", color: "0075ca", description: "A new feature" }],
    }),
  });
  // Label list catch returns []; createRepositoryLabel runs with description
  // arg (L440); label add succeeds.
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
});
