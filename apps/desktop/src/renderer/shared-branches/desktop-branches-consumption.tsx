import type { BranchesQueryIdentity } from "@repo/app/branches/hooks/branch-query-keys";
import { makeQueryClient } from "@repo/app/shared/query/query-client";
import type { QueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { DesktopAuthStatus } from "../../shared/contracts";
import { useDesktopAuth } from "../shared-agent-sessions/desktop-auth-provider";
import type { DesktopAuthState } from "../types/desktop-api";

type DesktopBranchesConsumption = {
  queryClient: QueryClient | null;
  queryIdentity?: BranchesQueryIdentity;
  queryPolicy?: {
    refetchOnReconnect: boolean;
    refetchOnWindowFocus: boolean;
    staleTime?: number;
    networkMode?: "always";
  };
  useCanonicalCloudSource: boolean;
};

const DesktopBranchesConsumptionContext =
  createContext<DesktopBranchesConsumption>({
    queryClient: null,
    useCanonicalCloudSource: false,
  });

/**
 * Own the Branch-only cache independently of the connectivity-selected app-core
 * stack. One client survives connectivity and auth transitions so mounted
 * TanStack observers never remain attached to an obsolete client. An identity
 * change synchronously clears the Branch client and changes its cache namespace
 * before descendants render, making the previous identity unreachable.
 */
export function DesktopBranchesConsumptionProvider({
  readsCloud,
  children,
}: Readonly<{
  /**
   * ISS-6972: `mode === DesktopAppCoreMode.Cloud` — the SAME decision that
   * selects the Sessions read source. Passed down by `DesktopAppCoreModeStack`
   * rather than re-read from a context here, so this module keeps no import edge
   * back to the app-core provider that mounts it.
   *
   * REQUIRED, with no default: a silent `false` would strand Branches on the
   * local source at a future mount site with nothing failing, which is the same
   * shape of quiet divergence ISS-5714 closed.
   */
  readsCloud: boolean;
  children: ReactNode;
}>) {
  const { state } = useDesktopAuth();
  const value = useDesktopBranchesConsumptionForAuth(state, readsCloud);
  return (
    <DesktopBranchesConsumptionContext.Provider value={value}>
      {children}
    </DesktopBranchesConsumptionContext.Provider>
  );
}

/**
 * Branch-only canonical-cloud policy and cache. The safe standalone default
 * keeps direct test/story mounts on their existing local source and parent
 * QueryClient.
 *
 * ISS-5714 / ISS-6972: `useCanonicalCloudSource` is a complete cloud identity
 * AND the app-core mode being Cloud. Identity alone put Branches on an empty
 * cloud projection while Sessions correctly stayed on populated local data — one
 * app telling a user its data lives in two places, and handing them a blank page
 * on one of them. Both surfaces now read the same mode, including offline: the
 * carve-out that kept Branches on cached cloud rows while Sessions dropped to
 * Local is retired, so one screen can no longer name two stores.
 *
 * ISS-5567: `useCanonicalCloudSource` is also the SINGLE answer to "who would
 * serve a `/branches/:id` opened right now" — branch ids are not interchangeable
 * across sources (the cloud detail reads a Branch artifact UUID, the local detail
 * decodes an `encodeBranchId` composite), so a surface that MINTS a branch link
 * must agree with the value `DesktopBranchesSource` selects on or the link is
 * dead. Read this value; do not re-derive the rule from auth state (see
 * `SessionDetailView`).
 */
export function useDesktopBranchesConsumption(): DesktopBranchesConsumption {
  return useContext(DesktopBranchesConsumptionContext);
}

function useDesktopBranchesConsumptionForAuth(
  state: DesktopAuthState,
  readsCloud: boolean
): DesktopBranchesConsumption {
  const identityKey = canonicalBranchesIdentityKey(state);
  // ISS-5714: a complete identity is necessary but not sufficient — Branches
  // also needs a non-empty org for its cache namespace, which the mode never
  // checks, so the two terms are both load-bearing.
  const useCanonicalCloudSource = identityKey !== null && readsCloud;
  const queryClientRef = useRef<QueryClient | null>(null);
  const priorIdentityKeyRef = useRef<string | null>(identityKey);
  if (!queryClientRef.current) {
    queryClientRef.current = createDesktopBranchesQueryClient();
  }
  if (priorIdentityKeyRef.current !== identityKey) {
    queryClientRef.current.clear();
    priorIdentityKeyRef.current = identityKey;
  }
  // The cache namespace has to track the SOURCE, not just the identity: rows
  // read from local SQLite and rows read from the cloud projection carry
  // different branch ids (see the `useCanonicalCloudSource` docblock), so a
  // shared namespace across a cutover would serve one source's ids to the other.
  const queryIdentity = useMemo(
    () => ({
      cacheScope: useCanonicalCloudSource
        ? `desktop-cloud:${identityKey}`
        : DESKTOP_LOCAL_BRANCH_CACHE_SCOPE,
    }),
    [identityKey, useCanonicalCloudSource]
  );
  useEffect(() => {
    const queryClient = queryClientRef.current;
    queryClient?.mount();
    return () => queryClient?.unmount();
  }, []);
  // Memoized because ISS-5714 moved this provider inside
  // `DesktopAppCoreModeStack`. ISS-6972 removed the readiness poll that used to
  // re-render that stack every few seconds, but a fresh object literal per render
  // would still push every parent render straight through the context into both
  // consumers — one of which is the whole `SessionDetailView`.
  return useMemo(
    () => ({
      queryClient: queryClientRef.current,
      queryIdentity,
      queryPolicy: useCanonicalCloudSource
        ? DESKTOP_CLOUD_BRANCH_QUERY_POLICY
        : DESKTOP_LOCAL_BRANCH_QUERY_POLICY,
      useCanonicalCloudSource,
    }),
    [queryIdentity, useCanonicalCloudSource]
  );
}

function canonicalBranchesIdentityKey(state: DesktopAuthState): string | null {
  if (
    state.status !== DesktopAuthStatus.Authenticated ||
    typeof state.userId !== "string" ||
    state.userId.length === 0 ||
    typeof state.organizationId !== "string" ||
    state.organizationId.length === 0
  ) {
    return null;
  }
  return JSON.stringify([state.userId, state.organizationId]);
}

function createDesktopBranchesQueryClient(): QueryClient {
  return makeQueryClient({
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
  });
}

const DESKTOP_LOCAL_BRANCH_CACHE_SCOPE = "desktop-local";
const DESKTOP_CLOUD_BRANCH_QUERY_POLICY = {
  refetchOnReconnect: true,
  refetchOnWindowFocus: false,
} as const;
const DESKTOP_LOCAL_BRANCH_QUERY_POLICY = {
  refetchOnReconnect: false,
  refetchOnWindowFocus: false,
  staleTime: Number.POSITIVE_INFINITY,
  // ISS-6972: the local source reads SQLite over IPC, which needs no network.
  // React Query's default `networkMode: "online"` pauses a fetch whenever the
  // browser reports offline, so without this the one state that now sends
  // Branches to the local source — going offline — is the one state in which it
  // could never actually read it, and the view renders nothing at all.
  networkMode: "always",
} as const;
