import { env } from "@/env";
import type { DocsCorpus } from "./docs-corpus";
import { readDocsCorpus, resolveDocsRoot } from "./docs-corpus";

let cached: DocsCorpus | null = null;

/**
 * Where a generated reference page sends the reader, resolved from THIS
 * deployment's own env for the same reason the route resolves `docsSiteUrl` for
 * the surface: a hardcoded host would send a stage reader to production docs.
 */
function docsSiteUrl(): string {
  return env.NEXT_PUBLIC_DOCS_URL ?? `${env.NEXT_PUBLIC_WEB_URL}/docs`;
}

/**
 * ISS-10006 — the corpus is immutable for the life of a deployment (it ships
 * with the build), so it is parsed once per server process rather than per
 * request. Deliberately NOT memoized across a failure: a throw leaves `cached`
 * null so the next request retries instead of pinning a transient fs error for
 * the lifetime of the lambda.
 */
export function docsCorpus(): DocsCorpus {
  if (cached === null) {
    cached = readDocsCorpus(resolveDocsRoot(), docsSiteUrl());
  }
  return cached;
}
