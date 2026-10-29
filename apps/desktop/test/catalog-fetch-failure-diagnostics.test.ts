/**
 * @file catalog-fetch-failure-diagnostics.test.ts
 * @description ISS-7951 — the collect half of the catalog fetch must not let a
 * failed GitHub lookup vanish.
 *
 * Before this, `collectCatalogFetchPlan` incremented `skipped` / `failed` and
 * moved on, so an operator reading the log saw a run that reported a count and
 * named no pack, while the user saw a catalog entry with no stars and no forks
 * that looked exactly like a pack GitHub genuinely has nothing to say about.
 * The apply half already logged its skips with the pack id; these assertions
 * pin the same treatment on the half that does the network.
 *
 * The marketplace case is the sharp one: a same-marketplace sub-plugin writes
 * deliberate null stars, while a distinct upstream lookup failure must not
 * write a fresh row with null stats.
 */

import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import { BUNDLED_LOCAL_CONTENTS_TYPE } from "../src/main/packs/catalog-contents.js";
import {
  type CatalogFetchTransport,
  collectCatalogFetchPlan,
} from "../src/main/packs/catalog-fetcher.js";
import { GitHubJsonFetchStatus } from "../src/main/packs/catalog-github-client.js";

const warnMock = vi.hoisted(() => vi.fn());

vi.mock("../src/main/logging/gateway-logger.js", () => ({
  gatewayLog: { info: vi.fn(), warn: warnMock, error: vi.fn() },
}));

/** Every warning message the run emitted, in order. */
function warnings(): string[] {
  return warnMock.mock.calls.map((call) => String(call[1]));
}

function transportOf(
  overrides: Partial<CatalogFetchTransport> = {}
): CatalogFetchTransport {
  return {
    fetchRepoStats:
      overrides.fetchRepoStats ??
      (() =>
        Promise.resolve({
          status: GitHubJsonFetchStatus.Success,
          value: {
            repo: { stargazers_count: 7, forks_count: 3, description: "d" },
            release: "v1.0.0",
          },
        })),
    fetchPluginManifest:
      overrides.fetchPluginManifest ??
      (() => Promise.resolve({ description: "plugin", version: "9.9.9" })),
  };
}

/**
 * A transport that records every lookup it is asked for, so a test can prove a
 * row cost NO network call rather than merely that it produced no entry.
 */
function countingTransport(): {
  transport: CatalogFetchTransport;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    transport: {
      fetchRepoStats: (owner, repo) => {
        calls.push(`fetchRepoStats:${owner}/${repo}`);
        return Promise.resolve({
          status: GitHubJsonFetchStatus.Success,
          value: {
            repo: { stargazers_count: 7, forks_count: 3, description: "d" },
            release: "v1.0.0",
          },
        });
      },
      fetchPluginManifest: (owner, repo, pluginPath) => {
        calls.push(`fetchPluginManifest:${owner}/${repo}/${pluginPath}`);
        return Promise.resolve({ description: "plugin", version: "9.9.9" });
      },
    },
  };
}

beforeEach(() => {
  warnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("an unparseable github_url names the pack and a fixed reason, never the value", async () => {
  const plan = await collectCatalogFetchPlan(
    [{ packId: "broken-pack", githubUrl: "not-a-url", contents: null }],
    { transport: transportOf() }
  );

  assert.equal(plan.skipped, 1);
  assert.equal(plan.entries.length, 0);
  assert.equal(warnings().length, 1);
  assert.ok(warnings()[0].includes("broken-pack"));
  assert.ok(!warnings()[0].includes("not-a-url"));
});

/**
 * This line reaches the PERSISTENT gateway log and the in-app Diagnostics
 * buffer, both of which outlive the run and travel in a support upload. A URL
 * that failed to parse still carries whatever the catalog put in it — here
 * userinfo credentials and a token in the query — so the message must name the
 * pack and a fixed reason and nothing else.
 */
test("a rejected github_url is never copied verbatim into the diagnostics buffer", async () => {
  const secretUrl =
    "https://alice:hunter2@notgithub.example/acme/widgets?token=sk_live_abcd1234";

  await collectCatalogFetchPlan(
    [{ packId: "leaky-pack", githubUrl: secretUrl, contents: null }],
    { transport: transportOf() }
  );

  assert.equal(warnings().length, 1);
  assert.ok(warnings()[0].includes("leaky-pack"));
  for (const secret of ["hunter2", "sk_live_abcd1234", "notgithub.example"]) {
    assert.ok(
      !warnings()[0].includes(secret),
      `warning leaked ${secret}: ${warnings()[0]}`
    );
  }
});

test("a failed repo-stats lookup names the pack and the repo it asked GitHub about", async () => {
  const plan = await collectCatalogFetchPlan(
    [
      {
        packId: "next-js",
        githubUrl: "https://github.com/vercel/next.js",
        contents: { type: "github" },
      },
    ],
    {
      transport: transportOf({
        fetchRepoStats: () =>
          Promise.resolve({
            status: GitHubJsonFetchStatus.Unavailable,
            value: null,
          }),
      }),
    }
  );

  assert.equal(plan.failed, 1);
  assert.equal(plan.entries.length, 0);
  assert.equal(warnings().length, 1);
  assert.ok(warnings()[0].includes("next-js"));
  // The repo the lookup actually used — the whole dotted name, so a future
  // truncation is legible in the log rather than only in a 404 nobody sees.
  assert.ok(warnings()[0].includes("vercel/next.js"));
});

test("a failed plugin-manifest lookup names the pack rather than only bumping a counter", async () => {
  const plan = await collectCatalogFetchPlan(
    [
      {
        packId: "context7",
        githubUrl: "https://github.com/upstash/context7",
        contents: {
          type: "github-claude-plugin",
          marketplace_repo: "anthropics/claude-plugins-official",
          plugin_path: "external_plugins/context7",
        },
      },
    ],
    {
      transport: transportOf({
        fetchPluginManifest: () => Promise.resolve(null),
      }),
    }
  );

  assert.equal(plan.failed, 1);
  assert.equal(warnings().length, 1);
  assert.ok(warnings()[0].includes("context7"));
});

test("a marketplace sub-plugin whose upstream lookup FAILED is warned and not written", async () => {
  const plan = await collectCatalogFetchPlan(
    [
      {
        packId: "context7",
        githubUrl: "https://github.com/upstash/context7",
        contents: {
          type: "github-claude-plugin",
          marketplace_repo: "anthropics/claude-plugins-official",
          plugin_path: "external_plugins/context7",
        },
      },
    ],
    {
      transport: transportOf({
        fetchRepoStats: () =>
          Promise.resolve({
            status: GitHubJsonFetchStatus.Unavailable,
            value: null,
          }),
      }),
    }
  );

  assert.equal(plan.failed, 1);
  assert.equal(plan.entries.length, 0);
  assert.equal(warnings().length, 1);
  assert.ok(warnings()[0].includes("context7"));
  assert.ok(warnings()[0].includes("upstash/context7"));
});

test("a sub-plugin whose null stars are DELIBERATE is not warned about", async () => {
  // `github_url` and `marketplace_repo` are the same repo, so the sub-plugin has
  // no independent star count and the null is the intended value. Warning here
  // would train an operator to ignore the warning that matters above.
  const plan = await collectCatalogFetchPlan(
    [
      {
        packId: "code-review",
        githubUrl: "https://github.com/anthropics/claude-plugins-official",
        contents: {
          type: "github-claude-plugin",
          marketplace_repo: "anthropics/claude-plugins-official",
          plugin_path: "plugins/code-review",
        },
      },
    ],
    { transport: transportOf() }
  );

  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0]?.stars, null);
  expect(warnMock).not.toHaveBeenCalled();
});

