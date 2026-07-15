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
  EXTRACTOR_VERSION,
  extractArtifactRefs,
  extractLaunchMetadataRefs,
  HARNESS_CAPABILITIES,
  stripCodeFences,
} from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { makeSession as baseSession } from "./normalized-session-test-utils.js";

// ---------------------------------------------------------------------------
// Minimal fixture helper
// ---------------------------------------------------------------------------

function makeSession(
  overrides: Partial<NormalizedSession> & {
    messages?: NormalizedSession["messages"];
    toolUses?: NormalizedSession["toolUses"];
  } = {}
): NormalizedSession {
  return baseSession({
    sessionId: "test-session-1",
    name: "test",
    cwd: null,
    model: null,
    startedAt: "2024-01-01T00:00:00.000Z",
    endedAt: null,
    ...overrides,
  });
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

  test("created PR with no per-tool gitBranch gets undefined head branch (FEA-2177: no session fallback)", () => {
    const session = makeSession({
      gitBranch: "fea-fallback",
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: { command: "gh pr create --fill" },
          output: "https://github.com/closedloop-ai/symphony-alpha/pull/43\n",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const prRef = refs.find((r) => r.targetKind === "pull_request");
    assert.equal(prRef?.relation, "created");
    assert.equal(prRef?.branchName, undefined);
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

  test("created PR with gitBranch='main' gets undefined head branch (FEA-2260: default branch rejection)", () => {
    const session = makeSession({
      gitBranch: "main",
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: { command: "gh pr create --fill" },
          output: "https://github.com/closedloop-ai/symphony-alpha/pull/44\n",
          gitBranch: "main",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const prRef = refs.find((r) => r.targetKind === "pull_request");
    assert.equal(prRef?.relation, "created");
    assert.equal(prRef?.branchName, undefined);
  });

  test("created PR with gitBranch='master' gets undefined head branch (FEA-2260)", () => {
    const session = makeSession({
      gitBranch: "master",
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: { command: "gh pr create --fill" },
          output: "https://github.com/closedloop-ai/symphony-alpha/pull/45\n",
          gitBranch: "master",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const prRef = refs.find((r) => r.targetKind === "pull_request");
    assert.equal(prRef?.relation, "created");
    assert.equal(prRef?.branchName, undefined);
  });

  test("created PR with gitBranch='develop' gets undefined head branch (FEA-2260)", () => {
    const session = makeSession({
      gitBranch: "develop",
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: { command: "gh pr create --fill" },
          output: "https://github.com/closedloop-ai/symphony-alpha/pull/46\n",
          gitBranch: "develop",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const prRef = refs.find((r) => r.targetKind === "pull_request");
    assert.equal(prRef?.relation, "created");
    assert.equal(prRef?.branchName, undefined);
  });

  test("created PR with a real feature branch still gets the correct head branch (FEA-2260)", () => {
    const session = makeSession({
      gitBranch: "main",
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: { command: "gh pr create --fill" },
          output: "https://github.com/closedloop-ai/symphony-alpha/pull/47\n",
          gitBranch: "feat/fea-1899",
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    const prRef = refs.find((r) => r.targetKind === "pull_request");
    assert.equal(prRef?.relation, "created");
    assert.equal(prRef?.branchName, "feat/fea-1899");
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

  test("FETCH_HEAD gitBranch produces no branch ref (FEA-2177)", () => {
    const session = makeSession({ gitBranch: "FETCH_HEAD" });
    const refs = extractArtifactRefs(session, NOW);
    const branchRef = refs.find((r) => r.targetKind === "branch");
    assert.equal(branchRef, undefined);
  });

  test("origin/ remote ref produces no branch ref (FEA-2177)", () => {
    const session = makeSession({ gitBranch: "origin/main" });
    const refs = extractArtifactRefs(session, NOW);
    const branchRef = refs.find((r) => r.targetKind === "branch");
    assert.equal(branchRef, undefined);
  });

  test("refs/ path produces no branch ref (FEA-2177)", () => {
    const session = makeSession({ gitBranch: "refs/pr/1748" });
    const refs = extractArtifactRefs(session, NOW);
    const branchRef = refs.find((r) => r.targetKind === "branch");
    assert.equal(branchRef, undefined);
  });

  test("bare SHA produces no branch ref (FEA-2177)", () => {
    const session = makeSession({ gitBranch: "a1b2c3d4e5f6a7b8" });
    const refs = extractArtifactRefs(session, NOW);
    const branchRef = refs.find((r) => r.targetKind === "branch");
    assert.equal(branchRef, undefined);
  });

  test("invalid gitBranch with embedded slug still produces closedloop_artifact ref (FEA-2177)", () => {
    const session = makeSession({ gitBranch: "FETCH_HEAD" });
    const refs = extractArtifactRefs(session, NOW);
    const branchRef = refs.find((r) => r.targetKind === "branch");
    assert.equal(branchRef, undefined, "no branch ref for FETCH_HEAD");
    const slugRef = refs.find(
      (r) =>
        r.targetKind === "closedloop_artifact" && r.method === "slug_in_branch"
    );
    assert.equal(
      slugRef,
      undefined,
      "FETCH_HEAD contains no slug — no closedloop_artifact ref either"
    );
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

// ---------------------------------------------------------------------------
// FEA-2531: branch-ref evidence split — relation by method, failed-push gate,
// per-ref event time, start_branch method rename, EXTRACTOR_VERSION bump.
// ---------------------------------------------------------------------------

describe("FEA-2531: branch ref relation by evidence method", () => {
  function branchRefFor(command: string, method: string, output?: string) {
    const session = makeSession({
      toolUses: [{ name: "Bash", timestamp: NOW, input: { command }, output }],
    });
    return extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "branch" && r.method === method
    );
  }

  test("git_push branch ref → relation=created", () => {
    const ref = branchRefFor("git push -u origin feat/fea-2531", "git_push");
    assert.ok(ref, "expected a git_push branch ref");
    assert.equal(ref?.relation, "created");
  });

  test("gh_pr_create branch ref → relation=created", () => {
    const ref = branchRefFor(
      "gh pr create --fill",
      "gh_pr_create",
      "Warning: 3 commits on branch 'feat/fea-2531'\nhttps://github.com/closedloop-ai/symphony-alpha/pull/1\n"
    );
    assert.ok(ref, "expected a gh_pr_create branch ref");
    assert.equal(ref?.branchName, "feat/fea-2531");
    assert.equal(ref?.relation, "created");
  });

  test("git_commit branch ref → relation=created", () => {
    const ref = branchRefFor(
      'git commit -m "work"',
      "git_commit",
      "[feat/fea-2531 abc1234] work\n 1 file changed"
    );
    assert.ok(ref, "expected a git_commit branch ref");
    assert.equal(ref?.relation, "created");
  });

  test("git_checkout branch ref → relation=workspace", () => {
    const ref = branchRefFor("git checkout -b feat/fea-2531", "git_checkout");
    assert.ok(ref, "expected a git_checkout branch ref");
    assert.equal(ref?.relation, "workspace");
  });

  test("git_worktree_add branch ref → relation=workspace", () => {
    const ref = branchRefFor(
      'git worktree add "../wt" -b feat/fea-2531 origin/main',
      "git_worktree_add"
    );
    assert.ok(ref, "expected a git_worktree_add branch ref");
    assert.equal(ref?.relation, "workspace");
  });

  test("session start-branch ref → relation=workspace, method=start_branch", () => {
    const session = makeSession({ gitBranch: "feat/fea-2531" });
    const refs = extractArtifactRefs(session, NOW);
    const branchRef = refs.find((r) => r.targetKind === "branch");
    assert.ok(branchRef, "expected a start-branch ref");
    assert.equal(branchRef?.method, "start_branch");
    assert.equal(branchRef?.relation, "workspace");
  });
});

describe("FEA-2531: failed push is not push evidence (PRD-510 C1)", () => {
  test("git push with isError=true emits NO branch ref", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: "git push origin feat-x" },
          isError: true,
        },
      ],
    });
    const branchRef = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "branch" && r.method === "git_push"
    );
    assert.equal(branchRef, undefined, "failed push must not record a branch");
  });

  test("git push with isError=false emits the created branch ref", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: "git push origin feat-x" },
          isError: false,
        },
      ],
    });
    const branchRef = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "branch" && r.method === "git_push"
    );
    assert.ok(branchRef, "successful push must record a branch");
    assert.equal(branchRef?.branchName, "feat-x");
    assert.equal(branchRef?.relation, "created");
  });

  test("git push with isError undefined (unset by harness) emits the branch ref", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: "git push origin feat-x" },
        },
      ],
    });
    const branchRef = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "branch" && r.method === "git_push"
    );
    assert.ok(branchRef, "absent isError is treated as success");
  });

  test("failed git push via array-shaped Codex command emits NO branch ref", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "shell",
          timestamp: NOW,
          input: { command: ["git", "push", "-u", "origin", "feat/fea-2531"] },
          isError: true,
        },
      ],
    });
    const branchRef = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "branch" && r.method === "git_push"
    );
    assert.equal(branchRef, undefined);
  });
});

