"use client";

import { useRouteParams } from "@repo/navigation/use-route-params";
import { createContext, type ReactNode, useContext } from "react";

type DocumentHost = {
  orgSlug: string;
  webOrigin?: string | null;
  hideHeaderBreadcrumbs?: boolean;
  /** Where a deleted document returns to, when the host's routes differ from the editor's own default. */
  deleteRedirectPath?: string;
  mobileSearch?: ReactNode;
  sidebarTrigger?: ReactNode;
};

const DocumentHostContext = createContext<DocumentHost | null>(null);

export function DocumentHostProvider({
  children,
  ...host
}: DocumentHost & { children: ReactNode }) {
  return (
    <DocumentHostContext.Provider value={host}>
      {children}
    </DocumentHostContext.Provider>
  );
}

export function useOrgSlug(): string {
  const host = useContext(DocumentHostContext);
  const params = useRouteParams();
  return (
    host?.orgSlug ?? (typeof params.orgSlug === "string" ? params.orgSlug : "")
  );
}

export function DocumentHostMobileSearch() {
  return useContext(DocumentHostContext)?.mobileSearch ?? null;
}

export function DocumentHostSidebarTrigger() {
  return useContext(DocumentHostContext)?.sidebarTrigger ?? null;
}

export function useDocumentPermalinkOrigin(): string | null | undefined {
  return useContext(DocumentHostContext)?.webOrigin;
}

export function DocumentHostBreadcrumbs({ children }: { children: ReactNode }) {
  const host = useContext(DocumentHostContext);
  return host?.hideHeaderBreadcrumbs ? null : children;
}

export function useDocumentHostDeleteRedirectPath(): string | undefined {
  return useContext(DocumentHostContext)?.deleteRedirectPath;
}
