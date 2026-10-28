"use client";

import type { Dispatch, SetStateAction } from "react";
import { useMemo, useState } from "react";
import { DATE_RANGES } from "./artifact-list-model";

export const DEFAULT_ARTIFACT_DATE_RANGE = "30d";

/**
 * Absence is a whole shape, not a flag. A surface that declares no date
 * dimension carries no range at all, so nothing downstream can initialize,
 * apply, persist or serialize one — the absent variant has no `range` to read
 * and no `setRange` to call. A second boolean beside the presentational prop
 * is precisely the defect ISS-10479 reports: hiding the picker left the shell
 * filtering a project collection by a window the route contract says it must
 * never read or retain, with no control on screen to see or clear it.
 */
export type ArtifactDateDimension =
  | { readonly present: false }
  | {
      readonly present: true;
      readonly range: string;
      readonly setRange: Dispatch<SetStateAction<string>>;
    };

const ABSENT_ARTIFACT_DATE_DIMENSION: ArtifactDateDimension = {
  present: false,
};

export function useArtifactDateDimension(
  present: boolean,
  defaultRange = DEFAULT_ARTIFACT_DATE_RANGE
): ArtifactDateDimension {
  const [range, setRange] = useState(defaultRange);
  return useMemo(
    () =>
      present
        ? ({ present: true, range, setRange } as const)
        : ABSENT_ARTIFACT_DATE_DIMENSION,
    [present, range]
  );
}

export function isArtifactDateRange(value: string | null): value is string {
  return DATE_RANGES.some((candidate) => candidate.value === value);
}

export function withinArtifactDateDimension(
  dimension: ArtifactDateDimension,
  updatedAgoMinutes: number
): boolean {
  if (!dimension.present) {
    return true;
  }
  const days =
    dimension.range === "all"
      ? Number.POSITIVE_INFINITY
      : Number(dimension.range.slice(0, -1));
  return updatedAgoMinutes <= days * 24 * 60;
}

/**
 * A delta is still measured on a surface with no date dimension — only the
 * window it is measured over is unnamed, which is the same thing "all time"
 * already means. Naming a window the surface does not have would be a
 * confident false claim about the number beside it.
 */
export function artifactDateComparisonLabel(
  dimension: ArtifactDateDimension
): string {
  if (!(dimension.present && dimension.range !== "all")) {
    return "vs. prior period";
  }
  return `vs. prior ${dimension.range.slice(0, -1)} days`;
}