describe("FEA-2531: per-ref observedAt from tool event time", () => {
  test("branch ref from a tool use stamps observedAt from the tool timestamp, not scan time", () => {
    const TOOL_TIME = "2026-06-08T08:00:00.000Z";
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: TOOL_TIME,
          input: { command: "git push -u origin feat/fea-2531" },
        },
      ],
    });
    // NOW (2024) is the scan/import time; it must not leak onto the branch ref.
    const branchRef = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "branch" && r.method === "git_push"
    );
    assert.ok(branchRef);
    assert.equal(branchRef?.observedAt, TOOL_TIME);
    assert.notEqual(branchRef?.observedAt, NOW);
  });

  test("branch ref with no tool timestamp falls back to scan time", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: null,
          input: { command: "git push -u origin feat/fea-2531" },
        },
      ],
    });
    const branchRef = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "branch" && r.method === "git_push"
    );
    assert.ok(branchRef);
    assert.equal(branchRef?.observedAt, NOW);
  });

  test("session start-branch ref keeps scan-time observedAt", () => {
    const session = makeSession({ gitBranch: "feat/fea-2531" });
    const branchRef = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "branch" && r.method === "start_branch"
    );
    assert.ok(branchRef);
    assert.equal(branchRef?.observedAt, NOW);
  });
});

