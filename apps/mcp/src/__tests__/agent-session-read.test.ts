import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_STATUS_FILTER_VALUES } from "@repo/api/src/agent-session-filters.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentSessionListInputSchema,
  buildAgentSessionListQuery,
  registerListAgentSessions,
  shapeAgentSessionListItem,
} from "../tools/agent-session-read.js";

/**
 * Every double-quoted value the scanned text mentions — deliberately any
 * non-quote run rather than a `[a-z_]+` token, so an off-vocabulary spelling
 * (say, a hyphenated "future-status") is parsed and fails the set comparison
 * instead of being silently skipped by a stricter pattern.
 */
const QUOTED_VALUE_PATTERN = /"([^"]+)"/g;

/**
 * The PUBLISHED reference for this tool — the page an external agent reads
 * instead of the wire description (ISS-5641). It is `.mdx`, so nothing
 * typechecks it; the guard below is the only thing holding it to the SSOT.
 */
const DOCS_PAGE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "apps",
  "web",
  "content",
  "docs",
  "mcp",
  "agent-sessions.mdx"
);

/**
 * The `list-agent-sessions(...)` signature block on that page. Tolerates CRLF
 * line endings and trailing whitespace after the closing `)` so a checkout with
 * `core.autocrlf=true` cannot fail the guard on an unmodified tree.
 */
const LIST_TOOL_SIGNATURE_PATTERN =
  /\r?\nlist-agent-sessions\(\r?\n([\s\S]*?)\r?\n\)[ \t]*\r?\n/;

/**
 * Separates the documented `status` union from the prose gloss after it. The
 * gloss quotes a member name of its own, so the union must be sliced off ahead
 * of the quoted-value scan — see `documentedStatusFilterLine`.
 */
const UNION_GLOSS_SEPARATOR = "—";

describe("buildAgentSessionListQuery", () => {
  it("maps provided filters and stringifies pagination params", () => {
    expect(
      buildAgentSessionListQuery({
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        harness: "claude-code",
        status: "completed",
        viewerScope: "organization",
        limit: 50,
        offset: 25,
      })
    ).toEqual({
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      harness: "claude-code",
      status: "completed",
      viewerScope: "organization",
      limit: "50",
      offset: "25",
      // FEA-3345: omitted quality → explicit `substantive` (see below).
      quality: "substantive",
    });
  });

  it("maps teamId + userId for scoped queries", () => {
    expect(
      buildAgentSessionListQuery({
        viewerScope: "team",
        teamId: "11111111-1111-1111-1111-111111111111",
        userId: "22222222-2222-2222-2222-222222222222",
      })
    ).toEqual({
      viewerScope: "team",
      teamId: "11111111-1111-1111-1111-111111111111",
      userId: "22222222-2222-2222-2222-222222222222",
      quality: "substantive",
    });
  });

  it("maps the quality filter so idle sessions can be revealed", () => {
    expect(buildAgentSessionListQuery({ quality: "all" })).toEqual({
      quality: "all",
    });
    expect(buildAgentSessionListQuery({ quality: "substantive" })).toEqual({
      quality: "substantive",
    });
  });

  it("keeps a zero offset instead of dropping it as undefined", () => {
    expect(buildAgentSessionListQuery({ offset: 0 })).toEqual({
      offset: "0",
      quality: "substantive",
    });
  });

  // FEA-3345: the server default is now fail-open `all`, but this MCP read tool
  // keeps its documented `substantive` default by sending it explicitly, so an
  // agent that omits `quality` still hides idle sessions (its `.describe()`
  // contract) rather than silently inheriting the server's `all`.
  it("defaults quality to substantive when the agent omits it", () => {
    expect(buildAgentSessionListQuery({ harness: "codex" })).toEqual({
      harness: "codex",
      quality: "substantive",
    });
    expect(buildAgentSessionListQuery({})).toEqual({ quality: "substantive" });
  });
});

