import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DesktopGithubPullRequestApiPath,
  DesktopGithubPullRequestBodyMaxLength,
  DesktopGithubPullRequestErrorCode,
  DesktopGithubPullRequestMode,
  DesktopGithubPullRequestReason,
  DesktopGithubPullRequestStage,
  DesktopGithubPullRequestStatus,
  DesktopGithubPullRequestSuccessMode,
} from "@repo/api/src/types/desktop-github-pull-request";
import { afterEach, test } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { configureBinaryPathsResolver } from "../src/server/operations/binary-path-overrides.js";
import { registerGitPrRoutes } from "../src/server/operations/git-pr.js";
import { registerGitPrCreateRoute } from "../src/server/operations/git-pr-create.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
} from "./helpers/git-gateway-op-harness.js";

const { makeTempDir } = createGitOpTempDirs("iss8637-pr-create-");
const tempDirs: string[] = [];

afterEach(async () => {
  configureBinaryPathsResolver(null);
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /api/gateway/git/user returns the explicit 410 compatibility stub", async () => {
  const { ghLog } = await makeBinaryFixture();
  const dispatcher = new OperationDispatcher();
  registerGitPrRoutes(dispatcher, () => [makeTempDir()]);

  const response = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: DesktopGithubPullRequestApiPath.LegacyGatewayGitUser,
  });

  assert.equal(response.statusCode, 410);
  assert.equal(response.body.error, "github_data_route_retired");
  assert.equal(await exists(ghLog), false);
});

test("POST /api/gateway/git/pr fails closed before push when the API route is missing", async () => {
  const { repoDir, gitLog, ghLog } = await makeBinaryFixture();
  const api = makeFetch([
    jsonResponse({ success: false, error: "Not Found" }, 404),
  ]);
  const response = await dispatchCreate(repoDir, api.fetch);

  assert.equal(response.statusCode, 503);
  assert.equal(
    response.body.code,
    DesktopGithubPullRequestErrorCode.ApiIncompatible
  );
  assert.equal(
    response.body.reason,
    DesktopGithubPullRequestReason.ApiIncompatible
  );
  assert.equal(response.body.stage, DesktopGithubPullRequestStage.ApiPreflight);
  assert.equal(response.body.retryable, false);
  assert.equal(response.body.burnRetryBudget, false);
  assert.equal(await commandWasRun(gitLog, "push"), false);
  assert.equal(await exists(ghLog), false);
  assert.equal(api.calls.length, 1);
  assert.deepEqual(api.calls[0]?.body, {
    contractVersion: 1,
    mode: DesktopGithubPullRequestMode.Preflight,
    repoFullName: "acme/widgets",
  });
});

test("POST /api/gateway/git/pr treats malformed preflight responses as API-incompatible", async () => {
  const { repoDir, gitLog, ghLog } = await makeBinaryFixture();
  const api = makeFetch([
    new Response("<html>old server</html>", { status: 200 }),
  ]);

  const response = await dispatchCreate(repoDir, api.fetch);

  assert.equal(response.statusCode, 503);
  assert.equal(
    response.body.code,
    DesktopGithubPullRequestErrorCode.ApiIncompatible
  );
  assert.equal(response.body.retryable, false);
  assert.equal(response.body.burnRetryBudget, false);
  assert.equal(await commandWasRun(gitLog, "push"), false);
  assert.equal(await exists(ghLog), false);
});

test("POST /api/gateway/git/pr fails closed when the local branch cannot be read", async () => {
  const { repoDir, gitLog, ghLog } = await makeBinaryFixture({
    revParseScript: "echo 'fatal: bad revision HEAD' >&2\nexit 128",
  });
  const api = makeFetch([]);

  const response = await dispatchCreate(repoDir, api.fetch);

  assert.equal(response.statusCode, 400);
  assert.equal(
    response.body.code,
    DesktopGithubPullRequestErrorCode.RepositoryUnavailable
  );
  assert.equal(
    response.body.reason,
    DesktopGithubPullRequestReason.RepositoryUnavailable
  );
  assert.equal(
    response.body.stage,
    DesktopGithubPullRequestStage.LocalPreflight
  );
  assert.equal(response.body.retryable, false);
  assert.equal(response.body.burnRetryBudget, false);
  assert.equal(api.calls.length, 0);
  assert.equal(await commandWasRun(gitLog, "push"), false);
  assert.equal(await exists(ghLog), false);
});

