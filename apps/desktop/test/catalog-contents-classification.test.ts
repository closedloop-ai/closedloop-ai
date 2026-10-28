/**
 * @file catalog-contents-classification.test.ts
 * @description ISS-6706 — what each `contents.type` in `catalog-seed.json`
 * actually produces, plus the two `refreshCatalogContents` behaviours the
 * seeded-cache path depends on.
 *
 * ASSERTED PER BRANCH ON THE DISCRIMINATING FIELDS — the item `type`, its source
 * `path`, and (where the branch adds one) `category`. Several dispatch branches
 * return supersets of one another, so a `length > 0` or a bare item count is
 * satisfied by the wrong branch having run and proves nothing about which did.
 *
 * The REST transport is stubbed for every case. Fixture hits answer from
 * `githubResponses`; misses answer 404 and log the path, so no case reaches the
 * runner's real network or local GitHub credentials.
 *
 * `none` is the one type no assertion can tell apart from the unknown-type
 * `default`: both return `[]` from the same dispatch with no round trip, so its
 * case below pins the no-scrape CONTRACT rather than which arm served it.
 */

import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import {
  CatalogContentsFetchStatus,
  fetchContents,
  fetchContentsResult,
  refreshCatalogContents,
} from "../src/main/packs/catalog-contents.js";
import {
  base64,
  entryFor,
  githubEndpoints,
  githubResponses,
  prisma,
  resetCatalogContentsMocks,
  restoreCatalogContentsMocks,
  restPaths,
  type TreeEntry,
} from "./support/catalog-contents.test-harness.js";
import {
  applyContentsFetchMock,
  gatewayLogWarnMock,
  telemetryEmitMock,
} from "./support/catalog-contents.test-mocks.js";

vi.mock("node:https", async () =>
  (await import("./support/catalog-contents.test-mocks.js")).httpsModuleMock()
);
vi.mock("../src/main/packs/catalog-store.js", async () =>
  (
    await import("./support/catalog-contents.test-mocks.js")
  ).catalogStoreModuleMock()
);
vi.mock("../src/main/logging/gateway-logger.js", async () =>
  (
    await import("./support/catalog-contents.test-mocks.js")
  ).gatewayLoggerModuleMock()
);
vi.mock("../src/main/telemetry/observability.js", async () =>
  (
    await import("./support/catalog-contents.test-mocks.js")
  ).observabilityModuleMock()
);

beforeEach(resetCatalogContentsMocks);
afterEach(restoreCatalogContentsMocks);

test("SKIP_CATALOG_CONTENTS_FETCH=1 leaves the cache untouched instead of overwriting it with an empty scrape", async () => {
  vi.stubEnv("SKIP_CATALOG_CONTENTS_FETCH", "1");

  const items = await refreshCatalogContents(
    prisma,
    entryFor({ type: "github-flat-md", md_path: "commands" })
  );

  assert.equal(items, null);
  expect(applyContentsFetchMock).not.toHaveBeenCalled();
  assert.deepEqual(githubEndpoints, []);
  assert.deepEqual(restPaths, []);
});

test("a normal refresh writes the scraped items to the cache under this entry's pack id", async () => {
  githubResponses.set("repos/acme/widgets/contents/commands", [
    { name: "guide.md", path: "commands/guide.md", type: "file" },
  ] satisfies TreeEntry[]);

  const items = await refreshCatalogContents(
    prisma,
    entryFor({ type: "github-flat-md", md_path: "commands" })
  );

  expect(applyContentsFetchMock).toHaveBeenCalledTimes(1);
  expect(applyContentsFetchMock).toHaveBeenCalledWith(prisma, {
    pack_id: "acme-pack",
    items,
  });
  assert.deepEqual(items, [
    { name: "guide", type: "command", path: "commands/guide.md" },
  ]);
});

test("an unavailable refresh leaves the existing contents cache untouched", async () => {
  const items = await refreshCatalogContents(
    prisma,
    entryFor({ type: "github-flat-md", md_path: "commands" })
  );

  assert.equal(items, null);
  expect(applyContentsFetchMock).not.toHaveBeenCalled();
  expect(gatewayLogWarnMock).toHaveBeenCalledWith(
    "catalog-contents",
    "contents refresh unavailable for acme-pack; cache left unchanged"
  );
});

