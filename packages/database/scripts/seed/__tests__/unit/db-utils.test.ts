/**
 * Unit tests for matchesProductionHostPattern (db-utils.ts)
 *
 * Matching is a plain substring check against PRODUCTION_HOST_PATTERNS
 * (fail-closed: over-reject rather than under-reject). Covers:
 *   - Known production hostnames returning the matched pattern string
 *   - Local / safe hostnames returning null
 *   - DATABASE_URL-only detection (via extracted hostname)
 *   - Production-shaped hosts where the pattern is a leading segment or an
 *     embedded substring (regression coverage for over-narrow matching)
 *   - Edge cases: empty string, bare pattern words, malformed host-like strings
 */

import { describe, expect, it } from "vitest";
import {
  matchesProductionHostPattern,
  PRODUCTION_HOST_PATTERNS,
} from "../../../db-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simulates the DATABASE_URL guard path: extract hostname from a URL string
 * then pass it to matchesProductionHostPattern, matching what seed.ts does via
 * `new URL(databaseUrl).hostname`.
 */
function matchesDatabaseUrl(rawUrl: string): string | null {
  const url = new URL(rawUrl);
  return matchesProductionHostPattern(url.hostname);
}

// ---------------------------------------------------------------------------
// 1. Known production hostnames
// ---------------------------------------------------------------------------

