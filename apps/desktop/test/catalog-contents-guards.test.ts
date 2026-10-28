/**
 * @file catalog-contents-guards.test.ts
 * @description ISS-8883 — the three walkers that skipped the shared API-budget
 * cap now honour it, every Contents-API path segment is percent-encoded with
 * traversal refused, and a marketplace plugin name is bounded before it can
 * become a path segment. Sibling of `catalog-contents-classification.test.ts`,
 * on the same REST-only harness (`support/catalog-contents.test-harness`).
 *
 * Every budget assertion is a CALL COUNT, never a duration.
 */
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import { fetchContents } from "../src/main/packs/catalog-contents.js";
import {
  base64,
  entryFor,
  githubEndpoints,
  githubResponses,
  resetCatalogContentsMocks,
  restoreCatalogContentsMocks,
  restPaths,
  type TreeEntry,
} from "./support/catalog-contents.test-harness.js";
import { gatewayLogWarnMock } from "./support/catalog-contents.test-mocks.js";

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

/** GitHub lists at most 1,000 entries per directory; a walker must not read each one. */
const GITHUB_DIRECTORY_LISTING_MAX = 1000;
/** The sibling walker's cap, restated so a drift in the constant fails here. */
const EXPECTED_WALKER_CAP = 100;

function dirEntries(parent: string, count: number): TreeEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `d${index}`,
    path: `${parent}/d${index}`,
    type: "dir",
  }));
}

function fileEntries(parent: string, count: number): TreeEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `f${index}.md`,
    path: `${parent}/f${index}.md`,
    type: "file",
  }));
}

test("ISS-8883 github-skill-tree: a 1,000-entry directory costs at most the walker cap in marker reads, and returns exactly that many skills", async () => {
  githubResponses.set(
    "repos/acme/widgets/contents/skills",
    dirEntries("skills", GITHUB_DIRECTORY_LISTING_MAX)
  );

  const items = await fetchContents(
    entryFor({ type: "github-skill-tree", skills_path: "skills" })
  );

  // Call COUNT, never duration (`no-timing-assertions`). No marker fixture is
  // set, so each read reaches the REST stub and records a fixture miss.
  const markerReads = githubEndpoints.filter((endpoint) =>
    endpoint.endsWith("/SKILL.md")
  );
  expect(markerReads).toHaveLength(EXPECTED_WALKER_CAP);
  expect(restPaths).toHaveLength(EXPECTED_WALKER_CAP);
  // The truncation is what the user sees for a legitimately huge repo, the
  // same shape `github-nested-skill-tree` already ships — pinned, not silent.
  expect(items).toHaveLength(EXPECTED_WALKER_CAP);
  assert.deepEqual(items[0], { name: "d0", type: "skill", path: "skills/d0" });
});

test("ISS-8883 github-nested-md: 1,000 categories cost at most the cap in inner reads, and one 1,000-file category yields exactly the cap", async () => {
  githubResponses.set(
    "repos/acme/widgets/contents/agents",
    dirEntries("agents", GITHUB_DIRECTORY_LISTING_MAX)
  );
  for (let index = 0; index < GITHUB_DIRECTORY_LISTING_MAX; index += 1) {
    githubResponses.set(
      `repos/acme/widgets/contents/agents/d${index}`,
      fileEntries(`agents/d${index}`, 1)
    );
  }

  const fanned = await fetchContents(
    entryFor({ type: "github-nested-md", root_path: "agents" })
  );

  expect(
    githubEndpoints.filter((endpoint) =>
      endpoint.startsWith("repos/acme/widgets/contents/agents/")
    )
  ).toHaveLength(EXPECTED_WALKER_CAP);
  expect(fanned).toHaveLength(EXPECTED_WALKER_CAP);

  githubResponses.clear();
  githubEndpoints.length = 0;
  githubResponses.set(
    "repos/acme/widgets/contents/agents",
    dirEntries("agents", 1)
  );
  githubResponses.set(
    "repos/acme/widgets/contents/agents/d0",
    fileEntries("agents/d0", GITHUB_DIRECTORY_LISTING_MAX)
  );

  const single = await fetchContents(
    entryFor({ type: "github-nested-md", root_path: "agents" })
  );

  expect(single).toHaveLength(EXPECTED_WALKER_CAP);
  assert.deepEqual(single[0], {
    name: "f0",
    type: "agent",
    category: "d0",
    path: "agents/d0/f0.md",
  });

  // 1,000 EMPTY categories: an item-count cap alone would issue every read
  // and collect nothing, so the budget is on reads too.
  githubResponses.clear();
  githubEndpoints.length = 0;
  githubResponses.set(
    "repos/acme/widgets/contents/agents",
    dirEntries("agents", GITHUB_DIRECTORY_LISTING_MAX)
  );
  for (let index = 0; index < GITHUB_DIRECTORY_LISTING_MAX; index += 1) {
    githubResponses.set(`repos/acme/widgets/contents/agents/d${index}`, []);
  }

  const empty = await fetchContents(
    entryFor({ type: "github-nested-md", root_path: "agents" })
  );

  expect(empty).toHaveLength(0);
  expect(
    githubEndpoints.filter((endpoint) =>
      endpoint.startsWith("repos/acme/widgets/contents/agents/")
    )
  ).toHaveLength(EXPECTED_WALKER_CAP);
});