test("a fully successful run emits no warnings at all", async () => {
  const plan = await collectCatalogFetchPlan(
    [
      {
        packId: "next-js",
        githubUrl: "https://github.com/vercel/next.js",
        contents: { type: "github" },
      },
    ],
    { transport: transportOf() }
  );

  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0]?.stars, 7);
  expect(warnMock).not.toHaveBeenCalled();
});

/**
 * ISS-10605 — a pack that ships inside Desktop installs from disk and has no
 * upstream repository, so there is nothing for this run to look up.
 *
 * Bare omission of `github_url` was NOT the fix: an absent or unparseable URL
 * falls into the parse guard above, which warns and counts a `skipped` on every
 * run. That moves the permanent noise between buckets rather than ending it,
 * and a monitor over these sites inherits it either way. The marker is what
 * lets the fetch say "not applicable" instead of "failed".
 */
test("a bundled pack is not looked up at all, and is counted apart from failures", async () => {
  const { transport, calls } = countingTransport();

  const plan = await collectCatalogFetchPlan(
    [
      {
        packId: "bundled-demo-pack",
        githubUrl: "https://github.com/acme/bundled-demo-pack",
        contents: { type: BUNDLED_LOCAL_CONTENTS_TYPE },
      },
    ],
    { transport }
  );

  assert.equal(calls.length, 0, "a bundled pack must cost no network call");
  assert.equal(plan.bundled, 1);
  assert.equal(plan.failed, 0);
  assert.equal(plan.skipped, 0);
  assert.equal(plan.entries.length, 0);
  expect(warnMock).not.toHaveBeenCalled();
});

/**
 * The two halves of the warn site ISS-8301 proposes to monitor. A 404 is the
 * permanent class and wants a human; everything else clears on its own. The
 * distinguishing words are asserted directly, because the value of this change
 * is that an operator can tell the two apart by reading the line.
 */
test("a permanently absent repo and a throttled one produce different warnings", async () => {
  const notFoundPlan = await collectCatalogFetchPlan(
    [
      {
        packId: "private-pack",
        githubUrl: "https://github.com/acme/private",
        contents: { type: "github" },
      },
    ],
    {
      transport: transportOf({
        fetchRepoStats: () =>
          Promise.resolve({
            status: GitHubJsonFetchStatus.NotFound,
            value: null,
          }),
      }),
    }
  );

  assert.equal(notFoundPlan.failed, 1);
  assert.equal(warnings().length, 1);
  assert.ok(
    warnings()[0].includes("permanently"),
    `expected a permanent-class warning, got: ${warnings()[0]}`
  );

  warnMock.mockReset();

  const throttledPlan = await collectCatalogFetchPlan(
    [
      {
        packId: "busy-pack",
        githubUrl: "https://github.com/acme/busy",
        contents: { type: "github" },
      },
    ],
    {
      transport: transportOf({
        fetchRepoStats: () =>
          Promise.resolve({
            status: GitHubJsonFetchStatus.Unavailable,
            value: null,
          }),
      }),
    }
  );

  assert.equal(throttledPlan.failed, 1);
  assert.equal(warnings().length, 1);
  assert.ok(
    warnings()[0].includes("transiently"),
    `expected a transient-class warning, got: ${warnings()[0]}`
  );
  assert.ok(!warnings()[0].includes("permanently"));
});
