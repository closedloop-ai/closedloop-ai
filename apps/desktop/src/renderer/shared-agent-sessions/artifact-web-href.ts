import type { SessionLinkedArtifact } from "@repo/api/src/types/agent-session";
import {
  getDocumentTypeRoute,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";
/**
 * ISS-4898: the ABSOLUTE web-app URL for a linked artifact, which is the only
 * destination this renderer can offer for one.
 *
 * The renderer hosts no document detail routes (`route-table.ts` maps sessions,
 * branches and agents only), so an in-app `/issues/<slug>` href would be
 * silently dropped by the nav guard. An absolute `https://` URL instead is
 * rendered by the shared pill as an external anchor and handed to the OS
 * browser by the Electron window-open handler — the same path the PR pills in
 * that row already take to GitHub.
 *
 * Returns null — never a partial URL — when the artifact has no navigable route
 * (a slug-less artifact, or a type like Template that has no detail page), so
 * the caller keeps that pill an honest inert label rather than a link that
 * lands on a 404.
 *
 * `webAppOrigin` is the origin this desktop is CONFIGURED against (see
 * `useWebAppOrigin`), not a hardcoded production host: the org slug comes from
 * whichever cloud the active gateway profile names, so pairing a stage slug with
 * a production origin would produce a link to someone else's org. The main
 * process's `shell.openExternal` allowlist (`external-url-allowlist.ts`) still
 * has the final say on whether a click opens.
 */
export function buildArtifactWebHref(
  webAppOrigin: string,
  orgSlug: string,
  artifact: SessionLinkedArtifact
): string | null {
  const route = withOrgSlug(
    orgSlug,
    getDocumentTypeRoute(artifact.documentType, artifact.slug)
  );
  return route === null ? null : `${webAppOrigin}${route}`;
}