test("ISS-8883 github-nested-skill-tree: 1,000 team dirs with no skills cost at most the cap in reads, and one huge team yields exactly the cap", async () => {
  // This walker already capped on ITEMS. A repo of a thousand empty teams
  // keeps items at zero, so that cap never fired and every team was read.
  githubResponses.set(
    "repos/acme/widgets/contents",
    Array.from({ length: GITHUB_DIRECTORY_LISTING_MAX }, (_, index) => ({
      name: `d${index}`,
      path: `d${index}`,
      type: "dir" as const,
    }))
  );

  const empty = await fetchContents(
    entryFor({ type: "github-nested-skill-tree" })
  );

  expect(empty).toHaveLength(0);
  expect(
    githubEndpoints.filter((endpoint) => endpoint.endsWith("/skills"))
  ).toHaveLength(EXPECTED_WALKER_CAP);

  // The items half still holds: one team listing 1,000 skills is truncated to
  // the cap rather than returned whole.
  githubResponses.clear();
  githubEndpoints.length = 0;
  githubResponses.set("repos/acme/widgets/contents", [
    { name: "d0", path: "d0", type: "dir" },
  ]);
  githubResponses.set(
    "repos/acme/widgets/contents/d0/skills",
    dirEntries("d0/skills", GITHUB_DIRECTORY_LISTING_MAX)
  );

  const single = await fetchContents(
    entryFor({ type: "github-nested-skill-tree" })
  );

  expect(single).toHaveLength(EXPECTED_WALKER_CAP);
  assert.deepEqual(single[0], {
    name: "d0",
    type: "skill",
    category: "d0",
    path: "d0/skills/d0",
  });
});

test("ISS-8883 github-claude-plugin: the cap bounds the union of commands, agents and skills, and a sub-walk past the cap is never issued", async () => {
  githubResponses.set("repos/acme/widgets/contents/plugins/p", [
    { name: "commands", path: "plugins/p/commands", type: "dir" },
  ]);
  githubResponses.set(
    "repos/acme/widgets/contents/plugins/p/commands",
    fileEntries("plugins/p/commands", GITHUB_DIRECTORY_LISTING_MAX)
  );

  const commandsOnly = await fetchContents(
    entryFor({ type: "github-claude-plugin", plugin_path: "plugins/p" })
  );
  expect(commandsOnly).toHaveLength(EXPECTED_WALKER_CAP);

  githubResponses.clear();
  githubEndpoints.length = 0;
  githubResponses.set("repos/acme/widgets/contents/plugins/p", [
    { name: "commands", path: "plugins/p/commands", type: "dir" },
    { name: "agents", path: "plugins/p/agents", type: "dir" },
    { name: "skills", path: "plugins/p/skills", type: "dir" },
  ]);
  githubResponses.set(
    "repos/acme/widgets/contents/plugins/p/commands",
    fileEntries("plugins/p/commands", 60)
  );
  githubResponses.set(
    "repos/acme/widgets/contents/plugins/p/agents",
    fileEntries("plugins/p/agents", 60)
  );
  githubResponses.set(
    "repos/acme/widgets/contents/plugins/p/skills",
    dirEntries("plugins/p/skills", 5)
  );

  const combined = await fetchContents(
    entryFor({ type: "github-claude-plugin", plugin_path: "plugins/p" })
  );

  expect(combined).toHaveLength(EXPECTED_WALKER_CAP);
  expect(combined.filter((item) => item.type === "command")).toHaveLength(60);
  expect(combined.filter((item) => item.type === "agent")).toHaveLength(40);
  // The skills sub-walk is skipped once the cap is reached: no listing read,
  // no marker reads.
  expect(
    githubEndpoints.filter((endpoint) => endpoint.includes("/skills"))
  ).toHaveLength(0);

  // Exactly AT the cap after one sub-walk: the next one is not issued either
  // (pins `<`, not `<=`), and a sub-walk whose directory is absent is never
  // requested regardless of budget.
  githubResponses.clear();
  githubEndpoints.length = 0;
  githubResponses.set("repos/acme/widgets/contents/plugins/p", [
    { name: "commands", path: "plugins/p/commands", type: "dir" },
    { name: "agents", path: "plugins/p/agents", type: "dir" },
  ]);
  githubResponses.set(
    "repos/acme/widgets/contents/plugins/p/commands",
    fileEntries("plugins/p/commands", EXPECTED_WALKER_CAP)
  );
  githubResponses.set(
    "repos/acme/widgets/contents/plugins/p/agents",
    fileEntries("plugins/p/agents", 1)
  );
  const atCap = await fetchContents(
    entryFor({ type: "github-claude-plugin", plugin_path: "plugins/p" })
  );
  expect(atCap).toHaveLength(EXPECTED_WALKER_CAP);
  expect(githubEndpoints.filter((e) => e.endsWith("/agents"))).toHaveLength(0);

  githubResponses.clear();
  githubEndpoints.length = 0;
  githubResponses.set("repos/acme/widgets/contents/plugins/p", [
    { name: "agents", path: "plugins/p/agents", type: "dir" },
  ]);
  githubResponses.set(
    "repos/acme/widgets/contents/plugins/p/agents",
    fileEntries("plugins/p/agents", 1)
  );
  const agentsOnly = await fetchContents(
    entryFor({ type: "github-claude-plugin", plugin_path: "plugins/p" })
  );
  expect(agentsOnly.map((item) => item.type)).toEqual(["agent"]);
  expect(githubEndpoints.filter((e) => e.endsWith("/commands"))).toHaveLength(
    0
  );
});

