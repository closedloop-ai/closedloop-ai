import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  HEALTH_CHECK_REPAIR_OPERATION_ID,
  HEALTH_CHECK_REPAIR_PATH,
} from "@repo/api/src/types/compute-target";
import {
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GITHUB_RESYNC_NUDGE_PATH,
} from "@repo/api/src/types/github-dirty-scope";
import {
  MEMBER_PACK_INSTALL_OPERATION_ID,
  MEMBER_PACK_INSTALL_PATH,
} from "@repo/api/src/types/member-pack-install";
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

  it("maps the System Check Repair path to its own operation id", () => {
    // Repair MUTATES the machine, so it must not resolve to the read-only
    // health_check id; leaving it unmapped made relay delivery fail the
    // operation id / path check (ISS-5389 review).
    expect(EXACT_OPERATION_IDS[HEALTH_CHECK_REPAIR_PATH]).toBe(
      HEALTH_CHECK_REPAIR_OPERATION_ID
    );
    expect(resolveOperationId(HEALTH_CHECK_REPAIR_PATH)).toBe(
      HEALTH_CHECK_REPAIR_OPERATION_ID
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

  it("maps Branch View local gateway routes before the generic git prefix", () => {
    expect(EXACT_OPERATION_IDS["/api/gateway/git/local-changes"]).toBe(
      "git_local_changes"
    );
    expect(EXACT_OPERATION_IDS["/api/gateway/git/local-changes/diff"]).toBe(
      "git_local_changes"
    );
    expect(
      EXACT_OPERATION_IDS["/api/gateway/git/local-changes/commit-push"]
    ).toBe("git_local_commit_push");
  });

  it("contains only string values", () => {
    for (const value of Object.values(EXACT_OPERATION_IDS)) {
      expect(typeof value).toBe("string");
    }
  });
});

describe("PREFIX_OPERATION_IDS", () => {
  // ISS-8049 removed the BARE `/api/gateway/git` prefix this case used to assert.
  // It was a defect, not a shape: "github" startsWith "git", so the bare prefix
  // silently rewrote the GitHub resync nudge to `git_action` and every desktop
  // rejected the nudge as unroutable. The bare path moved to EXACT_OPERATION_IDS
  // and the prefix grew the trailing slash that makes it stop matching `github`.
  it("maps the /api/gateway/git/ prefix to git_action without capturing github", () => {
    const entry = PREFIX_OPERATION_IDS.find(
      ([prefix]) => prefix === "/api/gateway/git/"
    );
    expect(entry).toBeDefined();
    expect(entry?.[1]).toBe("git_action");

    // The bare path still resolves — it is exact now, not a prefix.
    expect(resolveOperationId("/api/gateway/git")).toBe("git_action");
    expect(resolveOperationId("/api/gateway/git/status")).toBe("git_action");

    // The regression itself. A desktop on either side of this fix routes on the
    // operationId it is handed, so a nudge rewritten to `git_action` is dropped
    // by every build; this is the assertion that keeps the trailing slash.
    expect(resolveOperationId(GITHUB_RESYNC_NUDGE_PATH)).toBe(
      GITHUB_RESYNC_NUDGE_OPERATION_ID
    );
  });

  it("resolves Branch View local routes as exact matches", () => {
    expect(resolveOperationId("/api/gateway/git/local-changes")).toBe(
      "git_local_changes"
    );
    expect(resolveOperationId("/api/gateway/git/local-changes/diff")).toBe(
      "git_local_changes"
    );
    expect(
      resolveOperationId("/api/gateway/git/local-changes/commit-push")
    ).toBe("git_local_commit_push");
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

  it("returns null for /api/engineer/health-check (legacy namespace intentionally dropped)", () => {
    expect(resolveOperationId("/api/engineer/health-check")).toBeNull();
  });

  it("resolves exact match: /api/gateway/health-check → health_check", () => {
    expect(resolveOperationId("/api/gateway/health-check")).toBe(
      "health_check"
    );
  });

  it("resolves exact match: /api/gateway/repos → repos_config", () => {
    expect(resolveOperationId("/api/gateway/repos")).toBe("repos_config");
  });

  it("resolves the member pack-install path so it stays in sync with Electron (FEA-4082)", () => {
    expect(resolveOperationId(MEMBER_PACK_INSTALL_PATH)).toBe(
      MEMBER_PACK_INSTALL_OPERATION_ID
    );
    expect(EXACT_OPERATION_IDS[MEMBER_PACK_INSTALL_PATH]).toBe(
      MEMBER_PACK_INSTALL_OPERATION_ID
    );
  });

  it("resolves prefix match: /api/gateway/git/pr/123 → git_pr", () => {
    expect(resolveOperationId("/api/gateway/git/pr/123")).toBe("git_pr");
  });

  it("resolves prefix match: /api/gateway/git/commit → git_action (less-specific git prefix)", () => {
    expect(resolveOperationId("/api/gateway/git/commit")).toBe("git_action");
  });

  // ISS-12435: Loops retired the Symphony launch, loop, status, chat, plan,
  // judges, logs and sessions routes, codex review, deploy and their filesystem
  // helpers on Desktop, so the wire table no longer names them.
  it("resolves the retired Symphony, codex and deploy gateway paths to null", () => {
    for (const retiredPath of [
      "/api/gateway/symphony/launch",
      "/api/gateway/symphony/loop",
      "/api/gateway/symphony/loop/kill",
      "/api/gateway/symphony/plan-loop/ticket-abc",
      "/api/gateway/symphony/status/run-abc-123",
      "/api/gateway/symphony/chat/run-abc-123",
      "/api/gateway/codex/some-id",
      "/api/gateway/deploy",
      "/api/gateway/work-directory/ticket-abc",
    ]) {
      expect(resolveOperationId(retiredPath)).toBeNull();
    }
  });

  it("returns null for unknown /api/gateway/ subpath", () => {
    expect(resolveOperationId("/api/gateway/unknown-operation")).toBeNull();
  });

  // Regression: these routes were served by deleted Next.js handlers and
  // need to remain routable through CloudRelay via the wire table so
  // apps/api can dispatch them to the desktop gateway.
  it("resolves /api/gateway/version → health_check (replaces deleted apps/app handler)", () => {
    expect(resolveOperationId("/api/gateway/version")).toBe("health_check");
  });

  // ISS-12735: the learnings routes were deleted from Desktop, so the wire
  // table no longer names them.
  it("resolves the retired learnings gateway paths to null", () => {
    for (const retiredPath of [
      "/api/gateway/learnings",
      "/api/gateway/symphony/extract-learnings",
      "/api/gateway/symphony/process-learnings",
      "/api/gateway/symphony/process-all-learnings",
      "/api/gateway/symphony/pending-learnings",
      "/api/gateway/symphony/learnings-status/ticket-abc",
      "/api/gateway/symphony/record-learning-use",
    ]) {
      expect(resolveOperationId(retiredPath)).toBeNull();
    }
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
      // biome-ignore lint/suspicious/noMisplacedAssertion: assertion is inside this it.skipIf(...) test callback; Biome doesn't recognize the it.skipIf(cond)(name, fn) call shape as a test block
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
      // biome-ignore lint/suspicious/noMisplacedAssertion: assertion is inside this it.skipIf(...) test callback; Biome doesn't recognize the it.skipIf(cond)(name, fn) call shape as a test block
      expect(
        missingPrefix,
        `Electron source is missing prefix operation IDs: ${missingPrefix.join(", ")}`
      ).toEqual([]);
    }
  );
});
