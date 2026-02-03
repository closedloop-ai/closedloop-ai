import { createHash } from "node:crypto";

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

function normalizeExplicitSchemaName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 63);
}

function normalizePreviewSchemaName(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  const prefix = "preview_";
  const maxBaseLength = 63 - prefix.length - 1 - hash.length;
  const trimmed = base.slice(0, Math.max(1, maxBaseLength));
  return `${prefix}${trimmed}_${hash}`;
}
