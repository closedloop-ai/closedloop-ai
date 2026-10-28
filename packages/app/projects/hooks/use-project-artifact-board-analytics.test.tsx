import { ProjectArtifactBoardGroup } from "@repo/api/src/types/project-artifact-board-page";
import {
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  type ProjectArtifactPlacementResponse,
} from "@repo/api/src/types/project-artifact-placement";
import {
  ProjectArtifactBoardAnalyticsFailureKind,
  ProjectArtifactBoardAnalyticsLoadSource,
  ProjectArtifactBoardAnalyticsOutcome,
  ProjectArtifactBoardAnalyticsSignal,
  ProjectArtifactBoardHostAvailability,
  Surface,
  type SurfaceAnalyticsCapture,
  SurfaceAnalyticsEvent,
} from "@repo/api/src/types/surface-analytics";
import { ApiError } from "@repo/app/shared/api/api-error";
import { SurfaceAnalyticsProvider } from "@repo/app/shared/observability/surface-analytics-context";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { useProjectArtifactBoardAnalytics } from "./use-project-artifact-board-analytics";

const capture = vi.fn<SurfaceAnalyticsCapture>();
const TRANSACTION_ID = "11111111-1111-7111-8111-111111111111";
const RESPONSE: ProjectArtifactPlacementResponse = {
  affectedArtifactIds: [TRANSACTION_ID],
  affectedProjectIds: ["22222222-2222-7222-8222-222222222222"],
  placed: true,
  placement: {
    destinationProjectId: "22222222-2222-7222-8222-222222222222",
    position: ProjectArtifactPlacementPosition.Root,
    sourceArtifactIds: [TRANSACTION_ID],
  },
  projectVersions: {
    "22222222-2222-7222-8222-222222222222": "version-1",
  },
  replayed: false,
  transactionId: TRANSACTION_ID,
  undoAvailable: true,
};

type HookInput = Parameters<typeof useProjectArtifactBoardAnalytics>[0];

const BASE_INPUT: HookInput = {
  boardError: null,
  cardCount: 0,
  destinationError: null,
  groupBy: ProjectArtifactBoardGroup.Status,
  isLoaded: false,
  laneCount: 0,
  mutationError: null,
  mutationOperation: null,
  mutationResponse: undefined,
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
      {children}
    </SurfaceAnalyticsProvider>
  );
}

describe("CT-13 AC-009 Project Artifact Board analytics wiring", () => {
  beforeEach(() => {
    capture.mockReset();
  });

  it("emits reach, current host parity, and one bounded performance sample", () => {
    const rendered = renderHook(
      ({ input }: { input: HookInput }) =>
        useProjectArtifactBoardAnalytics(input),
      { initialProps: { input: BASE_INPUT }, wrapper }
    );

    expect(capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.ProjectArtifactBoardObserved,
      expect.objectContaining({
        group_by: ProjectArtifactBoardGroup.Status,
        signal: ProjectArtifactBoardAnalyticsSignal.Reach,
        surface: Surface.Web,
      })
    );
    expect(capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.ProjectArtifactBoardObserved,
      expect.objectContaining({
        host_availability: ProjectArtifactBoardHostAvailability.Paired,
        signal: ProjectArtifactBoardAnalyticsSignal.HostParity,
      })
    );

    rendered.rerender({
      input: { ...BASE_INPUT, cardCount: 24, isLoaded: true, laneCount: 6 },
    });
    expect(capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.ProjectArtifactBoardObserved,
      expect.objectContaining({
        card_count_bucket: "21-100",
        lane_count_bucket: "6-20",
        signal: ProjectArtifactBoardAnalyticsSignal.Performance,
      })
    );
    expect(
      capture.mock.calls.filter(
        ([, properties]) =>
          properties.signal === ProjectArtifactBoardAnalyticsSignal.Performance
      )
    ).toHaveLength(1);
  });

  it("classifies version-skew and destination load failures without payload data", () => {
    const skew = z.object({ version: z.literal(1) }).safeParse({ version: 2 });
    if (skew.success) {
      throw new Error("fixture must be invalid");
    }
    const rendered = renderHook(
      ({ input }: { input: HookInput }) =>
        useProjectArtifactBoardAnalytics(input),
      { initialProps: { input: BASE_INPUT }, wrapper }
    );
    capture.mockClear();

    rendered.rerender({
      input: { ...BASE_INPUT, boardError: skew.error },
    });
    rendered.rerender({
      input: {
        ...BASE_INPUT,
        destinationError: new ApiError("private destination detail", 0),
      },
    });

    expect(capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.ProjectArtifactBoardObserved,
      expect.objectContaining({
        failure_kind: ProjectArtifactBoardAnalyticsFailureKind.Contract,
        load_source: ProjectArtifactBoardAnalyticsLoadSource.BoardRead,
      })
    );
    expect(capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.ProjectArtifactBoardObserved,
      expect.objectContaining({
        failure_kind: ProjectArtifactBoardAnalyticsFailureKind.Network,
        load_source: ProjectArtifactBoardAnalyticsLoadSource.DestinationRead,
      })
    );
    for (const [, properties] of capture.mock.calls) {
      expect(Object.keys(properties).some((key) => key.endsWith("_id"))).toBe(
        false
      );
    }
  });

  it("separates move conflicts from failed and successful rollback", () => {
    const rendered = renderHook(
      ({ input }: { input: HookInput }) =>
        useProjectArtifactBoardAnalytics(input),
      { initialProps: { input: BASE_INPUT }, wrapper }
    );
    capture.mockClear();

    rendered.rerender({
      input: {
        ...BASE_INPUT,
        mutationError: new ApiError("stale", 409),
        mutationOperation: ProjectArtifactPlacementKind.Place,
      },
    });
    rendered.rerender({
      input: {
        ...BASE_INPUT,
        mutationError: { future: "failure" },
        mutationOperation: ProjectArtifactPlacementKind.Undo,
      },
    });
    rendered.rerender({
      input: {
        ...BASE_INPUT,
        mutationOperation: ProjectArtifactPlacementKind.Undo,
        mutationResponse: RESPONSE,
      },
    });

    expect(capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.ProjectArtifactBoardObserved,
      expect.objectContaining({
        signal: ProjectArtifactBoardAnalyticsSignal.MoveConflict,
      })
    );
    expect(capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.ProjectArtifactBoardObserved,
      expect.objectContaining({
        failure_kind: ProjectArtifactBoardAnalyticsFailureKind.Unknown,
        outcome: ProjectArtifactBoardAnalyticsOutcome.Failed,
        signal: ProjectArtifactBoardAnalyticsSignal.Rollback,
      })
    );
    expect(capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.ProjectArtifactBoardObserved,
      expect.objectContaining({
        outcome: ProjectArtifactBoardAnalyticsOutcome.Succeeded,
        signal: ProjectArtifactBoardAnalyticsSignal.Rollback,
      })
    );
  });

  it("emits no conflict or rollback signal for a non-target move failure", () => {
    const rendered = renderHook(
      ({ input }: { input: HookInput }) =>
        useProjectArtifactBoardAnalytics(input),
      { initialProps: { input: BASE_INPUT }, wrapper }
    );
    capture.mockClear();

    rendered.rerender({
      input: {
        ...BASE_INPUT,
        mutationError: new ApiError("server", 500),
        mutationOperation: ProjectArtifactPlacementKind.Place,
      },
    });

    expect(capture).not.toHaveBeenCalled();
  });
});
