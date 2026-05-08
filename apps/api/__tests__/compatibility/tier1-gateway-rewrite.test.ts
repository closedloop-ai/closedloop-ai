import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXACT_OPERATION_IDS,
  PREFIX_OPERATION_IDS,
  resolveOperationId,
} from "@/lib/desktop-gateway-wire";

describe("EXACT_OPERATION_IDS", () => {
  it("maps /api/gateway/health-check to health_check", () => {
    expect(EXACT_OPERATION_IDS["/api/gateway/health-check"]).toBe(
      "health_check"
    );
  });

  it("maps /api/gateway/symphony/launch to symphony_launch", () => {
    expect(EXACT_OPERATION_IDS["/api/gateway/symphony/launch"]).toBe(
      "symphony_launch"
    );
  });

  it("maps /api/gateway/symphony/kill to symphony_kill", () => {
    expect(EXACT_OPERATION_IDS["/api/gateway/symphony/kill"]).toBe(
      "symphony_kill"
    );
  });

  it("maps /api/gateway/symphony/loop to symphony_loop", () => {
    expect(EXACT_OPERATION_IDS["/api/gateway/symphony/loop"]).toBe(
      "symphony_loop"
    );
  });

  it("maps /api/gateway/repos to repos_config", () => {
    expect(EXACT_OPERATION_IDS["/api/gateway/repos"]).toBe("repos_config");
  });

  it("maps /api/gateway/directories to filesystem", () => {
    expect(EXACT_OPERATION_IDS["/api/gateway/directories"]).toBe("filesystem");
  });

  it("maps /api/gateway/git/branch-worktree to git_branch_worktree", () => {
    expect(EXACT_OPERATION_IDS["/api/gateway/git/branch-worktree"]).toBe(
      "git_branch_worktree"
    );
  });

  it("contains only string values", () => {
    for (const value of Object.values(EXACT_OPERATION_IDS)) {
      expect(typeof value).toBe("string");
    }
  });
});

describe("PREFIX_OPERATION_IDS", () => {
  it("maps /api/gateway/symphony/status/ prefix to symphony_status", () => {
    const entry = PREFIX_OPERATION_IDS.find(
      ([prefix]) => prefix === "/api/gateway/symphony/status/"
    );
    expect(entry).toBeDefined();
    expect(entry?.[1]).toBe("symphony_status");
  });

  it("maps /api/gateway/symphony/chat/ prefix to symphony_chat", () => {
    const entry = PREFIX_OPERATION_IDS.find(
      ([prefix]) => prefix === "/api/gateway/symphony/chat/"
    );
    expect(entry).toBeDefined();
    expect(entry?.[1]).toBe("symphony_chat");
  });

  it("maps /api/gateway/codex/ prefix to codex_review", () => {
    const entry = PREFIX_OPERATION_IDS.find(
      ([prefix]) => prefix === "/api/gateway/codex/"
    );
    expect(entry).toBeDefined();
    expect(entry?.[1]).toBe("codex_review");
  });

  it("maps /api/gateway/git prefix to git_action (less-specific git prefix)", () => {
    const entry = PREFIX_OPERATION_IDS.find(
      ([prefix]) => prefix === "/api/gateway/git"
    );
    expect(entry).toBeDefined();
    expect(entry?.[1]).toBe("git_action");
  });

  it("orders /api/gateway/codex/argue/ before /api/gateway/codex/ (more-specific first)", () => {
    const argueIndex = PREFIX_OPERATION_IDS.findIndex(
      ([prefix]) => prefix === "/api/gateway/codex/argue/"
    );
    const reviewIndex = PREFIX_OPERATION_IDS.findIndex(
      ([prefix]) => prefix === "/api/gateway/codex/"
    );
    expect(argueIndex).toBeGreaterThanOrEqual(0);
    expect(reviewIndex).toBeGreaterThanOrEqual(0);
    expect(argueIndex).toBeLessThan(reviewIndex);
  });

  it("contains only string tuple pairs", () => {
    for (const entry of PREFIX_OPERATION_IDS) {
      expect(Array.isArray(entry)).toBe(true);
      expect(entry).toHaveLength(2);
      expect(typeof entry[0]).toBe("string");
      expect(typeof entry[1]).toBe("string");
    }
  });
});