describe("FEA-2531: start_branch rename is scoped to the branch ref", () => {
  test("start-branch slug ref still uses method slug_in_branch", () => {
    const session = makeSession({ gitBranch: "feat/FEA-2531-attribution" });
    const refs = extractArtifactRefs(session, NOW);
    const branchRef = refs.find((r) => r.targetKind === "branch");
    assert.equal(branchRef?.method, "start_branch");
    const slugRef = refs.find(
      (r) =>
        r.targetKind === "closedloop_artifact" &&
        r.targetIdentity === "FEA-2531"
    );
    assert.ok(slugRef, "branch-name slug still resolves a closedloop_artifact");
    assert.equal(slugRef?.method, "slug_in_branch");
  });

  test("detected-branch slug ref keeps method slug_in_branch", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: "git push -u origin feat/fea-2531" },
        },
      ],
    });
    const slugRef = extractArtifactRefs(session, NOW).find(
      (r) =>
        r.targetKind === "closedloop_artifact" &&
        r.targetIdentity === "FEA-2531"
    );
    assert.ok(slugRef);
    assert.equal(slugRef?.method, "slug_in_branch");
  });
});

describe("FEA-2531: EXTRACTOR_VERSION bump", () => {
  test("EXTRACTOR_VERSION is 11", () => {
    assert.equal(EXTRACTOR_VERSION, 11);
  });

  test("emitted refs are stamped with extractorVersion 11", () => {
    const session = makeSession({
      gitBranch: "feat/fea-2531",
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: "git push -u origin feat/fea-2531" },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW);
    assert.ok(refs.length > 0);
    assert.ok(refs.every((r) => r.extractorVersion === 11));
  });
});

// ---------------------------------------------------------------------------
// FEA-2531 review fixes: evidence-ranked dedupe (commit-then-push keeps the
// push ref) and push-form coverage (long flags, HEAD via output, delete skip).
// ---------------------------------------------------------------------------

