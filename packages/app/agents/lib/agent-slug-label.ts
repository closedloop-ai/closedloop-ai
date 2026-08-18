/**
 * Display-label helpers for an agent-component identity slug (FEA-3977/3978).
 *
 * The org-level identity slug is `${componentKind}::${normalizedKey}` (the SSOT
 * codec in `@repo/api/src/types/agent-component-analytics`). It is the detail
 * page's route param and the DTO's `slug`, and it is our internal identity — not
 * the human name the user clicked. These helpers render it for humans without
 * ever restating the name and without corrupting a key that legitimately
 * contains percent characters.
 */

import {
  decodeComponentHashKey,
  decodeComponentSlug,
} from "@repo/api/src/types/agent-component-analytics";
import { portableDefinitionPath } from "./portable-definition-path";

/**
 * FEA-4335: the neutral breadcrumb label for a content-hash detail route when no
 * resolved component name is available. A content-hash slug's `::`-suffix is a
 * 64-char SHA-256 digest, NOT a human name, so rendering it verbatim (as the
 * key-suffix fallback would) shows the user a meaningless hash. The page passes
 * the resolved `component.name` when it has one; absent that, this neutral label
 * is shown instead of the digest.
 */
const CONTENT_HASH_CRUMB_FALLBACK = "Agent";

/**
 * The human-facing breadcrumb label for an agent-component detail route.
 *
 * The last crumb must read like the name the user clicked, matching the
 * Sessions/Branches detail routes (which put the human name in that slot) — not
 * our internal `kind::key` identity. `Agents >` is already the context and the
 * kind is an eyebrow on the page, so the crumb shows just the identity `key`
 * (the `::`-suffix), falling back to the whole slug only when it has no `::`
 * separator. The identity `key` itself is returned raw (never
 * `decodeURIComponent`-ed) because a valid key can contain a literal `%` (e.g.
 * `load%20test`) that must not be mangled — only a slug whose whole `::`
 * separator arrived percent-encoded is repaired (see `normalizeAgentSlug`,
 * ISS-4776).
 *
 * FEA-4335: for a CONTENT-HASH route (`${kind}::${64-hex}`) the `::`-suffix is a
 * digest, not a name, so this returns a `resolvedName` when the caller has one
 * (the resolved component name), else a neutral fallback — never the raw hash. A
 * legacy name-level slug is unchanged (its suffix IS the human key).
 *
 * ISS-4776: a slug whose `::`/`/` arrived percent-ENCODED (e.g.
 * `command%3A%3A%2F%2Fcl-ci-babysit`, when a router hop double-encoded the
 * segment instead of leaving it decoded) has no literal `::`, so the identity
 * codec below would miss it and the crumb would leak the raw `%3A%3A%2F%2F`. We
 * repair that up front by decoding the whole slug once when it holds no literal
 * `::` but decodes to one — never touching a genuinely-`::`-bearing slug, so a
 * key with a legitimate literal `%` (e.g. `tool::load%20test`) still stays raw.
 */
export function agentBreadcrumbLabel(
  slug: string,
  resolvedName?: string | null
): string {
  const trimmedName = resolvedName?.trim();
  if (trimmedName) {
    return trimmedName;
  }
  const normalized = normalizeAgentSlug(slug);
  if (isContentHashSlug(normalized)) {
    return CONTENT_HASH_CRUMB_FALLBACK;
  }
  return decodeComponentSlug(normalized)?.key ?? normalized;
}

/**
 * Pick the detail-header subtitle so it never restates the title (FEA-3978).
 *
 * The header's title is the component's display `name`. The subtitle should add
 * something the title does not already say — the definition-file `path` first
 * (it's the most useful locator), and, when the path is absent or is itself just
 * the name repeated, the identity `key` (the `::`-suffix of the raw slug) as a
 * distinct fallback.
 *
 * Returns `null` when neither candidate adds information beyond the name, so the
 * header can drop the subtitle entirely rather than print the name twice.
 * Comparisons trim whitespace and ignore case so a padded or lowercased
 * duplicate (the orphan path sets `name = key`) still counts as identical.
 *
 * ISS-4805: the path candidate is rendered through
 * {@link portableDefinitionPath}, never raw. A definition path is captured on
 * the machine that discovered it, so it can be an absolute per-user path
 * (`/Users/<someone>/Code/proj/.claude/skills/foo/SKILL.md`). This catalog is
 * org-shared — every member viewing the component sees this header — so
 * publishing that verbatim leaked a teammate's username and their machine's
 * directory layout, and told the reader nothing they could act on. The helper
 * keeps the portable tail (`.claude/skills/foo/SKILL.md`), which is the same
 * anchor on every machine, so the location still renders. Only a path with no
 * portable part at all falls through to the identity key below.
 */
