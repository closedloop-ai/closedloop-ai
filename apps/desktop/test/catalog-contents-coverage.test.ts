/**
 * @file catalog-contents-coverage.test.ts
 * @description ISS-10514 — the failure and edge branches of each
 * `catalog-contents` walker that the classification and guards suites leave
 * unpinned: a listing that is not an array, a mid-walk read that fails, a
 * seed missing its required path, and the frontmatter and fallback edges.
 * Same REST-only harness as its siblings; a server error is injected per
 * endpoint on top of it.
 */
import { afterEach, assert, beforeEach, expect, test, vi } from "vitest";
import {
  CatalogContentsFetchStatus,
  type ContentItemKind,
  fetchContents,
  fetchContentsResult,
} from "../src/main/packs/catalog-contents.js";
import {
  base64,
  entryFor,
  githubEndpoints,
  githubResponses,
  resetCatalogContentsMocks,
  restoreCatalogContentsMocks,
  type TreeEntry,
} from "./support/catalog-contents.test-harness.js";
import {
  gatewayLogWarnMock,
  httpsGetMock,
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

type GetOptions = { path: string };
type ResponseCallback = (response: unknown) => void;

const HTTP_SERVER_ERROR = 500;
const REPO = "repos/acme/widgets/contents";
const UNAVAILABLE = {
  status: CatalogContentsFetchStatus.Unavailable,
  items: null,
};

/** Endpoints (no leading slash) that answer HTTP 500 instead of the fixture. */
const serverErrorEndpoints = new Set<string>();

beforeEach(() => {
  resetCatalogContentsMocks();
  serverErrorEndpoints.clear();
  const fixtureGet = httpsGetMock.getMockImplementation();
  httpsGetMock.mockImplementation(
    (options: GetOptions, onResponse: ResponseCallback) => {
      const endpoint = options.path.slice(1);
      if (!serverErrorEndpoints.has(endpoint)) {
        return fixtureGet?.(options, onResponse);
      }
      githubEndpoints.push(endpoint);
      const req = { destroy: vi.fn(), on: () => req };
      queueMicrotask(() => onResponse(serverErrorResponse()));
      return req;
    }
  );
});
afterEach(restoreCatalogContentsMocks);

type WalkerFailureCase = {
  label: string;
  contents: Record<string, unknown>;
  fixtures: [string, unknown][];
  serverErrors: string[];
  lastEndpoint: string;
};

const WALKER_FAILURE_CASES: WalkerFailureCase[] = [
  {
    label: "github-skill-tree: a marker read that fails aborts the scrape",
    contents: { type: "github-skill-tree", skills_path: "skills" },
    fixtures: [
      [`${REPO}/skills`, [{ name: "a", path: "skills/a", type: "dir" }]],
    ],
    serverErrors: [`${REPO}/skills/a/SKILL.md`],
    lastEndpoint: `${REPO}/skills/a/SKILL.md`,
  },
  {
    label: "github-nested-md: a root that 404s",
    contents: { type: "github-nested-md", root_path: "agents" },
    fixtures: [],
    serverErrors: [],
    lastEndpoint: `${REPO}/agents`,
  },
  {
    label:
      "github-multi-skill-tree: a later skill path that 404s discards the earlier path's items",
    contents: { type: "github-multi-skill-tree", skill_paths: ["one", "two"] },
    fixtures: [[`${REPO}/one`, []]],
    serverErrors: [],
    lastEndpoint: `${REPO}/two`,
  },
  {
    label: "claude-marketplace: a manifest that 404s",
    contents: { type: "claude-marketplace" },
    fixtures: [],
    serverErrors: [],
    lastEndpoint: `${REPO}/.claude-plugin/marketplace.json`,
  },
  {
    label: "claude-marketplace: a skill enrichment read that fails",
    contents: { type: "claude-marketplace", plugins_root: "plugins" },
    fixtures: [
      [
        `${REPO}/.claude-plugin/marketplace.json`,
        { content: base64(JSON.stringify({ plugins: [{ name: "p" }] })) },
      ],
    ],
    serverErrors: [`${REPO}/plugins/p/skills`],
    lastEndpoint: `${REPO}/plugins/p/skills`,
  },
  {
    label: "github-claude-plugin: a plugin root that 404s",
    contents: { type: "github-claude-plugin", plugin_path: "plugins/tools" },
    fixtures: [],
    serverErrors: [],
    lastEndpoint: `${REPO}/plugins/tools`,
  },
  ...["commands", "agents", "skills"].map(
    (subdir): WalkerFailureCase => ({
      label: `github-claude-plugin: a failing ${subdir}/ walk`,
      contents: { type: "github-claude-plugin", plugin_path: "plugins/tools" },
      fixtures: [
        [
          `${REPO}/plugins/tools`,
          [{ name: subdir, path: `plugins/tools/${subdir}`, type: "dir" }],
        ],
      ],
      serverErrors: [`${REPO}/plugins/tools/${subdir}`],
      lastEndpoint: `${REPO}/plugins/tools/${subdir}`,
    })
  ),
  {
    label: "github-nested-skill-tree: a repository root that 404s",
    contents: { type: "github-nested-skill-tree" },
    fixtures: [],
    serverErrors: [],
    lastEndpoint: REPO,
  },
  {
    label:
      "github-nested-skill-tree: a team skills read that fails (not a 404)",
    contents: { type: "github-nested-skill-tree" },
    fixtures: [[REPO, [{ name: "team", path: "team", type: "dir" }]]],
    serverErrors: [`${REPO}/team/skills`],
    lastEndpoint: `${REPO}/team/skills`,
  },
];

test.each(WALKER_FAILURE_CASES)(
  "$label leaves the refresh unavailable",
  async ({ contents, fixtures, serverErrors, lastEndpoint }) => {
    for (const [endpoint, body] of fixtures) {
      githubResponses.set(endpoint, body);
    }
    for (const endpoint of serverErrors) {
      serverErrorEndpoints.add(endpoint);
    }

    const result = await fetchContentsResult(entryFor(contents));

    assert.deepEqual(result, UNAVAILABLE);
    // The walk stopped at the failing read, so that read is the last one made.
    assert.equal(githubEndpoints.at(-1), lastEndpoint);
  }
);

type NonArrayListingCase = {
  label: string;
  contents: Record<string, unknown>;
  fixtures: [string, unknown][];
  lastEndpoint: string;
};

const NOT_A_LISTING = { name: "file.md", path: "file.md", type: "file" };

const NON_ARRAY_LISTING_CASES: NonArrayListingCase[] = [
  {
    label: "github-skill-tree root",
    contents: { type: "github-skill-tree", skills_path: "skills" },
    fixtures: [[`${REPO}/skills`, NOT_A_LISTING]],
    lastEndpoint: `${REPO}/skills`,
  },
  {
    label: "github-flat-md root",
    contents: { type: "github-flat-md", md_path: "commands" },
    fixtures: [[`${REPO}/commands`, NOT_A_LISTING]],
    lastEndpoint: `${REPO}/commands`,
  },
  {
    label: "github-nested-md root",
    contents: { type: "github-nested-md", root_path: "agents" },
    fixtures: [[`${REPO}/agents`, NOT_A_LISTING]],
    lastEndpoint: `${REPO}/agents`,
  },
  {
    label: "github-nested-md category",
    contents: { type: "github-nested-md", root_path: "agents" },
    fixtures: [
      [`${REPO}/agents`, [{ name: "cat", path: "agents/cat", type: "dir" }]],
      [`${REPO}/agents/cat`, NOT_A_LISTING],
    ],
    lastEndpoint: `${REPO}/agents/cat`,
  },
  {
    label: "github-claude-plugin root",
    contents: { type: "github-claude-plugin", plugin_path: "plugins/tools" },
    fixtures: [[`${REPO}/plugins/tools`, NOT_A_LISTING]],
    lastEndpoint: `${REPO}/plugins/tools`,
  },
  {
    label: "github-nested-skill-tree root",
    contents: { type: "github-nested-skill-tree" },
    fixtures: [[REPO, NOT_A_LISTING]],
    lastEndpoint: REPO,
  },
  {
    label: "github-nested-skill-tree team skills dir",
    contents: { type: "github-nested-skill-tree" },
    fixtures: [
      [REPO, [{ name: "team", path: "team", type: "dir" }]],
      [`${REPO}/team/skills`, NOT_A_LISTING],
    ],
    lastEndpoint: `${REPO}/team/skills`,
  },
];

test.each(NON_ARRAY_LISTING_CASES)(
  "a $label that answers a single object instead of a listing is unavailable",
  async ({ contents, fixtures, lastEndpoint }) => {
    for (const [endpoint, body] of fixtures) {
      githubResponses.set(endpoint, body);
    }

    const result = await fetchContentsResult(entryFor(contents));

    assert.deepEqual(result, UNAVAILABLE);
    assert.equal(githubEndpoints.at(-1), lastEndpoint);
  }
);

test.each([
  { type: "github-skill-tree" },
  { type: "github-multi-skill-tree", skill_paths: [] },
  // A bare string is not a path list, so it reads as no paths at all.
  { type: "github-multi-skill-tree", skill_paths: "skills" },
  { type: "github-nested-md" },
  { type: "github-claude-plugin" },
])(
  "%o is missing its required path, so it is unavailable with no request",
  async (contents) => {
    const result = await fetchContentsResult(entryFor(contents));

    assert.deepEqual(result, UNAVAILABLE);
    assert.deepEqual(githubEndpoints, []);
  }
);

test.each([
  { label: "null contents", contents: null },
  { label: "contents with no type", contents: { md_path: "commands" } },
  { label: "a non-string type", contents: { type: 7, md_path: "commands" } },
])(
  "$label is a successful empty scrape with no request",
  async ({ contents }) => {
    const result = await fetchContentsResult({
      packId: "acme-pack",
      githubUrl: "https://github.com/acme/widgets",
      contents,
    });

    assert.deepEqual(result, {
      status: CatalogContentsFetchStatus.Success,
      items: [],
    });
    assert.deepEqual(githubEndpoints, []);
  }
);

test.each<{ kind: string; expected: ContentItemKind }>([
  { kind: "skill", expected: "skill" },
  { kind: "command", expected: "command" },
  { kind: "agent", expected: "agent" },
  { kind: "plugin", expected: "plugin" },
  { kind: "widget", expected: "command" },
])(
  "github-flat-md: kind $kind renders items as $expected",
  async ({ kind, expected }) => {
    githubResponses.set(`${REPO}/commands`, [
      { name: "plan.md", path: "commands/plan.md", type: "file" },
    ] satisfies TreeEntry[]);

    const items = await fetchContents(
      entryFor({ type: "github-flat-md", md_path: "commands", kind })
    );

    assert.deepEqual(items, [
      { name: "plan", type: expected, path: "commands/plan.md" },
    ]);
  }
);

test("github-multi-skill-tree: a non-string entry in skill_paths is dropped and the string paths still walk", async () => {
  githubResponses.set(`${REPO}/one`, [
    { name: "a", path: "one/a", type: "dir" },
  ] satisfies TreeEntry[]);

  const result = await fetchContentsResult(
    entryFor({ type: "github-multi-skill-tree", skill_paths: [7, "one", null] })
  );

  assert.deepEqual(result, {
    status: CatalogContentsFetchStatus.Success,
    items: [{ name: "a", type: "skill", path: "one/a" }],
  });
  assert.deepEqual(githubEndpoints, [`${REPO}/one`, `${REPO}/one/a/SKILL.md`]);
});

test("github-skill-tree: frontmatter strips single quotes and skips a line with no colon", async () => {
  githubResponses.set(`${REPO}/skills`, [
    { name: "alpha", path: "skills/alpha", type: "dir" },
  ] satisfies TreeEntry[]);
  githubResponses.set(`${REPO}/skills/alpha/SKILL.md`, {
    content: base64(
      "---\r\nname: 'Quoted Alpha'\r\njust a heading line\r\nDescription: 'Mixed \"quotes\"'\r\n---\r\nbody"
    ),
  });

  const items = await fetchContents(
    entryFor({ type: "github-skill-tree", skills_path: "skills" })
  );

  assert.deepEqual(items, [
    {
      name: "Quoted Alpha",
      type: "skill",
      description: 'Mixed "quotes"',
      path: "skills/alpha",
    },
  ]);
});

test("github-skill-tree: frontmatter keeps a one-sided quote, trims a padded key, and a colon-less line never becomes a field", async () => {
  githubResponses.set(`${REPO}/skills`, [
    { name: "double", path: "skills/double", type: "dir" },
    { name: "single", path: "skills/single", type: "dir" },
  ] satisfies TreeEntry[]);
  // `namex` has no colon; read as a key it would be sliced to `name` and win
  // over the earlier line.
  githubResponses.set(`${REPO}/skills/double/SKILL.md`, {
    content: base64(
      '---\nName : "lead only\nnamex\ndescription: trail only"\n---\n'
    ),
  });
  githubResponses.set(`${REPO}/skills/single/SKILL.md`, {
    content: base64("---\nname: 'lead only\ndescription  : trail only'\n---\n"),
  });

  const items = await fetchContents(
    entryFor({ type: "github-skill-tree", skills_path: "skills" })
  );

  assert.deepEqual(items, [
    {
      name: '"lead only',
      type: "skill",
      description: 'trail only"',
      path: "skills/double",
    },
    {
      name: "'lead only",
      type: "skill",
      description: "trail only'",
      path: "skills/single",
    },
  ]);
});

test("github-nested-md: a sub-directory and a non-markdown file inside a category are skipped", async () => {
  githubResponses.set(`${REPO}/agents`, [
    { name: "ops", path: "agents/ops", type: "dir" },
  ] satisfies TreeEntry[]);
  githubResponses.set(`${REPO}/agents/ops`, [
    // A directory whose name ends in .md is still not an item.
    { name: "nested.md", path: "agents/ops/nested.md", type: "dir" },
    { name: "notes.txt", path: "agents/ops/notes.txt", type: "file" },
    { name: "deploy.md", path: "agents/ops/deploy.md", type: "file" },
  ] satisfies TreeEntry[]);

  const items = await fetchContents(
    entryFor({ type: "github-nested-md", root_path: "agents", kind: "command" })
  );

  assert.deepEqual(items, [
    {
      name: "deploy",
      type: "command",
      category: "ops",
      path: "agents/ops/deploy.md",
    },
  ]);
  // A skipped sub-directory is not walked.
  expect(githubEndpoints).not.toContain(`${REPO}/agents/ops/nested.md`);
});

test("claude-marketplace: a plugin whose skills dir 404s is enriched with zero skills, not failed", async () => {
  githubResponses.set(`${REPO}/.claude-plugin/marketplace.json`, {
    content: base64(
      JSON.stringify({ plugins: [{ name: "bare", description: "No skills" }] })
    ),
  });

  const result = await fetchContentsResult(
    entryFor({ type: "claude-marketplace", plugins_root: "plugins" })
  );

  assert.deepEqual(result, {
    status: CatalogContentsFetchStatus.Success,
    items: [
      {
        name: "bare",
        type: "plugin",
        description: "No skills",
        skill_count: 0,
        skills: [],
      },
    ],
  });
  assert.deepEqual(githubEndpoints, [
    `${REPO}/.claude-plugin/marketplace.json`,
    `${REPO}/plugins/bare/skills`,
  ]);
});

test("claude-marketplace: a manifest with no plugins key is unavailable and is not reported as invalid", async () => {
  githubResponses.set(`${REPO}/.claude-plugin/marketplace.json`, {
    content: base64(JSON.stringify({ name: "empty-marketplace" })),
  });

  const result = await fetchContentsResult(
    entryFor({ type: "claude-marketplace" })
  );

  assert.deepEqual(result, UNAVAILABLE);
  expect(telemetryEmitMock).not.toHaveBeenCalled();
  expect(gatewayLogWarnMock).not.toHaveBeenCalled();
});

test("claude-marketplace: a manifest file with empty content is unavailable without decoding", async () => {
  githubResponses.set(`${REPO}/.claude-plugin/marketplace.json`, {
    content: "",
  });

  const result = await fetchContentsResult(
    entryFor({ type: "claude-marketplace" })
  );

  assert.deepEqual(result, UNAVAILABLE);
  expect(telemetryEmitMock).not.toHaveBeenCalled();
});

test("an unparseable marketplace_repo falls back to the pack's own githubUrl", async () => {
  githubResponses.set(`${REPO}/plugins/tools`, [] satisfies TreeEntry[]);

  const result = await fetchContentsResult(
    entryFor({
      type: "github-claude-plugin",
      plugin_path: "plugins/tools",
      marketplace_repo: "no-slash-here",
    })
  );

  assert.deepEqual(result, {
    status: CatalogContentsFetchStatus.Success,
    items: [],
  });
  assert.deepEqual(githubEndpoints, [`${REPO}/plugins/tools`]);
});

function serverErrorResponse() {
  const handlers = new Map<string, (chunk?: string) => void>();
  const response = {
    statusCode: HTTP_SERVER_ERROR,
    resume: vi.fn(),
    setEncoding: vi.fn(),
    on(event: string, handler: (chunk?: string) => void) {
      handlers.set(event, handler);
      if (event === "end") {
        queueMicrotask(() => handlers.get("end")?.());
      }
      return response;
    },
  };
  return response;
}
