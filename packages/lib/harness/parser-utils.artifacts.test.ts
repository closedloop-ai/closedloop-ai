import { describe, expect, it } from "vitest";
import {
  collectArtifacts,
  extractIssueReferences,
  extractPrReferences,
  extractRepoFromCwd,
} from "./parser-utils";

// ---------------------------------------------------------------------------
// extractRepoFromCwd — line 285: last && last.length > 0 ? last : null
// The TRUE path (normal repo name) is exercised by parse-codex tests.
// Only the FALSE path (empty last segment) is uncovered.
// ---------------------------------------------------------------------------

describe("extractRepoFromCwd — null last-segment path (Branch 45[1])", () => {
  it("returns null when cwd reduces to an empty segment after stripping trailing slash", () => {
    // "/" → strip trailing "/" → "" → split("/") = [""] → at(-1) = "" → falsy → null
    expect(extractRepoFromCwd("/")).toBeNull();
  });

  it("returns null for null cwd (early return branch)", () => {
    expect(extractRepoFromCwd(null)).toBeNull();
  });

  it("returns null for undefined cwd", () => {
    expect(extractRepoFromCwd(undefined)).toBeNull();
  });

  it("returns the last path segment for a normal cwd", () => {
    expect(extractRepoFromCwd("/home/user/my-repo")).toBe("my-repo");
  });

  it("trims trailing slashes before extracting the last segment", () => {
    expect(extractRepoFromCwd("/home/user/my-repo/")).toBe("my-repo");
  });
});

// ---------------------------------------------------------------------------
// extractPrReferences — lines 358-409
// ---------------------------------------------------------------------------

describe("extractPrReferences — non-object input early return (Branch 64[0])", () => {
  it("returns [] immediately when input is null", () => {
    expect(extractPrReferences("Bash", null)).toEqual([]);
  });

  it("returns [] immediately when input is a string", () => {
    expect(extractPrReferences("Bash", "git push")).toEqual([]);
  });

  it("returns [] immediately when input is a number", () => {
    expect(extractPrReferences("Bash", 42)).toEqual([]);
  });
});

describe("extractPrReferences — non-PR non-Bash tool (Branch 65[1] FALSE path)", () => {
  it("returns [] for a Read tool with no PR URL text", () => {
    expect(extractPrReferences("Read", { path: "/home/user/file.ts" })).toEqual(
      []
    );
  });

  it("extracts PR URLs from text fields of a non-PR tool", () => {
    const input = {
      content:
        "See https://github.com/closedloop-ai/symphony/pull/42 for context",
    };
    const refs = extractPrReferences("Read", input);
    expect(refs).toHaveLength(1);
    expect(refs[0].number).toBe("42");
    expect(refs[0].repo).toBe("closedloop-ai/symphony");
    expect(refs[0].url).toBe(
      "https://github.com/closedloop-ai/symphony/pull/42"
    );
  });
});

describe("extractPrReferences — FIXTURE_OWNER_RE skip (Branch 57[0])", () => {
  it("skips a PR URL whose owner matches a fixture pattern ('acme')", () => {
    const input = {
      body: "See https://github.com/acme/myrepo/pull/1 for details",
    };
    expect(extractPrReferences("Read", input)).toEqual([]);
  });

  it("skips 'owner' and 'example' owners but keeps real owners", () => {
    const input = {
      body: [
        "https://github.com/owner/repo/pull/1",
        "https://github.com/example/repo/pull/2",
        "https://github.com/closedloop-ai/symphony/pull/99",
      ].join("\n"),
    };
    const refs = extractPrReferences("Read", input);
    expect(refs).toHaveLength(1);
    expect(refs[0].number).toBe("99");
  });
});

describe("extractPrReferences — duplicate URL deduplication (Branch 60[0], Branch 61[0])", () => {
  it("deduplicates the same PR URL appearing twice within a single text (Branch 60[0])", () => {
    // The URL appears twice in the same body field — extractPrUrlsFromText uses
    // a local `seen` set so the second match fires Branch 60[0] (seen.has(url) → continue)
    const url = "https://github.com/closedloop-ai/symphony/pull/42";
    const input = { body: `${url} and again ${url}` };
    const refs = extractPrReferences("Read", input);
    expect(refs).toHaveLength(1);
    expect(refs[0].number).toBe("42");
  });

  it("deduplicates the same PR URL appearing in input and output (Branch 61[0])", () => {
    const url = "https://github.com/closedloop-ai/symphony/pull/42";
    const input = { body: url };
    const output = { result: url };
    const refs = extractPrReferences("Bash", input, output);
    // Both input and output mention the same URL → only one ref
    expect(refs).toHaveLength(1);
    expect(refs[0].number).toBe("42");
  });

  it("keeps distinct PR URLs from different repos", () => {
    const input = {
      body: [
        "https://github.com/closedloop-ai/symphony/pull/1",
        "https://github.com/closedloop-ai/api/pull/2",
      ].join(" "),
    };
    const refs = extractPrReferences("Read", input);
    expect(refs).toHaveLength(2);
  });
});