test("github-skill-tree: frontmatter overrides the directory name, and a marker file without it degrades rather than throwing", async () => {
  githubResponses.set("repos/acme/widgets/contents/skills", [
    { name: "alpha", path: "skills/alpha", type: "dir" },
    { name: "beta", path: "skills/beta", type: "dir" },
    { name: "gamma", path: "skills/gamma", type: "dir" },
    { name: "README.md", path: "skills/README.md", type: "file" },
  ] satisfies TreeEntry[]);
  githubResponses.set("repos/acme/widgets/contents/skills/alpha/SKILL.md", {
    content: base64(
      '---\nname: Alpha Skill\ndescription: "Does alpha."\n---\nbody'
    ),
  });
  // Present, but with no frontmatter block at all.
  githubResponses.set("repos/acme/widgets/contents/skills/beta/SKILL.md", {
    content: base64("# Beta\n\nNo frontmatter here.\n"),
  });
  // `gamma`'s marker file is absent: the REST call returns null.

  const items = await fetchContents(
    entryFor({ type: "github-skill-tree", skills_path: "skills" })
  );

  assert.deepEqual(items, [
    {
      name: "Alpha Skill",
      type: "skill",
      description: "Does alpha.",
      path: "skills/alpha",
    },
    { name: "beta", type: "skill", description: null, path: "skills/beta" },
    // No `description` key at all — the shape a missing marker file produces.
    { name: "gamma", type: "skill", path: "skills/gamma" },
  ]);
  // `gamma` is the only lookup with no fixture, so it is the only REST fixture
  // miss before resolving null.
  assert.deepEqual(restPaths, [
    "/repos/acme/widgets/contents/skills/gamma/SKILL.md",
  ]);
});

test("github-flat-md: .md files become commands by default, and README is excluded case-insensitively", async () => {
  githubResponses.set("repos/acme/widgets/contents/commands", [
    { name: "readme.md", path: "commands/readme.md", type: "file" },
    { name: "README.md", path: "commands/README.md", type: "file" },
    { name: "deploy.md", path: "commands/deploy.md", type: "file" },
    { name: "notes.txt", path: "commands/notes.txt", type: "file" },
    { name: "nested", path: "commands/nested", type: "dir" },
  ] satisfies TreeEntry[]);

  const items = await fetchContents(
    entryFor({ type: "github-flat-md", md_path: "commands" })
  );

  assert.deepEqual(items, [
    { name: "deploy", type: "command", path: "commands/deploy.md" },
  ]);
});

test("github-nested-md: each file carries its parent directory as category and defaults to agent", async () => {
  githubResponses.set("repos/acme/widgets/contents/categories", [
    { name: "core", path: "categories/core", type: "dir" },
    { name: "loose.md", path: "categories/loose.md", type: "file" },
  ] satisfies TreeEntry[]);
  githubResponses.set("repos/acme/widgets/contents/categories/core", [
    { name: "planner.md", path: "categories/core/planner.md", type: "file" },
    { name: "README.md", path: "categories/core/README.md", type: "file" },
  ] satisfies TreeEntry[]);

  const items = await fetchContents(
    entryFor({ type: "github-nested-md", root_path: "categories" })
  );

  assert.deepEqual(items, [
    {
      name: "planner",
      type: "agent",
      category: "core",
      path: "categories/core/planner.md",
    },
  ]);
});

test("github-nested-md: one category failing mid-walk leaves the refresh unavailable", async () => {
  githubResponses.set("repos/acme/widgets/contents/categories", [
    { name: "alpha", path: "categories/alpha", type: "dir" },
    { name: "beta", path: "categories/beta", type: "dir" },
    { name: "gamma", path: "categories/gamma", type: "dir" },
  ] satisfies TreeEntry[]);
  githubResponses.set("repos/acme/widgets/contents/categories/alpha", [
    { name: "a.md", path: "categories/alpha/a.md", type: "file" },
  ] satisfies TreeEntry[]);
  // `beta` has no fixture: its listing call fails mid-walk.
  githubResponses.set("repos/acme/widgets/contents/categories/gamma", [
    { name: "c.md", path: "categories/gamma/c.md", type: "file" },
  ] satisfies TreeEntry[]);

  const items = await refreshCatalogContents(
    prisma,
    entryFor({ type: "github-nested-md", root_path: "categories" })
  );

  assert.equal(items, null);
  expect(applyContentsFetchMock).not.toHaveBeenCalled();
  // The walk stops at the failed category instead of collecting a partial list
  // and stamping it into the cache as fresh.
  assert.ok(
    !githubEndpoints.includes("repos/acme/widgets/contents/categories/gamma")
  );
  assert.deepEqual(restPaths, ["/repos/acme/widgets/contents/categories/beta"]);
});

