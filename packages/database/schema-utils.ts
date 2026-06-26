import { createHash } from "node:crypto";

const NON_ALPHANUMERIC_CHARS = /[^a-z0-9_]+/g;
const LEADING_TRAILING_UNDERSCORES = /^_+|_+$/g;
const NON_IDENTIFIER_CHARS = /[^a-z0-9_]/;
const LEADING_DIGIT = /^[0-9]/;

type SchemaEnv = {
  pgSchema?: string | null | undefined;
  vercelEnv?: string | null | undefined;
  vercelGitCommitRef?: string | null | undefined;
};

export function resolveSchemaName(env: SchemaEnv): string | null {
  if (env.pgSchema) {
    const normalized = normalizeExplicitSchemaName(env.pgSchema);
    return normalized.length > 0 ? normalized : null;
  }
  const isPreview = env.vercelEnv === "preview";
  if (isPreview && env.vercelGitCommitRef) {
    return normalizePreviewSchemaName(env.vercelGitCommitRef);
  }
  return null;
}

export function addSchemaToUrl(databaseUrl: string, schema: string | null) {
  if (!schema) {
    return databaseUrl;
  }
  const url = new URL(databaseUrl);
  if (!url.searchParams.has("schema")) {
    url.searchParams.set("schema", schema);
  }
  return url.toString();
}

export function normalizeExplicitSchemaName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_CHARS, "_")
    .replace(LEADING_TRAILING_UNDERSCORES, "")
    .slice(0, 63);
}

export function normalizePreviewSchemaName(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_CHARS, "_")
    .replace(LEADING_TRAILING_UNDERSCORES, "");
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  const prefix = "preview_";
  const maxBaseLength = 63 - prefix.length - 1 - hash.length;
  const trimmed = base.slice(0, Math.max(1, maxBaseLength));
  return `${prefix}${trimmed}_${hash}`;
}

/**
 * Formats a schema name for use in a PostgreSQL `search_path` (e.g.
 * `options: -c search_path=<formatSearchPath(schema)>`). Quotes the identifier
 * when it contains non-identifier characters or a leading digit, escaping any
 * embedded double quotes. Canonical home for the helper shared by the runtime
 * Prisma client (`index.ts`) and the seed script.
 */
export function formatSearchPath(schema: string): string {
  const escaped = schema.replace(/"/g, '""');
  const needsQuotes =
    NON_IDENTIFIER_CHARS.test(schema) || LEADING_DIGIT.test(schema);
  return needsQuotes ? `"${escaped}"` : schema;
}
