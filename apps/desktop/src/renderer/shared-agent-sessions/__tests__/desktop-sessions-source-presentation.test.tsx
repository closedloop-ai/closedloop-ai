import {
  type AgentSessionListResponse,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import { ReadSource } from "@repo/api/src/types/read-source";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import type { QueryKey } from "@tanstack/react-query";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { resolveDesktopSessionsCapabilityPresentation } from "../../components/sessions/desktop-sessions-capability-presentation";
import {
  CACHED_CLOUD_SESSIONS_SOURCE_STATE,
  CLOUD_FRESH_SESSIONS_SOURCE_STATE,
  DesktopSessionsListCompleteness,
  DesktopSessionsListFreshness,
  DesktopSessionsListSource,
  getDesktopSessionsListSourceState,
  markDesktopSessionsListSourceState,
  reconcileDesktopSessionsFallback,
  toDesktopCachedCloudFallbackList,
} from "../desktop-session-source-precedence";
import { resolveDesktopSessionsSourcePresentation } from "../desktop-sessions-source-presentation";

function response(
  readSource?: AgentSessionListResponse["readSource"]
): AgentSessionListResponse {
  return {
    items: [],
    readSource,
    total: 0,
    viewerScope: AgentSessionViewerScope.Organization,
  };
}

describe("Desktop Sessions source presentation", () => {
  it("keeps flag-off cloud capability seams equal to the legacy source", () => {
    expect(
      resolveDesktopSessionsCapabilityPresentation({
        isCloudMode: true,
        items: [],
        sourcePrecedenceActive: false,
        sourceSupportsPriority: true,
        useCloudCapabilityDefaults: false,
      })
    ).toEqual({
      hasCustomFieldOperands: true,
      hasLinkedEntityOperands: true,
      hasTagOperands: true,
      showPriorityColumn: true,
    });
  });

  it("keeps flag-off local mode gates while Priority follows its writer", () => {
    expect(
      resolveDesktopSessionsCapabilityPresentation({
        isCloudMode: false,
        items: [],
        sourcePrecedenceActive: false,
        sourceSupportsPriority: true,
        useCloudCapabilityDefaults: false,
      })
    ).toEqual({
      hasCustomFieldOperands: false,
      hasLinkedEntityOperands: false,
      hasTagOperands: false,
      showPriorityColumn: true,
    });
  });

  it("keeps enabled fresh-cloud source defaults on an empty page", () => {
    expect(
      resolveDesktopSessionsCapabilityPresentation({
        isCloudMode: true,
        items: [],
        sourcePrecedenceActive: true,
        sourceSupportsPriority: true,
        useCloudCapabilityDefaults: true,
      })
    ).toEqual({
      hasCustomFieldOperands: true,
      hasLinkedEntityOperands: true,
      hasTagOperands: true,
      showPriorityColumn: true,
    });
  });

  it("derives enabled fallback seams from operands, including read-only Priority", () => {
    const localFallback = createAgentSessionListItemFixture({
      customFields: [],
      id: "local-fallback",
      priority: null,
      tags: [],
    });
    Reflect.deleteProperty(localFallback, "linkedArtifacts");
    Reflect.deleteProperty(localFallback, "project");

    expect(
      resolveDesktopSessionsCapabilityPresentation({
        isCloudMode: true,
        items: [localFallback],
        sourcePrecedenceActive: true,
        sourceSupportsPriority: false,
        useCloudCapabilityDefaults: false,
      })
    ).toEqual({
      hasCustomFieldOperands: true,
      hasLinkedEntityOperands: false,
      hasTagOperands: true,
      showPriorityColumn: true,
    });
  });

  it("withholds custom-field seams when any populated fallback row lacks the operand", () => {
    const cloudRow = createAgentSessionListItemFixture({ customFields: [] });
    const localRow = createAgentSessionListItemFixture();
    Reflect.deleteProperty(localRow, "customFields");

    expect(
      resolveDesktopSessionsCapabilityPresentation({
        isCloudMode: true,
        items: [cloudRow, localRow],
        sourcePrecedenceActive: true,
        sourceSupportsPriority: true,
        useCloudCapabilityDefaults: false,
      }).hasCustomFieldOperands
    ).toBe(false);
  });

  it("retains cached-cloud provenance when structurally equal business data refetches", async () => {
    const client = new QueryClient();
    const queryKey = ["desktop-sessions-provenance"] satisfies QueryKey;
    const freshPayload = response(ReadSource.Cloud);
    const cachedPayload = response(ReadSource.Cloud);
    expect(cachedPayload).toEqual(freshPayload);
    const freshCloud = markDesktopSessionsListSourceState(
      freshPayload,
      CLOUD_FRESH_SESSIONS_SOURCE_STATE
    );
    const cachedCloud = markDesktopSessionsListSourceState(
      cachedPayload,
      CACHED_CLOUD_SESSIONS_SOURCE_STATE
    );
    const queryFn = vi
      .fn<() => Promise<AgentSessionListResponse>>()
      .mockResolvedValueOnce(freshCloud)
      .mockResolvedValueOnce(cachedCloud);

    await client.fetchQuery({ queryFn, queryKey });
    await client.invalidateQueries({ queryKey });
    await client.fetchQuery({ queryFn, queryKey });

    const retained = client.getQueryData<AgentSessionListResponse>(queryKey);
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(retained).not.toBe(freshCloud);
    expect(getDesktopSessionsListSourceState(retained)).toEqual({
      completeness: DesktopSessionsListCompleteness.Partial,
      freshness: DesktopSessionsListFreshness.Stale,
      hasKnownTotal: true,
      source: DesktopSessionsListSource.CachedCloud,
    });
    expect(
      resolveDesktopSessionsSourcePresentation({
        sourcePrecedenceActive: true,
        response: retained,
      })
    ).toEqual({
      isPaginationTotalKnown: true,
      isPopulationComplete: false,
      useCloudCapabilityDefaults: false,
    });
  });

  it("AC-010 DT-SP-16 treats an older response with absent provenance conservatively", () => {
    const result = resolveDesktopSessionsSourcePresentation({
      sourcePrecedenceActive: true,
      response: response(),
    });

    expect(result).toEqual({
      isPaginationTotalKnown: false,
      isPopulationComplete: false,
      useCloudCapabilityDefaults: false,
    });
  });

  it("AC-001 AC-010 DT-SP-01 DT-SP-16 accepts the established cloud discriminator from an older producer", () => {
    expect(
      resolveDesktopSessionsSourcePresentation({
        sourcePrecedenceActive: true,
        response: response(ReadSource.Cloud),
      })
    ).toEqual({
      isPaginationTotalKnown: true,
      isPopulationComplete: true,
      useCloudCapabilityDefaults: true,
    });
  });

  it("AC-008 DT-SP-11 withholds a mixed-source label while retaining partial state", () => {
    const fallback = reconcileDesktopSessionsFallback({
      cachedCloud: response(ReadSource.Cloud),
      limit: 25,
      local: response(ReadSource.Local),
    });

    expect(
      resolveDesktopSessionsSourcePresentation({
        sourcePrecedenceActive: true,
        response: fallback,
      })
    ).toMatchObject({
      isPopulationComplete: false,
      useCloudCapabilityDefaults: false,
    });
  });

  it("keeps stale cached-cloud evidence partial without source UI state", () => {
    const cachedCloud = toDesktopCachedCloudFallbackList(
      response(ReadSource.Cloud)
    );

    expect(
      resolveDesktopSessionsSourcePresentation({
        sourcePrecedenceActive: true,
        response: cachedCloud,
      })
    ).toEqual({
      isPaginationTotalKnown: true,
      isPopulationComplete: false,
      useCloudCapabilityDefaults: false,
    });
  });

  it("keeps the legacy flag-off HTTP presentation complete", () => {
    expect(
      resolveDesktopSessionsSourcePresentation({
        sourcePrecedenceActive: false,
        response: response(ReadSource.Cloud),
      })
    ).toEqual({
      isPaginationTotalKnown: true,
      isPopulationComplete: true,
      useCloudCapabilityDefaults: false,
    });
  });
});
