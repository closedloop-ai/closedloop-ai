import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import { isValidVersionNumber } from "@repo/api/src/types/document-version";
import { CollaborationProviderWrapper } from "@repo/app/documents/components/collaboration-provider-wrapper";
import { DocumentHostProvider } from "@repo/app/documents/components/document-host-context";
import {
  VersionedDocumentEditorContainer,
  type VersionedDocumentEditorProps,
} from "@repo/app/documents/components/versioned-document-editor-container";
import { DocumentDetailEditor } from "@repo/app/documents/editors/document-detail-editor";
import { ApiError } from "@repo/app/shared/api/api-error";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { DesktopAuthStatus } from "../../../shared/contracts";
import {
  detailTitleKey,
  usePublishDetailTitle,
} from "../../navigation/detail-title-context";
import { hrefForNavId, NavId } from "../../navigation/route-table";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";
import { useDesktopIdentity } from "../../shared-agent-sessions/use-desktop-identity";
import { useWebAppOrigin } from "../../shared-agent-sessions/use-web-app-origin";
import { DocumentDetailErrorBoundary } from "./document-detail-error-boundary";

type DesktopDocumentDetailViewProps = {
  slug: string;
};

export function DesktopDocumentDetailView({
  slug,
}: DesktopDocumentDetailViewProps) {
  const searchParams = useSearchParamsValue();
  const version = parseDocumentVersion(searchParams.get("version"));
  const { origin } = useWebAppOrigin();
  const { state, beginSignIn } = useDesktopAuth();
  const { identity } = useDesktopIdentity(state.status, state.userId);
  if (state.status === DesktopAuthStatus.Loading) {
    return <Skeleton className="m-6 h-96" />;
  }
  if (
    !(state.status === DesktopAuthStatus.Authenticated && state.organizationId)
  ) {
    return (
      <div className="flex h-full items-center justify-center">
        <Button onClick={() => beginSignIn()}>Sign in</Button>
      </div>
    );
  }
  return (
    <DocumentHostProvider
      deleteRedirectPath={hrefForNavId(NavId.Documents)}
      hideHeaderBreadcrumbs
      orgSlug={identity?.organizationSlug ?? ""}
      webOrigin={identity?.organizationSlug ? origin : null}
    >
      <CollaborationProviderWrapper>
        <DocumentDetailErrorBoundary key={`${slug}:${version ?? "latest"}`}>
          <VersionedDocumentEditorContainer
            editor={DesktopDocumentEditor}
            onNotFound={documentNotFound}
            slug={slug}
            version={version}
          />
        </DocumentDetailErrorBoundary>
      </CollaborationProviderWrapper>
    </DocumentHostProvider>
  );
}

function DesktopDocumentEditor(props: VersionedDocumentEditorProps) {
  const { document } = props;
  usePublishDetailTitle(
    detailTitleKey("document", document.slug),
    document.title,
    true
  );
  return <DocumentDetailEditor {...props} onNotFound={documentNotFound} />;
}

function parseDocumentVersion(raw: string | null): number | undefined {
  if (!(raw && DOCUMENT_VERSION_PATTERN.test(raw))) {
    return undefined;
  }
  const version = Number(raw);
  return isValidVersionNumber(version) ? version : undefined;
}

function documentNotFound(): never {
  throw new ApiError("Not found", 404);
}

const DOCUMENT_VERSION_PATTERN = /^\d+$/;