test("ISS-8883 claude-marketplace: a traversal, a fragment and a leading-dot name are rejected before any enrichment call", async () => {
  githubResponses.set(
    "repos/acme/widgets/contents/.claude-plugin/marketplace.json",
    {
      content: base64(
        JSON.stringify({
          plugins: [
            { name: "../../../user" },
            { name: "a#x" },
            { name: ".hidden" },
            { name: "review" },
          ],
        })
      ),
    }
  );
  githubResponses.set("repos/acme/widgets/contents/plugins/review/skills", []);

  const items = await fetchContents(
    entryFor({ type: "claude-marketplace", plugins_root: "plugins" })
  );

  assert.deepEqual(items, [
    {
      name: "review",
      type: "plugin",
      description: null,
      skill_count: 0,
      skills: [],
    },
  ]);
  expect(gatewayLogWarnMock).toHaveBeenCalledWith(
    "catalog-contents",
    expect.stringContaining("invalid_plugins=3")
  );
  // The only per-plugin read is the valid sibling's; the three rejected names
  // never became a path segment on either transport.
  assert.deepEqual(
    githubEndpoints.filter((endpoint) => endpoint.includes("/plugins/")),
    ["repos/acme/widgets/contents/plugins/review/skills"]
  );
  expect(restPaths).toHaveLength(0);
});

test("ISS-8883 github-skill-tree: every path segment is percent-encoded, and a seed marker or path that traverses makes no request", async () => {
  // `encodeURI` left `#` alone, so this listing was requested as
  // `.../contents/team` (truncated at the fragment) before ISS-8883.
  githubResponses.set("repos/acme/widgets/contents/team%231/skills", [
    { name: "x", path: "team#1/skills/x", type: "dir" },
  ]);
  githubResponses.set(
    "repos/acme/widgets/contents/team%231/skills/x/SKILL.md",
    {
      content: base64("---\nname: Ex\n---\n"),
    }
  );

  const encoded = await fetchContents(
    entryFor({ type: "github-skill-tree", skills_path: "team#1/skills" })
  );

  assert.deepEqual(encoded, [
    { name: "Ex", type: "skill", description: null, path: "team#1/skills/x" },
  ]);
  assert.deepEqual(githubEndpoints, [
    "repos/acme/widgets/contents/team%231/skills",
    "repos/acme/widgets/contents/team%231/skills/x/SKILL.md",
  ]);

  githubEndpoints.length = 0;
  const traversal = await fetchContents(
    entryFor({ type: "github-skill-tree", skills_path: "../secrets" })
  );
  assert.deepEqual(traversal, []);
  expect(githubEndpoints).toHaveLength(0);
  expect(restPaths).toHaveLength(0);

  githubResponses.clear();
  githubEndpoints.length = 0;
  githubResponses.set("repos/acme/widgets/contents/skills", [
    { name: "x", path: "skills/x", type: "dir" },
  ]);
  const badMarker = await fetchContents(
    entryFor({
      type: "github-skill-tree",
      skills_path: "skills",
      skill_marker: "../../secrets",
    })
  );
  assert.deepEqual(badMarker, []);
  expect(githubEndpoints).toHaveLength(0);
  expect(restPaths).toHaveLength(0);

  githubEndpoints.length = 0;
  githubResponses.set("repos/acme/widgets/contents/skills/x/SKILL%231.md", {
    content: base64("---\nname: Hash\n---\n"),
  });
  const encodedMarker = await fetchContents(
    entryFor({
      type: "github-skill-tree",
      skills_path: "skills",
      skill_marker: "SKILL#1.md",
    })
  );
  assert.deepEqual(encodedMarker, [
    { name: "Hash", type: "skill", description: null, path: "skills/x" },
  ]);
  assert.deepEqual(githubEndpoints, [
    "repos/acme/widgets/contents/skills",
    "repos/acme/widgets/contents/skills/x/SKILL%231.md",
  ]);
});

