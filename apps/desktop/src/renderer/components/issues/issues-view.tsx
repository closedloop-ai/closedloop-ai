import type { DocumentWithProject } from "@repo/api/src/types/document";
import {
  getDocumentRoute,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";
import { IssuesIndexView } from "@repo/app/issues/components/issues-index-view";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { useDesktopIdentity } from "../../shared-agent-sessions/use-desktop-identity";
import { useWebAppOrigin } from "../../shared-agent-sessions/use-web-app-origin";

/** Issue details use the same configured web destination as linked artifacts. */
export function IssuesView() {
  const { state } = useDesktopAuth();
  const { identity } = useDesktopIdentity(state.status, state.userId);
  const { origin } = useWebAppOrigin();
  const artifactHref = (document: DocumentWithProject) => {
    if (!(origin && identity?.organizationSlug)) {
      return undefined;
    }
    const route = withOrgSlug(
      identity.organizationSlug,
      getDocumentRoute(document)
    );
    return route ? `${origin}${route}` : undefined;
  };
  return (
    <IssuesIndexView
      artifactHref={artifactHref}
      onOpenDocument={(document) => {
        const href = artifactHref(document);
        if (href) {
          globalThis.window.open(href, "_blank", "noopener,noreferrer");
        }
      }}
    />
  );
}