describe("resolveOperationId", () => {
  it("returns null for paths that do not start with /api/gateway/", () => {
    expect(resolveOperationId("/api/artifacts/123")).toBeNull();
    expect(resolveOperationId("/health")).toBeNull();
    expect(resolveOperationId("")).toBeNull();
  });

  it("resolves exact match: /api/gateway/health-check → health_check", () => {
    expect(resolveOperationId("/api/gateway/health-check")).toBe(
      "health_check"
    );
  });

  it("resolves exact match: /api/engineer/health-check → health_check", () => {
    expect(resolveOperationId("/api/engineer/health-check")).toBe(
      "health_check"
    );
  });

  it("resolves exact match: /api/gateway/symphony/launch → symphony_launch", () => {
    expect(resolveOperationId("/api/gateway/symphony/launch")).toBe(
      "symphony_launch"
    );
  });

  it("resolves exact match: /api/gateway/repos → repos_config", () => {
    expect(resolveOperationId("/api/gateway/repos")).toBe("repos_config");
  });

  it("resolves prefix match: /api/gateway/symphony/status/<id> → symphony_status", () => {
    expect(resolveOperationId("/api/gateway/symphony/status/run-abc-123")).toBe(
      "symphony_status"
    );
  });

  it("resolves prefix match: /api/gateway/symphony/chat/<id> → symphony_chat", () => {
    expect(resolveOperationId("/api/gateway/symphony/chat/run-abc-123")).toBe(
      "symphony_chat"
    );
  });

  it("resolves prefix match: /api/engineer/symphony/chat/<id> → symphony_chat", () => {
    expect(resolveOperationId("/api/engineer/symphony/chat/run-abc-123")).toBe(
      "symphony_chat"
    );
  });

  it("resolves prefix match: /api/gateway/codex/argue/<id> → codex_argue", () => {
    expect(resolveOperationId("/api/gateway/codex/argue/some-id")).toBe(
      "codex_argue"
    );
  });

  it("resolves prefix match: /api/gateway/codex/<id> → codex_review (not codex_argue)", () => {
    expect(resolveOperationId("/api/gateway/codex/some-id")).toBe(
      "codex_review"
    );
  });

  it("resolves prefix match: /api/gateway/git/pr/123 → git_pr", () => {
    expect(resolveOperationId("/api/gateway/git/pr/123")).toBe("git_pr");
  });

  it("resolves prefix match: /api/gateway/git/commit → git_action (less-specific git prefix)", () => {
    expect(resolveOperationId("/api/gateway/git/commit")).toBe("git_action");
  });

  it("returns null for unknown /api/gateway/ subpath", () => {
    expect(resolveOperationId("/api/gateway/unknown-operation")).toBeNull();
  });

  it("exact match takes precedence over prefix match for /api/gateway/symphony/loop", () => {
    expect(resolveOperationId("/api/gateway/symphony/loop")).toBe(
      "symphony_loop"
    );
  });

  // Regression: these routes were served by deleted Next.js handlers and
  // need to remain routable through CloudRelay via the wire table so
  // apps/api can dispatch them to the desktop gateway.
  it("resolves /api/gateway/version → health_check (replaces deleted apps/app handler)", () => {
    expect(resolveOperationId("/api/gateway/version")).toBe("health_check");
  });

  it("resolves /api/gateway/work-directory/<ticketId> → filesystem", () => {
    expect(resolveOperationId("/api/gateway/work-directory/ticket-abc")).toBe(
      "filesystem"
    );
  });

  it("resolves /api/gateway/symphony/upload/<ticketId> → filesystem", () => {
    expect(resolveOperationId("/api/gateway/symphony/upload/ticket-abc")).toBe(
      "filesystem"
    );
  });

  it("resolves /api/gateway/symphony/attachments/<ticketId>/... → filesystem", () => {
    expect(
      resolveOperationId("/api/gateway/symphony/attachments/ticket-abc/foo.png")
    ).toBe("filesystem");
  });

  it("resolves /api/gateway/symphony/learnings-status/<ticketId> → learnings", () => {
    expect(
      resolveOperationId("/api/gateway/symphony/learnings-status/ticket-abc")
    ).toBe("learnings");
  });

  it("resolves /api/gateway/symphony/record-learning-use → learnings", () => {
    expect(
      resolveOperationId("/api/gateway/symphony/record-learning-use")
    ).toBe("learnings");
  });

  it("resolves /api/gateway/symphony/sessions/unread-count → symphony_sessions", () => {
    expect(
      resolveOperationId("/api/gateway/symphony/sessions/unread-count")
    ).toBe("symphony_sessions");
  });

  it("resolves bare /api/gateway/symphony/status (without ticket id) → symphony_status", () => {
    expect(resolveOperationId("/api/gateway/symphony/status")).toBe(
      "symphony_status"
    );
  });
});

