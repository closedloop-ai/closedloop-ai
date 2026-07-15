/**
 * Content-addressed identity for an agentic component.
 *
 * A component's UUID is derived from `source + owner + normalized(content)`, so
 * the same file (from the same origin) resolves to the same id regardless of
 * where it was authored/imported (manual, zip, repo). This is the dedup key for
 * authoring/import and the source-agnostic join key between the desktop's local
 * components and the cloud's org-wide analytics.
 *
 * Client-safe: `uuid`'s v5 is a pure-JS SHA-1 namespace UUID (no Node crypto),
 * so this resolves in the browser, the desktop renderer, and the server alike.
 */

import { v5 as uuidv5 } from "uuid";

/**
 * Fixed namespace for component identities (a constant, not generated). Changing
 * it re-keys every component id, so it must stay stable.
 */
const COMPONENT_NAMESPACE = "6f2a1e34-9c8b-4d7e-a1f0-3b5c7d9e0011";

const WHITESPACE_RE = /\s+/g;

/** Lowercase, trim, and strip ALL whitespace — the canonical content form. */
export function normalizeComponentContent(content: string): string {
  return content.toLowerCase().trim().replace(WHITESPACE_RE, "");
}

export type ComponentIdentityInput = {
  /** Provenance of the component (repo full name, marketplace, or ""). */
  source: string;
  /** Owning scope (organization id, or publisher). */
  owner: string;
  /** Raw `.md` / config file contents. */
  content: string;
};

/**
 * Compute the deterministic content-addressed UUID for an agentic component.
 * Whitespace/case differences in `content` do not change the id.
 */
export function computeComponentUuid(input: ComponentIdentityInput): string {
  // Newline delimiter: absent from repo/org identifiers and from the
  // whitespace-stripped content, so the fields can't ambiguously run together.
  const name = [
    input.source.trim().toLowerCase(),
    input.owner.trim().toLowerCase(),
    normalizeComponentContent(input.content),
  ].join("\n");
  return uuidv5(name, COMPONENT_NAMESPACE);
}
