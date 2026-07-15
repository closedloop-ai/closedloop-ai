import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import {
  GitHubBundledPullRequestsStopReason,
  GitHubProviderBudgetState,
} from "@repo/api/src/types/github-read-model";
import {
  fetchBundledPullRequestsWithGh,
  resetGhGraphqlTransportForTests,
} from "../src/main/github/gh-graphql-transport.js";

test("fetchBundledPullRequestsWithGh maps PR and rateLimit data from gh GraphQL", async () => {
  resetGhGraphqlTransportForTests();
  await withTmpDir(async (dir) => {
    const ghPath = await writeFakeGh(
      dir,
      JSON.stringify({
        rateLimit: {
          cost: 1,
          remaining: 4999,
          resetAt: "2026-07-03T02:00:00Z",
        },
        repository: {
          pullRequests: {
            nodes: [
              {
                id: "PR_1",
                number: 7,
                title: "Test PR",
                url: "https://github.com/acme/repo/pull/7",
                state: "OPEN",
                isDraft: false,
                additions: 3,
                deletions: 2,
                changedFiles: 1,
                baseRefName: "main",
                headRefName: "feature",
                headRefOid: "abc123",
              },
            ],
          },
        },
      })
    );

    const result = await fetchBundledPullRequestsWithGh(
      ghPath,
      "acme",
      "repo",
      [7]
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(
        result.value.rateLimit.state,
        GitHubProviderBudgetState.Available
      );
      assert.equal(result.value.pullRequests[0]?.number, 7);
      assert.equal(result.value.pullRequests[0]?.additions, 3);
    }
  });
});

test("fetchBundledPullRequestsWithGh pages until a target PR is found", async () => {
  resetGhGraphqlTransportForTests();
  await withTmpDir(async (dir) => {
    const ghPath = await writeFakeGhScript(
      dir,
      `#!/usr/bin/env bash
args=" $* "
if [[ "$args" != *" pageSize=100"* ]]; then
  echo "missing pageSize" >&2
  exit 1
fi
if [[ "$args" == *" after=null"* ]]; then
  echo "after null should be omitted" >&2
  exit 1
fi
if [[ "$args" == *" after=cursor-1"* ]]; then
  cat <<'JSON'
{"rateLimit":{"cost":1,"remaining":4999,"resetAt":"2026-07-03T02:00:00Z"},"repository":{"pullRequests":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"PR_150","number":150,"title":"Target PR","url":"https://github.com/acme/repo/pull/150","state":"MERGED","isDraft":false,"headRefName":"feature-target","baseRefName":"main","headRefOid":"target-sha"}]}}}
JSON
  exit 0
fi
if [[ "$args" == *" after="* ]]; then
  echo "unexpected first-page after" >&2
  exit 1
fi
cat <<'JSON'
{"rateLimit":{"cost":1,"remaining":5000,"resetAt":"2026-07-03T02:00:00Z"},"repository":{"pullRequests":{"pageInfo":{"hasNextPage":true,"endCursor":"cursor-1"},"nodes":[{"id":"PR_1","number":1,"title":"First page","url":"https://github.com/acme/repo/pull/1","state":"OPEN","isDraft":false,"headRefName":"feature","baseRefName":"main","headRefOid":"first-sha"}]}}}
JSON
`
    );

    const result = await fetchBundledPullRequestsWithGh(
      ghPath,
      "acme",
      "repo",
      [150],
      { maxItems: 300, maxPages: 3, targetNumbers: [150] }
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(
        result.value.pullRequests.map((pullRequest) => pullRequest.number),
        [1, 150]
      );
      assert.equal(
        result.value.stopReason,
        GitHubBundledPullRequestsStopReason.TargetFound
      );
      assert.equal(result.value.truncated, false);
    }
  });
});

