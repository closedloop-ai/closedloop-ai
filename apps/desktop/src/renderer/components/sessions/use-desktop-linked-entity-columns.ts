import type { SessionLinkedArtifact } from "@repo/api/src/types/agent-session";
import { useCallback } from "react";
import { buildArtifactWebHref } from "../../shared-agent-sessions/artifact-web-href";
import { useDesktopIdentity } from "../../shared-agent-sessions/use-desktop-identity";
import { useWebAppOrigin } from "../../shared-agent-sessions/use-web-app-origin";
import type { DesktopAuthState } from "../../types/desktop-api";

/**
 * FEA-4209 / FEA-4210 (wongk review): the desktop Sessions list's half of the
 * linked-entity columns.
 *
 * `SyncedSessionsTable` gates the `Owning project` / `Linked issues` columns on
 * a HOST OPT-IN as well as the shared `grid-table-v2` flag, because both fields
 * they read (`project`, `linkedArtifacts`) are cloud projections. The original
 * reasoning stopped at "the desktop local producer emits neither" and left the
 * seam unwired — but the desktop has TWO source modes, and the CLOUD one reads
 * the same HTTP list the web app does (`createHttpAgentSessionsDataSource`),
 * so those rows carry both fields. Leaving the seam off meant a desktop user
 * with the Labs toggle on got no columns and no View-menu entries on data that
 * was already in hand.
 *
 * So the opt-in is the MODE, not the surface: cloud mode has the fields, local
 * mode does not and must never grow two tracks of em dashes.
 *
 * Lives in its own module rather than inline in `SessionsView` because that
 * component is already near the file-size ceiling, and because the href rule
 * below is worth testing on its own.
 */
export type DesktopLinkedEntityColumns = Readonly<{
  /** Whether this host has the data to render the columns at all. */
  showLinkedEntityColumns: boolean;
  /**
   * Route builder for a linked-issue chip. The renderer hosts no document detail
   * routes, so the only honest destination is the ABSOLUTE web-app URL the OS
   * browser opens — the same `buildArtifactWebHref` the session-detail linked
   * artifacts row uses (ISS-4898).
   */
  getIssueHref: (artifact: SessionLinkedArtifact) => string | null;
}>;

export function useDesktopLinkedEntityColumns(
  isCloudMode: boolean,
  authState: DesktopAuthState
): DesktopLinkedEntityColumns {
  const { identity } = useDesktopIdentity(authState.status, authState.userId);
  const organizationSlug = identity?.organizationSlug ?? null;
  const { origin: webAppOrigin } = useWebAppOrigin();
  const getIssueHref = useCallback(
    (artifact: SessionLinkedArtifact) =>
      // Both inputs arrive over IPC and either can settle as unusable. A
      // pending or failed read leaves the chip INERT — it still names the issue
      // — rather than pairing a production origin with a stage/local org slug,
      // which is the failure mode the session-detail row was reviewed for
      // (wongk + codex, ISS-5366). No loading state is needed here for the same
      // reason the detail row needed one and this does not: that row rendered a
      // settled "not reachable" LABEL it had not earned, while a chip that is
      // merely not-yet-a-link claims nothing.
      organizationSlug && webAppOrigin
        ? buildArtifactWebHref(webAppOrigin, organizationSlug, artifact)
        : null,
    [organizationSlug, webAppOrigin]
  );
  return { showLinkedEntityColumns: isCloudMode, getIssueHref };
}
