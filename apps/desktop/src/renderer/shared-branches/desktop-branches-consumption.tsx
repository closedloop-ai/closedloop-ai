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
  cloudHoldsHistory,
  children,
}: Readonly<{
  /**
   * ISS-5714: `CloudReadCutoverDecision.cloudHoldsHistory` — the backlog axis of
   * the SAME decision that selects the Sessions read source. Passed down by
   * `DesktopAppCoreModeStack` rather than re-read from a context here, so this
   * module keeps no import edge back to the app-core provider that mounts it.
   *
   * REQUIRED, with no default: a silent `false` would strand Branches on the
   * local source at a future mount site with nothing failing, which is the same
   * shape of quiet divergence this ticket closed.
   */
  cloudHoldsHistory: boolean;
  children: ReactNode;
}>) {
  const { state } = useDesktopAuth();
  const value = useDesktopBranchesConsumptionForAuth(state, cloudHoldsHistory);
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
 * ISS-5714: `useCanonicalCloudSource` is a complete cloud identity AND the
 * ISS-5477 cutover having established that the cloud actually holds this
 * machine's history. Identity alone put Branches on an empty cloud projection
 * while Sessions correctly stayed on populated local data — one app telling a
 * user its data lives in two places, and handing them a blank page on one of
 * them. Both surfaces now read the same `CloudReadCutoverDecision`.
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
  cloudHoldsHistory: boolean
): DesktopBranchesConsumption {
  const identityKey = canonicalBranchesIdentityKey(state);
  // ISS-5714: a complete identity is necessary but no longer sufficient. The
  // cloud must also actually HOLD this machine's history, or Branches renders
  // the empty workspace the ISS-5477 cutover gate exists to keep off screen —
  // beside a Sessions page that correctly stayed local and stayed populated.
  const useCanonicalCloudSource = identityKey !== null && cloudHoldsHistory;
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
  // Memoized because ISS-5714 moved this provider inside `DesktopAppCoreModeStack`,
  // which re-renders on every readiness poll (every `CLOUD_READ_READINESS_POLL_MS`
  // for the whole pre-cutover window). A fresh object literal per render would
  // push that cadence straight through the context into both consumers — one of
  // which is the whole `SessionDetailView`.
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
} as const;
