import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { createUrlBuilder, type McpUrlBuilder } from "./tools/tool-utils.js";

/**
 * Resolve the session's org slug and build its webapp URL builder. Per-session,
 * never module state: apps/mcp serves every org from one process, so a shared
 * slug is cross-tenant contamination (ISS-6570).
 *
 * The binding is re-confirmed rather than frozen. Once it goes stale the builder
 * emits org-less URLs — which the app proxy redirects to the caller's own org —
 * until a refresh re-reads this organization's current slug. Degrading is always
 * the safe direction: an org-less URL resolves for whoever is signed in, while a
 * stale slug can resolve into another tenant.
 */
export async function createSessionUrlBuilder(
  organizationId: string
): Promise<McpUrlBuilder> {
  let slug = await resolveOrgSlug(organizationId);
  let resolvedAtMs = Date.now();
  let refreshing = false;

  const refresh = (): void => {
    if (refreshing) {
      return;
    }
    refreshing = true;
    resolveOrgSlug(organizationId)
      .then((next) => {
        slug = next;
        resolvedAtMs = Date.now();
      })
      .finally(() => {
        refreshing = false;
      });
  };

  return createUrlBuilder(() => {
    const ageMs = Date.now() - resolvedAtMs;
    if (ageMs > ORG_SLUG_REVALIDATE_AFTER_MS) {
      // Revalidate BEFORE the binding expires, so a live session normally
      // renews it without ever emitting an org-less URL. Always in the
      // background: the builder is synchronous (it is called from inside
      // per-item `.map()`s), so awaiting here would cost a DB round-trip per
      // rendered row.
      refresh();
    }
    if (ageMs <= ORG_SLUG_TTL_MS) {
      return slug;
    }
    // Past the hard expiry with no fresh answer — the lookup is slow or down,
    // which is exactly when degrading is right. Report no slug rather than one
    // this session can no longer vouch for.
    return null;
  });
}

/**
 * Never rejects — a failed lookup resolves to `null` (org-less). `refresh()`
 * floats this promise without a `.catch()` and relies on that totality; keep it
 * if this ever grows a second failure mode.
 */
async function resolveOrgSlug(organizationId: string): Promise<string | null> {
  try {
    const org = await withDb((db) =>
      db.organization.findUnique({
        where: { id: organizationId },
        select: { slug: true },
      })
    );
    return org?.slug ?? null;
  } catch (error) {
    // Non-fatal: every webUrl degrades to the org-less form (which the app
    // proxy redirects to the caller's own org) until a later refresh succeeds,
    // so surface the degradation.
    log.warn("[mcp] org slug resolution failed; webUrls degrade to org-less", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * How long a resolved org slug stays trusted.
 *
 * An MCP session is evicted only after a window of INACTIVITY, so a session that
 * keeps calling tools lives indefinitely. Org slugs are editable, and a released
 * slug can be claimed by a different org — so a slug captured once at session
 * start eventually names someone else's namespace, which is the same
 * cross-tenant leak ISS-6570 closed, just delayed. A binding older than this is
 * therefore treated as unverified rather than correct.
 */
export const ORG_SLUG_TTL_MS = 60_000;

/**
 * When a live session starts revalidating its slug. Deliberately earlier than
 * {@link ORG_SLUG_TTL_MS}: renewing while the binding is still trusted keeps an
 * active session on its org-scoped URLs instead of dropping one org-less URL
 * every TTL, and leaves the degraded path for a lookup that is actually slow or
 * unavailable.
 */
const ORG_SLUG_REVALIDATE_AFTER_MS = ORG_SLUG_TTL_MS / 2;