describe("extractPrReferences — PR tool pending path (Branch 65[0])", () => {
  it("emits a pending ref when a PR tool has no URL in its input/output", () => {
    const refs = extractPrReferences("create_pull_request", {
      repo: "closedloop-ai/symphony",
      title: "My PR",
    });
    expect(refs).toHaveLength(1);
    expect(refs[0].number).toBe("pending");
    expect(refs[0].repo).toBe("closedloop-ai/symphony");
  });

  it("emits a pending ref with undefined repo when repo field is absent (Branch 66[1])", () => {
    const refs = extractPrReferences("create_pull_request", { title: "PR" });
    expect(refs).toHaveLength(1);
    expect(refs[0].number).toBe("pending");
    expect(refs[0].repo).toBeUndefined();
  });

  it("does NOT emit a pending ref when PR tool already extracted a URL (Branch 70 short-circuit)", () => {
    // refs.length > 0 → return early without pushing a pending entry
    const url = "https://github.com/closedloop-ai/symphony/pull/5";
    const refs = extractPrReferences("create_pull_request", { body: url });
    expect(refs).toHaveLength(1);
    expect(refs[0].url).toBe(url);
    // Ensure no pending ref was also added
    expect(refs.every((r) => r.number !== "pending")).toBe(true);
  });
});

