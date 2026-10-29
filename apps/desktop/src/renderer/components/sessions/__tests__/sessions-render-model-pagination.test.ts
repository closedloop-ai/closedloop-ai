import {
  type AgentSessionListResponse,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import { SESSION_LIST_MAX_OFFSET } from "@repo/api/src/types/agent-session-list-limits";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SessionsListReadState } from "@repo/app/agents/lib/sessions-list-read-state";
import { describe, expect, it } from "vitest";
import { buildSessionsRenderModel, PAGE_SIZE } from "../sessions-render-model";

/**
 * The render model's half of the ISS-9074 cap: given a ceiling it advertises
 * only the pages a capped read can serve, and given none it advertises them
 * all. WHICH of those two a mode gets is `SessionsView`'s decision and is not
 * reachable from here — `sessions-view-max-offset-cap.test.tsx` mounts the
 * view and pins that split against the outgoing read.
 */

// Only `total` matters here — the cap is derived from the row count alone —
// but the response is built whole rather than cast, so a new required field
// fails typecheck instead of being papered over.
const listResponse = (total: number): AgentSessionListResponse => ({
  items: [],
  total,
  viewerScope: AgentSessionViewerScope.Organization,
});

function buildModel(total: number, maxOffset?: number) {
  return buildSessionsRenderModel({
    displayState: "ready",
    maxOffset,
    sessionsData: listResponse(total),
    facetUsage: undefined,
    repositoryBreakdown: undefined,
  });
}

describe("buildSessionsRenderModel maxOffset cap", () => {
  it("does not promote a starting source fallback zero to a known total", () => {
    const model = buildSessionsRenderModel({
      displayState: "starting",
      sessionsData: undefined,
      facetUsage: undefined,
      repositoryBreakdown: undefined,
    });

    expect(model).toMatchObject({
      readState: SessionsListReadState.Syncing,
      total: 0,
      totalRowsKnown: false,
    });
    expect(model.knownTotal).toBeUndefined();
  });

  it("does not state a cached placeholder total as settled", () => {
    const model = buildSessionsRenderModel({
      displayState: "ready",
      isPlaceholderData: true,
      sessionsData: listResponse(431),
      facetUsage: undefined,
      repositoryBreakdown: undefined,
    });

    expect(model).toMatchObject({
      readState: SessionsListReadState.Placeholder,
      total: 0,
      totalPages: 1,
      totalRowsKnown: false,
    });
    expect(model.knownTotal).toBeUndefined();
  });

  it("AC-007 DT-SP-10 keeps a known local fallback total reachable while marking rows partial", () => {
    const model = buildSessionsRenderModel({
      displayState: "ready",
      isPopulationComplete: false,
      sessionsData: {
        ...listResponse(431),
        items: [
          createAgentSessionListItemFixture({
            externalSessionId: "fallback-session",
            id: "fallback-session",
          }),
        ],
      },
      facetUsage: undefined,
      repositoryBreakdown: undefined,
    });

    expect(model).toMatchObject({
      hasRenderableData: true,
      readState: SessionsListReadState.Partial,
      total: 431,
      totalPages: 18,
      totalRowsKnown: true,
    });
    expect(model.knownTotal).toBe(431);
  });

  it("keeps the pre-feature zero default when a partial total is genuinely unknown", () => {
    const model = buildSessionsRenderModel({
      displayState: "ready",
      isPaginationTotalKnown: false,
      isPopulationComplete: false,
      sessionsData: {
        ...listResponse(431),
        items: [createAgentSessionListItemFixture()],
      },
      facetUsage: undefined,
      repositoryBreakdown: undefined,
    });

    expect(model).toMatchObject({
      readState: SessionsListReadState.Partial,
      total: 0,
      totalPages: 1,
      totalRowsKnown: false,
    });
    expect(model.knownTotal).toBeUndefined();
  });

  it("keeps a known cached or mixed total pageable while marking it partial", () => {
    const model = buildSessionsRenderModel({
      displayState: "ready",
      isPaginationTotalKnown: true,
      isPopulationComplete: false,
      sessionsData: {
        ...listResponse(51),
        items: [createAgentSessionListItemFixture({ id: "session-26" })],
      },
      facetUsage: undefined,
      repositoryBreakdown: undefined,
    });

    expect(model).toMatchObject({
      knownTotal: 51,
      readState: SessionsListReadState.Partial,
      total: 51,
      totalPages: 3,
      totalRowsKnown: true,
    });
  });

  it("caps totalPages at the last page the ceiling can serve", () => {
    expect(buildModel(30_000, SESSION_LIST_MAX_OFFSET).totalPages).toBe(401);
  });

  it("advertises every page the rows imply when there is no ceiling", () => {
    expect(buildModel(30_000).totalPages).toBe(1200);
  });

  it("uses the raw count when it is already below the ceiling", () => {
    expect(buildModel(500, SESSION_LIST_MAX_OFFSET).totalPages).toBe(20);
  });

  it("keeps the last page servable: its offset is at most the ceiling", () => {
    const { totalPages } = buildModel(30_000, SESSION_LIST_MAX_OFFSET);
    const lastPageOffset = (totalPages - 1) * PAGE_SIZE;
    expect(lastPageOffset).toBeLessThanOrEqual(SESSION_LIST_MAX_OFFSET);
    // And it is the LAST such page — one more would cross the ceiling, so an
    // off-by-one that under-advertises is caught here too.
    expect(lastPageOffset + PAGE_SIZE).toBeGreaterThan(SESSION_LIST_MAX_OFFSET);
  });
});