describe("FEA-2531: same-relation dedupe keeps the strongest branch evidence", () => {
  test("commit then push on one branch → single created ref with method git_push", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: "2024-01-01T12:01:00.000Z",
          input: { command: 'git commit -m "work"' },
          output: "[feat/fea-x abc1234] work\n 1 file changed",
        },
        {
          name: "Bash",
          timestamp: "2024-01-01T12:02:00.000Z",
          input: { command: "git push -u origin feat/fea-x" },
        },
      ],
    });
    const created = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "branch" && r.relation === "created"
    );
    assert.equal(created.length, 1, "created refs collapse to one per branch");
    assert.equal(created[0]?.method, "git_push");
    assert.equal(created[0]?.observedAt, "2024-01-01T12:02:00.000Z");
  });

  test("push then commit on one branch → push ref still wins", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: "2024-01-01T12:01:00.000Z",
          input: { command: "git push -u origin feat/fea-x" },
        },
        {
          name: "Bash",
          timestamp: "2024-01-01T12:02:00.000Z",
          input: { command: 'git commit -m "more"' },
          output: "[feat/fea-x def5678] more\n 1 file changed",
        },
      ],
    });
    const created = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "branch" && r.relation === "created"
    );
    assert.equal(created.length, 1);
    assert.equal(created[0]?.method, "git_push");
  });

  test("two pushes on one branch → earliest push ref survives", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: "2024-01-01T12:01:00.000Z",
          input: { command: "git push -u origin feat/fea-x" },
        },
        {
          name: "Bash",
          timestamp: "2024-01-01T12:05:00.000Z",
          input: { command: "git push origin feat/fea-x" },
        },
      ],
    });
    const created = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "branch" && r.relation === "created"
    );
    assert.equal(created.length, 1);
    assert.equal(created[0]?.observedAt, "2024-01-01T12:01:00.000Z");
  });

  test("checkout plus push on one branch → both workspace and created refs", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: "2024-01-01T12:01:00.000Z",
          input: { command: "git checkout -b feat/fea-x" },
        },
        {
          name: "Bash",
          timestamp: "2024-01-01T12:02:00.000Z",
          input: { command: "git push -u origin feat/fea-x" },
        },
      ],
    });
    const branchRefs = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "branch"
    );
    const relations = branchRefs.map((r) => r.relation).sort();
    assert.deepEqual(relations, ["created", "workspace"]);
  });
});

describe("FEA-2531: push-form coverage", () => {
  function pushRefsFor(command: string, output?: string, isError?: boolean) {
    const session = makeSession({
      toolUses: [
        { name: "Bash", timestamp: NOW, input: { command }, output, isError },
      ],
    });
    return extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "branch" && r.method === "git_push"
    );
  }

  test("git push --set-upstream origin <branch> is push evidence", () => {
    const refs = pushRefsFor("git push --set-upstream origin feat/fea-x");
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.branchName, "feat/fea-x");
  });

  test("git push --force-with-lease origin <branch> is push evidence", () => {
    const refs = pushRefsFor("git push --force-with-lease origin feat/fea-x");
    assert.equal(refs.length, 1);
  });

  test("git push origin HEAD resolves the branch from the ref-line output", () => {
    const refs = pushRefsFor(
      "git push origin HEAD",
      "To github.com:closedloop-ai/symphony-alpha.git\n   abc1234..def5678  HEAD -> feat/fea-x\n"
    );
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.branchName, "feat/fea-x");
  });

  test("git push -u origin HEAD resolves the branch from the upstream output", () => {
    const refs = pushRefsFor(
      "git push -u origin HEAD",
      "branch 'feat/fea-x' set up to track 'origin/feat/fea-x'.\n"
    );
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.branchName, "feat/fea-x");
  });

  test("git push origin HEAD with no output emits no HEAD branch ref", () => {
    const refs = pushRefsFor("git push origin HEAD");
    assert.equal(refs.length, 0);
  });

  test("new-branch ref-line output is push evidence", () => {
    const refs = pushRefsFor(
      "git push --set-upstream origin feat/fea-x",
      "To github.com:closedloop-ai/symphony-alpha.git\n * [new branch]      feat/fea-x -> feat/fea-x\n"
    );
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.branchName, "feat/fea-x");
  });

  test("branch deletion is never push evidence", () => {
    assert.equal(pushRefsFor("git push origin --delete feat/fea-x").length, 0);
    assert.equal(pushRefsFor("git push --delete origin feat/fea-x").length, 0);
    assert.equal(pushRefsFor("git push -d origin feat/fea-x").length, 0);
  });

  test("failed HEAD push with rejected ref-line output is gated by isError", () => {
    const refs = pushRefsFor(
      "git push origin HEAD",
      "To github.com:closedloop-ai/symphony-alpha.git\n ! [rejected]        HEAD -> feat/fea-x (non-fast-forward)\n",
      true
    );
    assert.equal(refs.length, 0);
  });
});

