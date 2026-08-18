/**
 * FEA-4157: the combined Sessions list + usage read.
 *
 * Extracted from `shared-agent-sessions-api.ts` (a shrink-only grandfathered
 * file) when ISS-5283 added per-facet count scoping here: the composition root
 * for one IPC call's two halves is its own responsibility, and it now owns the
 * facet-scoping step as well as the two failure domains.
 */

import type {
  SharedAgentSessionsListRequest,
  SharedAgentSessionsPageDataResponse,
} from "../../shared/shared-agent-sessions-contract.js";
import { emptySharedAgentSessionsPageDataResponse } from "../../shared/shared-agent-sessions-contract.js";
import { isTransientDbHostError } from "../../shared/transient-db-host-error.js";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import {
  type GetSharedAgentSessionsOptions,
  getSharedAgentSessions,
  getSharedAgentSessionUsage,
} from "./shared-agent-sessions-api.js";
import { applyFacetScopedCounts } from "./shared-agent-sessions-facet-usage.js";

/**
 * FEA-4157: combined list + usage read — the Sessions counterpart of
 * `getSharedBranchesPageData`. The desktop Sessions view mounts the paginated
 * table and its prop-driven summary cards together, so serving both from one IPC
 * call reuses the same request/window instead of the two issuing independent
 * reads. `getSharedAgentSessionUsage` already prefers the metadata-only SQL
 * `aggregateUsage` (COUNT/SUM/GROUP BY over the token tables — never a full
 * corpus hydrate), so the usage half stays cheap; the list half is the same
 * paginated read `getSharedAgentSessions` performs. Run concurrently so the
 * combined call is no slower than the slower of the two. An absent source
 * degrades to the empty combined shape, matching each half's own guard.
 */
export async function getSharedAgentSessionsPageData(
  source: AgentSessionSyncSource | null | undefined,
  request: SharedAgentSessionsListRequest = {},
  options: GetSharedAgentSessionsOptions = {}
): Promise<SharedAgentSessionsPageDataResponse> {
  if (!source) {
    return emptySharedAgentSessionsPageDataResponse();
  }

  // FEA-4177 — independent failure domains. These are two separate SQL reads;
  // `Promise.all` gave them ONE failure domain, so a usage-aggregate failure
  // AFTER the list succeeded discarded the rows and errored the whole table.
  // `allSettled` keeps per-half state: the list is the required half (rethrow so
  // the table shows a real error), but a usage failure degrades ONLY the summary
  // cards (`usage` omitted, `usageError: true`) while the list still renders.
  const [listResult, usageResult] = await Promise.allSettled([
    getSharedAgentSessions(source, request, options),
    getSharedAgentSessionUsage(source, request),
  ]);
  if (listResult.status === "rejected") {
    throw listResult.reason;
  }
  if (usageResult.status === "rejected") {
    // ISS-4483 (review cid 3679616168, wongk): a usage-half rejection that is a
    // transient db-host lifecycle failure (the child restarting mid-backfill)
    // must not blank the cards to a fatal dash. The combined read still RESOLVES
    // here (the list won the race), so the renderer's query never rejects and
    // never auto-retries the usage half — carry a transient marker so the cards
    // route to the quiet reconnecting surface and drive a bounded refetch. A
    // genuine (non-lifecycle) usage failure leaves the marker absent and stays
    // the honest error state. Nothing about the raw error reaches the renderer;
    // only this boolean does.
    //
    // ISS-5808 (wongk review): classified by the TYPED helper, not by the
    // message. `handleExit` mints `db-host exited (code: N)` whether or not the
    // supervisor armed a replacement, so the message form marked a
    // permanently-down host `usageErrorTransient` and the cards sat in the quiet
    // reconnecting state retrying against a host nobody was bringing back. This
    // half also catches its own rejection, so the outer read's re-drive never
    // sees the exit and cannot correct the verdict — the classification has to
    // be right HERE. `isTransientDbHostError` falls back to the message
    // signatures for every non-typed case, so `db-host is closed` /
    // `db-host is not running` and the IPC-wrapper prefixes classify unchanged.
    if (isTransientDbHostError(usageResult.reason)) {
      return {
        list: listResult.value,
        usageError: true,
        usageErrorTransient: true,
      };
    }
    return { list: listResult.value, usageError: true };
  }
  // FEA-4192: reconcile the summary session COUNT with the list — the single
  // source of truth for this rationale (renderer callers point here). The list
  // half applies the Substantive|Idle|All quality segment (`matchesListQuery`);
  // the usage half is intentionally all-quality so its token/cost totals stay
  // byte-for-byte in step with the SQL `aggregateUsage` path (FEA-1834 §4), which
  // cannot express the substantive predicate on the column-less desktop
  // `sessions` table. That left `totalSessions` — the "Sessions" summary card —
  // counting the all-quality corpus while the visible list showed the
  // quality-gated subset, so the card contradicted the list total whenever the
  // segment was not `all`. Mirror the already-quality-gated `list.total` into the
  // count; the token/cost cards keep their all-quality basis by design.
  //
  // This is NOT full parity with the cloud SSOT, and the asymmetry is deliberate:
  // web `buildWhere` gates ALL THREE cards (count AND token/cost) in one SQL
  // predicate, so under a non-`all` segment web describes the gated set across the
  // whole row. Desktop can only gate the COUNT (the substantive predicate isn't
  // SQL-expressible here), so under a non-`all` segment its token/cost cards
  // describe a LARGER (all-quality) population than its count — two populations in
  // one row. The desktop Sessions UI stays consistent today because it never
  // sends a non-`all` segment: `buildFacetQuery` omits `quality`, so
  // `coerceSessionQuality` fails open to `all` and all three cards describe one
  // population on screen. Any caller that DOES pass a non-`all` segment here (the
  // API contract, the tests below, or a future desktop quality toggle) owns
  // giving the token/cost cards an honest per-basis caption in
  // `packages/app/agents/components/sessions/sessions-summary-cards.tsx` — e.g.
  // "all sessions in range" — before the mixed-basis row can reach a user.
  // ISS-5283 (wongk review): scope each FILTERED facet's option counts to every
  // OTHER active filter — see `shared-agent-sessions-facet-usage.ts`. Unfiltered
  // dimensions reuse this summary and issue no extra read.
  const usage = await applyFacetScopedCounts(
    { ...usageResult.value, totalSessions: listResult.value.total },
    request,
    (relaxed) => getSharedAgentSessionUsage(source, relaxed)
  );
  return { list: listResult.value, usage };
}