const electronCheckoutDir =
  process.env.ELECTRON_CHECKOUT_PATH ??
  path.resolve(process.cwd(), "electron-checkout");
const electronCheckoutExists = existsSync(electronCheckoutDir);

/**
 * Recursively find all `.ts` files under a directory, returning absolute paths.
 */
function findTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      results.push(...findTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Extract operation ID string literals from electron source files.
 * Looks for quoted strings that match known operation ID patterns
 * (snake_case identifiers used in the desktop gateway protocol).
 */
function extractOperationIdsFromElectron(dir: string): Set<string> {
  const ids = new Set<string>();
  const allExactIds = Object.values(EXACT_OPERATION_IDS);
  const allPrefixIds = PREFIX_OPERATION_IDS.map(([, id]) => id);
  const knownIds = new Set([...allExactIds, ...allPrefixIds]);

  for (const filePath of findTsFiles(dir)) {
    const content = readFileSync(filePath, "utf8");
    // Match quoted strings that look like operation IDs (snake_case).
    const regex = /["']([a-z][a-z0-9]*(?:_[a-z0-9]+)*)["']/g;
    for (
      let match = regex.exec(content);
      match !== null;
      match = regex.exec(content)
    ) {
      if (knownIds.has(match[1])) {
        ids.add(match[1]);
      }
    }
  }
  return ids;
}

describe("electron-checkout directory guard", () => {
  it.skipIf(!electronCheckoutExists)(
    "electron source references all EXACT_OPERATION_IDS values",
    () => {
      const electronIds = extractOperationIdsFromElectron(electronCheckoutDir);
      const missingExact: string[] = [];
      for (const opId of Object.values(EXACT_OPERATION_IDS)) {
        if (!electronIds.has(opId)) {
          missingExact.push(opId);
        }
      }
      expect(
        missingExact,
        `Electron source is missing exact operation IDs: ${missingExact.join(", ")}`
      ).toEqual([]);
    }
  );

  it.skipIf(!electronCheckoutExists)(
    "electron source references all PREFIX_OPERATION_IDS values",
    () => {
      const electronIds = extractOperationIdsFromElectron(electronCheckoutDir);
      const uniquePrefixIds = [
        ...new Set(PREFIX_OPERATION_IDS.map(([, id]) => id)),
      ];
      const missingPrefix: string[] = [];
      for (const opId of uniquePrefixIds) {
        if (!electronIds.has(opId)) {
          missingPrefix.push(opId);
        }
      }
      expect(
        missingPrefix,
        `Electron source is missing prefix operation IDs: ${missingPrefix.join(", ")}`
      ).toEqual([]);
    }
  );
});
