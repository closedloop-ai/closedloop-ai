import {
  AGENT_COMPONENT_INVENTORY_CAP,
  type AgentComponent,
  AgentComponentKind,
  AgentComponentSortDir,
  AgentComponentSortKey,
  Harness,
} from "@repo/api/src/types/agent-component";
import {
  AGENT_COMPONENT_PAGE_DATA_MAX_FACET_VALUES,
  AGENT_COMPONENT_PAGE_SIZE,
  type AgentComponentPageDataRequest,
  type AgentComponentPageDataResult,
  hasCompletePriorWindow,
  isUsableUsageBound,
  PRIOR_WINDOW_INCOMPLETE_MESSAGE,
  reduceAgentComponentPageData,
  USAGE_BOUND_INVALID_MESSAGE,
} from "@repo/api/src/utils/agent-component-page-data";
import { collectComponentPopulation } from "@repo/api/src/utils/agent-component-population";
import type { LocPerDollarFold } from "@repo/api/src/utils/agent-component-summary-aggregate";
import { z } from "zod";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import {
  type AgentComponentsReadPrisma,
  listAgentComponentsLocalWithLocPerDollarFold,
} from "./shared-agent-components-api.js";

/**
 * ISS-6822 — the desktop mirror of the cloud `GET /agent-components/page-data`.
 *
 * The renderer used to read the whole local inventory across the IPC boundary
 * and reduce it there. This runs the SAME `@repo/api` reduction in the main
 * process, beside the SQLite read, and sends back only the page plus the compact
 * facet and aggregate results — so the payload crossing IPC is bounded by the
 * page size rather than by how many components the machine has.
 *
 * ISS-6888 brought this to the cloud twin's THREE populations. It used to read
 * one, because the shared list never asked this source for the other two: its
 * capability gate recognised only `agent-components:http` as window-capable, so
 * desktop got neither a preceding-window baseline nor an unwindowed facet
 * universe. That gate was written by FEA-3178 when the local reader really did
 * ignore the window, and was never revisited after FEA-3196 taught it to apply
 * the bounds — so this reader inherited an omission whose reason had expired.
 * Both extra reads are now served, on the same terms as the cloud twin:
 *
 *  - **The unwindowed facet universe**, read when a window is selected AND the
 *    caller asked for it. It is what keeps an owner or source whose components
 *    were idle in the window listed as a zero-count filter option instead of
 *    vanishing from the menu. Both conditions are load-bearing: with no window
 *    the current population already IS unwindowed, and without the explicit ask
 *    this read escapes the rollout gate (see the call site).
 *  - **The preceding equivalent window**, read only when the caller sends BOTH
 *    bounds. Absent, `previous` is omitted and the cards render no delta — never
 *    a zero baseline.
 *
 * Every one of the three is a full local-inventory build, so each is issued only
 * when its own precondition holds; the common case (no window selected) is still
 * the single read this module has always done.
 */
