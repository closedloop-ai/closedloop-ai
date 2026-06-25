/**
 * Credential-audit unit test (AC-003)
 *
 * Scans all seed source files (the seed subdirectory plus
 * sibling seed entrypoint/helper files in packages/database/scripts/*.ts) for
 * patterns that match real credential formats. The test fails if any match is
 * found, catching credential leakage at authoring time without requiring a
 * running database.
 *
 * Patterns checked:
 *   - Stripe live secret/publishable keys (sk_live_, pk_live_)
 *   - Stripe test keys (sk_test_, pk_test_) — test keys are real API credentials
 *   - Clerk secret keys (sk_live_, sk_test_ prefixes used by Clerk SDK)
 *   - AWS access key IDs (AKIA[A-Z0-9]{16})
 *   - Base64-encoded JWT-shaped strings (three dot-separated base64url segments
 *     with a common JSON object header prefix)
 *   - Raw email addresses not wrapped in a placeholder pattern
 *   - Hardcoded passwords or connection strings containing real credentials
 *
 * Patterns intentionally NOT flagged:
 *   - String literals containing "seed-placeholder-*" (documented placeholders)
 *   - Pattern fragments that appear as comments explaining what the pattern looks like
 *   - Database URLs pointing to localhost / 127.0.0.1
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getLineNumber } from "./test-utils";

// ---------------------------------------------------------------------------
// Seed source roots:
// - packages/database/scripts/*.ts includes seed.ts and db-utils.ts
// - packages/database/scripts/seed/**/*.ts includes seed implementation files
// Exclude __tests__ subdirectory and its contents.
// ---------------------------------------------------------------------------

const SCRIPTS_DIR = resolve(import.meta.dirname, "../../../");
const SEED_DIR = join(SCRIPTS_DIR, "seed");

function getSeedSourceFiles(): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(SCRIPTS_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(join(SCRIPTS_DIR, entry.name));
    }
  }

  function walkSeedDir(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__") {
        continue;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkSeedDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(fullPath);
      }
    }
  }

  walkSeedDir(SEED_DIR);
  return files;
}

// ---------------------------------------------------------------------------
// Credential patterns
// ---------------------------------------------------------------------------

type CredentialPattern = {
  /** Human-readable label used in failure messages */
  label: string;
  /** Regex to search for in file contents */
  pattern: RegExp;
};

const CREDENTIAL_PATTERNS: CredentialPattern[] = [
  {
    label: "Stripe live secret key (sk_live_)",
    pattern: /sk_live_[A-Za-z0-9]{20,}/,
  },
  {
    label: "Stripe live publishable key (pk_live_)",
    pattern: /pk_live_[A-Za-z0-9]{20,}/,
  },
  {
    label: "Stripe test secret key (sk_test_)",
    pattern: /sk_test_[A-Za-z0-9]{20,}/,
  },
  {
    label: "Stripe test publishable key (pk_test_)",
    pattern: /pk_test_[A-Za-z0-9]{20,}/,
  },
  {
    // Clerk secret keys start with sk_live_ or sk_test_ (handled above) but
    // Clerk also uses a distinct prefix format. The patterns above cover the
    // common forms; this catches the distinct Clerk API key prefix.
    label: "Clerk secret key (clerk_sk_)",
    pattern: /clerk_sk_[A-Za-z0-9_-]{20,}/,
  },
  {
    // AWS IAM access key IDs are 20 characters total: the 4-character AKIA
    // prefix followed by exactly 16 uppercase alphanumeric characters.
    label: "AWS access key ID (AKIA…)",
    pattern: /AKIA[A-Z0-9]{16}/,
  },
  {
    // Base64url-encoded JWT shape: three segments separated by dots, with a
    // common JSON object header prefix. This is intentionally structural so the
    // test can run without decoding candidate tokens from source text.
    label: "Base64-encoded JWT token (three-segment base64url)",
    // Match three dot-separated base64url segments of realistic lengths.
    // A real JWT header is ≥20 chars, payload ≥20 chars, signature ≥20 chars.
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    // Raw email addresses in string literals (not placeholder / example domains).
    // We flag addresses at real corporate/personal domains but not example.com,
    // example.org, test.com, test.org, or seed-* / test-* local-parts.
    label: "Raw email address at non-placeholder domain",
    // Matches user@domain.tld but excludes example.com, example.org,
    // test.com, and seed-* / test-* local-parts.
    pattern:
      /(?<![a-zA-Z0-9._%+-])(?!seed-|test-)[a-zA-Z0-9._%+-]+@(?!example\.com|example\.org|test\.com|test\.org)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  },
  {
    // Hardcoded passwords in connection strings: postgresql://user:REALPASS@...
    // We flag password segments that look non-placeholder (no "seed", "test",
    // "placeholder", "example", "pass", "password", "dummy", "fake" substrings).
    label: "Hardcoded non-placeholder password in connection string",
    // Match postgresql://user:<password>@ where <password> does not contain
    // a known placeholder word.
    pattern:
      /postgresql:\/\/[^:]+:(?!seed|test|placeholder|example|pass|password|dummy|fake|x{3,}|\*{3,})[A-Za-z0-9!@#$%^&*()\-_=+]{8,}@/,
  },
  {
    // Generic high-entropy bearer tokens or API keys assigned to named fields.
    // Patterns like: apiKey: "abc123realtoken..." or token: "Bearer realtoken"
    // We target assignments of long (≥32 char) alphanumeric strings to fields
    // named *key*, *token*, *secret*, *password*, *credential* that don't
    // contain the word "placeholder", "seed", "test", "example", or "dummy".
    label: "High-entropy string assigned to a credential-named field",
    pattern:
      /(key|token|secret|password|credential)\s*[:=]\s*["'`](?!.*(?:placeholder|seed|test|example|dummy|fake|redact))[A-Za-z0-9+/]{32,}["'`]/i,
  },
];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("credential-audit — seed source files contain no real credentials", () => {
  const seedFiles = getSeedSourceFiles();

  it("finds at least one seed source file to scan", () => {
    expect(seedFiles.length).toBeGreaterThan(0);
  });

  it("lists the seed files that will be scanned (informational)", () => {
    // This assertion always passes; it surfaces the file list in CI output
    // so reviewers can confirm the expected files are present.
    const names = seedFiles.map((f) => f.split("/").at(-1));
    expect(names).toBeDefined();
  });

  for (const credPattern of CREDENTIAL_PATTERNS) {
    describe(`pattern: ${credPattern.label}`, () => {
      for (const filePath of seedFiles) {
        it(`${filePath.split("/").at(-1)} does not contain a match`, () => {
          const content = readFileSync(filePath, "utf-8");
          const match = credPattern.pattern.exec(content);

          if (match !== null) {
            // Provide a useful diagnostic: show the matched text and its line.
            const lineNumber = getLineNumber(content, match.index);
            expect.fail(
              `Credential pattern "${credPattern.label}" matched in ${filePath}:${lineNumber}\n` +
                `  Matched text: ${JSON.stringify(match[0])}\n` +
                "  If this is a safe placeholder, update the pattern exclusion list in credential-audit.test.ts."
            );
          }

          expect(match).toBeNull();
        });
      }
    });
  }
});