// ---------------------------------------------------------------------------
// FEA-2531 hardening: shell-quote-aware git detection. Regression fixtures are
// the LITERAL commands that minted phantom branches (feat, feat/x',
// feat/x','git) in real desktop data — git-command text embedded inside a
// quoted argument of another command must never produce branch/commit refs.
// ---------------------------------------------------------------------------

describe("FEA-2531 hardening: quoted git text is not evidence", () => {
  function branchRefsFor(command: string, output?: string) {
    const session = makeSession({
      toolUses: [{ name: "Bash", timestamp: NOW, input: { command }, output }],
    });
    return extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "branch"
    );
  }

  test("rg pattern containing git push text mints no branch (the `feat` poison)", () => {
    const refs = branchRefsFor(
      'rtk rg -n "git push.*HEAD|set-upstream|--set-upstream|push -u origin HEAD|push origin HEAD|git push origin feat|git push -u origin" apps/desktop/test/artifact-ref-extractor.test.ts apps/desktop/test -l'
    );
    assert.equal(refs.length, 0);
  });

  test("inline -e script with quoted git commands mints no branch (the `feat/x','git` poison)", () => {
    const refs = branchRefsFor(
      "rtk pnpm exec tsx -e \"import { extractArtifactRefs } from './apps/desktop/src/main/collectors/parsing/artifact-ref-extractor.ts'; const cmds = ['git push origin feat/x','git checkout -b feat/x']; console.log(cmds)\""
    );
    assert.equal(refs.length, 0);
  });

  test("rg output echoing push ref-lines is not scanned (command is not a push)", () => {
    const refs = branchRefsFor(
      'rg "git push" apps/desktop/test',
      'test.ts: "To github.com:x/y.git\\n * [new branch]      feat/x -> feat/x"'
    );
    assert.equal(refs.length, 0);
  });

  test("rg output echoing commit summary lines mints no commit refs", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: 'rg "git commit" apps/desktop/test' },
          output: 'test.ts: output: "[feat/x abc1234] work"\n',
        },
      ],
    });
    const commits = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "commit"
    );
    assert.equal(commits.length, 0);
  });

  test("git text inside commit -m body is ignored, chained real push still detected", () => {
    const refs = branchRefsFor(
      'git commit -m "docs: mention git push origin bogus and --delete" && git push origin feat/real'
    );
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.branchName, "feat/real");
    assert.equal(refs[0]?.method, "git_push");
  });

  test("wrapper-prefixed real git commands still count (rtk rewrite)", () => {
    const refs = branchRefsFor("rtk git push origin feat/wrapped");
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.branchName, "feat/wrapped");
  });

  test("cd-chained real push still counts", () => {
    const refs = branchRefsFor(
      "cd /home/user/wt && git push -u origin feat/chained"
    );
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.branchName, "feat/chained");
  });

  test("quoted branch NAME on a real checkout still captures", () => {
    const refs = branchRefsFor('git checkout -b "feat/quoted-ok"');
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.branchName, "feat/quoted-ok");
  });

  test("echoed gh pr create text does not classify the tool as PR-creating", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: 'echo "run gh pr create when ready"' },
          output:
            "run gh pr create when ready\nhttps://github.com/closedloop-ai/symphony-alpha/pull/999\n",
        },
      ],
    });
    const prRefs = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "pull_request"
    );
    assert.equal(prRefs.length, 1);
    assert.equal(prRefs[0]?.relation, "referenced");
  });
});

// ---------------------------------------------------------------------------
// FEA-2791: argv-shaped commands must respect the same quote-aware defense.
// `shellCommand`'s `join(" ")` erases argument boundaries, so git-command text
// bundled inside ONE non-first argv element (a `rg` search pattern) would look
// like bare command structure and mint a phantom branch — the exact case the
// string form (`rg "git push origin feat/x"`) rejects. A spaceless argv element
// is a plain token, so genuine tokenized argv pushes must still be detected.
// ---------------------------------------------------------------------------