test("fetchBundledPullRequestsWithGh keeps low-budget backoff in memory", async () => {
  resetGhGraphqlTransportForTests();
  await withTmpDir(async (dir) => {
    const ghPath = await writeFakeGh(
      dir,
      JSON.stringify({
        rateLimit: { cost: 1, remaining: 1, resetAt: "2026-07-03T02:00:00Z" },
        repository: { pullRequests: { nodes: [] } },
      })
    );

    const first = await fetchBundledPullRequestsWithGh(
      ghPath,
      "acme",
      "repo",
      []
    );
    const second = await fetchBundledPullRequestsWithGh(
      ghPath,
      "acme",
      "repo",
      []
    );

    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.reason, "rate_limited");
      assert.equal(typeof second.retryAfterMs, "number");
    }
  });
});

test("fetchBundledPullRequestsWithGh records low-budget backoff when a target PR is found", async () => {
  resetGhGraphqlTransportForTests();
  await withTmpDir(async (dir) => {
    const ghPath = await writeFakeGh(
      dir,
      JSON.stringify({
        rateLimit: {
          cost: 1,
          remaining: 1,
          resetAt: "2026-07-03T02:00:00Z",
        },
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "PR_150",
                number: 150,
                title: "Target PR",
                url: "https://github.com/acme/repo/pull/150",
                state: "MERGED",
                isDraft: false,
                headRefName: "feature-target",
                baseRefName: "main",
                headRefOid: "target-sha",
              },
            ],
          },
        },
      })
    );

    const first = await fetchBundledPullRequestsWithGh(
      ghPath,
      "acme",
      "repo",
      [150],
      { targetNumbers: [150] }
    );
    const second = await fetchBundledPullRequestsWithGh(
      ghPath,
      "acme",
      "repo",
      []
    );

    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(
        first.value.stopReason,
        GitHubBundledPullRequestsStopReason.TargetFound
      );
    }
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.reason, "rate_limited");
      assert.equal(typeof second.retryAfterMs, "number");
    }
  });
});

test("fetchBundledPullRequestsWithGh reports missing gh as unavailable", async () => {
  resetGhGraphqlTransportForTests();
  const result = await fetchBundledPullRequestsWithGh(
    path.join(os.tmpdir(), "missing-gh-binary"),
    "acme",
    "repo",
    []
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "gh_unavailable");
    assert.equal(result.retryAfterMs, null);
  }
});

test("fetchBundledPullRequestsWithGh classifies auth failures without backoff", async () => {
  resetGhGraphqlTransportForTests();
  await withTmpDir(async (dir) => {
    const ghPath = await writeFakeGhFailure(
      dir,
      "run gh auth login to authenticate",
      1
    );

    const result = await fetchBundledPullRequestsWithGh(
      ghPath,
      "acme",
      "repo",
      []
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "auth_required");
      assert.equal(result.retryAfterMs, null);
    }
  });
});

test("fetchBundledPullRequestsWithGh classifies malformed JSON as invalid_response", async () => {
  resetGhGraphqlTransportForTests();
  await withTmpDir(async (dir) => {
    const ghPath = await writeFakeGh(dir, "{not-json");

    const result = await fetchBundledPullRequestsWithGh(
      ghPath,
      "acme",
      "repo",
      []
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "invalid_response");
      assert.equal(result.retryAfterMs, null);
    }
  });
});

test("fetchBundledPullRequestsWithGh classifies rate-limit failures and expires process-local backoff", async () => {
  resetGhGraphqlTransportForTests();
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-07-03T02:00:00Z") });
  try {
    await withTmpDir(async (dir) => {
      const ghPath = await writeFakeGhFailure(
        dir,
        "API rate limit exceeded",
        1
      );

      const first = await fetchBundledPullRequestsWithGh(
        ghPath,
        "acme",
        "repo",
        []
      );
      assert.equal(first.ok, false);
      if (!first.ok) {
        assert.equal(first.reason, "rate_limited");
      }

      await writeFakeGh(
        dir,
        JSON.stringify({
          rateLimit: {
            cost: 1,
            remaining: 4999,
            resetAt: "2026-07-03T03:00:00Z",
          },
          repository: { pullRequests: { nodes: [] } },
        })
      );
      const duringBackoff = await fetchBundledPullRequestsWithGh(
        ghPath,
        "acme",
        "repo",
        []
      );
      assert.equal(duringBackoff.ok, false);

      mock.timers.setTime(new Date("2026-07-03T02:01:01Z").getTime());
      const afterBackoff = await fetchBundledPullRequestsWithGh(
        ghPath,
        "acme",
        "repo",
        []
      );
      assert.equal(afterBackoff.ok, true);
    });
  } finally {
    mock.timers.reset();
  }
});

