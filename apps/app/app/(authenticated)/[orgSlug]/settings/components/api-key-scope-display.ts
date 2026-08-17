import { API_KEY_SCOPES, ApiKeyScope } from "@repo/api/src/types/api-key";
import type { BadgeProps } from "@repo/design-system/components/ui/badge";
import { z } from "zod";

/**
 * ISS-4637: the honest set of privileges a key's scopes add up to, and the one
 * treatment for each.
 *
 * The Scope column used to derive two labels from
 * `scopes.includes("write") || scopes.includes("delete")`, which rendered a
 * `delete`-carrying key as "Read & Write" (never naming delete) and an
 * `admin`-carrying key as "Read only", the least-privileged label on the
 * most-privileged key. The invariant this module exists to hold: the label and
 * the scope set must agree — never naming a privilege the key does not carry,
 * and never omitting one it does.
 *
 * The vocabulary is a SET, not a hierarchy. `hasApiKeyScopes`
 * (`apps/api/lib/auth/api-key-scopes.ts`) requires exact membership for every
 * scope it checks, so a `["delete"]` key genuinely cannot read; a cumulative
 * "Read, write, delete" on that row would invent two capabilities. The label is
 * therefore built from the scopes actually held, in the contract's canonical
 * least-to-most-privileged order.
 */
export type ApiKeyScopeDisplay = {
  label: string;
  /**
   * The Badge variant when this row is worth stopping on, or `null` to render
   * the label as plain text alongside the Created and Last Used cells.
   *
   * Every key the API issues today carries read+write+delete, so a pill on the
   * routine ceilings would be the identical string repeated down every row —
   * decoration, not information. The pill is spent on the two states a reader
   * should actually look at, which makes the pill itself the signal.
   */
  variant: NonNullable<BadgeProps["variant"]> | null;
  /**
   * Explanation the label alone cannot carry. Rendered through the design-
   * system Tooltip on a focusable trigger with a visible affordance — not a
   * native `title`, which needs a mouse, waits about a second, never appears
   * for keyboard or touch, and gives no hint that there is more to read.
   */
  tooltip?: string;
};

/**
 * How each scope reads inside the comma list. Exhaustive over `ApiKeyScope` so
 * a scope added to the contract fails `tsc` here rather than rendering as an
 * unknown key.
 */
const API_KEY_SCOPE_WORDS: Record<ApiKeyScope, string> = {
  [ApiKeyScope.Read]: "read",
  [ApiKeyScope.Write]: "write",
  [ApiKeyScope.Delete]: "delete",
  [ApiKeyScope.Admin]: "admin",
};

const KNOWN_API_KEY_SCOPES: ReadonlySet<string> = new Set(API_KEY_SCOPES);

/**
 * The scope field as it actually arrives, not as the type claims. The
 * `/api-keys` read casts its parsed body to `ApiKey[]` without validating it
 * (`usePlatformApiKeys`), so a null, absent, or non-array `scopes` reaches this
 * module at runtime. Reading `.length` off that would throw inside render and
 * take the whole Settings panel down over one malformed row.
 */
const apiKeyScopesSchema = z.array(z.string());

/**
 * No truthful label can be stated: the key carries no scopes at all, carries a
 * scope this build does not recognize, or its `scopes` field did not arrive as
 * an array of strings at all. Deliberately NOT collapsed into "Read only" — an
 * empty scope array is not a read-only key (the MCP server treats a stored
 * empty array as full access), and an unrecognized or unreadable scope field
 * could outrank every scope we know.
 *
 * `warning` is the one something-is-off tone in this column, and it is spent
 * only here. Admin is not an anomaly, it is the top of the scale, so it carries
 * `accent` instead; sharing amber between the two would make a reader decode
 * the label before knowing which kind of row they are looking at.
 */
const UNKNOWN_API_KEY_SCOPE_DISPLAY: ApiKeyScopeDisplay = {
  label: "Unknown",
  variant: "warning",
  tooltip: "We can't confirm this key's access. It may have more than shown.",
};

/**
 * A key that can only read says so plainly; "Read" alone under a column headed
 * Scope leaves a reader wondering what else is in the set.
 */
const READ_ONLY_API_KEY_SCOPE_DISPLAY: ApiKeyScopeDisplay = {
  label: "Read only",
  variant: null,
};

function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The scopes a key actually carries, deduped and ordered least- to
 * most-privileged, or `null` when the set cannot be read truthfully — the field
 * is not an array of strings at all, is empty, or carries a scope this build
 * does not recognize.
 *
 * Accepts `unknown` rather than `readonly ApiKeyScope[]` on purpose: this is a
 * trust boundary. The values arrive over the wire and are cast, not validated,
 * so both a scope this build has never heard of and an outright malformed field
 * are reachable at runtime even though the type forbids them.
 */
export function getRecognizedApiKeyScopes(
  scopes: unknown
): ApiKeyScope[] | null {
  const parsed = apiKeyScopesSchema.safeParse(scopes);
  if (!parsed.success || parsed.data.length === 0) {
    return null;
  }
  for (const scope of parsed.data) {
    if (!KNOWN_API_KEY_SCOPES.has(scope)) {
      return null;
    }
  }
  return API_KEY_SCOPES.filter((scope) => parsed.data.includes(scope));
}

/** The label and treatment the Scope column renders for a key. */
export function getApiKeyScopeDisplay(scopes: unknown): ApiKeyScopeDisplay {
  const held = getRecognizedApiKeyScopes(scopes);
  if (held === null || held.length === 0) {
    return UNKNOWN_API_KEY_SCOPE_DISPLAY;
  }
  if (held.length === 1 && held[0] === ApiKeyScope.Read) {
    return READ_ONLY_API_KEY_SCOPE_DISPLAY;
  }
  return {
    label: capitalizeFirst(
      held.map((scope) => API_KEY_SCOPE_WORDS[scope]).join(", ")
    ),
    variant: held.includes(ApiKeyScope.Admin) ? "accent" : null,
  };
}
