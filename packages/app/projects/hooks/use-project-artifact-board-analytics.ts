"use client";

import type { ProjectArtifactBoardGroup } from "@repo/api/src/types/project-artifact-board-page";
import {
  ProjectArtifactPlacementKind,
  type ProjectArtifactPlacementResponse,
} from "@repo/api/src/types/project-artifact-placement";
import {
  ProjectArtifactBoardAnalyticsLoadSource,
  ProjectArtifactBoardAnalyticsOutcome,
  ProjectArtifactBoardAnalyticsSignal,
  ProjectArtifactBoardHostAvailability,
  SurfaceAnalyticsEvent,
} from "@repo/api/src/types/surface-analytics";
import { useSurfaceAnalytics } from "@repo/app/shared/observability/surface-analytics-context";
import { useEffect, useRef } from "react";
import {
  isProjectArtifactBoardConflict,
  projectArtifactBoardFailureKind,
  projectArtifactBoardPerformanceProperties,
} from "../lib/project-artifact-board-analytics";

type ProjectArtifactBoardAnalyticsInput = {
  boardError: unknown;
  cardCount: number;
  destinationError: unknown;
  groupBy: ProjectArtifactBoardGroup;
  isLoaded: boolean;
  laneCount: number;
  mutationError: unknown;
  mutationOperation: unknown;
  mutationResponse: ProjectArtifactPlacementResponse | undefined;
};

/** Emit the closed Project board signal catalog through the shell-owned port. */
export function useProjectArtifactBoardAnalytics(
  input: ProjectArtifactBoardAnalyticsInput
): void {
  const { capture } = useSurfaceAnalytics();
  const startedAt = useRef<number | null>(null);
  if (startedAt.current === null) {
    startedAt.current = globalThis.performance.now();
  }
  const reachEmitted = useRef(false);
  const performanceEmitted = useRef(false);
  const lastBoardError = useRef<unknown>(null);
  const lastDestinationError = useRef<unknown>(null);
  const lastMutationError = useRef<unknown>(null);
  const lastMutationResponse = useRef<
    ProjectArtifactPlacementResponse | undefined
  >(undefined);

  useEffect(() => {
    if (reachEmitted.current) {
      return;
    }
    reachEmitted.current = true;
    capture(SurfaceAnalyticsEvent.ProjectArtifactBoardObserved, {
      group_by: input.groupBy,
      signal: ProjectArtifactBoardAnalyticsSignal.Reach,
    });
    capture(SurfaceAnalyticsEvent.ProjectArtifactBoardObserved, {
      host_availability: ProjectArtifactBoardHostAvailability.Paired,
      signal: ProjectArtifactBoardAnalyticsSignal.HostParity,
    });
  }, [capture, input.groupBy]);

  useEffect(() => {
    if (!input.boardError || input.boardError === lastBoardError.current) {
      return;
    }
    lastBoardError.current = input.boardError;
    capture(SurfaceAnalyticsEvent.ProjectArtifactBoardObserved, {
      failure_kind: projectArtifactBoardFailureKind(input.boardError),
      load_source: ProjectArtifactBoardAnalyticsLoadSource.BoardRead,
      signal: ProjectArtifactBoardAnalyticsSignal.LoadFailure,
    });
  }, [capture, input.boardError]);

  useEffect(() => {
    if (
      !input.destinationError ||
      input.destinationError === lastDestinationError.current
    ) {
      return;
    }
    lastDestinationError.current = input.destinationError;
    capture(SurfaceAnalyticsEvent.ProjectArtifactBoardObserved, {
      failure_kind: projectArtifactBoardFailureKind(input.destinationError),
      load_source: ProjectArtifactBoardAnalyticsLoadSource.DestinationRead,
      signal: ProjectArtifactBoardAnalyticsSignal.LoadFailure,
    });
  }, [capture, input.destinationError]);

  useEffect(() => {
    if (!(input.isLoaded && !performanceEmitted.current)) {
      return;
    }
    const properties = projectArtifactBoardPerformanceProperties({
      cardCount: input.cardCount,
      durationMs: globalThis.performance.now() - (startedAt.current ?? 0),
      laneCount: input.laneCount,
    });
    if (!properties) {
      return;
    }
    performanceEmitted.current = true;
    capture(SurfaceAnalyticsEvent.ProjectArtifactBoardObserved, {
      ...properties,
      signal: ProjectArtifactBoardAnalyticsSignal.Performance,
    });
  }, [capture, input.cardCount, input.isLoaded, input.laneCount]);

  useEffect(() => {
    if (
      !input.mutationError ||
      input.mutationError === lastMutationError.current
    ) {
      return;
    }
    lastMutationError.current = input.mutationError;
    if (
      input.mutationOperation === ProjectArtifactPlacementKind.Place &&
      isProjectArtifactBoardConflict(input.mutationError)
    ) {
      capture(SurfaceAnalyticsEvent.ProjectArtifactBoardObserved, {
        signal: ProjectArtifactBoardAnalyticsSignal.MoveConflict,
      });
      return;
    }
    if (input.mutationOperation === ProjectArtifactPlacementKind.Undo) {
      capture(SurfaceAnalyticsEvent.ProjectArtifactBoardObserved, {
        failure_kind: projectArtifactBoardFailureKind(input.mutationError),
        outcome: ProjectArtifactBoardAnalyticsOutcome.Failed,
        signal: ProjectArtifactBoardAnalyticsSignal.Rollback,
      });
    }
  }, [capture, input.mutationError, input.mutationOperation]);

  useEffect(() => {
    const response = input.mutationResponse;
    if (
      !response ||
      response === lastMutationResponse.current ||
      input.mutationOperation !== ProjectArtifactPlacementKind.Undo
    ) {
      return;
    }
    lastMutationResponse.current = response;
    capture(SurfaceAnalyticsEvent.ProjectArtifactBoardObserved, {
      outcome: ProjectArtifactBoardAnalyticsOutcome.Succeeded,
      signal: ProjectArtifactBoardAnalyticsSignal.Rollback,
    });
  }, [capture, input.mutationOperation, input.mutationResponse]);
}