test("fetchBundledPullRequestsWithGh caps process-local backoff entries", async () => {
  resetGhGraphqlTransportForTests();
  await withTmpDir(async (dir) => {
    let firstGhPath = "";
    for (let index = 0; index < 51; index++) {
      const rateLimitedGh = await writeFakeGhFailure(
        dir,
        `gh-${index}`,
        "secondary rate limit",
        1
      );
      if (index === 0) {
        firstGhPath = rateLimitedGh;
      }
      await fetchBundledPullRequestsWithGh(rateLimitedGh, "acme", "repo", []);
    }

    await writeFakeGh(
      dir,
      "gh-0",
      JSON.stringify({
        rateLimit: { cost: 1, remaining: 4999, resetAt: null },
        repository: { pullRequests: { nodes: [] } },
      })
    );
    const result = await fetchBundledPullRequestsWithGh(
      firstGhPath,
      "acme",
      "repo",
      []
    );

    assert.equal(result.ok, true);
  });
});

test("resetGhGraphqlTransportForTests clears process-local credential backoff", async () => {
  resetGhGraphqlTransportForTests();
  await withTmpDir(async (dir) => {
    const ghPath = await writeFakeGh(
      dir,
      JSON.stringify({
        rateLimit: { cost: 1, remaining: 1, resetAt: null },
        repository: { pullRequests: { nodes: [] } },
      })
    );
    await fetchBundledPullRequestsWithGh(ghPath, "acme", "repo", []);

    resetGhGraphqlTransportForTests();
    const result = await fetchBundledPullRequestsWithGh(
      ghPath,
      "acme",
      "repo",
      []
    );

    assert.equal(result.ok, true);
  });
});

async function writeFakeGh(
  dir: string,
  nameOrStdout: string,
  stdout?: string
): Promise<string> {
  const name = stdout === undefined ? "gh" : nameOrStdout;
  const payload = stdout === undefined ? nameOrStdout : stdout;
  const file = path.join(dir, name);
  const encoded = Buffer.from(payload, "utf8").toString("base64");
  await writeFile(
    file,
    `#!/usr/bin/env bash\nprintf '%s' '${encoded}' | base64 -d\n`
  );
  await chmod(file, 0o755);
  return file;
}

async function writeFakeGhFailure(
  dir: string,
  nameOrStderr: string,
  stderrOrExitCode: string | number,
  maybeExitCode?: number
): Promise<string> {
  const name = typeof stderrOrExitCode === "number" ? "gh" : nameOrStderr;
  const stderr =
    typeof stderrOrExitCode === "number" ? nameOrStderr : stderrOrExitCode;
  const exitCode =
    typeof stderrOrExitCode === "number" ? stderrOrExitCode : maybeExitCode;
  const file = path.join(dir, name);
  const encoded = Buffer.from(stderr, "utf8").toString("base64");
  await writeFile(
    file,
    `#!/usr/bin/env bash\nprintf '%s' '${encoded}' | base64 -d >&2\nexit ${exitCode ?? 1}\n`
  );
  await chmod(file, 0o755);
  return file;
}

async function writeFakeGhScript(dir: string, script: string): Promise<string> {
  const file = path.join(dir, "gh");
  await writeFile(file, script);
  await chmod(file, 0o755);
  return file;
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gh-graphql-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