export function detailHeaderSubtitle(args: {
  name: string;
  path: string;
  slug: string;
  /**
   * ISS-5518 (flag `agents-detail-honesty`, default OFF): suppress the identity-
   * key fallback when that key is a content-hash DIGEST. `decodeComponentSlug`
   * hands back the raw `::`-suffix, and for a content-hash route that suffix is
   * 64 hex characters — so on the DEFAULT route shape (the service emits
   * `routableKey`, which carries a fingerprint for every row with a captured
   * definition) the path candidate losing meant publishing a SHA-256 under the
   * title. A digest is not a locator and not a name; it adds nothing the reader
   * can act on, which is the exact bar this helper's contract sets. With no
   * candidate left the header drops the subtitle entirely, as it already does
   * when the only candidate would restate the name.
   */
  honest?: boolean;
}): string | null {
  const name = args.name.trim();
  const path = portableDefinitionPath(args.path);
  if (path && !equalsNameFold(path, name)) {
    return path;
  }
  if (args.honest && isContentHashSlug(args.slug)) {
    return null;
  }
  const key = decodeComponentSlug(args.slug)?.key.trim() ?? "";
  if (key && !equalsNameFold(key, name)) {
    return key;
  }
  return null;
}

/** Case-insensitive equality used to decide whether a candidate restates the name. */
function equalsNameFold(candidate: string, name: string): boolean {
  return candidate.toLowerCase() === name.toLowerCase();
}

/**
 * ISS-4776: normalize an agent-component route param — return `slug` with a
 * percent-ENCODED `${kind}::${key}` identity decoded back to its literal form,
 * or `slug` unchanged otherwise.
 *
 * The detail page must normalize the route param ONCE at the boundary and key
 * the breadcrumb, the detail fetch, and the token-trend fetch off the same
 * value, or the crumb (which decodes) and the body (which fetches the raw param)
 * disagree: a double-encoded `command%3A%3A%2F%2Fcl-ci-babysit` would render
 * `//cl-ci-babysit` in the crumb above an `AgentDetailNotFound` body, because the
 * identity codec finds no literal `::` in the still-encoded slug and the API
 * lookup misses.
 *
 * A correctly-decoded route param already carries a literal `::`; those (and any
 * key with a legitimate literal `%`, which by construction also carries a literal
 * `::`) are returned untouched so a valid `%` is never mangled. Only a slug that
 * lacks a literal `::` yet whose `decodeURIComponent` form reveals one is
 * repaired — the mangled-encoding case where `%3A%3A`/`%2F` would otherwise leak
 * into the UI. A malformed percent sequence (`decodeURIComponent` throws) falls
 * back to the raw slug rather than crashing the page.
 */
export function normalizeAgentSlug(slug: string): string {
  if (slug.includes("::") || !slug.includes("%")) {
    return slug;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    return slug;
  }
  return decoded.includes("::") ? decoded : slug;
}

/**
 * ISS-5518: whether `slug`'s identity `key` is a content-hash DIGEST rather than
 * a human key.
 *
 * Shared by {@link agentBreadcrumbLabel} and {@link detailHeaderSubtitle} so the
 * two cannot rule differently on the same value — the defect this fixes was
 * exactly that split: on one screen the crumb refused to print the digest
 * (falling back to the neutral "Agent") while the subtitle printed all 64 hex
 * characters of it. One predicate means a change to what counts as a digest
 * moves both slots together.
 */
function isContentHashSlug(slug: string): boolean {
  return Boolean(decodeComponentHashKey(normalizeAgentSlug(slug))?.fingerprint);
}