describe("matchesProductionHostPattern — production hostnames", () => {
  it("matches a cl-ai-prod hostname", () => {
    const result = matchesProductionHostPattern("db.cl-ai-prod");
    expect(result).toBe("cl-ai-prod");
  });

  it("matches a hostname that IS the bare cl-ai-prod pattern", () => {
    const result = matchesProductionHostPattern("cl-ai-prod");
    expect(result).toBe("cl-ai-prod");
  });

  it("matches a hostname ending with .cl-ai-prod as a segment", () => {
    const result = matchesProductionHostPattern("my-project.cl-ai-prod");
    expect(result).toBe("cl-ai-prod");
  });

  it("matches a hostname containing .cl-ai-prod. as a dot-delimited segment", () => {
    const result = matchesProductionHostPattern("shard.cl-ai-prod.db.example");
    expect(result).toBe("cl-ai-prod");
  });

  it("matches a hostname containing .prod. as a literal substring", () => {
    const result = matchesProductionHostPattern("db.prod.example.com");
    expect(result).toBe(".prod.");
  });

  it("matches a hostname containing 'production'", () => {
    const result = matchesProductionHostPattern("db.production");
    expect(result).toBe("production");
  });

  it("matches a hostname that IS 'production'", () => {
    const result = matchesProductionHostPattern("production");
    expect(result).toBe("production");
  });

  it("matches a hostname starting with prod- as a literal prefix pattern", () => {
    const result = matchesProductionHostPattern("prod-db.internal.example.com");
    expect(result).toBe("prod-");
  });

  it("matches prod-replica style hostnames", () => {
    const result = matchesProductionHostPattern("prod-replica.db.example.com");
    expect(result).toBe("prod-");
  });

  it("returns the first matched pattern when multiple patterns would match", () => {
    // A hostname with both cl-ai-prod (first in list) and .prod. should return cl-ai-prod
    const result = matchesProductionHostPattern("db.prod.cl-ai-prod");
    // cl-ai-prod is at index 0 in PRODUCTION_HOST_PATTERNS, so it wins
    expect(result).toBe("cl-ai-prod");
  });

  it("covers all patterns defined in PRODUCTION_HOST_PATTERNS", () => {
    // Assert every pattern in the constant can actually trigger a match
    const hostPerPattern: Record<string, string> = {
      "cl-ai-prod": "db.cl-ai-prod",
      ".prod.": "host.prod.example.com",
      production: "db.production",
      "prod-": "prod-db.example.com",
    };

    for (const pattern of PRODUCTION_HOST_PATTERNS) {
      const host = hostPerPattern[pattern];
      expect(
        host,
        `No test hostname defined for pattern "${pattern}"`
      ).toBeDefined();
      expect(matchesProductionHostPattern(host)).toBe(pattern);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Local / safe hostnames → null
// ---------------------------------------------------------------------------

describe("matchesProductionHostPattern — local / safe hostnames", () => {
  it("returns null for 'localhost'", () => {
    expect(matchesProductionHostPattern("localhost")).toBeNull();
  });

  it("returns null for '127.0.0.1'", () => {
    expect(matchesProductionHostPattern("127.0.0.1")).toBeNull();
  });

  it("returns null for '::1'", () => {
    expect(matchesProductionHostPattern("::1")).toBeNull();
  });

  it("returns null for a staging hostname that does not match any pattern", () => {
    expect(matchesProductionHostPattern("staging-db.example.com")).toBeNull();
  });

  it("returns null for a dev hostname", () => {
    expect(matchesProductionHostPattern("dev-db.internal")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Regression: fail-closed substring matching must catch production-shaped
// hosts where the pattern is a leading segment or an embedded substring. An
// earlier segment-aware refactor narrowed the denylist and let these through.
// ---------------------------------------------------------------------------

describe("matchesProductionHostPattern — fail-closed over-rejection", () => {
  it("matches a leading-segment production host (production.rds.amazonaws.com)", () => {
    expect(matchesProductionHostPattern("production.rds.amazonaws.com")).toBe(
      "production"
    );
  });

  it("matches a leading-segment cl-ai-prod host (cl-ai-prod.eu.rds.amazonaws.com)", () => {
    expect(
      matchesProductionHostPattern("cl-ai-prod.eu.rds.amazonaws.com")
    ).toBe("cl-ai-prod");
  });

  it("matches an embedded 'production' substring (cl-ai-production-db.aws.com)", () => {
    // Contains both 'cl-ai-prod' and 'production'; 'cl-ai-prod' is first in the list.
    expect(matchesProductionHostPattern("cl-ai-production-db.aws.com")).toBe(
      "cl-ai-prod"
    );
  });

  it("matches 'production' as a hyphenated infix (myproduction-test.db)", () => {
    expect(matchesProductionHostPattern("myproduction-test.db")).toBe(
      "production"
    );
  });
});

// ---------------------------------------------------------------------------
// 3. DATABASE_URL-only detection
// ---------------------------------------------------------------------------

describe("matchesProductionHostPattern — DATABASE_URL hostname extraction", () => {
  it("detects a production host extracted from a DATABASE_URL", () => {
    const result = matchesDatabaseUrl(
      "postgresql://user:pass@db.cl-ai-prod:5432/mydb"
    );
    expect(result).toBe("cl-ai-prod");
  });

  it("detects .prod. in a DATABASE_URL hostname", () => {
    const result = matchesDatabaseUrl(
      "postgresql://user:pass@host.prod.example.com:5432/mydb"
    );
    expect(result).toBe(".prod.");
  });

  it("returns null for a localhost DATABASE_URL", () => {
    const result = matchesDatabaseUrl(
      "postgresql://user:pass@localhost:5432/mydb"
    );
    expect(result).toBeNull();
  });

  it("returns null for a 127.0.0.1 DATABASE_URL", () => {
    const result = matchesDatabaseUrl(
      "postgresql://user:pass@127.0.0.1:5432/mydb"
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Edge cases
// ---------------------------------------------------------------------------

describe("matchesProductionHostPattern — edge cases", () => {
  it("returns null for an empty string", () => {
    expect(matchesProductionHostPattern("")).toBeNull();
  });

  it("returns null for a single dot", () => {
    expect(matchesProductionHostPattern(".")).toBeNull();
  });

  it("returns null for a hostname with numeric segments only", () => {
    expect(matchesProductionHostPattern("10.0.0.1")).toBeNull();
  });

  it("matches uppercase production hostnames case-insensitively", () => {
    expect(matchesProductionHostPattern("PRODUCTION")).toBe("production");
    expect(matchesProductionHostPattern("DB.PROD.EXAMPLE.COM")).toBe(".prod.");
  });

  it("does not match 'prod' without a dash suffix or dot prefix when it's an infix", () => {
    // 'myproddb' contains 'prod' but not 'prod-' or '.prod.'
    expect(matchesProductionHostPattern("myproddb.example.com")).toBeNull();
  });

  it("matches a very long production hostname that ends with .cl-ai-prod", () => {
    const hostname = "a.b.c.d.e.f.g.cl-ai-prod";
    expect(matchesProductionHostPattern(hostname)).toBe("cl-ai-prod");
  });
});