describe("shapeAgentSessionListItem", () => {
  it("projects the identifiers and core run metadata", () => {
    const shaped = shapeAgentSessionListItem({
      id: "33333333-3333-3333-3333-333333333333",
      slug: "SES-42",
      externalSessionId: "ext-abc",
      name: "Fix flaky test",
      status: "completed",
      harness: "claude-code",
      model: "claude-opus-4",
      repositoryFullName: "closedloop-ai/symphony-alpha",
      baseBranch: "main",
      startedAt: "2026-07-10T00:00:00.000Z",
      lastActivityAt: "2026-07-10T01:00:00.000Z",
      endedAt: "2026-07-10T01:05:00.000Z",
      estimatedCost: 1.23,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      agentCount: 2,
      toolUseCount: 9,
      errorCount: 0,
      sourceArtifactId: "44444444-4444-4444-4444-444444444444",
      sourceLoopId: "55555555-5555-5555-5555-555555555555",
      user: {
        id: "66666666-6666-6666-6666-666666666666",
        email: "dev@example.com",
        firstName: "Dev",
        lastName: "Eloper",
        avatarUrl: "https://example.com/a.png",
      },
      // Fields intentionally omitted from the compact projection.
      events: [{ type: "noise" }],
    });

    expect(shaped).toEqual({
      id: "33333333-3333-3333-3333-333333333333",
      slug: "SES-42",
      externalSessionId: "ext-abc",
      name: "Fix flaky test",
      status: "completed",
      harness: "claude-code",
      model: "claude-opus-4",
      repositoryFullName: "closedloop-ai/symphony-alpha",
      baseBranch: "main",
      startedAt: "2026-07-10T00:00:00.000Z",
      lastActivityAt: "2026-07-10T01:00:00.000Z",
      endedAt: "2026-07-10T01:05:00.000Z",
      estimatedCost: 1.23,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      agentCount: 2,
      toolUseCount: 9,
      errorCount: 0,
      sourceArtifactId: "44444444-4444-4444-4444-444444444444",
      sourceLoopId: "55555555-5555-5555-5555-555555555555",
      user: {
        id: "66666666-6666-6666-6666-666666666666",
        email: "dev@example.com",
        firstName: "Dev",
        lastName: "Eloper",
      },
    });
  });

  it("nulls absent fields and keeps user null when the row has no user", () => {
    const shaped = shapeAgentSessionListItem({
      id: "77777777-7777-7777-7777-777777777777",
      status: "running",
      harness: "codex",
      user: null,
    });

    expect(shaped.slug).toBeNull();
    expect(shaped.model).toBeNull();
    expect(shaped.endedAt).toBeNull();
    expect(shaped.estimatedCost).toBeNull();
    expect(shaped.user).toBeNull();
  });
});

describe("list-agent-sessions status filter contract (ISS-4858)", () => {
  const description = agentSessionListInputSchema.status.description ?? "";

  it("advertises exactly the canonical Status-facet vocabulary", () => {
    // Every quoted value in the description must be a canonical facet value, and
    // every canonical value must appear. ISS-4586 collapsed `completed`/
    // `abandoned` into `inactive`, so advertising a retired value would put a
    // word the product no longer uses in front of an agent instead of the one
    // working value.
    //
    // ISS-4985 removed the ROW-level consequence that used to be the sharper
    // half of this rule: a retired spelling no longer "reaches only
    // not-yet-migrated legacy rows", because `buildStatusFacetPredicate` now
    // resolves it to the same population `inactive` returns. Sending one is safe;
    // it is simply not advertised, so that ONE vocabulary reaches agents. The
    // assertion is unchanged — it is the advertised SET that is pinned here, and
    // pinning it against the SSOT is what keeps this description count-agnostic
    // as that set grows.
    const quoted = [...description.matchAll(QUOTED_VALUE_PATTERN)].map(
      (match) => match[1]
    );
    expect(quoted.length).toBeGreaterThan(0);
    expect(new Set(quoted)).toEqual(new Set(SESSION_STATUS_FILTER_VALUES));
  });

  it("publishes the same vocabulary in the MCP reference docs", () => {
    // ISS-5641: the tool renders its description from the SSOT, but the
    // published page hand-typed the union and kept the pre-ISS-5366 four —
    // `stale` and `unknown` were filterable and undiscoverable. Nothing
    // typechecks an `.mdx`, so this is the guard that keeps the two agreeing.
    const documented = [
      ...documentedStatusFilterLine().matchAll(QUOTED_VALUE_PATTERN),
    ].map((match) => match[1]);

    expect(new Set(documented)).toEqual(new Set(SESSION_STATUS_FILTER_VALUES));
  });
});

