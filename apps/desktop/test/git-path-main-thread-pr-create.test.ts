/**
 * ISS-11596 red-first: the legacy gateway pull-request create route no longer
 * blocks the event loop while resolving git on a cold login-shell PATH cache
 * (PLN-2165 AC-005, sites S11 to S13). No git override is configured, so every
 * resolution probes the fake login shell; see `git-path-resolution-fixtures.ts`
 * for why an unacknowledged probe means the event loop was blocked.
 *
 * S12 is the request's first resolution. S11 follows the `rev-parse` child,
 * which announces itself so the observer resets the cache before S11 resolves.
 * S13 follows the preflight API call, whose scripted fetch resets the cache.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  DesktopGithubPullRequestApiPath,
  DesktopGithubPullRequestContractVersion,
  DesktopGithubPullRequestStatus,
  DesktopGithubPullRequestSuccessMode,
} from "@repo/api/src/types/desktop-github-pull-request";
import { afterEach, beforeEach, describe, test } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { configureBinaryPathsResolver } from "../src/server/operations/binary-path-overrides.js";
import { registerGitPrCreateRoute } from "../src/server/operations/git-pr-create.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
} from "./helpers/git-gateway-op-harness.js";
import {
  assertProbesNeverBlocked,
  CacheScope,
  type ColdShellProbe,
  coldShellProbe,
  withColdShell,
} from "./helpers/git-path-resolution-fixtures.js";

const { makeTempDir } = createGitOpTempDirs("iss11596-mt-prc-");

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

let repoDir = "";
let probe: ColdShellProbe;

beforeEach(async () => {
  configureBinaryPathsResolver(null);
  repoDir = makeTempDir();
  probe = await coldShellProbe({
    root: makeTempDir(),
    scope: CacheScope.Context,
  });
  await fs.writeFile(
    path.join(probe.binDir, "git"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  rev-parse)",
      ...probe.announceLines("rev-parse").map((line) => `    ${line}`),
      "    printf 'feat/cov\\n' ;;",
      "  remote) printf 'git@github.com:acme/widgets.git\\n' ;;",
      "  push) exit 0 ;;",
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
});

afterEach(() => {
  probe.stop();
});

function createPullRequest(): Promise<unknown> {
  const bodies: unknown[] = [PREFLIGHT_OK, CREATE_OK];
  let calls = 0;
  const fetchImpl = (_input: RequestInfo | URL, _init?: RequestInit) => {
    calls += 1;
    if (calls === 1) {
      probe.resetNow("preflight");
    }
    const next = bodies.shift();
    return Promise.resolve(
      new Response(JSON.stringify({ success: true, data: next }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  };
  const dispatcher = new OperationDispatcher();
  registerGitPrCreateRoute(dispatcher, () => [repoDir], {
    fetch: fetchImpl as typeof fetch,
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

describe("legacy gateway pull request create: git resolution on a cold PATH cache", () => {
  test("S12: the current-branch read's resolution leaves the event loop free", async () => {
    await withColdShell(probe, createPullRequest);

    await assertProbesNeverBlocked(probe);
  });

  test("S11: the origin-slug reads' resolution leaves the event loop free", async () => {
    await withColdShell(probe, createPullRequest);

    await assertProbesNeverBlocked(probe, "rev-parse");
  });

  test("S13: the push's resolution leaves the event loop free", async () => {
    await withColdShell(probe, createPullRequest);

    await assertProbesNeverBlocked(probe, "preflight");
  });
});