test("github-multi-skill-tree: every declared skill path contributes, not just the first", async () => {
  githubResponses.set("repos/acme/widgets/contents/one", [
    { name: "first", path: "one/first", type: "dir" },
  ] satisfies TreeEntry[]);
  githubResponses.set("repos/acme/widgets/contents/two", [
    { name: "second", path: "two/second", type: "dir" },
  ] satisfies TreeEntry[]);
  githubResponses.set("repos/acme/widgets/contents/one/first/SKILL.md", {});
  githubResponses.set("repos/acme/widgets/contents/two/second/SKILL.md", {});

  const items = await fetchContents(
    entryFor({
      type: "github-multi-skill-tree",
      skill_paths: ["one", "two"],
    })
  );

  assert.deepEqual(
    items.map((item) => item.path),
    ["one/first", "two/second"]
  );
});

test("claude-marketplace: the base64 manifest becomes plugin items, with a missing description as null", async () => {
  githubResponses.set(
    "repos/acme/widgets/contents/.claude-plugin/marketplace.json",
    {
      content: base64(
        JSON.stringify({
          plugins: [
            { name: "code", description: "Writes code." },
            { name: "review" },
          ],
        })
      ),
    }
  );

  const items = await fetchContents(entryFor({ type: "claude-marketplace" }));

  assert.deepEqual(items, [
    { name: "code", type: "plugin", description: "Writes code." },
    { name: "review", type: "plugin", description: null },
  ]);
  expect(gatewayLogWarnMock).not.toHaveBeenCalled();
  expect(telemetryEmitMock).not.toHaveBeenCalled();
});

test("claude-marketplace: an invalid description is omitted while valid plugin fields still render", async () => {
  githubResponses.set(
    "repos/acme/widgets/contents/.claude-plugin/marketplace.json",
    {
      content: base64(
        JSON.stringify({
          plugins: [
            { name: "code", description: { text: "not a string" } },
            { name: "review", description: "Reviews code." },
          ],
        })
      ),
    }
  );

  const items = await fetchContents(entryFor({ type: "claude-marketplace" }));

  assert.deepEqual(items, [
    { name: "code", type: "plugin", description: null },
    { name: "review", type: "plugin", description: "Reviews code." },
  ]);
  expect(gatewayLogWarnMock).toHaveBeenCalledWith(
    "catalog-contents",
    expect.stringContaining("invalid_descriptions=1")
  );
  expect(telemetryEmitMock).toHaveBeenCalledTimes(1);
  expect(telemetryEmitMock.mock.calls[0]?.[0]).toMatchObject({
    category: "catalog.marketplace_manifest_invalid",
    // The relayed message carries the counts so the monitored main-process
    // app.exception can tell this apart from a wholly corrupt manifest.
    message:
      "Remote marketplace manifest contained invalid plugin metadata; invalid_manifest=0 invalid_plugins=0 invalid_descriptions=1",
    severity: "error",
  });
});

test("claude-marketplace: a structurally invalid manifest is unavailable and preserves cache", async () => {
  githubResponses.set(
    "repos/acme/widgets/contents/.claude-plugin/marketplace.json",
    {
      content: base64(JSON.stringify({ plugins: { name: "not an array" } })),
    }
  );

  const refreshed = await refreshCatalogContents(
    prisma,
    entryFor({ type: "claude-marketplace" })
  );

  assert.equal(refreshed, null);
  expect(applyContentsFetchMock).not.toHaveBeenCalled();
  expect(gatewayLogWarnMock).toHaveBeenCalledWith(
    "catalog-contents",
    expect.stringContaining("invalid_manifest=1")
  );
  expect(gatewayLogWarnMock).toHaveBeenCalledWith(
    "catalog-contents",
    expect.stringContaining("contents refresh unavailable")
  );
  expect(telemetryEmitMock).toHaveBeenCalledTimes(1);
});

