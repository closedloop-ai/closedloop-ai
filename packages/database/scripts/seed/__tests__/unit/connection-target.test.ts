import { describe, expect, it } from "vitest";
import { resolveSeedConnectionTarget } from "../../connection-target";

/**
 * Resolution of the schema a seed run writes into.
 *
 * Extracted from `createSeedPrisma` in `scripts/seed.ts` for exactly this
 * reason — inline, it could only be exercised by constructing a real pg Pool
 * and PrismaClient, so its most important branch had no coverage at all.
 *
 * That branch is the empty-schema fall-through. A DSN carrying a blank or
 * all-separator `?schema=` normalizes to `""`, and the resolver uses `||` (not
 * `??`) so that empty result falls through to the environment. Treating `""` as
 * resolved would leave `targetSchema` empty — disabling both the `search_path`
 * and the schema guard, and routing every seed write into `public`.
 */

const DSN = "postgresql://user:pass@localhost:5432/db";
const url = (suffix = "") => new URL(`${DSN}${suffix}`);

describe("resolveSeedConnectionTarget — DSN schema", () => {
  it("takes an explicit ?schema= and quotes it for search_path", () => {
    const result = resolveSeedConnectionTarget(url("?schema=my_schema"), {});

    expect(result.targetSchema).toBe("my_schema");
    expect(result.searchPath).toBe("my_schema");
  });

  it("normalizes the DSN schema the same way PGSCHEMA is", () => {
    // A mixed-case or special-character value must not produce a quoted
    // search_path identifier that mismatches the lowercased schema — that
    // mismatch is a false-positive abort in the schema guard.
    const result = resolveSeedConnectionTarget(url("?schema=My-Schema"), {});

    expect(result.targetSchema).toBe("my_schema");
    expect(result.searchPath).toBe("my_schema");
  });

  it("quotes a normalized name that still needs it", () => {
    const result = resolveSeedConnectionTarget(url("?schema=9lives"), {});

    expect(result.targetSchema).toBe("9lives");
    // Leading digit — unquoted this is not a legal Postgres identifier.
    expect(result.searchPath).toBe('"9lives"');
  });
});

describe("resolveSeedConnectionTarget — the empty-schema fall-through", () => {
  it("falls through to PGSCHEMA when the DSN schema normalizes to nothing", () => {
    // "---" is all separators. `??` here would have returned "" and sent the
    // seed into `public` with the guard disabled.
    const result = resolveSeedConnectionTarget(url("?schema=---"), {
      pgSchema: "from_env",
    });

    expect(result.targetSchema).toBe("from_env");
  });

  it("falls through on a blank ?schema=", () => {
    const result = resolveSeedConnectionTarget(url("?schema="), {
      pgSchema: "from_env",
    });

    expect(result.targetSchema).toBe("from_env");
  });

  it("yields null — not an empty string — when nothing resolves", () => {
    const result = resolveSeedConnectionTarget(url("?schema=---"), {});

    expect(result.targetSchema).toBeNull();
    expect(result.searchPath).toBeNull();
  });
});

describe("resolveSeedConnectionTarget — environment fallback", () => {
  it("uses PGSCHEMA when the DSN carries no schema", () => {
    const result = resolveSeedConnectionTarget(url(), { pgSchema: "env_one" });

    expect(result.targetSchema).toBe("env_one");
  });

  it("derives a preview schema from the branch ref", () => {
    const result = resolveSeedConnectionTarget(url(), {
      vercelEnv: "preview",
      vercelGitCommitRef: "feat/x",
    });

    expect(result.targetSchema).toContain("preview_");
  });

  it("lets the DSN schema win over the environment", () => {
    const result = resolveSeedConnectionTarget(url("?schema=explicit"), {
      pgSchema: "from_env",
    });

    expect(result.targetSchema).toBe("explicit");
  });

  it("returns null when neither the DSN nor the environment names one", () => {
    const result = resolveSeedConnectionTarget(url(), {});

    expect(result.targetSchema).toBeNull();
    expect(result.searchPath).toBeNull();
  });
});

describe("resolveSeedConnectionTarget — sslmode and URL stripping", () => {
  it("returns the DSN's sslmode", () => {
    expect(
      resolveSeedConnectionTarget(url("?sslmode=disable"), {}).sslmode
    ).toBe("disable");
  });

  it("returns null when the DSN carries no sslmode", () => {
    expect(resolveSeedConnectionTarget(url(), {}).sslmode).toBeNull();
  });

  it("STRIPS both params from the url it is given", () => {
    // Both are re-applied through explicit pool config; leaving them on the
    // connection string conflicts with the driver adapter.
    const target = url("?sslmode=require&schema=my_schema");

    resolveSeedConnectionTarget(target, {});

    expect(target.searchParams.has("sslmode")).toBe(false);
    expect(target.searchParams.has("schema")).toBe(false);
  });

  it("leaves unrelated query parameters alone", () => {
    const target = url(
      "?sslmode=require&application_name=seed&connect_timeout=5"
    );

    resolveSeedConnectionTarget(target, {});

    expect(target.searchParams.get("application_name")).toBe("seed");
    expect(target.searchParams.get("connect_timeout")).toBe("5");
  });

  it("reads sslmode BEFORE stripping it", () => {
    // Order matters: deleting first would always report null.
    const target = url("?sslmode=verify-full");

    expect(resolveSeedConnectionTarget(target, {}).sslmode).toBe("verify-full");
    expect(target.searchParams.has("sslmode")).toBe(false);
  });
});
