import {
  type BranchesDataSource,
  createHttpBranchesDataSource,
} from "@repo/app/branches/data-source/branches-data-source";
import { BranchesLiveBridge } from "@repo/app/branches/data-source/branches-live-bridge";
import { BranchesDataSourceProvider } from "@repo/app/branches/data-source/provider";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { type ReactNode, useMemo } from "react";
import { useDesktopBranchesConsumption } from "./desktop-branches-consumption";
import { createLocalBranchesDataSource } from "./local-branches-data-source";

/**
 * Auth-driven Branches read-source selection (PLN-1138 D-E / Phase 2), shared by
 * the desktop Branches list and detail views so the rule lives in one place.
 *
 * - **Authenticated with complete identity, online or offline:** the shared
 *   HTTP source (scope `"http"`) under an identity-owned Branch QueryClient.
 *   TanStack's default online network mode serves matching cached canonical
 *   data while offline and pauses uncached reads without invoking the HTTP or
 *   local query functions; reconnect resumes against the cloud source.
 * - **Signed out, incomplete identity, or standalone:** the local SQLite source
 *   (scope `"local"`) over IPC, keeping the existing local predicate.
 *
 * The provider tree and Branch-only QueryClient stay put across connectivity
 * and identity changes. Identity changes synchronously clear and re-namespace
 * the Branch cache; explicit client injection applies only to Branch hooks, so
 * GitHub connection and trace-comment descendants keep the app-core client.
 *
 * The consumption context defaults to local/no nested client with no app-core
 * ancestor, so a view rendered directly in a test/story keeps local behavior;
 * `override` short-circuits source selection for the view test seams.
 */
export function DesktopBranchesSource({
  override,
  children,
}: {
  /** Test seam: inject a source directly, bypassing mode-based selection. */
  override?: BranchesDataSource;
  children: ReactNode;
}) {
  const { queryClient, queryIdentity, queryPolicy, useCanonicalCloudSource } =
    useDesktopBranchesConsumption();
  // Called unconditionally (Rules of Hooks); the HTTP source is selected only
  // for a complete authenticated identity. Every Branches view mounts under an
  // `ApiAdapterProvider` (the shared read hooks construct `useApiClient`
  // unconditionally), so this needs no new ancestor.
  const apiClient = useApiClient();
  // Built once and kept stable so unrelated `apiClient` identity churn never
  // rebuilds the Local-mode source (which would swap the provider value and drop
  // the local branch cache); mirrors `DesktopSessionsViewSource`'s hoisted
  // `localSource`. The HTTP source legitimately tracks `apiClient`.
  const localSource = useMemo(
    () => createLocalBranchesDataSource(window.desktopApi),
    []
  );
  const source = useMemo(() => {
    if (override) {
      return override;
    }
    return useCanonicalCloudSource
      ? createHttpBranchesDataSource(apiClient)
      : localSource;
  }, [override, useCanonicalCloudSource, apiClient, localSource]);

  return (
    <BranchesDataSourceProvider
      dataSource={source}
      queryClient={queryClient ?? undefined}
      queryIdentity={queryIdentity}
      queryPolicy={queryPolicy}
    >
      {/* Scoped {branchId} (and broad) invalidation off the local DB's
          desktop:db:changed push in local mode; a no-op on the HTTP source. */}
      <BranchesLiveBridge />
      {children}
    </BranchesDataSourceProvider>
  );
}