test("claude-marketplace: a plugin with an invalid name is dropped and reported without hiding valid siblings", async () => {
  githubResponses.set(
    "repos/acme/widgets/contents/.claude-plugin/marketplace.json",
    {
      content: base64(
        JSON.stringify({
          plugins: [
            { name: { text: "not a string" }, description: "Invalid." },
            { name: "review", description: "Reviews code." },
          ],
        })
      ),
    }
  );

  const items = await fetchContents(entryFor({ type: "claude-marketplace" }));

  assert.deepEqual(items, [
    { name: "review", type: "plugin", description: "Reviews code." },
  ]);
  expect(gatewayLogWarnMock).toHaveBeenCalledWith(
    "catalog-contents",
    expect.stringContaining("invalid_plugins=1")
  );
  expect(telemetryEmitMock).toHaveBeenCalledTimes(1);
});

test("claude-marketplace: a blank plugin name is dropped and reported without hiding valid siblings", async () => {
  // A blank name is both an unrenderable identity and a path segment that would
  // build `<plugins_root>//skills`, so it is rejected at the parse boundary.
  githubResponses.set(
    "repos/acme/widgets/contents/.claude-plugin/marketplace.json",
    {
      content: base64(
        JSON.stringify({
          plugins: [
            { name: "", description: "Empty." },
            { name: "   ", description: "Whitespace only." },
            { name: "review", description: "Reviews code." },
          ],
        })
      ),
    }
  );

  const items = await fetchContents(entryFor({ type: "claude-marketplace" }));

  assert.deepEqual(items, [
    { name: "review", type: "plugin", description: "Reviews code." },
  ]);
  expect(gatewayLogWarnMock).toHaveBeenCalledWith(
    "catalog-contents",
    expect.stringContaining("invalid_plugins=2")
  );
  expect(telemetryEmitMock).toHaveBeenCalledTimes(1);
});

test("claude-marketplace: a padded name is rejected as a path segment, and a dotted-hyphenated one emits byte-identically", async () => {
  // ISS-8331 judged emptiness only and let `" review "` through. ISS-8883
  // retires that: the name is a path segment in the enrichment lookup, so it is
  // bounded to `[A-Za-z0-9._-]` with no leading dot, and a space is outside
  // it. A name inside the charset is still never coerced.
  githubResponses.set(
    "repos/acme/widgets/contents/.claude-plugin/marketplace.json",
    {
      content: base64(
        JSON.stringify({
          plugins: [
            { name: " review ", description: "Padded." },
            { name: "my.plugin-v2", description: "Ok." },
          ],
        })
      ),
    }
  );

  const items = await fetchContents(entryFor({ type: "claude-marketplace" }));

  assert.deepEqual(items, [
    { name: "my.plugin-v2", type: "plugin", description: "Ok." },
  ]);
  expect(gatewayLogWarnMock).toHaveBeenCalledWith(
    "catalog-contents",
    expect.stringContaining("invalid_plugins=1")
  );
  expect(telemetryEmitMock).toHaveBeenCalledTimes(1);
});

test("claude-marketplace: a manifest that fails JSON decoding is reported, not silently swallowed", async () => {
  githubResponses.set(
    "repos/acme/widgets/contents/.claude-plugin/marketplace.json",
    { content: base64("{ this is not json") }
  );

  const items = await fetchContents(entryFor({ type: "claude-marketplace" }));

  assert.deepEqual(items, []);
  expect(gatewayLogWarnMock).toHaveBeenCalledWith(
    "catalog-contents",
    expect.stringContaining("invalid_manifest=1")
  );
  expect(telemetryEmitMock).toHaveBeenCalledTimes(1);
  expect(telemetryEmitMock.mock.calls[0]?.[0]).toMatchObject({
    category: "catalog.marketplace_manifest_invalid",
    message:
      "Remote marketplace manifest contained invalid plugin metadata; invalid_manifest=1 invalid_plugins=0 invalid_descriptions=0",
    severity: "error",
  });
});

