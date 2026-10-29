/**
 * ISS-11596 characterization: the legacy gateway pull-request create route
 * keeps its observable behavior when its three git resolutions (S11 origin
 * slug, S12 current branch, S13 push, numbered as in PLN-2165) move to
 * `await getResolvedGitPathAsync()`. Every assertion must pass UNCHANGED on
 * `origin/main` and on the branch. The fake git makes the override unusable at
 * the step under test, so the ISS-10194 strict refusal shows where the route
 * surfaces a resolver failure.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DesktopGithubPullRequestApiPath,
  DesktopGithubPullRequestContractVersion,
  DesktopGithubPullRequestErrorCode,
  DesktopGithubPullRequestReason,
  DesktopGithubPullRequestStage,
  DesktopGithubPullRequestStatus,
  DesktopGithubPullRequestSuccessMode,
} from "@repo/api/src/types/desktop-github-pull-request";
import { afterEach, describe, expect, test } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { configureBinaryPathsResolver } from "../src/server/operations/binary-path-overrides.js";
import { registerGitPrCreateRoute } from "../src/server/operations/git-pr-create.js";
import { getRemoteRepoSlugs } from "../src/server/operations/git-pr-exec.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
} from "./helpers/git-gateway-op-harness.js";
import {
  assertStrictBinaryOverrides,
  type RevocableBinary,
  revocableBinary,
} from "./helpers/git-path-resolution-fixtures.js";

const { makeTempDir } = createGitOpTempDirs("iss11596-prc-");
const binDirs: string[] = [];

afterEach(async () => {
  configureBinaryPathsResolver(null);
  for (const dir of binDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const PREFLIGHT_OK = {
  success: true,
  contractVersion: DesktopGithubPullRequestContractVersion,
  mode: DesktopGithubPullRequestSuccessMode.Preflight,
  status: DesktopGithubPullRequestStatus.Available,
  repository: { fullName: "acme/widgets", defaultBranch: "main" },
  identity: { login: "daveth" },
};

const CREATE_OK = {
  success: true,
  contractVersion: DesktopGithubPullRequestContractVersion,
  mode: DesktopGithubPullRequestSuccessMode.Create,
  status: DesktopGithubPullRequestStatus.Created,
  pullRequest: { url: "https://github.com/acme/widgets/pull/42", number: 42 },
};

/** Which git step makes the override unusable (`chmod 644 "$0"`) after it runs. */
const RevokeAfter = {
  Never: "never",
  RevParse: "rev-parse",
} as const;
type RevokeAfter = (typeof RevokeAfter)[keyof typeof RevokeAfter];

async function makeRepoWithFakeGit(revokeAfter: RevokeAfter): Promise<{
  repoDir: string;
  git: RevocableBinary;
}> {
  const repoDir = makeTempDir();
  const binDir = await mkdtemp(path.join(tmpdir(), "iss11596-prc-bin-"));
  binDirs.push(binDir);
  const revokeOnRevParse =
    revokeAfter === RevokeAfter.RevParse ? 'chmod 644 "$0"; ' : "";
  const git = revocableBinary(
    binDir,
    "git",
    `#!/bin/sh
case "$1" in
  rev-parse) ${revokeOnRevParse}printf 'feat/cov\\n' ;;
  remote) printf 'git@github.com:acme/widgets.git\\n' ;;
  push) exit 0 ;;
  *) exit 1 ;;
esac
`
  );
  configureBinaryPathsResolver(() => ({ git: git.path }));
  return { repoDir, git };
}

function scriptedFetch(
  bodies: unknown[],
  onFetch: (index: number) => void = () => undefined
): { fetch: typeof fetch; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (_input: RequestInfo | URL, init?: RequestInit) => {
    onFetch(sent.length);
    sent.push(
      JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    );
    const next = bodies.shift();
    if (next === undefined) {
      return Promise.reject(new Error("unexpected fetch"));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ success: true, data: next }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  };
  return { fetch: fetchImpl as typeof fetch, sent };
}