test("POST /api/gateway/git/pr validates the server create payload before push", async () => {
  const { repoDir, gitLog, ghLog } = await makeBinaryFixture();
  const api = makeFetch([]);

  const response = await dispatchCreate(repoDir, api.fetch, {
    body: "x".repeat(DesktopGithubPullRequestBodyMaxLength + 1),
  });

  assert.equal(response.statusCode, 400);
  assert.equal(
    response.body.code,
    DesktopGithubPullRequestErrorCode.ValidationFailed
  );
  assert.equal(
    response.body.reason,
    DesktopGithubPullRequestReason.ValidationFailed
  );
  assert.equal(
    response.body.stage,
    DesktopGithubPullRequestStage.LocalPreflight
  );
  assert.equal(response.body.retryable, false);
  assert.equal(response.body.burnRetryBudget, false);
  assert.equal(api.calls.length, 0);
  assert.equal(await commandWasRun(gitLog, "push"), false);
  assert.equal(await exists(ghLog), false);
});

test("POST /api/gateway/git/pr succeeds through preflight, git push, then server create", async () => {
  const { repoDir, gitLog, ghLog } = await makeBinaryFixture();
  const api = makeFetch([
    successResponse({
      success: true,
      contractVersion: 1,
      mode: DesktopGithubPullRequestSuccessMode.Preflight,
      status: DesktopGithubPullRequestStatus.Available,
      repository: {
        fullName: "acme/widgets",
        defaultBranch: "main",
      },
      identity: { login: "daveth" },
    }),
    successResponse({
      success: true,
      contractVersion: 1,
      mode: DesktopGithubPullRequestSuccessMode.Create,
      status: DesktopGithubPullRequestStatus.Created,
      pullRequest: {
        url: "https://github.com/acme/widgets/pull/42",
        number: 42,
        headBranch: "feat/no-gh",
        baseBranch: "main",
      },
      labels: {
        appliedLabels: ["ISS-8637"],
        labelsApplied: true,
      },
    }),
  ]);

  const response = await dispatchCreate(repoDir, api.fetch, {
    labels: [{ name: "ISS-8637", color: "0366d6" }],
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.number, 42);
  assert.deepEqual(response.body.appliedLabels, ["ISS-8637"]);
  assert.equal(await commandWasRun(gitLog, "push"), true);
  assert.equal(await exists(ghLog), false);
  assert.equal(api.calls.length, 2);
  assert.deepEqual(api.calls[0]?.body, {
    contractVersion: 1,
    mode: DesktopGithubPullRequestMode.Preflight,
    repoFullName: "acme/widgets",
  });
  assert.equal(api.calls[1]?.body.mode, DesktopGithubPullRequestMode.Create);
  assert.equal(api.calls[1]?.body.repoFullName, "acme/widgets");
  assert.equal(api.calls[1]?.body.headBranch, "feat/no-gh");
});

test("POST /api/gateway/git/pr preserves distinct fetch and pushed head repositories", async () => {
  const { repoDir, gitLog, ghLog } = await makeBinaryFixture({
    remoteScript:
      "if [ \"$3\" = \"--push\" ]; then printf 'git@github.com:daveth/widgets.git\\n'; else printf 'git@github.com:acme/widgets.git\\n'; fi",
  });
  const api = makeFetch([
    successResponse({
      success: true,
      contractVersion: 1,
      mode: DesktopGithubPullRequestSuccessMode.Preflight,
      status: DesktopGithubPullRequestStatus.Available,
      repository: {
        fullName: "acme/widgets",
        defaultBranch: "main",
      },
      identity: { login: "daveth" },
    }),
    successResponse({
      success: true,
      contractVersion: 1,
      mode: DesktopGithubPullRequestSuccessMode.Create,
      status: DesktopGithubPullRequestStatus.Created,
      pullRequest: {
        url: "https://github.com/acme/widgets/pull/42",
        number: 42,
        headBranch: "feat/no-gh",
        baseBranch: "main",
      },
    }),
  ]);

  const response = await dispatchCreate(repoDir, api.fetch);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(api.calls[0]?.body, {
    contractVersion: 1,
    mode: DesktopGithubPullRequestMode.Preflight,
    repoFullName: "acme/widgets",
    headRepoFullName: "daveth/widgets",
  });
  assert.equal(api.calls[1]?.body.mode, DesktopGithubPullRequestMode.Create);
  assert.equal(api.calls[1]?.body.repoFullName, "acme/widgets");
  assert.equal(api.calls[1]?.body.headRepoFullName, "daveth/widgets");
  assert.equal(await commandWasRun(gitLog, "push"), true);
  assert.equal(await exists(ghLog), false);
});

test("POST /api/gateway/git/pr does not fetch or push without a desktop session token", async () => {
  const { repoDir, gitLog, ghLog } = await makeBinaryFixture();
  const api = makeFetch([]);

  const response = await dispatchCreate(repoDir, api.fetch, {}, null);

  assert.equal(response.statusCode, 401);
  assert.equal(
    response.body.code,
    DesktopGithubPullRequestErrorCode.AuthenticationRequired
  );
  assert.equal(response.body.retryable, false);
  assert.equal(response.body.burnRetryBudget, false);
  assert.equal(api.calls.length, 0);
  assert.equal(await commandWasRun(gitLog, "push"), false);
  assert.equal(await exists(ghLog), false);
});

test("POST /api/gateway/git/pr times out stalled git push without create API or gh fallback", async () => {
  const { repoDir, gitLog, ghLog } = await makeBinaryFixture({
    pushScript: "sleep 5\nexit 0",
  });
  const api = makeFetch([
    successResponse({
      success: true,
      contractVersion: 1,
      mode: DesktopGithubPullRequestSuccessMode.Preflight,
      status: DesktopGithubPullRequestStatus.Available,
      repository: {
        fullName: "acme/widgets",
        defaultBranch: "main",
      },
      identity: { login: "daveth" },
    }),
  ]);

  const response = await dispatchCreate(
    repoDir,
    api.fetch,
    {},
    "desktop-token",
    { gitPushTimeoutMs: 50 }
  );

  assert.equal(response.statusCode, 500);
  assert.equal(
    response.body.code,
    DesktopGithubPullRequestErrorCode.TransientUnavailable
  );
  assert.equal(
    response.body.reason,
    DesktopGithubPullRequestReason.TransientUnavailable
  );
  assert.equal(response.body.stage, DesktopGithubPullRequestStage.GitPush);
  assert.equal(response.body.retryable, true);
  assert.equal(response.body.burnRetryBudget, false);
  assert.equal(api.calls.length, 1);
  assert.equal(await commandWasRun(gitLog, "push"), true);
  assert.equal(await exists(ghLog), false);
});

test("POST /api/gateway/git/pr reports push auth failures without create API or gh fallback", async () => {
  const { repoDir, gitLog, ghLog } = await makeBinaryFixture({
    pushScript:
      "echo 'remote: Permission denied' >&2\necho 'fatal: Authentication failed' >&2\nexit 128",
  });
  const api = makeFetch([
    successResponse({
      success: true,
      contractVersion: 1,
      mode: DesktopGithubPullRequestSuccessMode.Preflight,
      status: DesktopGithubPullRequestStatus.Available,
      repository: {
        fullName: "acme/widgets",
        defaultBranch: "main",
      },
      identity: { login: "daveth" },
    }),
  ]);

  const response = await dispatchCreate(repoDir, api.fetch);

  assert.equal(response.statusCode, 403);
  assert.equal(
    response.body.code,
    DesktopGithubPullRequestErrorCode.AuthorizationDenied
  );
  assert.equal(
    response.body.reason,
    DesktopGithubPullRequestReason.AuthorizationDenied
  );
  assert.equal(response.body.stage, DesktopGithubPullRequestStage.GitPush);
  assert.equal(response.body.retryable, false);
  assert.equal(response.body.burnRetryBudget, false);
  assert.equal(api.calls.length, 1);
  assert.equal(await commandWasRun(gitLog, "push"), true);
  assert.equal(await exists(ghLog), false);
});

test("POST /api/gateway/git/pr classifies push failures from stderr only", async () => {
  const { repoDir, gitLog, ghLog } = await makeBinaryFixture({
    revParseScript: "printf 'feature/network-retry\\n'",
    pushScript: "echo 'remote: rejected push' >&2\nexit 128",
  });
  const api = makeFetch([
    successResponse({
      success: true,
      contractVersion: 1,
      mode: DesktopGithubPullRequestSuccessMode.Preflight,
      status: DesktopGithubPullRequestStatus.Available,
      repository: {
        fullName: "acme/widgets",
        defaultBranch: "main",
      },
      identity: { login: "daveth" },
    }),
  ]);

  const response = await dispatchCreate(repoDir, api.fetch);

  assert.equal(response.statusCode, 500);
  assert.equal(
    response.body.code,
    DesktopGithubPullRequestErrorCode.ProviderRejected
  );
  assert.equal(
    response.body.reason,
    DesktopGithubPullRequestReason.ProviderRejected
  );
  assert.equal(response.body.stage, DesktopGithubPullRequestStage.GitPush);
  assert.equal(response.body.retryable, false);
  assert.equal(response.body.burnRetryBudget, false);
  assert.equal(await commandWasRun(gitLog, "push"), true);
  assert.equal(await exists(ghLog), false);
});

test("POST /api/gateway/git/pr reports post-push create failure without false success", async () => {
  const { repoDir, gitLog, ghLog } = await makeBinaryFixture();
  const api = makeFetch([
    successResponse({
      success: true,
      contractVersion: 1,
      mode: DesktopGithubPullRequestSuccessMode.Preflight,
      status: DesktopGithubPullRequestStatus.Available,
      repository: {
        fullName: "acme/widgets",
        defaultBranch: "main",
      },
      identity: { login: "daveth" },
    }),
    jsonResponse(
      {
        success: false,
        error: "GitHub pull request service is temporarily unavailable.",
        code: DesktopGithubPullRequestErrorCode.TransientUnavailable,
        details: {
          reason: DesktopGithubPullRequestReason.TransientUnavailable,
          stage: DesktopGithubPullRequestStage.ApiCreate,
          retryable: true,
          burnRetryBudget: false,
        },
      },
      503
    ),
  ]);

  const response = await dispatchCreate(repoDir, api.fetch);

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.success, false);
  assert.equal(
    response.body.reason,
    DesktopGithubPullRequestReason.TransientUnavailable
  );
  assert.equal(response.body.stage, DesktopGithubPullRequestStage.ApiCreate);
  assert.equal(response.body.retryable, true);
  assert.equal(response.body.burnRetryBudget, false);
  assert.equal(await commandWasRun(gitLog, "push"), true);
  assert.equal(await exists(ghLog), false);
});