test("ISS-8883: a response-owned path that traverses skips only that entry, and its valid siblings still walk", async () => {
  // These paths come back FROM GitHub, not from the seed, so the guard must be
  // at the per-entry read: `valid-a / ../x / valid-b` keeps a and b.
  githubResponses.set("repos/acme/widgets/contents/skills", [
    { name: "valid-a", path: "skills/valid-a", type: "dir" },
    { name: "bad", path: "../x", type: "dir" },
    { name: "valid-b", path: "skills/valid-b", type: "dir" },
  ]);
  const skills = await fetchContents(
    entryFor({ type: "github-skill-tree", skills_path: "skills" })
  );
  assert.deepEqual(
    skills.map((item) => item.name),
    ["valid-a", "bad", "valid-b"]
  );
  assert.deepEqual(
    githubEndpoints.filter((endpoint) => endpoint.endsWith("/SKILL.md")),
    [
      "repos/acme/widgets/contents/skills/valid-a/SKILL.md",
      "repos/acme/widgets/contents/skills/valid-b/SKILL.md",
    ]
  );

  githubResponses.clear();
  githubEndpoints.length = 0;
  githubResponses.set("repos/acme/widgets/contents/agents", [
    { name: "valid-a", path: "agents/valid-a", type: "dir" },
    { name: "bad", path: "../x", type: "dir" },
    { name: "valid-b", path: "agents/valid-b", type: "dir" },
  ]);
  githubResponses.set(
    "repos/acme/widgets/contents/agents/valid-a",
    fileEntries("agents/valid-a", 1)
  );
  githubResponses.set(
    "repos/acme/widgets/contents/agents/valid-b",
    fileEntries("agents/valid-b", 1)
  );
  const nested = await fetchContents(
    entryFor({ type: "github-nested-md", root_path: "agents" })
  );
  assert.deepEqual(
    nested.map((item) => item.category),
    ["valid-a", "valid-b"]
  );
  assert.deepEqual(
    githubEndpoints.filter(
      (endpoint) => endpoint !== "repos/acme/widgets/contents/agents"
    ),
    [
      "repos/acme/widgets/contents/agents/valid-a",
      "repos/acme/widgets/contents/agents/valid-b",
    ]
  );

  githubResponses.clear();
  githubEndpoints.length = 0;
  // A dot-prefixed NAME is already skipped by the walker, so the bad case here
  // carries a benign name with a hostile response path.
  githubResponses.set("repos/acme/widgets/contents", [
    { name: "team-a", path: "team-a", type: "dir" },
    { name: "team-b", path: "../x", type: "dir" },
    { name: "team-c", path: "team-c", type: "dir" },
  ]);
  githubResponses.set("repos/acme/widgets/contents/team-a/skills", [
    { name: "s1", path: "team-a/skills/s1", type: "dir" },
  ]);
  githubResponses.set("repos/acme/widgets/contents/team-c/skills", [
    { name: "s2", path: "team-c/skills/s2", type: "dir" },
  ]);
  const teams = await fetchContents(
    entryFor({ type: "github-nested-skill-tree" })
  );
  assert.deepEqual(
    teams.map((item) => item.category),
    ["team-a", "team-c"]
  );
  assert.deepEqual(
    githubEndpoints.filter((endpoint) => endpoint.endsWith("/skills")),
    [
      "repos/acme/widgets/contents/team-a/skills",
      "repos/acme/widgets/contents/team-c/skills",
    ]
  );
});
