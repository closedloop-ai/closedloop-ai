/**
 * @file artifact-ref-extractor.test.ts
 * @description Unit tests for FEA-1684 artifact-ref-extractor.ts covering all ACs:
 * strict slug regex, code-fence/inline-code stripping, Closedloop URL extraction,
 * PR created-vs-referenced, MCP dual-pattern, primary selection, deduplication,
 * HARNESS_CAPABILITIES constant, and unclosed fence behaviour.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const HEX_16_RE = /^[0-9a-f]{16}$/;

import {
  type ArtifactRefRecord,
  artifactLinkId,
  canonicalKeyForRef,
  extractArtifactRefs,
  extractLaunchMetadataRefs,
  HARNESS_CAPABILITIES,
  stripCodeFences,
} from "../src/main/collectors/artifact-ref-extractor.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";

// ---------------------------------------------------------------------------
// Minimal fixture helper
// ---------------------------------------------------------------------------

function makeSession(
  overrides: Partial<NormalizedSession> & {
    messages?: NormalizedSession["messages"];
    toolUses?: NormalizedSession["toolUses"];
  } = {}
): NormalizedSession {
  return {
    sessionId: "test-session-1",
    name: "test",
    cwd: null,
    model: null,
    version: null,
    slug: null,
    gitBranch: null,
    startedAt: "2024-01-01T00:00:00.000Z",
    endedAt: null,
    teams: [],
    userMessages: 0,
    assistantMessages: 0,
    tokensByModel: {},
    messageTimestamps: [],
    toolUses: [],
    compactions: [],
    apiErrors: [],
    fileModifiedAt: null,
    turnDurations: [],
    entrypoint: "claude",
    permissionMode: null,
    thinkingBlockCount: 0,
    toolResultErrors: [],
    usageExtras: { service_tiers: [], speeds: [], inference_geos: [] },
    messages: [],
    tokenSeries: [],
    diffStats: null,
    slashCommands: [],
    artifacts: { prs: [], issues: [], repo: null },
    ...overrides,
  };
}

const NOW = "2024-01-01T12:00:00.000Z";

// ---------------------------------------------------------------------------
// AC 1-3: Strict slug regex positives
// ---------------------------------------------------------------------------

describe("strict slug regex — positives (AC 1-3)", () => {
  const validSlugs = [
    "FEA-1",
    "PRD-42",
    "PLN-657",
    "PRO-3",
    "WRK-12",
    "SES-999",
    "FEA-12345",
  ];

  for (const slug of validSlugs) {
    test(`extracts ${slug} from message text`, () => {
      const session = makeSession({
        messages: [
          { role: "human", timestamp: null, text: `Working on ${slug} today.` },
        ],
      });
      const refs = extractArtifactRefs(session, NOW);
      const clRefs = refs.filter(
        (r) => r.targetKind === "closedloop_artifact" && r.slug === slug
      );
      assert.ok(clRefs.length > 0, `expected at least one ref for ${slug}`);
    });
  }
});

// ---------------------------------------------------------------------------
// AC 2: Strict slug regex negatives
// ---------------------------------------------------------------------------

describe("strict slug regex — negatives (AC 2)", () => {
  const invalidSlugs = [
    "TASK-10",
    "BUG-123",
    "FEA-123456", // 6 digits — exceeds max
    "fea-123", // lowercase
    "FEA_123", // underscore separator
    "HTTP-500",
    "JIRA-123",
    "AWS-456",
  ];

  for (const slug of invalidSlugs) {
    test(`does not extract ${slug} from message text`, () => {
      const session = makeSession({
        messages: [
          { role: "human", timestamp: null, text: `See ${slug} for details.` },
        ],
      });
      const refs = extractArtifactRefs(session, NOW);
      const clRefs = refs.filter(
        (r) =>
          r.targetKind === "closedloop_artifact" && r.targetIdentity === slug
      );
      assert.equal(clRefs.length, 0, `${slug} should not be extracted`);
    });
  }
});

// ---------------------------------------------------------------------------
// stripCodeFences — unit tests
// ---------------------------------------------------------------------------

describe("stripCodeFences", () => {
  test("removes lines inside triple-backtick fences", () => {
    const text = "Before\n```\nFEA-1\n```\nAfter";
    const result = stripCodeFences(text);
    assert.ok(!result.includes("FEA-1"), "slug inside fence should be removed");
    assert.ok(result.includes("Before"), "text before fence should remain");
    assert.ok(result.includes("After"), "text after fence should remain");
  });

  test("preserves text outside fences when slug is outside", () => {
    const text = "FEA-10 mentioned here\n```\nsome code\n```\nend";
    const result = stripCodeFences(text);
    assert.ok(result.includes("FEA-10"));
  });

  test("strips inline code spans", () => {
    const text = "Use `FEA-42` as the key.";
    const result = stripCodeFences(text);
    assert.ok(
      !result.includes("FEA-42"),
      "slug in inline code should be stripped"
    );
    assert.ok(result.includes("Use"), "surrounding text should remain");
  });

  test("unclosed fence: content after opener is treated as fenced (conservative)", () => {
    const text = "Before\n```\nFEA-99\nno closing fence";
    const result = stripCodeFences(text);
    assert.ok(
      !result.includes("FEA-99"),
      "unclosed fence: slug should not appear"
    );
    assert.ok(result.includes("Before"), "text before opener should remain");
  });

  test("fence with language specifier is opened correctly", () => {
    const text = "```typescript\nFEA-5\n```\noutside";
    const result = stripCodeFences(text);
    assert.ok(!result.includes("FEA-5"));
    assert.ok(result.includes("outside"));
  });

  test("returns empty string for empty input", () => {
    assert.equal(stripCodeFences(""), "");
  });
});

// ---------------------------------------------------------------------------
// AC 4: Code-fence stripping — integration with extractArtifactRefs
// ---------------------------------------------------------------------------

describe("AC 4: code-fence stripping in extractArtifactRefs", () => {
  test("slug inside triple-backtick fence in message is NOT extracted", () => {
    const session = makeSession({
      messages: [
        {
          role: "human",
          timestamp: null,
          text: "Here is the code:\n```\n// fixes FEA-100\n```\ndone",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const prose = refs.filter(
      (r) => r.targetIdentity === "FEA-100" && r.method === "slug_in_message"
    );
    assert.equal(prose.length, 0, "slug inside fence must not be extracted");
  });

  test("slug outside fence in same message IS extracted", () => {
    const session = makeSession({
      messages: [
        {
          role: "human",
          timestamp: null,
          text: "FEA-200 is the goal.\n```\nignore FEA-300\n```\nend",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const fe200 = refs.filter(
      (r) => r.targetIdentity === "FEA-200" && r.method === "slug_in_message"
    );
    const fe300 = refs.filter(
      (r) => r.targetIdentity === "FEA-300" && r.method === "slug_in_message"
    );
    assert.ok(fe200.length > 0, "FEA-200 outside fence should be extracted");
    assert.equal(fe300.length, 0, "FEA-300 inside fence must not be extracted");
  });
});

// ---------------------------------------------------------------------------
// AC 5: Inline code exclusion in extractArtifactRefs
// ---------------------------------------------------------------------------

describe("AC 5: inline code exclusion in extractArtifactRefs", () => {
  test("slug inside backtick inline code is NOT extracted", () => {
    const session = makeSession({
      messages: [
        {
          role: "human",
          timestamp: null,
          text: "See `FEA-404` in the codebase.",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const prose = refs.filter(
      (r) => r.targetIdentity === "FEA-404" && r.method === "slug_in_message"
    );
    assert.equal(prose.length, 0, "slug in inline code must not be extracted");
  });

  test("slug alongside inline code in same message IS extracted", () => {
    const session = makeSession({
      messages: [
        {
          role: "human",
          timestamp: null,
          text: "FEA-405 is the task. Use `some_function()` to do it.",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const extracted = refs.filter(
      (r) => r.targetIdentity === "FEA-405" && r.method === "slug_in_message"
    );
    assert.ok(
      extracted.length > 0,
      "FEA-405 outside inline code should be extracted"
    );
  });
});

// ---------------------------------------------------------------------------
// AC 7: Closedloop URL extraction with higher confidence than bare slug
// ---------------------------------------------------------------------------

describe("AC 7: Closedloop URL extraction", () => {
  test("URL in message text produces url_match confidence ref", () => {
    const session = makeSession({
      messages: [
        {
          role: "human",
          timestamp: null,
          text: "See https://app.closedloop.ai/my-org/features/FEA-555 for context.",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const urlRefs = refs.filter(
      (r) => r.targetIdentity === "FEA-555" && r.confidence === "url_match"
    );
    assert.ok(
      urlRefs.length > 0,
      "URL-based ref should have url_match confidence"
    );
  });

  test("URL ref has higher confidence than bare slug ref for same artifact", () => {
    // The session has both a URL (url_match) and a prose mention (slug_match_in_prose)
    // After deduplication the url_match winner should survive
    const session = makeSession({
      messages: [
        {
          role: "human",
          timestamp: null,
          text: "FEA-666 — see https://app.closedloop.ai/my-org/features/FEA-666 for details.",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const forArtifact = refs.filter((r) => r.targetIdentity === "FEA-666");
    // After dedup the "input|FEA-666" key should be kept with the higher confidence
    const inputRefs = forArtifact.filter((r) => r.relation === "input");
    assert.ok(inputRefs.length > 0);
    // The surviving ref should be url_match (confidence rank 3) not slug_match_in_prose (rank 2)
    assert.equal(
      inputRefs[0].confidence,
      "url_match",
      "url_match should survive deduplication over slug_match_in_prose"
    );
  });

  test("URL in tool input produces url_match ref", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: {
            command: "open https://app.closedloop.ai/my-org/plans/PLN-7",
          },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const urlRefs = refs.filter(
      (r) => r.targetIdentity === "PLN-7" && r.confidence === "url_match"
    );
    assert.ok(urlRefs.length > 0);
  });

  test("implementation-plans route URL produces url_match ref", () => {
    const session = makeSession({
      messages: [
        {
          role: "human",
          text: "see https://app.closedloop.ai/my-org/implementation-plans/PLN-12",
          timestamp: null,
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const urlRefs = refs.filter(
      (r) => r.targetIdentity === "PLN-12" && r.confidence === "url_match"
    );
    assert.ok(urlRefs.length > 0, "implementation-plans route should match");
  });
});

// ---------------------------------------------------------------------------
// AC 8: PR created-vs-referenced distinction
// ---------------------------------------------------------------------------

describe("AC 8: PR created-vs-referenced", () => {
  test("gh pr create output with new URL → relation=created", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: { command: "gh pr create --title 'My PR' --body 'body'" },
          output: "https://github.com/closedloop-ai/symphony-alpha/pull/99\n",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const prRefs = refs.filter((r) => r.targetKind === "pull_request");
    assert.ok(prRefs.length > 0, "expected a PR ref");
    assert.equal(prRefs[0].relation, "created");
    assert.equal(prRefs[0].prNumber, 99);
    assert.equal(prRefs[0].repoFullName, "closedloop-ai/symphony-alpha");
  });

  test("URL that appears in tool input (not creation output) → relation=referenced", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: {
            command:
              "gh pr view https://github.com/closedloop-ai/symphony-alpha/pull/77",
          },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const prRefs = refs.filter((r) => r.targetKind === "pull_request");
    assert.ok(prRefs.length > 0);
    assert.equal(prRefs[0].relation, "referenced");
  });

  test("URL present in both input and output of gh pr create → relation=referenced", () => {
    // When the URL is already in the input (e.g. passed as arg), it's not a creation
    const prUrl = "https://github.com/closedloop-ai/symphony-alpha/pull/55";
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: { command: `gh pr create --body "fixes ${prUrl}"` },
          output: `${prUrl}\n`,
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const prRefs = refs.filter((r) => r.targetKind === "pull_request");
    assert.ok(prRefs.length > 0);
    assert.equal(prRefs[0].relation, "referenced");
  });

  test("non-create tool with PR URL → relation=referenced", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Read",
          timestamp: null,
          input: { file: "README.md" },
          output:
            "See https://github.com/closedloop-ai/symphony-alpha/pull/10 for context.",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const prRefs = refs.filter((r) => r.targetKind === "pull_request");
    assert.ok(prRefs.length > 0);
    assert.equal(prRefs[0].relation, "referenced");
  });

  test("created PR carries the branch active when `gh pr create` ran (per-tool gitBranch)", () => {
    const session = makeSession({
      gitBranch: "main", // stale session START branch
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: { command: "gh pr create --fill" },
          output: "https://github.com/closedloop-ai/symphony-alpha/pull/42\n",
          gitBranch: "fea-real-head", // the branch at creation time
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const prRef = refs.find((r) => r.targetKind === "pull_request");
    assert.equal(prRef?.relation, "created");
    // The PR head ref is the branch at creation, NOT the session start branch.
    assert.equal(prRef?.branchName, "fea-real-head");
  });

  test("created PR falls back to the session branch when the tool has no per-line branch", () => {
    const session = makeSession({
      gitBranch: "fea-fallback",
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: { command: "gh pr create --fill" },
          output: "https://github.com/closedloop-ai/symphony-alpha/pull/43\n",
          // no per-tool gitBranch (e.g. a non-Claude harness)
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const prRef = refs.find((r) => r.targetKind === "pull_request");
    assert.equal(prRef?.relation, "created");
    assert.equal(prRef?.branchName, "fea-fallback");
  });

  test("referenced PR carries no head branch", () => {
    const session = makeSession({
      gitBranch: "fea-mine",
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: { command: "gh pr view 88" },
          output: "https://github.com/closedloop-ai/symphony-alpha/pull/88\n",
          gitBranch: "fea-mine",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const prRef = refs.find((r) => r.targetKind === "pull_request");
    assert.equal(prRef?.relation, "referenced");
    // A referenced PR is someone else's work — no head ref is attributed.
    assert.equal(prRef?.branchName, undefined);
  });
});

// ---------------------------------------------------------------------------
// AC 9: MCP dual-pattern detection
// ---------------------------------------------------------------------------

describe("AC 9: MCP dual-pattern", () => {
  test("tool named mcp__closedloop__get-document (name prefix) is detected", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "mcp__closedloop__get-document",
          timestamp: null,
          input: { documentId: "FEA-777" },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const mcpRefs = refs.filter(
      (r) => r.confidence === "mcp_call" && r.targetIdentity === "FEA-777"
    );
    assert.ok(
      mcpRefs.length > 0,
      "mcp__closedloop__ prefix pattern must be detected"
    );
    assert.equal(mcpRefs[0].method, "mcp_tool_call");
    assert.equal(mcpRefs[0].relation, "input");
  });

  test("tool named closedloop__get-document with mcpServer=closedloop (Codex format) is detected", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "closedloop__get-document",
          mcpServer: "closedloop",
          timestamp: null,
          input: { slug: "PRD-88" },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const mcpRefs = refs.filter(
      (r) => r.confidence === "mcp_call" && r.targetIdentity === "PRD-88"
    );
    assert.ok(
      mcpRefs.length > 0,
      "mcpServer=closedloop Codex pattern must be detected"
    );
  });

  test("MCP output slugs produce output refs when not in input", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "mcp__closedloop__list-documents",
          timestamp: null,
          input: {},
          output: '{"documents":[{"slug":"FEA-321","title":"My Feature"}]}',
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const outputRefs = refs.filter(
      (r) =>
        r.confidence === "mcp_call" &&
        r.relation === "output" &&
        r.targetIdentity === "FEA-321"
    );
    assert.ok(
      outputRefs.length > 0,
      "MCP output slug should produce output ref"
    );
  });

  test("MCP input slug not duplicated as output ref when it appears in both", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "mcp__closedloop__get-document",
          timestamp: null,
          input: { documentId: "FEA-888" },
          output: '{"slug":"FEA-888","title":"My Feature"}',
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const mcpRefs = refs.filter(
      (r) => r.confidence === "mcp_call" && r.targetIdentity === "FEA-888"
    );
    // input slug present in output too — dedup inside the extractor means only "input" ref
    const relations = mcpRefs.map((r) => r.relation);
    assert.ok(relations.includes("input"), "input ref should exist");
    assert.ok(
      !relations.includes("output"),
      "output ref should not duplicate the input slug"
    );
  });
});

// ---------------------------------------------------------------------------
// AC 12: Primary selection
// ---------------------------------------------------------------------------

describe("AC 12: primary selection", () => {
  test("single MCP ref for one artifact → isPrimary=true", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "mcp__closedloop__get-document",
          timestamp: null,
          input: { documentId: "FEA-1" },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const primary = refs.filter((r) => r.isPrimary);
    assert.equal(primary.length, 1);
    assert.equal(primary[0].targetIdentity, "FEA-1");
  });

  test("two MCP calls to different artifacts → no primary (ambiguous)", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "mcp__closedloop__get-document",
          timestamp: null,
          input: { documentId: "FEA-11" },
        },
        {
          name: "mcp__closedloop__get-document",
          timestamp: null,
          input: { documentId: "PRD-22" },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const primary = refs.filter((r) => r.isPrimary);
    assert.equal(
      primary.length,
      0,
      "two MCP refs to different artifacts = no primary"
    );
  });

  test("URL ref + branch ref to same artifact → URL method wins as primary", () => {
    // url_in_message ranks higher (index 1) than slug_in_branch (index 4) in PRIMARY_METHOD_PRECEDENCE
    const session = makeSession({
      gitBranch: "feat/FEA-50-my-feature",
      messages: [
        {
          role: "human",
          timestamp: null,
          text: "See https://app.closedloop.ai/my-org/features/FEA-50 for the spec.",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const primary = refs.filter((r) => r.isPrimary);
    assert.equal(primary.length, 1);
    assert.equal(primary[0].method, "url_in_message");
    assert.equal(primary[0].targetIdentity, "FEA-50");
  });

  test("branch-only ref → isPrimary=true when no higher-precedence method", () => {
    const session = makeSession({
      gitBranch: "feat/FEA-99-some-work",
    });
    const refs = extractArtifactRefs(session, NOW);
    const primary = refs.filter((r) => r.isPrimary);
    assert.equal(primary.length, 1);
    assert.equal(primary[0].targetIdentity, "FEA-99");
  });
});

// ---------------------------------------------------------------------------
// Deduplication: same slug via multiple methods → one row per key, highest confidence wins
// ---------------------------------------------------------------------------

describe("deduplication", () => {
  test("same slug mentioned in prose and as URL → single input ref with url_match confidence", () => {
    const session = makeSession({
      messages: [
        {
          role: "human",
          timestamp: null,
          text: "FEA-111 — see https://app.closedloop.ai/my-org/features/FEA-111 for context.",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const inputRefs = refs.filter(
      (r) =>
        r.targetKind === "closedloop_artifact" &&
        r.targetIdentity === "FEA-111" &&
        r.relation === "input"
    );
    assert.equal(
      inputRefs.length,
      1,
      "dedup should produce exactly one input ref"
    );
    assert.equal(inputRefs[0].confidence, "url_match");
  });

  test("same PR URL appearing in multiple tool outputs is deduplicated", () => {
    const prUrl = "https://github.com/closedloop-ai/symphony-alpha/pull/42";
    const session = makeSession({
      toolUses: [
        {
          name: "Read",
          timestamp: null,
          input: {},
          output: `Check ${prUrl}`,
        },
        {
          name: "Read",
          timestamp: null,
          input: {},
          output: `Also see ${prUrl}`,
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const prRefs = refs.filter(
      (r) => r.targetKind === "pull_request" && r.prNumber === 42
    );
    // Each tool use creates its own ref before dedup, but dedup keys on targetKind|targetIdentity|relation
    // Both are referenced, same identity — should be deduplicated to one
    assert.equal(prRefs.length, 1);
  });
});

// ---------------------------------------------------------------------------
// AC 13: HARNESS_CAPABILITIES constant
// ---------------------------------------------------------------------------

describe("AC 13: HARNESS_CAPABILITIES", () => {
  test("all five harnesses are present", () => {
    const keys = Object.keys(HARNESS_CAPABILITIES);
    assert.ok(keys.includes("claude"));
    assert.ok(keys.includes("codex"));
    assert.ok(keys.includes("cursor"));
    assert.ok(keys.includes("copilot"));
    assert.ok(keys.includes("opencode"));
    assert.equal(keys.length, 5);
  });

  test("each capability entry has the four required boolean fields", () => {
    for (const [harness, caps] of Object.entries(HARNESS_CAPABILITIES)) {
      assert.equal(
        typeof caps.gitBranch,
        "boolean",
        `${harness}.gitBranch must be boolean`
      );
      assert.equal(
        typeof caps.mcpServer,
        "boolean",
        `${harness}.mcpServer must be boolean`
      );
      assert.equal(
        typeof caps.mcpMethod,
        "boolean",
        `${harness}.mcpMethod must be boolean`
      );
      assert.equal(
        typeof caps.slug,
        "boolean",
        `${harness}.slug must be boolean`
      );
    }
  });

  test("claude has gitBranch=true and slug=true (no mcpServer/mcpMethod)", () => {
    assert.equal(HARNESS_CAPABILITIES.claude.gitBranch, true);
    assert.equal(HARNESS_CAPABILITIES.claude.slug, true);
    assert.equal(HARNESS_CAPABILITIES.claude.mcpServer, false);
    assert.equal(HARNESS_CAPABILITIES.claude.mcpMethod, false);
  });

  test("codex has mcpServer=true and mcpMethod=true (Codex preserves mcp_server field)", () => {
    assert.equal(HARNESS_CAPABILITIES.codex.mcpServer, true);
    assert.equal(HARNESS_CAPABILITIES.codex.mcpMethod, true);
    assert.equal(HARNESS_CAPABILITIES.codex.gitBranch, true);
    assert.equal(HARNESS_CAPABILITIES.codex.slug, false);
  });

  test("copilot has all capabilities false", () => {
    assert.equal(HARNESS_CAPABILITIES.copilot.gitBranch, false);
    assert.equal(HARNESS_CAPABILITIES.copilot.mcpServer, false);
    assert.equal(HARNESS_CAPABILITIES.copilot.mcpMethod, false);
    assert.equal(HARNESS_CAPABILITIES.copilot.slug, false);
  });
});

// ---------------------------------------------------------------------------
// Workspace context refs: gitBranch, cwd, session slug
// ---------------------------------------------------------------------------

describe("workspace context refs", () => {
  test("gitBranch containing a slug produces both a closedloop_artifact and a branch ref", () => {
    const session = makeSession({ gitBranch: "feat/FEA-42-my-feature" });
    const refs = extractArtifactRefs(session, NOW);

    const slugRef = refs.find(
      (r) =>
        r.targetKind === "closedloop_artifact" && r.targetIdentity === "FEA-42"
    );
    const branchRef = refs.find((r) => r.targetKind === "branch");

    assert.ok(slugRef, "closedloop_artifact ref from branch");
    assert.equal(slugRef?.relation, "workspace");
    assert.equal(slugRef?.method, "slug_in_branch");
    assert.equal(slugRef?.confidence, "slug_match_in_branch");

    assert.ok(branchRef, "branch ref");
    assert.equal(branchRef?.branchName, "feat/FEA-42-my-feature");
    assert.equal(branchRef?.relation, "workspace");
  });

  test("gitBranch without a slug still produces a branch ref", () => {
    const session = makeSession({ gitBranch: "main" });
    const refs = extractArtifactRefs(session, NOW);
    const branchRef = refs.find((r) => r.targetKind === "branch");
    assert.ok(branchRef);
    assert.equal(branchRef?.branchName, "main");
    // No closedloop_artifact ref from branch
    const slugRef = refs.find(
      (r) =>
        r.targetKind === "closedloop_artifact" && r.method === "slug_in_branch"
    );
    assert.equal(slugRef, undefined);
  });

  test("cwd last component containing a slug produces a closedloop_artifact ref", () => {
    const session = makeSession({ cwd: "/home/user/Workspace/FEA-9-spike" });
    const refs = extractArtifactRefs(session, NOW);
    const cwdRef = refs.find((r) => r.method === "slug_in_cwd");
    assert.ok(cwdRef);
    assert.equal(cwdRef?.targetIdentity, "FEA-9");
    assert.equal(cwdRef?.confidence, "slug_match_in_branch");
  });

  test("session.slug that matches pattern produces workspace ref", () => {
    const session = makeSession({ slug: "FEA-33" });
    const refs = extractArtifactRefs(session, NOW);
    const sessionSlugRef = refs.find(
      (r) => r.method === "slug_in_session_slug"
    );
    assert.ok(sessionSlugRef);
    assert.equal(sessionSlugRef?.targetIdentity, "FEA-33");
  });

  test("branch ref includes repoFullName from artifacts.repo", () => {
    const session = makeSession({
      gitBranch: "main",
      artifacts: { prs: [], issues: [], repo: "closedloop-ai/symphony-alpha" },
    });
    const refs = extractArtifactRefs(session, NOW);
    const branchRef = refs.find((r) => r.targetKind === "branch");
    assert.ok(branchRef);
    assert.equal(branchRef?.repoFullName, "closedloop-ai/symphony-alpha");
  });
});

// ---------------------------------------------------------------------------
// extractLaunchMetadataRefs
// ---------------------------------------------------------------------------

describe("extractLaunchMetadataRefs", () => {
  test("valid slug → returns one mcp_call confidence ref", () => {
    const refs = extractLaunchMetadataRefs(
      { sourceArtifactId: "FEA-500" },
      NOW
    );
    assert.equal(refs.length, 1);
    assert.equal(refs[0].targetIdentity, "FEA-500");
    assert.equal(refs[0].confidence, "mcp_call");
    assert.equal(refs[0].method, "launch_metadata");
    assert.equal(refs[0].relation, "input");
  });

  test("null launchMetadata → empty array", () => {
    assert.deepEqual(extractLaunchMetadataRefs(null), []);
  });

  test("invalid slug (6 digits) → empty array", () => {
    assert.deepEqual(
      extractLaunchMetadataRefs({ sourceArtifactId: "FEA-123456" }),
      []
    );
  });

  test("invalid slug (wrong prefix) → empty array", () => {
    assert.deepEqual(
      extractLaunchMetadataRefs({ sourceArtifactId: "TASK-10" }),
      []
    );
  });
});

// ---------------------------------------------------------------------------
// canonicalKeyForRef and artifactLinkId
// ---------------------------------------------------------------------------

describe("canonicalKeyForRef", () => {
  test("pull_request → repo#number", () => {
    const ref: ArtifactRefRecord = {
      targetKind: "pull_request",
      targetIdentity: "closedloop-ai/symphony-alpha#99",
      relation: "referenced",
      method: "pr_url_in_tool_use",
      evidence: "{}",
      observedAt: NOW,
      confidence: "url_match",
      extractorVersion: 1,
      isPrimary: false,
      repoFullName: "closedloop-ai/symphony-alpha",
      prNumber: 99,
    };
    assert.equal(canonicalKeyForRef(ref), "closedloop-ai/symphony-alpha#99");
  });

  test("branch → repo:branchName", () => {
    const ref: ArtifactRefRecord = {
      targetKind: "branch",
      targetIdentity: "main",
      relation: "workspace",
      method: "slug_in_branch",
      evidence: "{}",
      observedAt: NOW,
      confidence: "slug_match_in_branch",
      extractorVersion: 1,
      isPrimary: false,
      repoFullName: "closedloop-ai/symphony-alpha",
      branchName: "main",
    };
    assert.equal(canonicalKeyForRef(ref), "closedloop-ai/symphony-alpha:main");
  });

  test("branch with no repo → :branchName", () => {
    const ref: ArtifactRefRecord = {
      targetKind: "branch",
      targetIdentity: "feat/x",
      relation: "workspace",
      method: "slug_in_branch",
      evidence: "{}",
      observedAt: NOW,
      confidence: "slug_match_in_branch",
      extractorVersion: 1,
      isPrimary: false,
      branchName: "feat/x",
    };
    assert.equal(canonicalKeyForRef(ref), ":feat/x");
  });

  test("commit → sha", () => {
    const ref: ArtifactRefRecord = {
      targetKind: "commit",
      targetIdentity: "abc1234",
      sha: "abc1234",
      relation: "output",
      method: "git_command",
      evidence: "{}",
      observedAt: NOW,
      confidence: "slug_match_in_prose",
      extractorVersion: 1,
      isPrimary: false,
    };
    assert.equal(canonicalKeyForRef(ref), "abc1234");
  });

  test("closedloop_artifact → slug", () => {
    const ref: ArtifactRefRecord = {
      targetKind: "closedloop_artifact",
      targetIdentity: "FEA-1",
      slug: "FEA-1",
      relation: "input",
      method: "mcp_tool_call",
      evidence: "{}",
      observedAt: NOW,
      confidence: "mcp_call",
      extractorVersion: 1,
      isPrimary: false,
    };
    assert.equal(canonicalKeyForRef(ref), "FEA-1");
  });
});

describe("artifactLinkId", () => {
  test("produces a 16-character hex string", () => {
    const id = artifactLinkId(
      "session-1",
      "closedloop_artifact",
      "FEA-1",
      "input"
    );
    assert.equal(id.length, 16);
    assert.match(id, HEX_16_RE);
  });

  test("is deterministic for the same inputs", () => {
    const a = artifactLinkId(
      "session-1",
      "closedloop_artifact",
      "FEA-1",
      "input"
    );
    const b = artifactLinkId(
      "session-1",
      "closedloop_artifact",
      "FEA-1",
      "input"
    );
    assert.equal(a, b);
  });

  test("differs when any input differs", () => {
    const base = artifactLinkId(
      "session-1",
      "closedloop_artifact",
      "FEA-1",
      "input"
    );
    assert.notEqual(
      base,
      artifactLinkId("session-2", "closedloop_artifact", "FEA-1", "input")
    );
    assert.notEqual(
      base,
      artifactLinkId("session-1", "pull_request", "FEA-1", "input")
    );
    assert.notEqual(
      base,
      artifactLinkId("session-1", "closedloop_artifact", "FEA-2", "input")
    );
    assert.notEqual(
      base,
      artifactLinkId("session-1", "closedloop_artifact", "FEA-1", "output")
    );
  });
});

// ---------------------------------------------------------------------------
// Edge: empty session produces no refs
// ---------------------------------------------------------------------------

test("empty session produces no refs", () => {
  const session = makeSession();
  const refs = extractArtifactRefs(session, NOW);
  assert.deepEqual(refs, []);
});

// ---------------------------------------------------------------------------
// Git-command branch detection (session.gitBranch is stale; detect from cmds)
// ---------------------------------------------------------------------------

describe("git-command branch detection", () => {
  test("git worktree add -b <branch> produces branch ref", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: {
            command:
              'git worktree add "../symphony-alpha-fea-1684" -b "feat/fea-1684" origin/main',
          },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const branchRefs = refs.filter(
      (r) => r.targetKind === "branch" && r.method === "git_worktree_add"
    );
    assert.equal(branchRefs.length, 1);
    assert.equal(branchRefs[0].branchName, "feat/fea-1684");
  });

  test("git worktree add without -b still detects branch", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: 'git worktree add "../wt" feat/fea-1684' },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const branchRefs = refs.filter(
      (r) => r.targetKind === "branch" && r.method === "git_worktree_add"
    );
    assert.equal(branchRefs.length, 1);
    assert.equal(branchRefs[0].branchName, "feat/fea-1684");
  });

  test("git checkout -b <branch> produces branch ref", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: "git checkout -b feature/new-thing" },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const branchRefs = refs.filter(
      (r) => r.targetKind === "branch" && r.method === "git_checkout"
    );
    assert.equal(branchRefs.length, 1);
    assert.equal(branchRefs[0].branchName, "feature/new-thing");
  });

  test("git switch <branch> produces branch ref", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: "git switch feat/fea-999" },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const branchRefs = refs.filter(
      (r) => r.targetKind === "branch" && r.method === "git_checkout"
    );
    assert.equal(branchRefs.length, 1);
    assert.equal(branchRefs[0].branchName, "feat/fea-999");
  });

  test("git push -u origin <branch> produces branch ref", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: "git push -u origin feat/fea-1684" },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const branchRefs = refs.filter(
      (r) => r.targetKind === "branch" && r.method === "git_push"
    );
    assert.equal(branchRefs.length, 1);
    assert.equal(branchRefs[0].branchName, "feat/fea-1684");
  });

  test("array-shaped command.command (Codex shell tool) produces branch ref", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "shell",
          timestamp: NOW,
          input: { command: ["git", "push", "-u", "origin", "feat/fea-1684"] },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const branchRefs = refs.filter(
      (r) => r.targetKind === "branch" && r.method === "git_push"
    );
    assert.equal(branchRefs.length, 1);
    assert.equal(branchRefs[0].branchName, "feat/fea-1684");
  });

  test("top-level array command (Codex exec_command) produces branch ref", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "exec_command",
          timestamp: NOW,
          input: ["git", "checkout", "-b", "feat/fea-1684"],
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const branchRefs = refs.filter((r) => r.targetKind === "branch");
    assert.equal(branchRefs.length, 1);
    assert.equal(branchRefs[0].branchName, "feat/fea-1684");
  });

  test("git commit output with branch name produces branch ref", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: 'git commit -m "test"' },
          output:
            "[feat/fea-1684 abc1234] test commit message\n 1 file changed",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const branchRefs = refs.filter(
      (r) => r.targetKind === "branch" && r.method === "git_commit"
    );
    assert.equal(branchRefs.length, 1);
    assert.equal(branchRefs[0].branchName, "feat/fea-1684");
  });

  test("commit ref captures the subject + commit time, not scan time (PRD-486)", () => {
    const COMMIT_TIME = "2026-06-08T08:00:00.000Z";
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: COMMIT_TIME,
          input: { command: 'git commit -m "Add the thing"' },
          output: "[feat/x abc1234def] Add the thing\n 2 files changed",
        },
      ],
    });
    // Pass NOW (2024) as the import/scan time so it can't be mistaken for the
    // commit time captured from the tool-use timestamp.
    const refs = extractArtifactRefs(session, NOW);
    const commitRef = refs.find((r) => r.targetKind === "commit");
    assert.ok(commitRef, "expected a commit ref");
    assert.equal(commitRef.sha, "abc1234def");
    assert.equal(commitRef.message, "Add the thing");
    assert.equal(commitRef.committedAt, COMMIT_TIME);
    assert.notEqual(commitRef.committedAt, NOW);
  });

  test("commit with no tool timestamp captures no committedAt (FEA-2022 guard)", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: { command: 'git commit -m "Untimed"' },
          output: "[feat/x abc1234def] Untimed\n 1 file changed",
        },
      ],
    });
    const commitRef = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "commit"
    );
    assert.ok(commitRef, "expected a commit ref");
    // No event time → committedAt stays undefined (never the scan-time NOW), so
    // the downstream `committed_at IS NOT NULL` read filters it out (no dot).
    assert.equal(commitRef.committedAt, undefined);
    assert.notEqual(commitRef.committedAt, NOW);
    // The subject is still captured (independent of the timestamp).
    assert.equal(commitRef.message, "Untimed");
  });

  test("Closedloop slug extracted from detected branch name", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: "git push -u origin feat/fea-1684" },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const slugRefs = refs.filter(
      (r) => r.targetKind === "closedloop_artifact" && r.slug === "FEA-1684"
    );
    assert.ok(
      slugRefs.length >= 1,
      "should extract FEA-1684 slug from branch name"
    );
  });

  test("multiple git commands produce multiple branch refs", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: "git checkout -b feat/fea-100" },
        },
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: "git push -u origin feat/fea-200" },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const branchNames = refs
      .filter((r) => r.targetKind === "branch")
      .map((r) => r.branchName);
    assert.ok(branchNames.includes("feat/fea-100"));
    assert.ok(branchNames.includes("feat/fea-200"));
  });

  test("gitBranch=main still produces a branch ref alongside detected branches", () => {
    const session = makeSession({
      gitBranch: "main",
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: "git push -u origin feat/fea-1684" },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const branchNames = refs
      .filter((r) => r.targetKind === "branch")
      .map((r) => r.branchName);
    assert.ok(branchNames.includes("main"), "gitBranch=main still recorded");
    assert.ok(
      branchNames.includes("feat/fea-1684"),
      "detected branch also recorded"
    );
  });
});