describe("FEA-2791: argv-shaped commands respect the quote-aware defense", () => {
  function branchRefsForArgv(argv: string[], output?: string) {
    const session = makeSession({
      toolUses: [
        { name: "Bash", timestamp: NOW, input: { command: argv }, output },
      ],
    });
    return extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "branch"
    );
  }

  test("git push text bundled in one rg argv element mints no branch", () => {
    const refs = branchRefsForArgv(["rg", "git push origin feat/x"]);
    assert.equal(refs.length, 0);
  });

  test("bare-array argv rg form is neutralized too", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: ["rg", "git push origin feat/x", "apps/desktop"],
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "branch"
    );
    assert.equal(refs.length, 0);
  });

  test("tokenized argv git push (spaceless elements) is still detected", () => {
    const refs = branchRefsForArgv([
      "git",
      "push",
      "-u",
      "origin",
      "feat/fea-2791",
    ]);
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.branchName, "feat/fea-2791");
    assert.equal(refs[0]?.method, "git_push");
  });

  test("git commit text bundled in one rg argv element mints no commit refs", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: ["rg", "git commit", "apps/desktop"] },
          output: 'test.ts: "[feat/x abc1234def5678] work"\n',
        },
      ],
    });
    const commits = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "commit"
    );
    assert.equal(commits.length, 0);
  });

  test("null/undefined argv elements keep offsets aligned (no phantom branch)", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: ["rg", null, "git push origin feat/x"] },
        },
      ],
    });
    const refs = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "branch"
    );
    assert.equal(refs.length, 0);
  });
});

// ---------------------------------------------------------------------------
// FEA-2531 hardening: created-PR head branch resolves from the session's own
// write evidence (relationships) before the CWD-derived tu.gitBranch. The
// worktree fixture mirrors real data: session CWD on main, worktree work via
// `cd`, PR raised from the worktree — per-line gitBranch says main and the
// head ref must come from the push relationship instead.
// ---------------------------------------------------------------------------

const CREATE_TOOL_EVIDENCE_RE = /create_tool_evidence/;
const PRECEDING_WRITE_RE = /preceding_write/;
const TOOL_GIT_BRANCH_RE = /tool_git_branch/;

describe("FEA-2531: created-PR head branch from write evidence", () => {
  const PR_URL = "https://github.com/closedloop-ai/symphony-alpha/pull/2320";

  function createdRefFor(
    toolUses: NormalizedSession["toolUses"]
  ): ArtifactRefRecord | undefined {
    const session = makeSession({ toolUses });
    return extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "pull_request" && r.relation === "created"
    );
  }

  test("gh's 'Creating pull request for' output line is the head ref", () => {
    const ref = createdRefFor([
      {
        name: "Bash",
        timestamp: NOW,
        gitBranch: "main",
        input: { command: "gh pr create --title x --body-file /tmp/b.md" },
        output: `Creating pull request for feat/fea-2531 into main in closedloop-ai/symphony-alpha\n${PR_URL}\n`,
      },
    ]);
    assert.ok(ref);
    assert.equal(ref?.branchName, "feat/fea-2531");
    assert.match(ref?.evidence ?? "", CREATE_TOOL_EVIDENCE_RE);
  });

  test("--head flag names the head ref", () => {
    const ref = createdRefFor([
      {
        name: "Bash",
        timestamp: NOW,
        gitBranch: "main",
        input: {
          command: "gh pr create --head feat/from-flag --title x --body y",
        },
        output: `${PR_URL}\n`,
      },
    ]);
    assert.equal(ref?.branchName, "feat/from-flag");
  });

  test("worktree PR heals from the preceding push relationship", () => {
    const ref = createdRefFor([
      {
        name: "Bash",
        timestamp: "2024-01-01T11:58:00.000Z",
        gitBranch: "main",
        input: {
          command:
            "cd /home/user/symphony-alpha-fea-2531 && git push -u origin feat/fea-2531",
        },
      },
      {
        name: "Bash",
        timestamp: NOW,
        gitBranch: "main",
        input: {
          command:
            "cd /home/user/symphony-alpha-fea-2531 && gh pr create --title x --body y",
        },
        output: `${PR_URL}\n`,
      },
    ]);
    assert.equal(ref?.branchName, "feat/fea-2531");
    assert.match(ref?.evidence ?? "", PRECEDING_WRITE_RE);
  });

  test("failed preceding push is not head evidence", () => {
    const ref = createdRefFor([
      {
        name: "Bash",
        timestamp: "2024-01-01T11:58:00.000Z",
        gitBranch: "main",
        input: { command: "git push -u origin feat/failed" },
        isError: true,
      },
      {
        name: "Bash",
        timestamp: NOW,
        gitBranch: "main",
        input: { command: "gh pr create --title x --body y" },
        output: `${PR_URL}\n`,
      },
    ]);
    assert.equal(ref?.branchName, undefined);
  });

  test("tu.gitBranch is the LAST fallback and still works for direct sessions", () => {
    const ref = createdRefFor([
      {
        name: "Bash",
        timestamp: NOW,
        gitBranch: "feat/direct",
        input: { command: "gh pr create --title x --body y" },
        output: `${PR_URL}\n`,
      },
    ]);
    assert.equal(ref?.branchName, "feat/direct");
    assert.match(ref?.evidence ?? "", TOOL_GIT_BRANCH_RE);
  });

  test("worktree session with no write evidence yields no head ref (never main)", () => {
    const ref = createdRefFor([
      {
        name: "Bash",
        timestamp: NOW,
        gitBranch: "main",
        input: { command: "gh pr create --title x --body y" },
        output: `${PR_URL}\n`,
      },
    ]);
    assert.ok(ref);
    assert.equal(ref?.branchName, undefined);
  });

  test("referenced PRs never carry a head ref", () => {
    const ref = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          gitBranch: "feat/mine",
          input: { command: "gh pr view 111" },
          output: "https://github.com/closedloop-ai/symphony-alpha/pull/111\n",
        },
      ],
    });
    const refs = extractArtifactRefs(ref, NOW).filter(
      (r) => r.targetKind === "pull_request"
    );
    assert.equal(refs[0]?.relation, "referenced");
    assert.equal(refs[0]?.branchName, undefined);
  });

  test("create output head line also emits gh_pr_create branch write evidence", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          gitBranch: "main",
          input: { command: "gh pr create --title x --body y" },
          output: `Creating pull request for feat/fea-2531 into main in closedloop-ai/symphony-alpha\n${PR_URL}\n`,
        },
      ],
    });
    const branchRefs = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "branch" && r.relation === "created"
    );
    assert.equal(branchRefs.length, 1);
    assert.equal(branchRefs[0]?.branchName, "feat/fea-2531");
    assert.equal(branchRefs[0]?.method, "gh_pr_create");
  });
});