export async function agentComponentsPageDataLocal(
  prisma: AgentComponentsReadPrisma,
  request: AgentComponentPageDataRequest,
  computeTargetId: string | null = null,
  sessionSource?: AgentSessionSyncSource | null
): Promise<AgentComponentPageDataResult> {
  const read = (window: LocalPopulationWindow) =>
    readLocalPopulationWithFold(prisma, window, computeTargetId, sessionSource);
  // Concurrent, like the cloud twin: these are three independent reads and the
  // reduction below needs all three before it can produce anything, so awaiting
  // them in series would add their latencies without lowering the peak.
  const [current, unwindowed, previous] = await Promise.all([
    read(request.startDate ? { startDate: request.startDate } : {}),
    // FEA-3202: skipped when no window is selected, which is the same condition
    // the cloud service and the renderer's own legacy path skip it under — with
    // no bound the current population is already the universe.
    //
    // Its LOC/$ fold is discarded — no card folds the universe. The cloud twin
    // says that by reading this one through a fold-less `readPopulation`; there
    // is no local equivalent to reach for, because `listAgentComponentsLocal`
    // only strips the fold off the SAME read. Nothing is saved by routing
    // through it, so this deliberately does not.
    //
    // ISS-6888: `startDate` alone does NOT authorize it. The bounded request
    // carries `startDate` on every windowed read regardless of whether the
    // caller's source honors the window, so inferring the universe from it would
    // hand a flag-OFF desktop the zero-count facet options this rollout exists to
    // withhold — the perceivable half of ISS-6888 escaping its own gate. An
    // omitted ask defaults to this reader's prior behavior: no universe read.
    request.startDate && request.unwindowedFacetUniverse ? read({}) : undefined,
    // FEA-3178: bounded ABOVE by `prevEnd` so the preceding window cannot
    // overlap the current one.
    request.prevStart && request.prevEnd
      ? read({ endDate: request.prevEnd, startDate: request.prevStart })
      : undefined,
  ]);

  return reduceAgentComponentPageData(
    {
      current: current.items,
      universe: unwindowed?.items ?? current.items,
      // Preserve omission rather than passing `previous: undefined`, so the
      // populations object states "no prior window" the way the wire contract
      // does.
      ...(previous ? { previous: previous.items } : {}),
    },
    {
      filters: request.filters,
      sortBy: request.sortBy,
      sortDir: request.sortDir,
      page: request.page,
      pageSize: request.pageSize,
      honestSource: request.honestSource,
      dedupePluginRollups: request.dedupePluginRollups,
    },
    // ISS-6409: a fold closes over the session maps of the population it was
    // built from, so the preceding window carries ITS OWN fold — reusing the
    // current window's would re-fold the current window's sessions and report
    // the delta against itself.
    {
      current: current.foldLocPerDollar,
      ...(previous ? { previous: previous.foldLocPerDollar } : {}),
    }
  );
}

/** The usage bounds one population read is taken under; absent ⇒ unbounded. */
type LocalPopulationWindow = { startDate?: string; endDate?: string };

/**
 * One COMPLETE local population for a usage window, plus the LOC/$ fold over its
 * own sessions — or a throw.
 *
 * The read is unnarrowed: the facets are applied by the shared reduction so the
 * facet COUNTS describe the same population the rows are drawn from, the
 * identical arrangement the renderer had.
 *
 * ISS-6891: the read is PAGINATED, so the pages are followed rather than the
 * first one being taken for the population. A machine with more components than
 * one page would otherwise have had its facet menu, both summary aggregates, and
 * its row count computed from a prefix and presented as the whole. The follower
 * is shared with the cloud mirror so the two cannot disagree.
 *
 * ISS-6409: the LOC/$ fold rides the SAME read and is taken from the read whose
 * rows are kept — a fold over a prefix is the summary card's half of the same
 * truncation, and the card renders an exact number either way.
 */
async function readLocalPopulationWithFold(
  prisma: AgentComponentsReadPrisma,
  window: LocalPopulationWindow,
  computeTargetId: string | null,
  sessionSource: AgentSessionSyncSource | null | undefined
): Promise<{ items: AgentComponent[]; foldLocPerDollar: LocPerDollarFold }> {
  let foldLocPerDollar: LocPerDollarFold | undefined;
  const population = await collectComponentPopulation(
    async (page) => {
      const response = await listAgentComponentsLocalWithLocPerDollarFold(
        prisma,
        {
          ...page,
          ...(window.startDate ? { startDate: window.startDate } : {}),
          ...(window.endDate ? { endDate: window.endDate } : {}),
        },
        computeTargetId,
        sessionSource
      );
      foldLocPerDollar = response.foldLocPerDollar;
      return response;
    },
    // #6483: an in-process SQLite read, not the IPC surface, so the renderer's
    // page ceiling does not apply and the remainder is asked for in ONE call.
    // The reader builds and collapses the whole local inventory before slicing,
    // so a page walk paid that build once per page. Asking for the remainder in
    // one request is also what keeps the fold's precondition (see
    // `listAgentComponentsLocalWithLocPerDollarFold`): the retained rows come
    // from a single read whose page spans the whole population.
    {
      pageSize: AGENT_COMPONENT_INVENTORY_CAP,
      maxPageSize: Number.POSITIVE_INFINITY,
    }
  );
  // ISS-6891: `hasMore` here means the follower could NOT exhaust the population
  // — the local reader stopped short of its own `total`. The reduction computes
  // facet counts and both summary aggregates over what came back, so taking the
  // rows without reading this flag would serve a partial inventory as the
  // machine's whole one.
  //
  // #6483 (whitlockk, chatgpt-codex-connector): it FAILS instead of reducing, for the
  // same reason `parseAgentComponentPageDataRequest` throws rather than
  // defaulting — a list that says it could not load beats one that answers a
  // narrower question than the one on screen. The renderer's local data source
  // wraps this into its sanitized `ApiError` and the Agents list renders its real
  // error state. Kept identical to the cloud mirror so the two surfaces cannot
  // disagree about what an unexhausted population means.
  if (population.hasMore) {
    const detail = `read ${population.items.length} of a reported ${population.total}`;
    gatewayLog.error(PAGE_DATA_LOG_TAG, `partial population: ${detail}`);
    throw new Error(
      `${AGENT_COMPONENTS_PAGE_DATA_PARTIAL_POPULATION_CODE}: ${detail}`
    );
  }
  if (!foldLocPerDollar) {
    // The follower always reads at least one page, so this cannot be reached
    // from a completed read; it exists so the fold is never `undefined` at the
    // type level, and it FAILS rather than folding nothing, which would report
    // LOC/$ unavailable for a population that was in fact read.
    throw new Error(
      `${AGENT_COMPONENTS_PAGE_DATA_PARTIAL_POPULATION_CODE}: no page was read`
    );
  }
  return { foldLocPerDollar, items: population.items };
}