test("claude-marketplace: per-plugin skill enrichment is capped at the sibling walker limit without truncating the manifest", async () => {
  const plugins = Array.from({ length: 101 }, (_, index) => ({
    name: `plugin-${index}`,
  }));
  githubResponses.set(
    "repos/acme/widgets/contents/.claude-plugin/marketplace.json",
    { content: base64(JSON.stringify({ plugins })) }
  );
  for (let index = 0; index < 100; index += 1) {
    githubResponses.set(
      `repos/acme/widgets/contents/plugins/plugin-${index}/skills`,
      []
    );
  }

  const items = await fetchContents(
    entryFor({ type: "claude-marketplace", plugins_root: "plugins" })
  );

  expect(items).toHaveLength(101);
  assert.deepEqual(items[99], {
    name: "plugin-99",
    type: "plugin",
    description: null,
    skill_count: 0,
    skills: [],
  });
  assert.deepEqual(items[100], {
    name: "plugin-100",
    type: "plugin",
    description: null,
  });
  expect(
    githubEndpoints.filter((endpoint) => endpoint.includes("/plugins/plugin-"))
  ).toHaveLength(100);
});

test("github-claude-plugin: only the subdirectories the plugin actually has are walked", async () => {
  githubResponses.set("repos/acme/widgets/contents/plugins/tools", [
    { name: "commands", path: "plugins/tools/commands", type: "dir" },
    { name: "skills", path: "plugins/tools/skills", type: "dir" },
    { name: "README.md", path: "plugins/tools/README.md", type: "file" },
    // A FILE named `agents` — not a dir, so it must not be walked.
    { name: "agents", path: "plugins/tools/agents", type: "file" },
  ] satisfies TreeEntry[]);
  githubResponses.set("repos/acme/widgets/contents/plugins/tools/commands", [
    { name: "ship.md", path: "plugins/tools/commands/ship.md", type: "file" },
  ] satisfies TreeEntry[]);
  githubResponses.set("repos/acme/widgets/contents/plugins/tools/skills", [
    { name: "plan", path: "plugins/tools/skills/plan", type: "dir" },
  ] satisfies TreeEntry[]);
  githubResponses.set(
    "repos/acme/widgets/contents/plugins/tools/skills/plan/SKILL.md",
    {}
  );

  const items = await fetchContents(
    entryFor({ type: "github-claude-plugin", plugin_path: "plugins/tools" })
  );

  assert.deepEqual(
    items.map((item) => [item.type, item.path]),
    [
      ["command", "plugins/tools/commands/ship.md"],
      ["skill", "plugins/tools/skills/plan"],
    ]
  );
  assert.ok(
    !githubEndpoints.includes(
      "repos/acme/widgets/contents/plugins/tools/agents"
    ),
    "a non-directory `agents` entry must not trigger an agents walk"
  );
});

test("github-claude-plugin: marketplace_repo overrides githubUrl, so the pack is scraped from the marketplace that carries it", async () => {
  // The seed's `context7` shape: an Upstash pack URL whose plugin contents live
  // in the Anthropic marketplace. Fixtures exist ONLY under the marketplace
  // repo, so an override that silently fell back to `githubUrl` would miss every
  // lookup and yield [] instead of these items.
  githubResponses.set(
    "repos/anthropics/claude-plugins-official/contents/external_plugins/context7",
    [
      {
        name: "commands",
        path: "external_plugins/context7/commands",
        type: "dir",
      },
    ] satisfies TreeEntry[]
  );
  githubResponses.set(
    "repos/anthropics/claude-plugins-official/contents/external_plugins/context7/commands",
    [
      {
        name: "docs.md",
        path: "external_plugins/context7/commands/docs.md",
        type: "file",
      },
    ] satisfies TreeEntry[]
  );

  const items = await fetchContents({
    packId: "context7",
    githubUrl: "https://github.com/upstash/context7",
    contents: {
      type: "github-claude-plugin",
      marketplace_repo: "anthropics/claude-plugins-official",
      plugin_path: "external_plugins/context7",
    },
  });

  assert.deepEqual(items, [
    {
      name: "docs",
      type: "command",
      path: "external_plugins/context7/commands/docs.md",
    },
  ]);
  assert.ok(
    !githubEndpoints.some((endpoint) => endpoint.includes("upstash")),
    "the pack's own githubUrl must not be reached once marketplace_repo is set"
  );
  // Every lookup hit a fixture on the marketplace repo, so nothing fell through
  // to the REST transport.
  assert.deepEqual(restPaths, []);
});