function dispatchCreate(
  repoDir: string,
  fetchImpl: typeof fetch,
  extraBody: Record<string, unknown> = {},
  token: string | null = "desktop-token",
  apiOptions: { gitPushTimeoutMs?: number } = {}
): ReturnType<typeof dispatchOperation> {
  const dispatcher = new OperationDispatcher();
  registerGitPrCreateRoute(dispatcher, () => [repoDir], {
    fetch: fetchImpl,
    getAccessToken: () => Promise.resolve(token),
    getApiOrigin: () => "https://api.closedloop.test",
    ...apiOptions,
  });
  return dispatchOperation({
    dispatcher,
    method: "POST",
    pathname: DesktopGithubPullRequestApiPath.LegacyGatewayPullRequest,
    body: JSON.stringify({
      repoPath: repoDir,
      title: "Retire gh PR creation",
      body: "Use the server-backed API",
      ...extraBody,
    }),
  });
}

type BinaryFixtureOptions = {
  revParseScript?: string;
  remoteScript?: string;
  pushScript?: string;
};

async function makeBinaryFixture(options: BinaryFixtureOptions = {}): Promise<{
  repoDir: string;
  gitLog: string;
  ghLog: string;
}> {
  const repoDir = makeTempDir();
  const binDir = await mkdtemp(path.join(tmpdir(), "iss8637-pr-bin-"));
  tempDirs.push(binDir);
  const gitLog = path.join(binDir, "git.log");
  const ghLog = path.join(binDir, "gh.log");
  const gitBin = path.join(binDir, "git");
  const ghBin = path.join(binDir, "gh");
  await writeFile(
    gitBin,
    `#!/bin/sh
echo "$@" >> ${JSON.stringify(gitLog)}
case "$1" in
  rev-parse) ${options.revParseScript ?? "printf 'feat/no-gh\\n'"} ;;
  remote) ${options.remoteScript ?? "printf 'git@github.com:acme/widgets.git\\n'"} ;;
  push) ${options.pushScript ?? "exit 0"} ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 }
  );
  await writeFile(
    ghBin,
    `#!/bin/sh
echo "$@" >> ${JSON.stringify(ghLog)}
exit 2
`,
    { mode: 0o755 }
  );
  await chmod(gitBin, 0o755);
  await chmod(ghBin, 0o755);
  configureBinaryPathsResolver(() => ({ git: gitBin, gh: ghBin }));
  return { repoDir, gitLog, ghLog };
}

type FetchCall = {
  url: string;
  method?: string;
  body: Record<string, unknown>;
  authorization?: string;
};

function makeFetch(responses: Array<Response | Error>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      ...methodField(init?.method),
      ...authorizationHeader(init?.headers),
    });
    const next = responses.shift();
    if (!next) {
      return Promise.reject(new Error("Unexpected fetch call"));
    }
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve(next);
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

function methodField(
  method: string | undefined
): Pick<FetchCall, "method"> | Record<string, never> {
  return method ? { method } : {};
}

function authorizationHeader(
  headers: HeadersInit | undefined
): Pick<FetchCall, "authorization"> | Record<string, never> {
  const authorization = new Headers(headers).get("authorization");
  return authorization ? { authorization } : {};
}

function successResponse(body: Record<string, unknown>): Response {
  return jsonResponse({ success: true, data: body }, 200);
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function commandWasRun(
  logPath: string,
  command: string
): Promise<boolean> {
  const contents = await readText(logPath);
  return contents.split("\n").some((line) => line.startsWith(command));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
