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

import tls from "node:tls";
import {
  DbHealthAuthMode,
  DbHealthCheckStatus,
  DbHealthHostType,
  DbHealthSource,
  DbHealthSslMode,
  DbHealthTransportError,
} from "@repo/api/src/types/db-health";
import { describe, expect, it } from "vitest";
import {
  classifyDatabaseTransport,
  matchesProductionHostPattern,
  PRODUCTION_HOST_PATTERNS,
  resolveSslOption,
} from "../../../db-utils";
import { AWS_RDS_CA_BUNDLE } from "../../../rds-ca-bundle";

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

// ---------------------------------------------------------------------------
// 5. resolveSslOption — SSL verification policy
//
// This is the shared SSOT used by the seed scripts AND the runtime pool's
// IAM/production path (packages/database/index.ts getPool). The production
// path passes { isLocalhost: false, sslmode: null } and must default to
// verified TLS so short-lived IAM tokens and queries can't be MITM'd; the
// ALLOW_INSECURE_SSL escape hatch (allowInsecure: true) restores the legacy
// unverified behavior for endpoints whose RDS CA chain isn't yet trusted.
// ---------------------------------------------------------------------------

describe("resolveSslOption — verification policy", () => {
  it("disables TLS for localhost regardless of other options", () => {
    expect(
      resolveSslOption({
        isLocalhost: true,
        sslmode: null,
        allowInsecure: true,
      })
    ).toBe(false);
  });

  it("disables TLS for sslmode=disable", () => {
    expect(
      resolveSslOption({
        isLocalhost: false,
        sslmode: "disable",
        allowInsecure: false,
      })
    ).toBe(false);
  });

  it("verifies the server cert by default on the IAM/production path", () => {
    // Mirrors getPool's IAM branch: non-localhost, no sslmode, not opted out.
    const ssl = resolveSslOption({
      isLocalhost: false,
      sslmode: null,
      allowInsecure: false,
    });
    expect(ssl).not.toBe(false);
    if (ssl === false) {
      throw new Error("expected verifying SSL option");
    }
    expect(ssl.rejectUnauthorized).toBe(true);
    // Trust anchors must include the RDS CA bundle (absent from some runtimes'
    // default store — the prod-down cause) AND the system roots (so publicly
    // trusted hosts like Neon still verify). `ca` REPLACES the default store,
    // so both must be present in the union.
    expect(Array.isArray(ssl.ca)).toBe(true);
    expect(ssl.ca).toContain(AWS_RDS_CA_BUNDLE);
    for (const root of tls.rootCertificates) {
      expect(ssl.ca).toContain(root);
    }
  });

  it("opts into unverified TLS only when allowInsecure is set (ALLOW_INSECURE_SSL=1)", () => {
    expect(
      resolveSslOption({
        isLocalhost: false,
        sslmode: null,
        allowInsecure: true,
      })
    ).toEqual({ rejectUnauthorized: false });
  });
});

