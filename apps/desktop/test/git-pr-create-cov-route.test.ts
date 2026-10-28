/**
 * ISS-11282 — branch coverage for git-pr-create.ts: a non-string description
 * with a ticket URL, an origin that is not a GitHub remote, push failures
 * classified as not-a-repository and as network errors, and an `existing`
 * create answer carrying server label details. A fake `git` script stands in
 * for the binary and a scripted fetch for the Closedloop API.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import {
  createGitOpTempDirs,
  dispatchOperation,
} from "./helpers/git-gateway-op-harness.js";

const { makeTempDir } = createGitOpTempDirs("iss11282-prc-");
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

type FixtureScripts = { remote?: string; push?: string };

async function makeRepoWithFakeGit(
  scripts: FixtureScripts = {}
): Promise<string> {
  const repoDir = makeTempDir();
  const binDir = await mkdtemp(path.join(tmpdir(), "iss11282-prc-bin-"));
  binDirs.push(binDir);
  const gitBin = path.join(binDir, "git");
  await writeFile(
    gitBin,
    `#!/bin/sh
case "$1" in
  rev-parse) printf 'feat/cov\\n' ;;
  remote) ${scripts.remote ?? "printf 'git@github.com:acme/widgets.git\\n'"} ;;
  push) ${scripts.push ?? "exit 0"} ;;
  *) exit 1 ;;
esac
`
  );
  await chmod(gitBin, 0o755);
  configureBinaryPathsResolver(() => ({ git: gitBin }));
  return repoDir;
}

function scriptedFetch(bodies: unknown[]): {
  fetch: typeof fetch;
  sent: Record<string, unknown>[];
} {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (_input: RequestInfo | URL, init?: RequestInit) => {
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

function dispatchCreate(
  repoDir: string,
  fetchImpl: typeof fetch,
  extraBody: Record<string, unknown> = {}
) {
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
      ...extraBody,
    }),
  });
}

function createAnswer(extra: Record<string, unknown>) {
  return {
    success: true,
    contractVersion: DesktopGithubPullRequestContractVersion,
    mode: DesktopGithubPullRequestSuccessMode.Create,
    status: DesktopGithubPullRequestStatus.Created,
    pullRequest: { url: "https://github.com/acme/widgets/pull/42", number: 42 },
    ...extra,
  };
}

describe("POST legacy gateway pull request — request shaping", () => {
  test("a non-string description with a ticket URL sends only the Linear footer as the body", async () => {
    const repoDir = await makeRepoWithFakeGit();
    const api = scriptedFetch([PREFLIGHT_OK, createAnswer({})]);

    const response = await dispatchCreate(repoDir, api.fetch, {
      body: 7,
      ticketUrl: "https://linear.app/acme/issue/ACME-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      success: true,
      url: "https://github.com/acme/widgets/pull/42",
      number: 42,
      message: "Created PR #42",
    });
    expect(api.sent[1]?.body).toBe(
      "---\nLinear: https://linear.app/acme/issue/ACME-1"
    );
  });

  test.each([
    [
      "the fetch and push URLs",
      "printf 'https://gitlab.com/acme/widgets.git\\n'",
    ],
    [
      "the fetch URL while the push URL is GitHub",
      "if [ \"$3\" = \"--push\" ]; then printf 'git@github.com:acme/widgets.git\\n'; else printf 'https://gitlab.com/acme/widgets.git\\n'; fi",
    ],
  ])(
    "a non-GitHub origin for %s fails local preflight before any API call",
    async (_label, remote) => {
      const repoDir = await makeRepoWithFakeGit({ remote });
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
    }
  );
});

describe("POST legacy gateway pull request — push failure classification", () => {
  test.each([
    {
      label: "a not-a-repository stderr",
      push: "echo 'fatal: not a git repository (or any parent)' >&2\nexit 128",
      code: DesktopGithubPullRequestErrorCode.RepositoryUnavailable,
      reason: DesktopGithubPullRequestReason.RepositoryUnavailable,
      error: "Not a git repository.",
      retryable: false,
    },
    {
      label: "a network stderr",
      push: "echo 'ssh: connect to host github.com: ECONNREFUSED' >&2\nexit 128",
      code: DesktopGithubPullRequestErrorCode.TransientUnavailable,
      reason: DesktopGithubPullRequestReason.TransientUnavailable,
      error: "Network error while pushing the current branch.",
      retryable: true,
    },
    {
      label: "any other stderr",
      push: "echo 'remote: rejected by policy' >&2\nexit 1",
      code: DesktopGithubPullRequestErrorCode.ProviderRejected,
      reason: DesktopGithubPullRequestReason.ProviderRejected,
      error: "Failed to push the current branch before pull request creation.",
      retryable: false,
    },
  ])("$label is reported as $code without calling create", async (expected) => {
    const repoDir = await makeRepoWithFakeGit({ push: expected.push });
    const api = scriptedFetch([PREFLIGHT_OK]);

    const response = await dispatchCreate(repoDir, api.fetch);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      success: false,
      error: expected.error,
      code: expected.code,
      reason: expected.reason,
      stage: DesktopGithubPullRequestStage.GitPush,
      retryable: expected.retryable,
      burnRetryBudget: false,
    });
    expect(api.sent).toHaveLength(1);
  });
});

describe("POST legacy gateway pull request — existing pull request answer", () => {
  test("an existing PR reports 'already exists' and passes through the server label details", async () => {
    const repoDir = await makeRepoWithFakeGit();
    const api = scriptedFetch([
      PREFLIGHT_OK,
      createAnswer({
        status: DesktopGithubPullRequestStatus.Existing,
        labels: {
          appliedLabels: ["docs"],
          labelsApplied: false,
          droppedLabels: ["too-long"],
          unappliedLabels: ["infra"],
        },
      }),
    ]);

    const response = await dispatchCreate(repoDir, api.fetch);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      success: true,
      url: "https://github.com/acme/widgets/pull/42",
      number: 42,
      message: "PR #42 already exists",
      labelsApplied: false,
      appliedLabels: ["docs"],
      droppedLabels: ["too-long"],
      unappliedLabels: ["infra"],
    });
  });
});