test("claude-marketplace: marketplace_repo overrides githubUrl for the manifest read too", async () => {
  // ISS-8006. Both `claude-marketplace` seed entries point `marketplace_repo`
  // at the SAME repo as their `github_url`, so with real seed data a broken
  // override and a working one produce identical output and no assertion over
  // them can fail. The differing pair is built HERE instead — the seed stays
  // a record of the real catalog, and this input is still the shape the seed
  // permits, the one `github-claude-plugin`'s `context7` already has.
  //
  // The manifest fixture exists ONLY under the marketplace repo, so a branch
  // that fell back to `githubUrl` reads nothing and returns [].
  githubResponses.set(
    "repos/anthropics/claude-plugins-official/contents/.claude-plugin/marketplace.json",
    {
      content: base64(
        JSON.stringify({ plugins: [{ name: "docs", description: "Docs." }] })
      ),
    }
  );

  const items = await fetchContents({
    packId: "acme-pack",
    githubUrl: "https://github.com/acme/widgets",
    contents: {
      type: "claude-marketplace",
      marketplace_repo: "anthropics/claude-plugins-official",
    },
  });

  assert.deepEqual(items, [
    { name: "docs", type: "plugin", description: "Docs." },
  ]);
  assert.ok(
    !githubEndpoints.some((endpoint) => endpoint.includes("acme")),
    "the pack's own githubUrl must not be reached once marketplace_repo is set"
  );
  assert.deepEqual(restPaths, []);
});

test("github-nested-skill-tree: every team's skills dir contributes, the team name becomes the category, and dot-directories are skipped", async () => {
  // The only branch that lists the repo ROOT rather than a declared sub-path.
  githubResponses.set("repos/acme/widgets/contents", [
    { name: "team-alpha", path: "team-alpha", type: "dir" },
    { name: "team-beta", path: "team-beta", type: "dir" },
    { name: ".github", path: ".github", type: "dir" },
    { name: "README.md", path: "README.md", type: "file" },
  ] satisfies TreeEntry[]);
  githubResponses.set("repos/acme/widgets/contents/team-alpha/skills", [
    { name: "planner", path: "team-alpha/skills/planner", type: "dir" },
    // A file beside the skill dirs: only directories become skills.
    { name: "index.md", path: "team-alpha/skills/index.md", type: "file" },
  ] satisfies TreeEntry[]);
  githubResponses.set("repos/acme/widgets/contents/team-beta/skills", [
    { name: "shipper", path: "team-beta/skills/shipper", type: "dir" },
  ] satisfies TreeEntry[]);

  const items = await fetchContents(
    entryFor({
      type: "github-nested-skill-tree",
      match_pattern: "*/skills/*/SKILL.md",
    })
  );

  assert.deepEqual(items, [
    {
      name: "planner",
      type: "skill",
      category: "team-alpha",
      path: "team-alpha/skills/planner",
    },
    {
      name: "shipper",
      type: "skill",
      category: "team-beta",
      path: "team-beta/skills/shipper",
    },
  ]);
  assert.ok(
    !githubEndpoints.some((endpoint) => endpoint.includes(".github")),
    "a dot-directory must not be walked for a skills dir"
  );
});

test("a dotted repository name is scraped from the whole name, not the part before the dot", async () => {
  // ISS-7951, the SECOND call site. Fixtures exist ONLY under `vercel/next.js`,
  // so the pre-fix parse (`repo = "next"`) reaches `repos/vercel/next/...`,
  // misses every fixture and yields [].
  githubResponses.set("repos/vercel/next.js/contents/commands", [
    { name: "build.md", path: "commands/build.md", type: "file" },
  ] satisfies TreeEntry[]);

  const items = await fetchContents({
    packId: "next-js",
    githubUrl: "https://github.com/vercel/next.js",
    contents: { type: "github-flat-md", md_path: "commands" },
  });

  assert.deepEqual(items, [
    { name: "build", type: "command", path: "commands/build.md" },
  ]);
  assert.deepEqual(githubEndpoints, ["repos/vercel/next.js/contents/commands"]);
  assert.deepEqual(restPaths, []);
});

