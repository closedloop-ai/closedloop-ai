import { teamKeys } from "@repo/app/teams/hooks/use-teams";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { useClearQueryCacheOnOrgChange } from "../use-clear-query-cache-on-org-change";

// A real org-agnostic key from the app: nearly every list family uses one, so
// an entry surviving an org change is a cache HIT for the next org. Read from
// the canonical owner so org-scoping that family shows up here.
const TEAMS_LIST_KEY = teamKeys.lists();
const ORG_A_TEAMS = [{ id: "team-in-org-a", name: "Org A team" }];

function Probe({ orgId }: { orgId: string | undefined }) {
  useClearQueryCacheOnOrgChange(orgId);
  return null;
}

function mountProbe(queryClient: QueryClient, orgId: string | undefined) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Probe orgId={orgId} />
    </QueryClientProvider>
  );
}

describe("useClearQueryCacheOnOrgChange", () => {
  afterEach(cleanup);

  test("drops the previous org's cached data when the org changes across an unmount", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(TEAMS_LIST_KEY, ORG_A_TEAMS);

    const orgA = mountProbe(queryClient, "org-a");
    // The seed survives the mount that recorded org A — without this the
    // emptiness asserted below would be satisfied by a seed that never landed.
    expect(queryClient.getQueryData(TEAMS_LIST_KEY)).toEqual(ORG_A_TEAMS);

    // ISS-7344: the remount that used to reset the in-component ref, making the
    // org-b mount look like a first load and skip the clear.
    orgA.unmount();
    mountProbe(queryClient, "org-b");

    expect(queryClient.getQueryData(TEAMS_LIST_KEY)).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  test("clears on sign-out, before releasing the cache's org marker", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(TEAMS_LIST_KEY, ORG_A_TEAMS);

    const signedIn = mountProbe(queryClient, "org-a");
    signedIn.unmount();
    mountProbe(queryClient, undefined);

    // Order is the whole invariant: releasing the marker first would return the
    // client to the "unrecorded" state that deliberately skips clearing, so the
    // next org would inherit org A's rows.
    expect(queryClient.getQueryData(TEAMS_LIST_KEY)).toBeUndefined();
  });

  test("keeps cached data while the active org is still unresolved", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(TEAMS_LIST_KEY, ORG_A_TEAMS);

    // Clerk's loading window: undefined, then the org resolves. Clearing here
    // would wipe a warm cache on every page load.
    const loading = mountProbe(queryClient, undefined);
    loading.unmount();
    mountProbe(queryClient, "org-a");

    expect(queryClient.getQueryData(TEAMS_LIST_KEY)).toEqual(ORG_A_TEAMS);
  });

  test("clears the entries a shell query cached while Clerk was between orgs", () => {
    const queryClient = new QueryClient();

    mountProbe(queryClient, "org-a").unmount();

    // Clerk drops the active org mid-switch. The shell keeps rendering, and a
    // query issued in that window refills the cache with rows this hook cannot
    // attribute to an org.
    mountProbe(queryClient, undefined).unmount();
    queryClient.setQueryData(TEAMS_LIST_KEY, ORG_A_TEAMS);

    // ISS-7344: releasing the marker in the window above made this client look
    // never-used, so org B skipped the clear and adopted those rows.
    mountProbe(queryClient, "org-b");

    expect(queryClient.getQueryData(TEAMS_LIST_KEY)).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  test("clears mid-switch entries even when the original org comes back", () => {
    const queryClient = new QueryClient();

    mountProbe(queryClient, "org-a").unmount();
    mountProbe(queryClient, undefined).unmount();
    queryClient.setQueryData(TEAMS_LIST_KEY, ORG_A_TEAMS);

    // Returning to the org that owned the cache before the window does not make
    // the window's arrivals its own — the session may have been mid-switch to
    // another org when they were fetched. The mark says "unattributable", not
    // "a different org", so the clear still has to run.
    mountProbe(queryClient, "org-a");

    expect(queryClient.getQueryData(TEAMS_LIST_KEY)).toBeUndefined();
  });

  test("keeps cached data when the same org remounts", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(TEAMS_LIST_KEY, ORG_A_TEAMS);

    const first = mountProbe(queryClient, "org-a");
    first.unmount();
    mountProbe(queryClient, "org-a");

    expect(queryClient.getQueryData(TEAMS_LIST_KEY)).toEqual(ORG_A_TEAMS);
  });
});