describe("extractPrReferences — Bash gh pr create (Branch 71[0])", () => {
  it("emits a pending ref for a Bash 'gh pr create' command with no URL", () => {
    const refs = extractPrReferences("Bash", {
      command: "gh pr create --title 'My PR' --body 'Details'",
    });
    expect(refs).toHaveLength(1);
    expect(refs[0].number).toBe("pending");
    expect(refs[0].repo).toBeUndefined();
  });

  it("does NOT add a pending ref when the Bash command already has a URL (Branch 72[1] false path)", () => {
    // refs.length > 0 prevents the pending ref
    const url = "https://github.com/closedloop-ai/symphony/pull/10";
    const refs = extractPrReferences(
      "Bash",
      { command: "gh pr create --title x" },
      { result: url }
    );
    // The URL from output is captured; no extra pending entry
    expect(refs.some((r) => r.url === url)).toBe(true);
    expect(refs.filter((r) => r.number === "pending")).toHaveLength(0);
  });

  it("does NOT add a pending ref for a plain Bash command with no gh pr create", () => {
    const refs = extractPrReferences("Bash", {
      command: "git push origin main",
    });
    expect(refs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractIssueReferences — lines 421-471
// ---------------------------------------------------------------------------

describe("extractIssueReferences — non-object input early return", () => {
  it("returns [] for null input", () => {
    expect(extractIssueReferences("Bash", null)).toEqual([]);
  });

  it("returns [] for string input", () => {
    expect(extractIssueReferences("Bash", "ISS-123")).toEqual([]);
  });
});

describe("extractIssueReferences — issue tool patterns (Branch 76[0])", () => {
  it("extracts issue_id from a linear get_issue call (Branch 77[0])", () => {
    const refs = extractIssueReferences("linear.get_issue", {
      issue_id: "ISS-123",
    });
    expect(refs).toHaveLength(1);
    expect(refs[0].key).toBe("ISS-123");
  });

  it("falls through to issueId when issue_id is absent (Branch 77[1] → Branch 78[0])", () => {
    const refs = extractIssueReferences("mcp__linear-server__get_issue", {
      issueId: "FEA-456",
    });
    expect(refs).toHaveLength(1);
    expect(refs[0].key).toBe("FEA-456");
  });

  it("returns null key when neither issue_id nor issueId is present (Branch 78[1])", () => {
    // No key to push, but text fields might still match below
    const refs = extractIssueReferences("linear.get_issue", {});
    expect(refs).toEqual([]);
  });

  it("deduplicates a key found in both issue_id and a text field (Branch 79[1])", () => {
    // issue_id gives "ISS-789", command also mentions "ISS-789"
    const refs = extractIssueReferences("linear.get_issue", {
      issue_id: "ISS-789",
      command: "Working on ISS-789",
    });
    // ISS-789 appears twice but is deduped — exactly one entry
    expect(refs.filter((r) => r.key === "ISS-789")).toHaveLength(1);
  });
});

describe("extractIssueReferences — text field parsing (Branch 82[0], 83[0])", () => {
  it("extracts JIRA-style issue keys (e.g. ISS-123) from the command field", () => {
    const refs = extractIssueReferences("Bash", {
      command: "fix ISS-100 and ISS-200",
    });
    expect(refs.map((r) => r.key)).toEqual(["ISS-100", "ISS-200"]);
  });

  it("skips non-string fields (Branch 82[0] TRUE — continue)", () => {
    const refs = extractIssueReferences("Bash", {
      command: 42, // non-string → skip
      query: "see ISS-555",
    });
    expect(refs.map((r) => r.key)).toEqual(["ISS-555"]);
  });

  it("extracts hash-style issue references (#123) from a text field (Branch 83[0])", () => {
    const refs = extractIssueReferences("Bash", {
      command: "fix #42 and #99",
    });
    expect(refs.map((r) => r.key)).toContain("#42");
    expect(refs.map((r) => r.key)).toContain("#99");
  });

  it("skips a duplicate #N hash reference in the same field (Branch 83[1])", () => {
    // "#42" appears twice in command — first occurrence adds it, second triggers
    // Branch 83[1]: seen.has(k) is TRUE → skip (implicit else)
    const refs = extractIssueReferences("Bash", {
      command: "fix #42 and also #42",
    });
    expect(refs.filter((r) => r.key === "#42")).toHaveLength(1);
  });

  it("does not double-count an issue key in multiple text fields", () => {
    // ISS-100 appears in both command and body
    const refs = extractIssueReferences("Bash", {
      command: "work on ISS-100",
      body: "addresses ISS-100",
    });
    expect(refs.filter((r) => r.key === "ISS-100")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// collectArtifacts — lines 485-512
// ---------------------------------------------------------------------------

describe("collectArtifacts — PR deduplication and key computation", () => {
  it("uses pr.url as the dedup key when present (Branch 84[0])", () => {
    const toolUses = [
      {
        name: "Bash",
        input: {
          command: "gh pr create --title x",
          body: "https://github.com/closedloop-ai/symphony/pull/5",
        },
        output: "https://github.com/closedloop-ai/symphony/pull/5",
      },
    ];
    const result = collectArtifacts(toolUses, "/workspace/symphony");
    // Same URL from input and output → deduplicated to one entry
    expect(result.prs).toHaveLength(1);
    expect(result.prs[0].url).toBe(
      "https://github.com/closedloop-ai/symphony/pull/5"
    );
  });

  it("uses repo+number as the dedup key when url is absent (Branch 84[1])", () => {
    // create_pull_request with a repo but no URL in text → pending ref, url=undefined
    const toolUses = [
      {
        name: "create_pull_request",
        input: { repo: "closedloop-ai/symphony", title: "My PR" },
      },
    ];
    const result = collectArtifacts(toolUses, "/workspace/symphony");
    expect(result.prs).toHaveLength(1);
    expect(result.prs[0].number).toBe("pending");
    expect(result.prs[0].repo).toBe("closedloop-ai/symphony");
  });

  it("uses empty-string repo prefix when repo is undefined (Branch 85[1])", () => {
    // create_pull_request with NO repo → pending ref with undefined repo
    // dedup key = ":pending"
    const toolUses = [
      { name: "create_pull_request", input: { title: "No-repo PR" } },
      { name: "create_pull_request", input: { title: "Also no-repo PR" } },
    ];
    const result = collectArtifacts(toolUses, null);
    // Both produce the same ":pending" key → deduplicated to one entry (Branch 86[1])
    expect(result.prs).toHaveLength(1);
  });

  it("deduplicates PR refs across multiple tool uses (Branch 86[1])", () => {
    const url = "https://github.com/closedloop-ai/symphony/pull/42";
    const toolUses = [
      { name: "Read", input: { body: url } },
      { name: "Write", input: { content: url } },
    ];
    const result = collectArtifacts(toolUses, "/workspace");
    expect(result.prs).toHaveLength(1);
  });
});

describe("collectArtifacts — issue deduplication (Branch 87[0], 87[1])", () => {
  it("collects issue references from multiple tool uses (Branch 87[0])", () => {
    const toolUses = [{ name: "Bash", input: { command: "work on ISS-100" } }];
    const result = collectArtifacts(toolUses, "/workspace/proj");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].key).toBe("ISS-100");
  });

  it("deduplicates the same issue key across tool uses (Branch 87[1])", () => {
    const toolUses = [
      { name: "Bash", input: { command: "fix ISS-100" } },
      { name: "Bash", input: { command: "continue ISS-100" } },
    ];
    const result = collectArtifacts(toolUses, "/workspace");
    expect(result.issues.filter((i) => i.key === "ISS-100")).toHaveLength(1);
  });
});

describe("collectArtifacts — repo extraction", () => {
  it("extracts repo from cwd last segment", () => {
    const result = collectArtifacts([], "/home/user/my-project");
    expect(result.repo).toBe("my-project");
  });

  it("returns null repo for null cwd", () => {
    const result = collectArtifacts([], null);
    expect(result.repo).toBeNull();
  });

  it("returns all three fields in the artifacts structure", () => {
    const result = collectArtifacts([], "/workspace/proj");
    expect(result).toHaveProperty("prs");
    expect(result).toHaveProperty("issues");
    expect(result).toHaveProperty("repo");
    expect(Array.isArray(result.prs)).toBe(true);
    expect(Array.isArray(result.issues)).toBe(true);
  });
});
