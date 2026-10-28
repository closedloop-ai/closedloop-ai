import "server-only";

import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { clerkService } from "@/lib/auth/clerk-service";

/**
 * Resolves the display identity for a signed-in desktop session: the user's
 * name/email plus their organization's name and URL slug. Org-scoped to the authenticated
 * user so a token can only ever read its own identity.
 */
export const desktopIdentityService = {
  async get(
    userId: string,
    organizationId: string
  ): Promise<DesktopIdentity | null> {
    const user = await withDb((db) =>
      db.user.findFirst({
        where: { id: userId, organizationId },
        select: {
          id: true,
          organizationId: true,
          email: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
          organization: {
            select: {
              name: true,
              slug: true,
              clerkId: true,
            },
          },
        },
      })
    );

    if (!user) {
      return null;
    }

    const organizationImageUrl = await readOrganizationImageUrl(
      user.organization?.clerkId
    );

    return {
      userId: user.id,
      organizationId: user.organizationId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      organizationName: user.organization?.name ?? null,
      // ISS-4898: the org slug the web app's artifact routes are scoped by, so
      // the desktop renderer can build `/<orgSlug>/issues/<slug>` and open a
      // linked artifact in the browser. OMITTED rather than sent as `null` when
      // the organization row could not be read — an absent optional field is
      // the wire shape old and new desktops both handle, and a `null` here would
      // only invite a consumer to interpolate it into a URL.
      ...(user.organization?.slug
        ? { organizationSlug: user.organization.slug }
        : {}),
      // ISS-11449: the org session-sync policy is retired and nothing here reads
      // it. Installed desktops still run `OrgSyncPolicyStore`, which keeps a
      // previously cached `false` when these fields go absent, so this server
      // sends the explicit allow they resolve to until those builds age out.
      sessionSyncPolicyEnabled: true,
      sessionSyncPolicySupported: true,
      // ISS-11465: the workspace menu's logo and avatar. The desktop renderer has
      // no Clerk client, so these only reach it here. OMITTED rather than sent as
      // `null` when absent — the same wire shape `organizationSlug` uses, and the
      // one that leaves the renderer's existing initial-letter fallback intact.
      //
      // The avatar is already mirrored into our own column by the Clerk webhook
      // (`webhook-mappers.ts` maps `image_url` -> `avatarUrl`), so it costs no
      // request. The organization logo is NOT mirrored — `Organization` has no
      // image column — which is why only that one reaches out to Clerk.
      ...(organizationImageUrl ? { organizationImageUrl } : {}),
      ...(user.avatarUrl ? { userImageUrl: user.avatarUrl } : {}),
    };
  },
};

/**
 * How long the optional Clerk logo read may hold up the identity response.
 *
 * WELL under the desktop client's own 10s abort on `GET /desktop/identity`
 * (`apps/desktop/src/main/auth/desktop-identity-client.ts`). A slow Clerk — as
 * opposed to a Clerk that rejects, which the `catch` already covers — would
 * otherwise push the whole response past that abort, and this response is not
 * only the logo: it is the whole account identity (name, email, organization),
 * and an optional decoration must never be able to fail that, so it gets a
 * budget rather than the caller's.
 */
const ORGANIZATION_IMAGE_TIMEOUT_MS = 2000;

/**
 * The organization's Clerk-hosted logo, or `undefined` when there is none, when
 * Clerk cannot answer, and when Clerk does not answer in time.
 *
 * Deliberately NON-FATAL and BOUNDED: this route's job is to return the
 * session's identity, and a Clerk outage or slowdown must degrade the workspace
 * menu to its initial-letter fallback rather than fail — or delay past the
 * client's abort — the whole identity read and leave the desktop with no name,
 * email or org at all. The failure is logged rather than swallowed
 * silently, because a persistent one means every desktop is quietly missing its
 * logo with nothing on screen to say so.
 */
async function readOrganizationImageUrl(
  organizationClerkId: string | undefined
): Promise<string | undefined> {
  if (!organizationClerkId) {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const organization = await Promise.race([
      clerkService.getOrganization(organizationClerkId),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Clerk organization read exceeded ${ORGANIZATION_IMAGE_TIMEOUT_MS}ms`
              )
            ),
          ORGANIZATION_IMAGE_TIMEOUT_MS
        );
      }),
    ]);
    return organization.imageUrl ?? undefined;
  } catch (error) {
    log.warn("desktop_identity_organization_image_unavailable", {
      // Without the org id a spike here cannot be told apart from one broken
      // organization, which are very different pages.
      organizationClerkId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