/**
 * The `status` line of the published `list-agent-sessions(...)` signature.
 * Throws rather than returning nothing when the block cannot be found, so a
 * renamed tool or a restructured code fence fails loudly instead of quietly
 * turning the guard above into a no-op.
 */
function documentedStatusFilterLine(): string {
  const page = readFileSync(DOCS_PAGE_PATH, "utf8");
  const signature = LIST_TOOL_SIGNATURE_PATTERN.exec(page)?.[1];
  if (!signature) {
    throw new Error(
      `no list-agent-sessions(...) signature block in ${DOCS_PAGE_PATH}`
    );
  }
  const statusLine = signature
    .split("\n")
    .find((line) => line.trimStart().startsWith("status?:"));
  if (!statusLine) {
    throw new Error(`no status filter documented in ${DOCS_PAGE_PATH}`);
  }
  // Scan the UNION only, never the gloss that follows it. That gloss names
  // `"inactive"` in its own double quotes, so scanning the whole line let a
  // union which had DROPPED `"inactive"` still satisfy the set comparison —
  // the guard went green on precisely the drift it exists to catch, for the
  // one value the page emphasises most. Require the separator so a reworded
  // line fails loudly rather than silently widening what is scanned again.
  const [union] = statusLine.split(UNION_GLOSS_SEPARATOR);
  if (union === statusLine) {
    throw new Error(
      `no "${UNION_GLOSS_SEPARATOR}" separating the status union from its gloss in ${DOCS_PAGE_PATH}`
    );
  }
  return union;
}

// ---------------------------------------------------------------------------
// Registered-handler coverage: the list-agent-sessions tool handler logic
// (items array fallback, total fallback) is only reached through the registered
// handler — pure function tests above never exercise it.
// ---------------------------------------------------------------------------

const listSessionsRegisterTool = vi.fn();
const listSessionsApiClient = { get: vi.fn() };

function listSessionsHandler() {
  return listSessionsRegisterTool.mock.calls[0]?.[2] as (
    input: Record<string, unknown>
  ) => Promise<{ content: { text: string }[] }>;
}

const MINIMAL_SESSION_ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "SES-1",
  externalSessionId: null,
  name: "Test session",
  status: "inactive",
  harness: "claude-code",
  model: null,
  repositoryFullName: null,
  baseBranch: null,
  startedAt: null,
  lastActivityAt: null,
  endedAt: null,
  estimatedCost: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  agentCount: null,
  toolUseCount: null,
  errorCount: null,
  sourceArtifactId: null,
  sourceLoopId: null,
  user: null,
};

describe("list-agent-sessions registered tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerListAgentSessions(
      { registerTool: listSessionsRegisterTool } as never,
      listSessionsApiClient as never
    );
  });

  it("shapes items from an array response and echoes the numeric total", async () => {
    // Covers the true arm of Array.isArray(record.items) and the left arm of ?? items.length.
    listSessionsApiClient.get.mockResolvedValue({
      items: [MINIMAL_SESSION_ROW],
      total: 7,
      hasMore: false,
      viewerScope: "organization",
    });

    const result = await listSessionsHandler()({});
    const payload = JSON.parse(result.content[0].text);

    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].id).toBe(MINIMAL_SESSION_ROW.id);
    expect(payload.total).toBe(7);
    expect(payload.returned).toBe(1);
    expect(listSessionsApiClient.get).toHaveBeenCalledWith(
      "/agent-sessions",
      expect.objectContaining({ quality: "substantive" })
    );
  });

  it("falls back to an empty items array when the API response has no items field", async () => {
    // Covers the false arm of Array.isArray(record.items).
    listSessionsApiClient.get.mockResolvedValue({ total: 0, hasMore: false });

    const result = await listSessionsHandler()({});
    const payload = JSON.parse(result.content[0].text);

    expect(payload.items).toEqual([]);
    expect(payload.returned).toBe(0);
  });

  it("falls back to items.length for total when the API response total is not a number", async () => {
    // Covers the right arm of readNumber(record.total) ?? items.length.
    listSessionsApiClient.get.mockResolvedValue({
      items: [MINIMAL_SESSION_ROW],
      hasMore: false,
    });

    const result = await listSessionsHandler()({});
    const payload = JSON.parse(result.content[0].text);

    expect(payload.total).toBe(1);
  });
});
