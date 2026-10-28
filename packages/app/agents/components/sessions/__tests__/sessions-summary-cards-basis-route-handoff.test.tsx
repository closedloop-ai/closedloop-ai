/**
 * @file sessions-summary-cards-basis-route-handoff.test.tsx
 * @description ISS-9978 at the SKEW BOUNDARY — `/agent-sessions/usage` — rather
 * than at the component's props.
 *
 * WHY THIS EXISTS SEPARATELY (davetho, #7020). Its sibling
 * `sessions-summary-cards-loc-per-dollar-basis.test.tsx` hands
 * `SessionsSummaryCards` a usage object directly, so it grades the FOLD and
 * nothing above it. But the basis only ever reaches this client by crossing one
 * seam: the web Sessions surface reads `/agent-sessions/usage` through
 * `createHttpAgentSessionsDataSource`, and a newer API is exactly where an
 * unrecognized basis comes from. That read is a bare `api.get<T>()` — a TYPE
 * ASSERTION over the transport, with no runtime schema to keep the field alive —
 * so anything that later narrows, re-shapes, or re-validates the usage payload
 * drops `mergedLocPerDollarBasis` silently, the card reverts to the compiled-in
 * "LOC / $" label and "across sessions in range" caption, and every
 * component-level case stays green while production resumes describing a ratio
 * the server declined to name.
 *
 * So this drives the REAL data source over a mocked response and renders what
 * comes back out of it. The assertions are the coarsened copy AND the retained
 * value: coarsening must not withdraw the number the reader came for.
 */

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { MergedLocPerDollarBasis } from "@repo/api/src/types/merged-loc-per-dollar-basis";
import { createHttpAgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createAgentSessionUsageSummaryFixture } from "../session-list-fixtures";
import { SessionsSummaryCards } from "../sessions-summary-cards";

const USAGE_PATH = "/agent-sessions/usage";
const START_DATE = "2026-08-04T00:00:00.000Z";

/** The ratio every response below publishes, so only the BASIS distinguishes them. */
const RATIO_TEXT = "3.50";

/** The shipped label and caption — what a stated or absent basis must keep. */
const SHIPPED_LABEL = "LOC / $";
const SHIPPED_DETAIL = "across sessions in range";

/** What a basis this build never compiled against must coarsen to. */
const UNRECOGNIZED_LABEL = "Efficiency ratio";
const UNRECOGNIZED_DETAIL = "scope not stated";

/**
 * A basis from a server newer than this build. Written as a raw JSON body the
 * way the transport really delivers one, so no annotation in this file narrows
 * it on the way in — the open consumer field is the contract under test.
 */
const NEWER_SERVER_BODY = `{
  "mergedLocPerDollar": 3.5,
  "mergedLocPerDollarBasis": "pensero_points_over_total_cost"
}`;

/**
 * Reads the usage summary through the real HTTP data source, with the wire body
 * supplied by the caller. `get` is the only seam the source has, so this is the
 * production path from the route response to the object the page renders.
 */
async function readUsageFromRoute(
  body: Partial<AgentSessionUsageSummary>
): Promise<{ requestedPaths: string[]; usage: AgentSessionUsageSummary }> {
  const requestedPaths: string[] = [];
  const source = createHttpAgentSessionsDataSource({
    get: <T,>(path: string): Promise<T> => {
      requestedPaths.push(path);
      return Promise.resolve(
        createAgentSessionUsageSummaryFixture(
          AgentSessionViewerScope.Organization,
          {
            mergedPrCount: 7,
            totalEstimatedCost: 42,
            totalSessions: 12,
            ...body,
          }
        ) as T
      );
    },
  });

  const usage = await source.usage({ startDate: START_DATE });
  return { requestedPaths, usage };
}

function renderFromRoute(usage: AgentSessionUsageSummary) {
  render(
    <SessionsSummaryCards authenticated isLoading={false} usage={usage} />
  );
}

describe("ISS-9978 — the basis survives the /agent-sessions/usage handoff", () => {
  it("coarsens the label and the caption for a basis the route delivered from a newer server", async () => {
    const { requestedPaths, usage } = await readUsageFromRoute(
      JSON.parse(NEWER_SERVER_BODY)
    );

    renderFromRoute(usage);

    expect(requestedPaths.some((path) => path.startsWith(USAGE_PATH))).toBe(
      true
    );
    expect(screen.getByText(UNRECOGNIZED_LABEL)).toBeInTheDocument();
    expect(screen.getByText(UNRECOGNIZED_DETAIL)).toBeInTheDocument();
    // THE REGRESSION this file exists for: if the handoff drops the basis, both
    // of these come back and the card resumes naming a ratio the response
    // declined to name — with every component-level case still green.
    expect(screen.queryByText(SHIPPED_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText(SHIPPED_DETAIL)).not.toBeInTheDocument();
  });

  it("still renders the ratio the route returned once the copy coarsens", async () => {
    const { requestedPaths, usage } = await readUsageFromRoute(
      JSON.parse(NEWER_SERVER_BODY)
    );

    renderFromRoute(usage);

    expect(requestedPaths.some((path) => path.startsWith(USAGE_PATH))).toBe(
      true
    );
    // Coarsening the copy must not withdraw the number. Without this, a change
    // that hid the whole card would satisfy the negatives above.
    expect(screen.getByText(RATIO_TEXT)).toBeInTheDocument();
  });

  it.each([
    [
      "a basis this build knows",
      {
        mergedLocPerDollarBasis:
          MergedLocPerDollarBasis.MergedLinesOverTotalCost,
      },
    ],
    ["a producer that states none", {}],
  ])(
    "keeps the shipped label and caption for %s",
    async (_case, overrides: Partial<AgentSessionUsageSummary>) => {
      // The positive siblings, on the SAME locators as the negatives above and
      // through the same route seam. Every server deployed today lands on one of
      // these two arms, which is what makes ISS-9978 non-perceivable in
      // production: the only render that moves needs a server newer than this
      // client.
      const { requestedPaths, usage } = await readUsageFromRoute({
        mergedLocPerDollar: 3.5,
        ...overrides,
      });

      renderFromRoute(usage);

      expect(requestedPaths.some((path) => path.startsWith(USAGE_PATH))).toBe(
        true
      );
      expect(screen.getByText(SHIPPED_LABEL)).toBeInTheDocument();
      expect(screen.getByText(SHIPPED_DETAIL)).toBeInTheDocument();
      expect(screen.queryByText(UNRECOGNIZED_LABEL)).not.toBeInTheDocument();
      expect(screen.queryByText(UNRECOGNIZED_DETAIL)).not.toBeInTheDocument();
      cleanup();
    }
  );
});
