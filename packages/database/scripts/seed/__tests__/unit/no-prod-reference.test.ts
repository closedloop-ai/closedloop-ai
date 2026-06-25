/**
 * No-prod-reference guard test (AC-007)
 *
 * Scans all Dockerfiles and CI workflow files in the repository and asserts
 * that none reference the dev-only seed script. This is a defense-in-depth
 * check: the seed script destroys/overwrites data and must never appear in a
 * production or deployment pipeline.
 *
 * Patterns checked (any occurrence fails the test):
 *   - "pnpm seed"      — direct script invocation via pnpm
 *   - "db:seed"        — npm/pnpm script alias
 *   - "seed.ts"        — direct ts-node / tsx invocation
 *   - "scripts/seed"   — executable command reference to the seed directory
 *                        or entry point. YAML path filters containing this
 *                        path are intentionally permitted.
 *
 * Files scanned:
 *   - All Dockerfile* files found recursively (excluding node_modules)
 *   - All .github/workflows/*.yml files
 */

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getLineNumber } from "./test-utils";

// ---------------------------------------------------------------------------
// Repo root and file discovery
// ---------------------------------------------------------------------------

// __dirname is packages/database/scripts/seed/__tests__/unit
// repo root is 6 levels up
const REPO_ROOT = resolve(import.meta.dirname, "../../../../../../");

// e2e/Dockerfile.db-tools is the containerized-E2E seed-runner image (FEA-2091):
// running the dev-only seed IS its purpose, so it deliberately references
// scripts/seed.ts. It is dev/test infrastructure brought up by e2e/compose.yml,
// never a production deploy image — this guard targets prod/deploy Dockerfiles,
// so the seed-runner is explicitly exempt.
const SEED_RUNNER_DOCKERFILE_ALLOWLIST = ["e2e/Dockerfile.db-tools"];

/**
 * Returns all Dockerfile paths found under the repo root, excluding
 * node_modules directories and the allowlisted E2E seed-runner image.
 */
function findDockerfiles(): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.startsWith("Dockerfile")) {
        results.push(fullPath);
      }
    }
  }

  walk(REPO_ROOT);
  return results.filter(
    (filePath) =>
      !SEED_RUNNER_DOCKERFILE_ALLOWLIST.some((allowed) =>
        filePath.endsWith(allowed)
      )
  );
}

/**
 * Returns all *.yml files under .github/workflows/ in the repo root.
 */
function findCiWorkflowFiles(): string[] {
  const workflowsDir = join(REPO_ROOT, ".github", "workflows");
  if (!existsSync(workflowsDir)) {
    return [];
  }
  const entries = readdirSync(workflowsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
    .map((entry) => join(workflowsDir, entry.name));
}

// ---------------------------------------------------------------------------
// Seed-reference patterns
// ---------------------------------------------------------------------------

type SeedPattern = {
  label: string;
  pattern: RegExp;
};

const SEED_PATTERNS: SeedPattern[] = [
  {
    label: "pnpm seed invocation",
    pattern: /pnpm\s+seed\b/,
  },
  {
    label: "db:seed script alias",
    pattern: /db:seed\b/,
  },
  {
    label: "seed.ts direct reference",
    pattern: /seed\.ts\b/,
  },
  {
    label: "scripts/seed executable command reference",
    pattern: /(?:pnpm|npm|node|tsx?|ts-node|bun|deno)[^\n]*scripts\/seed\b/,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertNoSeedReferences(
  suiteLabel: string,
  getFiles: () => string[],
  opts: { requireFiles: boolean } = { requireFiles: true }
): void {
  describe(suiteLabel, () => {
    const files = getFiles();

    it("resolves the file list to scan", () => {
      if (opts.requireFiles) {
        expect(files.length).toBeGreaterThan(0);
        return;
      }
      expect(files).toEqual(expect.any(Array));
    });

    for (const seedPattern of SEED_PATTERNS) {
      describe(`pattern: ${seedPattern.label}`, () => {
        for (const filePath of files) {
          it(`${filePath.replace(REPO_ROOT, "")} does not contain a match`, () => {
            const content = readFileSync(filePath, "utf-8");
            const match = seedPattern.pattern.exec(content);

            if (match !== null) {
              const lineNumber = getLineNumber(content, match.index);
              expect.fail(
                `Seed pattern "${seedPattern.label}" found in ${filePath}:${lineNumber}\n` +
                  `  Matched text: ${JSON.stringify(match[0])}\n` +
                  "  The seed script is dev-only and must not appear in Dockerfiles or CI workflows."
              );
            }

            expect(match).toBeNull();
          });
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

assertNoSeedReferences(
  "no-prod-reference — Dockerfiles contain no seed script references",
  findDockerfiles
);

assertNoSeedReferences(
  "no-prod-reference — CI workflow files contain no seed script references",
  findCiWorkflowFiles,
  { requireFiles: false }
);