function dispatchCreate(repoDir: string, fetchImpl: typeof fetch) {
  const dispatcher = new OperationDispatcher();
  registerGitPrCreateRoute(dispatcher, () => [repoDir], {
    fetch: fetchImpl,
    getAccessToken: () => Promise.resolve("desktop-token"),
    getApiOrigin: () => "https://api.closedloop.test",
  });
  return dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: DesktopGithubPullRequestApiPath.LegacyGatewayPullRequest,
    body: JSON.stringify({
      repoPath: repoDir,
      title: "Coverage PR",
      body: "Description",
    }),
  });
}

describe("legacy gateway pull request create, git resolution sites", () => {
  test("a working override creates the pull request", async () => {
    const { repoDir } = await makeRepoWithFakeGit(RevokeAfter.Never);
    const api = scriptedFetch([PREFLIGHT_OK, CREATE_OK]);

    const response = await dispatchCreate(repoDir, api.fetch);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      success: true,
      url: "https://github.com/acme/widgets/pull/42",
      number: 42,
      message: "Created PR #42",
    });
    expect(api.sent).toHaveLength(2);
  });

  test("S12: an unusable override fails local preflight reading the current branch", async () => {
    assertStrictBinaryOverrides();
    const { repoDir, git } = await makeRepoWithFakeGit(RevokeAfter.Never);
    git.revoke();
    const api = scriptedFetch([]);

    const response = await dispatchCreate(repoDir, api.fetch);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error:
        "Unable to read the current git branch before pull request creation.",
      code: DesktopGithubPullRequestErrorCode.RepositoryUnavailable,
      reason: DesktopGithubPullRequestReason.RepositoryUnavailable,
      stage: DesktopGithubPullRequestStage.LocalPreflight,
      retryable: false,
      burnRetryBudget: false,
    });
    expect(api.sent).toHaveLength(0);
  });

  test("S11: an override made unusable after rev-parse reads empty origin slugs", async () => {
    assertStrictBinaryOverrides();
    const { repoDir } = await makeRepoWithFakeGit(RevokeAfter.RevParse);
    const api = scriptedFetch([]);

    const response = await dispatchCreate(repoDir, api.fetch);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: "GitHub origin remote is required for pull request creation.",
      code: DesktopGithubPullRequestErrorCode.RepositoryUnavailable,
      reason: DesktopGithubPullRequestReason.RepositoryUnavailable,
      stage: DesktopGithubPullRequestStage.LocalPreflight,
      retryable: false,
      burnRetryBudget: false,
    });
    expect(api.sent).toHaveLength(0);
  });

  test("S11: getRemoteRepoSlugs swallows the refusal into empty slugs", async () => {
    assertStrictBinaryOverrides();
    const { repoDir, git } = await makeRepoWithFakeGit(RevokeAfter.Never);
    git.revoke();

    await expect(getRemoteRepoSlugs(repoDir)).resolves.toEqual({
      fetchRepoFullName: "",
      pushRepoFullName: "",
    });
  });

  test("S13: an override made unusable during preflight reports a push failure without calling create", async () => {
    assertStrictBinaryOverrides();
    const { repoDir, git } = await makeRepoWithFakeGit(RevokeAfter.Never);
    const api = scriptedFetch([PREFLIGHT_OK], (index) => {
      if (index === 0) {
        git.revoke();
      }
    });

    const response = await dispatchCreate(repoDir, api.fetch);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      success: false,
      error: "Failed to push the current branch before pull request creation.",
      code: DesktopGithubPullRequestErrorCode.ProviderRejected,
      reason: DesktopGithubPullRequestReason.ProviderRejected,
      stage: DesktopGithubPullRequestStage.GitPush,
      retryable: false,
      burnRetryBudget: false,
    });
    expect(api.sent).toHaveLength(1);
  });
});