/**
 * Compile-time coverage guard for the schema below.
 *
 * `satisfies Record<keyof AgentComponentPageDataRequest, z.ZodTypeAny>` makes
 * the shape TOTAL over the request contract: a field added to
 * `AgentComponentPageDataRequest` without a decision here fails `tsc`, and so
 * does a schema key the type does not declare. That is the point — the omission
 * this guard was added for looked exactly like an absent key, and Zod's default
 * unknown-key stripping turned it into a clean parse rather than an error. The
 * next field now has to be carried or explicitly rejected before it compiles.
 */
type PageDataRequestSchemaShape = Record<
  keyof AgentComponentPageDataRequest,
  z.ZodTypeAny
>;

/**
 * The page-data request as it arrives over IPC: `unknown`, from a renderer whose
 * version is not this process's to assume.
 *
 * Parsed rather than cast. A structured-clone payload is a real trust boundary,
 * and a bad value here would not throw on its own — it would quietly reduce a
 * differently-narrowed population and hand back numbers the Agents list presents
 * as measured.
 *
 * ABSENCE is the only thing that defaults. Every optional field's absence has a
 * meaning this contract already fixes — no `startDate` is the all-time view, an
 * unsent gate is closed — so a request from an older renderer parses cleanly.
 * A field that is PRESENT and unusable does not default: there is no honest
 * value to substitute for a narrowing the caller asked for and this build cannot
 * apply, and answering a different question is the failure mode this whole
 * module exists to avoid.
 *
 * "Unusable" is a question about the VALUE, not only its type, and the two
 * window rules below are where that distinction has teeth (whitlockk review, #6725).
 * A `prevStart` of `"not-a-date"` is a string, so a type-only schema passed it
 * straight through — and `coerceIsoBound` then dropped it downstream, leaving
 * the surviving `prevEnd` to bound a baseline that reached back over ALL
 * history. The cards rendered a delta against that wrong baseline with no error
 * anywhere: a plausible, wrong number, which is the one outcome this module
 * refuses. The predicates come from `@repo/api` so this boundary and the HTTP
 * query validator enforce one rule rather than two spellings of it.
 */

const usageBoundSchema = z
  .string()
  .refine(isUsableUsageBound, USAGE_BOUND_INVALID_MESSAGE);

/**
 * A multi-select facet, bounded the way the HTTP validator bounds it (ISS-9073,
 * marisolashgrove review, #6715): de-duplicated on the raw value, then capped at
 * the SHARED {@link AGENT_COMPONENT_PAGE_DATA_MAX_FACET_VALUES} rather than a
 * number written out here.
 *
 * `packages/app/agents/data-source` drives this reader and the cloud route off
 * ONE filter selection — web and cloud-mode desktop take the route, local mode
 * takes this module — so a bound on only one of them makes the same selection a
 * 200 in local mode and a 400 in cloud. The narrowing this refuses is in-memory
 * `O(rows x N)` filtering over the whole org population in either place, so the
 * answer has to be the same in both; pointing both at the one constant is what
 * stops them drifting apart again.
 */
