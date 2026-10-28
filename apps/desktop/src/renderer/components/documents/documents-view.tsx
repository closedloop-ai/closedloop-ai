import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import { DocumentsIndexSurface } from "@repo/app/documents/components/index/documents-index-surface";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { useDesktopAuth } from "../../shared-agent-sessions/desktop-auth-provider";

/** Cloud Documents use the same listing and creation flow as Web. */
export function DocumentsView() {
  const { state, beginSignIn } = useDesktopAuth();
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
    <div className="flex h-full min-h-0 flex-col">
      <DocumentsIndexSurface
        renderHeader={(action) => (
          <div className="flex shrink-0 items-center justify-end px-4 py-3">
            {action}
          </div>
        )}
      />
    </div>
  );
}
