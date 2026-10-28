/**
 * FEA-4157: the combined Sessions list + usage read.
 *
 * Extracted from `shared-agent-sessions-api.ts` (a shrink-only grandfathered
 * file) when ISS-5283 added per-facet count scoping here: the composition root
 * for one IPC call's two halves is its own responsibility, and it now owns the
 * facet-scoping step as well as the two failure domains.
 */

import { isReadCancelledError } from "../../shared/read-cancellation-contract.js";
import type {
  SharedAgentSessionsListRequest,
  SharedAgentSessionsPageDataResponse,
} from "../../shared/shared-agent-sessions-contract.js";
import { emptySharedAgentSessionsPageDataResponse } from "../../shared/shared-agent-sessions-contract.js";
import { isTransientDbHostError } from "../../shared/transient-db-host-error.js";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import { SESSION_COMPACT_FILTER_VERSION } from "../agent-sync/session-compact-filter-capabilities.js";
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
 * reads. Supported quality/facet combinations stay on the grouped SQLite
 * aggregate, while the list pages before projecting visible rows. The list half
 * is the same paginated read
 * `getSharedAgentSessions` performs. A writer revision change prompts at most
 * two fresh attempts, but unrelated writes cannot discard the last completed
 * page. The counter is a best-effort change signal, not an atomic snapshot
 * across the separate list and usage operations. An absent source
 * degrades to the empty combined shape, matching each half's own guard.
 */
export async function getSharedAgentSessionsPageData(
  source: AgentSessionSyncSource | null | undefined,
  request: SharedAgentSessionsListRequest = {},
  options: GetSharedAgentSessionsOptions = {},
  listReader?: () => Promise<Awaited<ReturnType<typeof getSharedAgentSessions>>>
): Promise<SharedAgentSessionsPageDataResponse> {
  if (!source) {
    return emptySharedAgentSessionsPageDataResponse();
  }

  let revision = await readSessionStoreRevision(source);
  if (revision === null) {
    return readPageDataOnce(source, request, options, listReader);
  }
  let remainingRetries = 2;
  while (true) {
    const page = await readPageDataOnce(source, request, options, listReader);
    const nextRevision = await readSessionStoreRevision(source);
    if (nextRevision === revision) {
      return page;
    }
    if (nextRevision === null || remainingRetries === 0) {
      return page;
    }
    remainingRetries -= 1;
    revision = nextRevision;
  }
}

async function readPageDataOnce(
  source: AgentSessionSyncSource,
  request: SharedAgentSessionsListRequest,
  options: GetSharedAgentSessionsOptions,
  listReader?: () => Promise<Awaited<ReturnType<typeof getSharedAgentSessions>>>
): Promise<SharedAgentSessionsPageDataResponse> {
  // FEA-4177 — independent failure domains. These are two separate SQL reads;
  // `Promise.all` gave them ONE failure domain, so a usage-aggregate failure
  // AFTER the list succeeded discarded the rows and errored the whole table.
  // `allSettled` keeps per-half state: the list is the required half (rethrow so
  // the table shows a real error), but a usage failure degrades ONLY the summary
  // cards (`usage` omitted, `usageError: true`) while the list still renders.
  const [listResult, usageResult] = await Promise.allSettled([
    listReader?.() ?? getSharedAgentSessions(source, request, options),
    getSharedAgentSessionUsage(source, request),
  ]);
  if (listResult.status === "rejected") {
    throw listResult.reason;
  }
  if (usageResult.status === "rejected") {
    // ISS-9802 (whitlockk review): a CANCELLATION is not a usage failure, and the
    // degrade below would turn the caller's own abort into `usageError: true` —
    // summary cards reporting a problem for a read the user superseded. It is
    // re-thrown for the same reason the list half re-throws and the analytics
    // aggregate stops degrading: the read never finished, so the honest answer
    // is "unknown", never a fabricated one. Reachable only since this change
    // gave `aggregateSqliteUsage` its `yieldDbHostLoop()` checkpoints — before
    // them the usage half could not receive a cancellation at all.
    if (isReadCancelledError(usageResult.reason)) {
      throw usageResult.reason;
    }
    // ISS-4483 (review cid 3679616168, whitlockk): a usage-half rejection that is a
    // transient db-host lifecycle failure (the child restarting mid-backfill)
    // must not blank the cards to a fatal dash. The combined read still RESOLVES
    // here (the list won the race), so the renderer's query never rejects and
    // never auto-retries the usage half — carry a transient marker so the cards
    // route to the quiet reconnecting surface and drive a bounded refetch. A
    // genuine (non-lifecycle) usage failure leaves the marker absent and stays
    // the honest error state. Nothing about the raw error reaches the renderer;
    // only this boolean does.
    //
    // ISS-5808 (whitlockk review): classified by the TYPED helper, not by the
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
  // Both reads apply the same quality predicate. Keep the usage count from its
  // own aggregate so count, tokens and cost retain one population.
  // ISS-5283 (whitlockk review): scope each FILTERED facet's option counts to every
  // OTHER active filter — see `shared-agent-sessions-facet-usage.ts`. Unfiltered
  // dimensions reuse this summary and issue no extra read.
  const usage = await applyFacetScopedCounts(
    usageResult.value,
    request,
    (relaxed) => getSharedAgentSessionUsage(source, relaxed)
  );
  return { list: listResult.value, usage };
}

async function readSessionStoreRevision(
  source: AgentSessionSyncSource
): Promise<number | null> {
  if (!source.readSessionCompactFilterCapabilities) {
    return null;
  }
  try {
    const capabilities = await source.readSessionCompactFilterCapabilities();
    const revision = capabilities.storeRevision;
    if (
      capabilities.cursor !== SESSION_COMPACT_FILTER_VERSION ||
      capabilities.usage !== SESSION_COMPACT_FILTER_VERSION ||
      !Number.isSafeInteger(revision) ||
      (revision ?? -1) < 0
    ) {
      return null;
    }
    return revision ?? null;
  } catch (error) {
    if (isTransientDbHostError(error)) {
      throw error;
    }
    return null;
  }
}