function facetArray<T extends z.ZodTypeAny>(element: T) {
  return z
    .preprocess(
      (value) => (Array.isArray(value) ? [...new Set(value)] : value),
      z.array(element).max(AGENT_COMPONENT_PAGE_DATA_MAX_FACET_VALUES)
    )
    .default([]);
}

const pageDataRequestSchema = z
  .object({
    filters: z
      .object({
        kinds: facetArray(z.enum(AgentComponentKind)),
        collaborators: facetArray(z.string()),
        sources: facetArray(z.string()),
        harnesses: facetArray(z.enum(Harness)),
        search: z.string().default(""),
      })
      .default({
        kinds: [],
        collaborators: [],
        sources: [],
        harnesses: [],
        search: "",
      }),
    sortBy: z.enum(AgentComponentSortKey).default(AgentComponentSortKey.Name),
    sortDir: z.enum(AgentComponentSortDir).default(AgentComponentSortDir.Asc),
    page: z.number().int().nonnegative().default(0),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(AGENT_COMPONENT_INVENTORY_CAP)
      .default(AGENT_COMPONENT_PAGE_SIZE),
    honestSource: z.boolean().default(false),
    dedupePluginRollups: z.boolean().default(false),
    startDate: usageBoundSchema.optional(),
    // ISS-6888: CARRIED, where they were previously rejected. Rejecting was right
    // while this reader could not produce a baseline — the alternative, leaving the
    // keys off the schema, was the silent drop the module's doctrine forbids, since
    // Zod strips unknown keys and the caller could not then tell "there is no prior
    // period" from "this build never looked". Now `agentComponentsPageDataLocal`
    // reads the preceding window, so the honest answer to a caller that sends both
    // bounds is the baseline, not an error.
    prevStart: usageBoundSchema.optional(),
    prevEnd: usageBoundSchema.optional(),
    // ISS-6888: absence defaults CLOSED, which is this reader's prior behavior —
    // it never read an unwindowed universe. So a renderer that predates the field
    // keeps the surface it had, and only a caller that explicitly asks gets the
    // second population build.
    unwindowedFacetUniverse: z.boolean().default(false),
  } satisfies PageDataRequestSchemaShape)
  .refine(hasCompletePriorWindow, {
    message: PRIOR_WINDOW_INCOMPLETE_MESSAGE,
    path: ["prevStart"],
  });

/**
 * Error code for a page-data request this build cannot honor.
 *
 * The renderer's local data source wraps a rejected read into its sanitized
 * `ApiError`, so the Agents list renders its real error state. That is the
 * intended outcome: a list that says it could not load beats a list that
 * silently answers a narrower or wider question than the one on screen, which is
 * what returning a defaulted request would produce — the type tab and filter
 * chips would still claim a narrowing the page, the facet counts, and the
 * summary totals no longer describe.
 */
export const AGENT_COMPONENTS_PAGE_DATA_BAD_REQUEST_CODE =
  "AGENT_COMPONENTS_PAGE_DATA_BAD_REQUEST" as const;

/**
 * Parse untrusted IPC input into a page-data request, or throw.
 *
 * Throwing is the deliberate choice over a defaulted fallback — see
 * {@link AGENT_COMPONENTS_PAGE_DATA_BAD_REQUEST_CODE}. It is not a
 * compatibility break for a renderer that predates a field, because absence
 * still defaults; it only fires for a field that is present and unusable, which
 * within one packaged binary is a bug rather than a supported skew.
 */
export function parseAgentComponentPageDataRequest(
  value: unknown
): AgentComponentPageDataRequest {
  const parsed = pageDataRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${AGENT_COMPONENTS_PAGE_DATA_BAD_REQUEST_CODE}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`
    );
  }
  return parsed.data;
}

/** Log tag for the desktop page-data read, so its events group in the gateway log. */
const PAGE_DATA_LOG_TAG = "agent-components-page-data";

/**
 * Error code for a local inventory read that could not be exhausted.
 *
 * Sibling of {@link AGENT_COMPONENTS_PAGE_DATA_BAD_REQUEST_CODE} and thrown for
 * the same reason: the honest answer to "I could not read the whole population"
 * is a failed read, not facet counts and summary aggregates computed over a
 * prefix and rendered as the machine's inventory.
 */
export const AGENT_COMPONENTS_PAGE_DATA_PARTIAL_POPULATION_CODE =
  "AGENT_COMPONENTS_PAGE_DATA_PARTIAL_POPULATION" as const;