test("a dotted marketplace_repo overrides githubUrl without losing its dot", async () => {
  // `marketplaceSourceRepo` re-parses `owner/repo` through the same helper, so
  // the truncation reached the override path too.
  githubResponses.set(
    "repos/acme/plugins.dev/contents/.claude-plugin/marketplace.json",
    {
      content: base64(
        JSON.stringify({ plugins: [{ name: "docs", description: "Docs." }] })
      ),
    }
  );

  const items = await fetchContents({
    packId: "acme-pack",
    githubUrl: "https://github.com/acme/widgets",
    contents: {
      type: "claude-marketplace",
      marketplace_repo: "acme/plugins.dev",
    },
  });

  assert.deepEqual(items, [
    { name: "docs", type: "plugin", description: "Docs." },
  ]);
  assert.deepEqual(restPaths, []);
});

test("an unparseable githubUrl yields no items and makes no GitHub round trip", async () => {
  // The catalog `github_url` is external input: a malformed one must degrade to
  // an empty scrape, never throw through the catalog render.
  const items = await fetchContents({
    packId: "broken",
    githubUrl: "not-a-url-at-all",
    contents: { type: "github-flat-md", md_path: "commands" },
  });

  assert.deepEqual(items, []);
  assert.deepEqual(githubEndpoints, []);
  assert.deepEqual(restPaths, []);
});

test("an unknown contents type is unavailable at the cache-write boundary", async () => {
  const result = await fetchContentsResult(
    entryFor({ type: "future-catalog-shape", md_path: "commands" })
  );

  assert.deepEqual(result, {
    status: CatalogContentsFetchStatus.Unavailable,
    items: null,
  });
  assert.deepEqual(githubEndpoints, []);
  assert.deepEqual(restPaths, []);
});

test("a known contents type missing its required path is unavailable", async () => {
  const result = await fetchContentsResult(
    entryFor({ type: "github-flat-md" })
  );

  assert.deepEqual(result, {
    status: CatalogContentsFetchStatus.Unavailable,
    items: null,
  });
  assert.deepEqual(githubEndpoints, []);
  assert.deepEqual(restPaths, []);
});

test("contents.type `none` yields no items and makes no GitHub round trip on either transport", async () => {
  const items = await fetchContents(
    entryFor({
      type: "none",
      reason: "Router CLI tool, not a skill collection.",
    })
  );

  assert.deepEqual(items, []);
  assert.deepEqual(githubEndpoints, []);
  assert.deepEqual(restPaths, []);
});

/**
 * ISS-10605 — `bundled-local` marks a pack that ships inside Desktop.
 *
 * Asserted through `fetchContentsResult` rather than `fetchContents`, because
 * the STATUS is the whole point: the unknown-type `default` arm also produces no
 * items, but it produces them as Unavailable. Before this type existed the
 * bundled row fell to that arm, so a plain empty-items assertion would pass
 * while the dispatch reported the pack's contents as a failed lookup.
 */
test("contents.type `bundled-local` completes successfully with no items and no round trip", async () => {
  const result = await fetchContentsResult(
    entryFor({
      type: "bundled-local",
      reason: "Built-in Desktop command-pack manifest.",
    })
  );

  assert.equal(result.status, CatalogContentsFetchStatus.Success);
  assert.deepEqual(result.items, []);
  assert.deepEqual(githubEndpoints, []);
  assert.deepEqual(restPaths, []);
});

test("an unknown contents.type is still Unavailable, so `bundled-local` is not merely the default arm", async () => {
  const result = await fetchContentsResult(
    entryFor({ type: "not-a-real-contents-type" })
  );

  assert.equal(result.status, CatalogContentsFetchStatus.Unavailable);
  assert.equal(result.items, null);
});
