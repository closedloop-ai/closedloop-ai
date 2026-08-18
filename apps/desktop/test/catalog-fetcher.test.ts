/**
 * @file catalog-fetcher.test.ts
 * @description ISS-5274 — the collect/apply split of the catalog fetch.
 *
 * Covers the per-row policy that had no test before the split (an unparseable
 * URL, the marketplace-sub-plugin branch and its deliberate stars-null rule),
 * plus the new stale-source guard: an entry whose catalog row changed source
 * between collect and apply must NOT be written, or one source's stars land on
 * another source's row.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCatalogFetchPlan,
  type CatalogFetchTransport,
  catalogSourceFingerprint,
  collectCatalogFetchPlan,
} from "../src/main/packs/catalog-fetcher.js";
import { openTestPrisma } from "./prisma-test-utils.js";

type TransportCall = { fn: string; args: unknown[] };

function fakeTransport(overrides: Partial<CatalogFetchTransport> = {}): {
  transport: CatalogFetchTransport;
  calls: TransportCall[];
} {
  const calls: TransportCall[] = [];
  const transport: CatalogFetchTransport = {
    fetchRepoStats: (owner, repo, useGh) => {
      calls.push({ fn: "fetchRepoStats", args: [owner, repo, useGh] });
      return overrides.fetchRepoStats
        ? overrides.fetchRepoStats(owner, repo, useGh)
        : Promise.resolve({
            repo: { stargazers_count: 7, forks_count: 3, description: "d" },
            release: "v1.2.3",
          });
    },
    fetchPluginManifest: (owner, repo, pluginPath, useGh) => {
      calls.push({
        fn: "fetchPluginManifest",
        args: [owner, repo, pluginPath, useGh],
      });
      return overrides.fetchPluginManifest
        ? overrides.fetchPluginManifest(owner, repo, pluginPath, useGh)
        : Promise.resolve({ description: "plugin desc", version: "9.9.9" });
    },
  };
  return { transport, calls };
}

test("an unparseable github_url is skipped, not fetched", async () => {
  const { transport, calls } = fakeTransport();

  const plan = await collectCatalogFetchPlan(
    [{ packId: "p1", githubUrl: "not-a-url", contents: null }],
    { ghAvailable: false, transport }
  );

  assert.equal(plan.skipped, 1);
  assert.equal(plan.entries.length, 0);
  assert.deepEqual(calls, [], "nothing to fetch means no network call");
});

test("a standalone repo entry carries its stars, forks, description and release", async () => {
  const { transport } = fakeTransport();

  const plan = await collectCatalogFetchPlan(
    [
      {
        packId: "p1",
        githubUrl: "https://github.com/o/r",
        contents: { type: "github" },
      },
    ],
    { ghAvailable: true, transport }
  );

  assert.equal(plan.entries.length, 1);
  assert.deepEqual(
    {
      packId: plan.entries[0].packId,
      stars: plan.entries[0].stars,
      forks: plan.entries[0].forks,
      description: plan.entries[0].description,
      lastRelease: plan.entries[0].lastRelease,
    },
    {
      packId: "p1",
      stars: 7,
      forks: 3,
      description: "d",
      lastRelease: "v1.2.3",
    }
  );
});

test("a repo whose stats cannot be fetched counts as failed and yields no entry", async () => {
  const { transport } = fakeTransport({
    fetchRepoStats: () => Promise.resolve(null),
  });

  const plan = await collectCatalogFetchPlan(
    [{ packId: "p1", githubUrl: "https://github.com/o/r", contents: null }],
    { ghAvailable: false, transport }
  );

  assert.equal(plan.failed, 1);
  assert.equal(plan.entries.length, 0);
});

test("a marketplace sub-plugin in its own marketplace leaves stars null", async () => {
  const { transport, calls } = fakeTransport();

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
    { ghAvailable: false, transport }
  );

  // github_url IS the marketplace, so the row is a subdirectory with no
  // independent star count — writing the marketplace's stars here is the v5
  // bug where every plugin card showed the same 21.3k.
  assert.equal(plan.entries[0].stars, null);
  assert.equal(plan.entries[0].forks, null);
  assert.equal(plan.entries[0].description, "plugin desc");
  assert.equal(plan.entries[0].lastRelease, "9.9.9");
  assert.ok(
    !calls.some((c) => c.fn === "fetchRepoStats"),
    "no repo stats call should be made for a same-repo sub-plugin"
  );
});

test("a marketplace sub-plugin with a distinct upstream DOES fetch that upstream's stars", async () => {
  const { transport, calls } = fakeTransport();

  const plan = await collectCatalogFetchPlan(
    [
      {
        packId: "context7",
        githubUrl: "https://github.com/upstash/context7",
        contents: {
          type: "github-claude-plugin",
          marketplace_repo: "anthropics/claude-plugins-official",
          plugin_path: "plugins/context7",
        },
      },
    ],
    { ghAvailable: false, transport }
  );

  assert.equal(plan.entries[0].stars, 7);
  // The manifest comes from the MARKETPLACE repo; the stars from the upstream.
  assert.deepEqual(
    calls.find((c) => c.fn === "fetchPluginManifest")?.args.slice(0, 3),
    ["anthropics", "claude-plugins-official", "plugins/context7"]
  );
  assert.deepEqual(
    calls.find((c) => c.fn === "fetchRepoStats")?.args.slice(0, 2),
    ["upstash", "context7"]
  );
});

test("the manifest version wins over the release tag", async () => {
  const { transport } = fakeTransport({
    fetchPluginManifest: () =>
      Promise.resolve({ description: "d", version: undefined }),
  });

  const plan = await collectCatalogFetchPlan(
    [
      {
        packId: "p",
        githubUrl: "https://github.com/upstash/context7",
        contents: {
          type: "github-claude-plugin",
          marketplace_repo: "anthropics/official",
          plugin_path: "plugins/p",
        },
      },
    ],
    { ghAvailable: false, transport }
  );

  // No manifest version → fall through to the upstream's release tag.
  assert.equal(plan.entries[0].lastRelease, "v1.2.3");
});

test("gh availability is forwarded to the transport rather than re-resolved", async () => {
  const { transport, calls } = fakeTransport();

  await collectCatalogFetchPlan(
    [{ packId: "p", githubUrl: "https://github.com/o/r", contents: null }],
    { ghAvailable: true, transport }
  );

  assert.equal(calls[0]?.args[2], true);
});

// ---------------------------------------------------------------------------
// Source fingerprint + apply
// ---------------------------------------------------------------------------

test("the fingerprint is stable whether contents arrives as an object or a JSON string", () => {
  const asObject = catalogSourceFingerprint({
    githubUrl: "https://github.com/o/r",
    contents: { type: "github", marketplace_repo: "a/b" },
  });
  const asString = catalogSourceFingerprint({
    githubUrl: "https://github.com/o/r",
    contents: JSON.stringify({ marketplace_repo: "a/b", type: "github" }),
  });

  // The Json column comes back either way depending on the driver path. If the
  // two disagreed, every apply would look stale and the catalog would silently
  // stop updating forever.
  assert.equal(asObject, asString);
});

test("the fingerprint moves when contents changes even though github_url is identical", () => {
  const before = catalogSourceFingerprint({
    githubUrl: "https://github.com/o/r",
    contents: { type: "github" },
  });
  const after = catalogSourceFingerprint({
    githubUrl: "https://github.com/o/r",
    contents: { type: "github-claude-plugin", plugin_path: "plugins/x" },
  });

  // A seed can rewrite `contents` while leaving `github_url` byte-identical,
  // and `contents` is what selects the marketplace branch — so github_url alone
  // is not a sufficient identity.
  assert.notEqual(before, after);
});

test("apply writes a matching entry and skips one whose source moved", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO pack_catalog (pack_id, display_name, github_url, contents)
         VALUES ('fresh', 'Fresh', 'https://github.com/o/fresh', '{"type":"github"}'),
                ('moved', 'Moved', 'https://github.com/o/moved', '{"type":"github"}')`
      )
    );
    const rows = await prisma.client.packCatalog.findMany({
      select: { packId: true, githubUrl: true, contents: true },
    });
    const fingerprintOf = (packId: string) =>
      catalogSourceFingerprint(
        rows.find((r) => r.packId === packId) as {
          githubUrl: string;
          contents: unknown;
        }
      );

    const summary = await applyCatalogFetchPlan(prisma, {
      startedAt: new Date().toISOString(),
      usedGhCli: false,
      skipped: 0,
      failed: 0,
      entries: [
        {
          packId: "fresh",
          sourceFingerprint: fingerprintOf("fresh"),
          stars: 11,
          forks: 2,
          description: "fresh desc",
          lastRelease: "v1",
        },
        {
          packId: "moved",
          // Fetched for a source this row no longer has.
          sourceFingerprint: "stale-fingerprint",
          stars: 999,
          forks: 999,
          description: "wrong repo's description",
          lastRelease: "v9",
        },
      ],
    });

    assert.equal(summary.succeeded, 1);
    assert.equal(summary.skipped, 1);

    const written = await prisma.client.packCatalog.findMany({
      select: { packId: true, stars: true, descriptionLive: true },
      orderBy: { packId: "asc" },
    });
    assert.deepEqual(written, [
      { packId: "fresh", stars: 11, descriptionLive: "fresh desc" },
      // Untouched — the stale entry's values must never land here.
      { packId: "moved", stars: null, descriptionLive: null },
    ]);
  } finally {
    await close();
  }
});

test("apply carries the collect half's skipped and failed counts through", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const summary = await applyCatalogFetchPlan(prisma, {
      startedAt: new Date().toISOString(),
      usedGhCli: true,
      skipped: 2,
      failed: 3,
      entries: [],
    });

    // The summary describes the WHOLE run, not just its writing half — the
    // rows the network half could not use must still be accounted for.
    assert.equal(summary.skipped, 2);
    assert.equal(summary.failed, 3);
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.used_gh_cli, true);
    assert.ok(summary.ended_at);
  } finally {
    await close();
  }
});
