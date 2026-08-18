import { describe, expect, it } from "vitest";
import {
  addSchemaToUrl,
  formatSearchPath,
  normalizeExplicitSchemaName,
  normalizePreviewSchemaName,
  resolveSchemaName,
} from "./schema-utils";

/**
 * These five helpers decide which Postgres schema a deployment talks to, and
 * how that schema name is interpolated into a `search_path`. Both matter beyond
 * tidiness: the resolver is what keeps one preview branch out of another's data,
 * and `formatSearchPath` is the only quoting between a branch-derived name and a
 * `-c search_path=` connection option.
 *
 * The module had no test file at all before this.
 */

const PG_IDENT_MAX = 63;
const PREVIEW_PREFIX = /^preview_/;
const PREVIEW_FEAT_BRANCH = /^preview_feat_my_branch_[0-9a-f]{8}$/;

describe("resolveSchemaName", () => {
  it("prefers an explicit PGSCHEMA over anything else", () => {
    expect(
      resolveSchemaName({
        pgSchema: "My-Schema",
        vercelEnv: "preview",
        vercelGitCommitRef: "feat/x",
      })
    ).toBe("my_schema");
  });

  it("falls through to null when an explicit schema normalizes to nothing", () => {
    // "---" is all separators; normalizing strips it to "". Returning that
    // would point the client at a schema named empty string.
    expect(resolveSchemaName({ pgSchema: "---" })).toBeNull();
  });

  it("derives a preview schema from the branch ref", () => {
    const name = resolveSchemaName({
      vercelEnv: "preview",
      vercelGitCommitRef: "feat/my-branch",
    });

    expect(name).toMatch(PREVIEW_PREFIX);
    expect(name).toContain("feat_my_branch");
  });

  it("returns null outside preview, even with a branch ref", () => {
    expect(
      resolveSchemaName({
        vercelEnv: "production",
        vercelGitCommitRef: "main",
      })
    ).toBeNull();
  });

  it("returns null in preview with no branch ref", () => {
    expect(resolveSchemaName({ vercelEnv: "preview" })).toBeNull();
  });

  it("returns null for an empty environment", () => {
    expect(resolveSchemaName({})).toBeNull();
    expect(resolveSchemaName({ pgSchema: null, vercelEnv: null })).toBeNull();
  });
});

describe("addSchemaToUrl", () => {
  const url = "postgresql://user:pass@host:5432/db";

  it("returns the url untouched when there is no schema", () => {
    expect(addSchemaToUrl(url, null)).toBe(url);
  });

  it("appends the schema as a query parameter", () => {
    expect(addSchemaToUrl(url, "preview_x")).toContain("schema=preview_x");
  });

  it("does NOT overwrite a schema the url already carries", () => {
    // An explicit schema in the connection string is the operator's choice and
    // outranks the derived one.
    const withSchema = `${url}?schema=explicit`;

    expect(addSchemaToUrl(withSchema, "derived")).toContain("schema=explicit");
    expect(addSchemaToUrl(withSchema, "derived")).not.toContain("derived");
  });

  it("preserves other query parameters", () => {
    const result = addSchemaToUrl(`${url}?sslmode=require`, "preview_x");

    expect(result).toContain("sslmode=require");
    expect(result).toContain("schema=preview_x");
  });
});

describe("normalizeExplicitSchemaName", () => {
  it("lowercases and collapses runs of separators to one underscore", () => {
    expect(normalizeExplicitSchemaName("My--Weird..Name")).toBe(
      "my_weird_name"
    );
  });

  it("strips leading and trailing underscores", () => {
    expect(normalizeExplicitSchemaName("__edge__")).toBe("edge");
  });

  it("caps at the Postgres identifier limit", () => {
    expect(normalizeExplicitSchemaName("a".repeat(200))).toHaveLength(
      PG_IDENT_MAX
    );
  });

  it("returns an empty string when nothing survives normalization", () => {
    expect(normalizeExplicitSchemaName("///")).toBe("");
  });
});

describe("normalizePreviewSchemaName", () => {
  it("prefixes, slugifies, and appends a stable hash", () => {
    const name = normalizePreviewSchemaName("feat/My-Branch");

    expect(name).toMatch(PREVIEW_FEAT_BRANCH);
  });

  it("is deterministic for the same ref", () => {
    expect(normalizePreviewSchemaName("feat/x")).toBe(
      normalizePreviewSchemaName("feat/x")
    );
  });

  it("distinguishes refs that slugify identically", () => {
    // "feat/x" and "feat-x" both slugify to "feat_x"; the hash is what stops
    // two branches sharing one preview schema.
    expect(normalizePreviewSchemaName("feat/x")).not.toBe(
      normalizePreviewSchemaName("feat-x")
    );
  });

  it("stays within the Postgres identifier limit for a very long ref", () => {
    const name = normalizePreviewSchemaName(`feat/${"a".repeat(300)}`);

    expect(name.length).toBeLessThanOrEqual(PG_IDENT_MAX);
    expect(name).toMatch(PREVIEW_PREFIX);
  });

  it("still produces a usable name when the slug would be empty", () => {
    // The Math.max(1, …) floor: a ref of pure separators leaves no base, and a
    // bare "preview__<hash>" must still be a valid identifier.
    const name = normalizePreviewSchemaName("///");

    expect(name).toMatch(PREVIEW_PREFIX);
    expect(name.length).toBeGreaterThan("preview_".length);
  });
});

describe("formatSearchPath", () => {
  it("leaves a plain identifier unquoted", () => {
    expect(formatSearchPath("public")).toBe("public");
    expect(formatSearchPath("preview_feat_x_1a2b3c4d")).toBe(
      "preview_feat_x_1a2b3c4d"
    );
  });

  it("quotes a name with non-identifier characters", () => {
    expect(formatSearchPath("has-dash")).toBe('"has-dash"');
    expect(formatSearchPath("has space")).toBe('"has space"');
  });

  it("quotes a name starting with a digit", () => {
    // Unquoted, `1schema` is not a legal Postgres identifier.
    expect(formatSearchPath("1schema")).toBe('"1schema"');
  });

  it("escapes embedded double quotes by doubling them", () => {
    // This is the interpolation boundary into `-c search_path=…`; a lone quote
    // would terminate the identifier early.
    expect(formatSearchPath('we"ird')).toBe('"we""ird"');
  });

  it("quotes and escapes a name that is only quotes", () => {
    expect(formatSearchPath('"')).toBe('""""');
  });
});