describe("classifyDatabaseTransport — runtime health posture", () => {
  it("classifies DATABASE_URL RDS verified TLS as healthy", () => {
    expect(
      classifyDatabaseTransport({
        databaseUrl:
          "postgresql://user:pass@stage-db.abc123.us-east-1.rds.amazonaws.com:5432/app",
      })
    ).toMatchObject({
      status: DbHealthCheckStatus.Ok,
      hostType: DbHealthHostType.Rds,
      sslMode: DbHealthSslMode.Verified,
      authMode: DbHealthAuthMode.Password,
      source: DbHealthSource.DatabaseUrl,
      verifiedRdsTls: true,
    });
  });

  it("classifies DATABASE_URL localhost as disabled TLS and not RDS", () => {
    expect(
      classifyDatabaseTransport({
        databaseUrl: "postgresql://user:pass@localhost:5432/app",
      })
    ).toMatchObject({
      status: DbHealthCheckStatus.Error,
      hostType: DbHealthHostType.Localhost,
      sslMode: DbHealthSslMode.Disabled,
      error: DbHealthTransportError.TlsDisabled,
      verifiedRdsTls: false,
    });
  });

  it("classifies DATABASE_URL sslmode=disable as disabled TLS", () => {
    expect(
      classifyDatabaseTransport({
        databaseUrl:
          "postgresql://user:pass@stage-db.abc123.us-east-1.rds.amazonaws.com:5432/app?sslmode=disable",
      })
    ).toMatchObject({
      status: DbHealthCheckStatus.Error,
      hostType: DbHealthHostType.Rds,
      sslMode: DbHealthSslMode.Disabled,
      error: DbHealthTransportError.TlsDisabled,
      verifiedRdsTls: false,
    });
  });

  it("classifies DATABASE_URL ALLOW_INSECURE_SSL as insecure TLS", () => {
    expect(
      classifyDatabaseTransport({
        databaseUrl:
          "postgresql://user:pass@stage-db.abc123.us-east-1.rds.amazonaws.com:5432/app",
        allowInsecureSsl: true,
      })
    ).toMatchObject({
      status: DbHealthCheckStatus.Error,
      hostType: DbHealthHostType.Rds,
      sslMode: DbHealthSslMode.Insecure,
      error: DbHealthTransportError.TlsInsecure,
      verifiedRdsTls: false,
    });
  });

  it("classifies PGHOST/IAM RDS verified TLS as healthy", () => {
    expect(
      classifyDatabaseTransport({
        pgHost: "stage-db.abc123.us-east-1.rds.amazonaws.com",
        pgDatabase: "app",
        pgUser: "app_user",
      })
    ).toMatchObject({
      status: DbHealthCheckStatus.Ok,
      hostType: DbHealthHostType.Rds,
      sslMode: DbHealthSslMode.Verified,
      authMode: DbHealthAuthMode.Iam,
      source: DbHealthSource.PgHostIam,
      verifiedRdsTls: true,
    });
  });

  it("classifies PGHOST/IAM ALLOW_INSECURE_SSL as insecure TLS", () => {
    expect(
      classifyDatabaseTransport({
        pgHost: "stage-db.abc123.us-east-1.rds.amazonaws.com",
        pgDatabase: "app",
        pgUser: "app_user",
        allowInsecureSsl: true,
      })
    ).toMatchObject({
      status: DbHealthCheckStatus.Error,
      hostType: DbHealthHostType.Rds,
      sslMode: DbHealthSslMode.Insecure,
      error: DbHealthTransportError.TlsInsecure,
      verifiedRdsTls: false,
    });
  });

  it("classifies PGHOST/IAM localhost as disabled TLS", () => {
    expect(
      classifyDatabaseTransport({
        pgHost: "localhost",
        pgDatabase: "app",
        pgUser: "app_user",
        allowInsecureSsl: true,
      })
    ).toMatchObject({
      status: DbHealthCheckStatus.Error,
      hostType: DbHealthHostType.Localhost,
      sslMode: DbHealthSslMode.Disabled,
      error: DbHealthTransportError.TlsDisabled,
      verifiedRdsTls: false,
    });
  });

  it("classifies bracketed IPv6 PGHOST/IAM localhost as localhost", () => {
    expect(
      classifyDatabaseTransport({
        pgHost: "[::1]",
        pgDatabase: "app",
        pgUser: "app_user",
      })
    ).toMatchObject({
      status: DbHealthCheckStatus.Error,
      hostType: DbHealthHostType.Localhost,
      sslMode: DbHealthSslMode.Disabled,
      error: DbHealthTransportError.TlsDisabled,
      verifiedRdsTls: false,
    });
  });

  it("classifies PGHOST/IAM non-RDS as not RDS", () => {
    expect(
      classifyDatabaseTransport({
        pgHost: "db.example.com",
        pgDatabase: "app",
        pgUser: "app_user",
      })
    ).toMatchObject({
      status: DbHealthCheckStatus.Error,
      hostType: DbHealthHostType.Other,
      sslMode: DbHealthSslMode.Verified,
      error: DbHealthTransportError.NotRds,
      verifiedRdsTls: false,
    });
  });

  it("classifies missing or invalid runtime DB inputs as unknown posture", () => {
    for (const input of [
      {},
      { databaseUrl: "not a url" },
      { pgHost: "stage-db.abc123.us-east-1.rds.amazonaws.com" },
    ]) {
      expect(classifyDatabaseTransport(input)).toMatchObject({
        status: DbHealthCheckStatus.Error,
        hostType: DbHealthHostType.Unknown,
        sslMode: DbHealthSslMode.Unknown,
        authMode: DbHealthAuthMode.Unknown,
        source: DbHealthSource.Unknown,
        error: DbHealthTransportError.UnknownPosture,
        verifiedRdsTls: false,
      });
    }
  });
});
