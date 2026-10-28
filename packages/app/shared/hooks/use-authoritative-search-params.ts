"use client";

import { useRef, useState } from "react";
import { browserSearchParams } from "../lib/facet-filter-params";

/**
 * The params source to trust THIS render: the reactive snapshot once it has
 * proven authoritative, and the mount-time browser URL until then.
 *
 * On the web App Router the search-params snapshot can still be reconciling —
 * and therefore EMPTY — on the first client render after a reload or a deep
 * link. `initialFacetParamsSource` guards the same gap for the facet seed, but
 * it is safe there precisely because that seed is a one-time `useState`
 * initializer. Linked view state is DERIVED on every render, and reading the browser
 * URL on every render would be a different bug in the same family: clearing the
 * linked state empties the snapshot legitimately, and a `location.search` that has not
 * caught up would resurrect the view state the user just cleared.
 *
 * So the fallback is LATCHED. A snapshot that has ever carried params is
 * authoritative from then on, and once it is, an empty snapshot means an empty
 * URL rather than an unreconciled one. On the desktop hash router the snapshot
 * is synchronous and `location.search` sits outside the hash, so the latch flips
 * on the first populated render and the fallback never fires.
 */
export function useAuthoritativeSearchParams<
  T extends Pick<URLSearchParams, "get" | "toString">,
>(snapshot: T, routePath: string): T | URLSearchParams {
  // Captured once: the address bar at mount is what the reconciling snapshot is
  // converging TOWARD — but only while it is on THIS route, which is why the
  // read is path-scoped (ISS-8187). Re-reading it later could only introduce the
  // skew this exists to avoid.
  const [initialBrowserParams] = useState(() => browserSearchParams(routePath));
  const hasAuthoritativeSnapshot = useRef(false);
  if (snapshot.toString() !== "") {
    hasAuthoritativeSnapshot.current = true;
  }
  if (hasAuthoritativeSnapshot.current || initialBrowserParams === null) {
    return snapshot;
  }
  return initialBrowserParams;
}