// FEA-2789: the FEA-2531 failed-push gate must cover EVERY push method, not
// just git_push. gh_pr_create is also a push method, so a failed
// `gh pr create --head feat/x` mints no branch ref and is no head evidence.
describe("FEA-2789: failed gh pr create is not push evidence", () => {
  const PR_URL = "https://github.com/closedloop-ai/symphony-alpha/pull/2789";

  test("failed gh pr create --head emits NO branch ref (pushBranchRefs)", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          gitBranch: "main",
          input: {
            command: "gh pr create --head feat/phantom --title x --body y",
          },
          isError: true,
        },
      ],
    });
    const branchRef = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "branch" && r.method === "gh_pr_create"
    );
    assert.equal(
      branchRef,
      undefined,
      "a failed gh pr create must not mint a phantom pushed branch"
    );
  });

  test("successful gh pr create --head still emits the branch ref", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          gitBranch: "main",
          input: {
            command: "gh pr create --head feat/real --title x --body y",
          },
          output: `${PR_URL}\n`,
          isError: false,
        },
      ],
    });
    const branchRef = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "branch" && r.method === "gh_pr_create"
    );
    assert.ok(branchRef, "successful gh pr create must record a branch");
    assert.equal(branchRef?.branchName, "feat/real");
    assert.equal(branchRef?.relation, "created");
  });

  test("failed preceding gh pr create is not head evidence (collectBranchWriteEvents)", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: "2024-01-01T11:58:00.000Z",
          gitBranch: "main",
          input: {
            command: "gh pr create --head feat/phantom --title x --body y",
          },
          isError: true,
        },
        {
          name: "Bash",
          timestamp: NOW,
          gitBranch: "main",
          input: { command: "gh pr create --title x --body y" },
          output: `${PR_URL}\n`,
        },
      ],
    });
    const ref = extractArtifactRefs(session, NOW).find(
      (r) => r.targetKind === "pull_request" && r.relation === "created"
    );
    assert.equal(
      ref?.branchName,
      undefined,
      "a failed gh pr create must not resolve a later PR's head branch"
    );
  });
});
